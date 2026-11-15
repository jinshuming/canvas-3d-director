# Atlas（World Labs）功能拆解：Viewfinder / Chisel / Relight / Splat to mesh

调研日期：2026-11-15。来源有三类：
- 公开文档 `docs.atlas.worldlabs.ai`（`llms.txt` 下的全部 `.md`）；
- 登录后的 Atlas Studio（`atlas.worldlabs.ai`）界面和它发出的网络请求；
- Studio 前端的 JS 包（`atlas.worldlabs.ai/assets/*.js`，共 482 个文件，静态读取）。

调研时没有提交任何生成任务，没有花额度。前端代码是压缩过的，文中的「前端 / 后端」判断依据是：调用了哪个接口、代码在哪个文件里执行。模型内部怎么实现看不到，标「推断」的地方是根据参数名和文档推出来的。

## 1. 整体架构

| 层 | 内容 |
|---|---|
| 前端 | TanStack Start（React，Vite / rolldown 打包）。3D 用 three.js（WebGPU，着色器写成 TSL 节点）加 **Spark**（`spark.module`）渲染 splat。重计算放在 Web Worker 里：`depth-points-worker`、`depth-splat-tree-worker`、`lodWorker`、`depth-worker` |
| 登录 | Clerk（`clerk.worldlabs.ai`），请求带 Bearer token |
| 会话 | 每个工具（applet）的一次工作是一个 session：`/web-api/sessions?applet=viewgen | chisel-to-world | relight | splat-to-mesh`。前端定时把整个 store 存成 `/sessions/{id}/snapshot`（界面上显示「Saved to session」） |
| 任务 | 所有模型计算都是异步 operation：`POST /web-api/sessions/{session}/tasks:<task>` 返回 operation，前端再 `operations.wait / get` 轮询。每次提交带 `Idempotency-Key`（`web-workflow-<random>`），并把「请求 + operation id」记进会话的 journal，刷新页面后可以接着等，不会重复扣费 |
| 素材 | `/assets`：上传、读取 URL、删除。输入（深度 PNG、mask 等）由前端先上传，再在任务里引用 `assetId` |
| 服务端函数 | 少量逻辑走 TanStack `createServerFn`（POST RPC）：Chisel Agent 的大模型转发、Relight 的「AI 去光照」调用第三方图像模型 |
| 实时串流 | `serving-sessions` / `serving-types/frameboy`：Frameboy 是服务端实时渲染的串流会话，每段最长 1 分钟，500 额度一次 |

前端可以调用的全部任务（`index-*.js` 里的 API 客户端）：

`images2PosedRGBD` · `video2PosedRGBD` · `posedImages2Cameras` · `atlasTextToImage` · `atlasEnhancePrompt` · `atlasGenerate` · `atlasChisel` · `atlasChiselDev` · `chiselCaption` · `chiselCaptionUpdate` · `imageEdit` · `imageUpscale` · `posedImages2Splats` · `splats2Mesh`

前端里写的额度价目（`task-pricing-*.js`，1000 额度 = 1 美元）：

| 任务 | 额度 |
|---|---|
| `images2PosedRGBD` | 2 / 张 |
| `atlasTextToImage` | 40 |
| `atlasEnhancePrompt`、`chiselCaption`、`chiselCaptionUpdate` | 20 |
| `atlasGenerate` / `atlasChisel` | 第一帧 40（只出 RGB）或 50（出 RGBD）；之后每帧 8 或 10 |
| `imageEdit` | 125 |
| `imageUpscale` | 10 |
| `posedImages2Splats` | draft 500，refined 5000 |

## 2. 核心概念：posed RGBD view

Atlas 不是一次生成整个世界，而是**一张一张地生成视角**。每个视角是「RGB 图 + 相机（内参、外参，camera-to-world）+ 深度图」打包成的一个单元。
- `images2PosedRGBD`：给照片估计相机和深度。
- `atlasGenerate`：给出已有的视角（`contextFrames`）和要拍的新相机（`targetCameras`），生成这些新相机看到的画面，可以附带深度（`returnDepth`）。新视角又可以作为下一次请求的 context。
- `posedImages2Splats`：把一组 posed 视角一次性重建成 Gaussian splat（`.spz`）。

**相机由调用方选**：文档原话是「你的应用或 agent 负责选相机、记住场景」。这正是导演 agent 能接管的位置。

## 3. Viewfinder（图像 → 场景）

界面上有三种起点：**Reconstruct**（多张重叠的同一地点照片）、**Image**（一次一张图，拼成场景）、**Text**（文字出几张候选图，选一张）。之后在 3D 视口里用 WASD 漫游、摆相机，生成新视角，最后导出视频或 splat。

| 步骤 | 前端 | 后端 |
|---|---|---|
| 起点 | 选文件、上传素材；Text 起点先出候选图让用户挑 | `atlasTextToImage`；`images2PosedRGBD`（Reconstruct 一次提交全部照片，Image 每张单独提交）；`video2PosedRGBD`（视频） |
| 显示已有视角 | 把 RGBD 反投影成点云或预览 splat：`depth-points-worker`、`depth-splat-tree-worker`（744 KB 的 worker），EXR 深度解码（`decode-exr`、`EXRLoader`）。**免费的「depth」级 splat 是前端直接用深度图拼出来的**，不调后端 | — |
| 摆相机 | 视口相机、相机画中画（`camera-pip`）、变换手柄（`transform-gizmo`）、飞行路径（`flythrough-path`、`scene-curve`）都在前端。相机的位姿、视场角、分辨率（只能是 1280×720、960×720、528×704、720×1280）由前端算好 | — |
| 生成新视角 | 组装 `contextFrames`（相机 + 深度 + 图）和 `targetCameras`；context 多于 16 帧时先抽帧；没有 prompt 时先调 `atlasEnhancePrompt`，之后复用返回的 `promptUsed` 并关闭 enhance（跳过重新打标，速度更快） | `atlasEnhancePrompt`、`atlasGenerate`。视频路径用一次请求提交整条有序相机路径，可以带 `rolloutPlan`（例如 16 个关键帧，按顺序生成） |
| 出 splat | 选级别：depth（前端，免费）/ draft / refined | `posedImages2Splats {posedFrames, refine}`：`refine:false` 是 draft（500 额度），`true` 是 refined（5000 额度） |
| 导出视频 | `viewgen-video-export`：把生成的帧在前端拼成视频 | — |

## 4. Chisel（3D 白模 → 世界）

界面分三步：**Layout**（搭白模）→ **Picture**（逐个机位出图）→ **Video**（沿相机路径出视频）。左侧有一个 **Agent** 对话框。视图模式有 Blueprint / Geometry / Splat，还有完整的调色面板（LUT、曲线、色调映射）。

### 4.1 生成管线

| 步骤 | 前端 | 后端 |
|---|---|---|
| 搭白模 | 全部在前端：节点树（`scene-node`、`chisel-store`）、基本形体和参数化形状（`shape-registry`：墙、开洞、楼板、曲线、挤出、旋转、放样）、地形（`terrain-height`）、树（`create_tree`，可以调关节姿态）、用户上传的模型库（kit，支持 OBJ / FBX / GLB）、吸附与碰撞（`snap`、`MeshBVH`）、走动碰撞体（`scene-walk-collider`，胶囊体 + 八叉树） | — |
| 渲染条件图 | 前端从每个机位渲染**深度图**（编码为 inverted log depth 的 PNG，记录 zMin / zMax）和**物体 ID 图**（每个物体一种颜色），上传成素材 | — |
| 生成文字描述 | 把场景里的实体列表、ID 图的图例、每个机位的深度图和 ID 图发出去 | `chiselCaption`：后端的「caption compiler」返回整体 prompt 和**每个机位的条件图**（语义图或深度 mask）。改 prompt 时调 `chiselCaptionUpdate`，传入上一版 caption 和用户的修改要求 |
| 出图 | 组装 `targetFrames`（每帧：相机 + 深度 + 可选的图和 keep mask），可以带风格参考图 | `atlasChisel`（正式模型）或 `atlasChiselDev`（内部模型通道，例如 `chisel-flash-v1`） |
| 局部修改 | 前端画 mask（白色保留，黑色重新生成），上传 | `atlasChisel` 带 `imageAsset` + `maskAsset`；`depth.maskAsset` 可以单独控制几何要不要保留 |
| 出视频 | 沿相机路径取帧；Chisel Flash 要求至少 2 帧 | `atlasChiselDev` + `chisel-flash-v1` + `rolloutPlan` |
| 出世界 | — | `posedImages2Splats` |

文档里的要点：**深度决定布局，已知像素决定外观，context 图决定要和哪张照片保持一致**。想换风格时，不要把旧图放进 context，只用深度加新的 prompt。

### 4.2 Chisel Agent（和导演 agent 最相关）

- **大模型调用走后端，agent 循环和工具执行都在前端**。服务端函数是一个 POST 流式 RPC，参数包括 `provider`、`system`、`web`（是否允许联网）、`purpose`。工具在浏览器里直接修改场景 store，这和本项目的 `app/agent` 结构一样。
- 可选模型和前端写死的耗时统计（2026-10-27）：`sonnet` 中位 8 秒 / 轮（200 次运行）、`claude` 12.9 秒、`geminiFlash` 13 秒（814 次运行，用得最多）、`glmFlash` 8.6 秒，以及内部的 `argon` 27.9 秒。
- **按用途拆开的子调用**（`purpose`）：`agent`、`agentAsk`、`agentPlan`、`agentPlanAsk`、`agentPlanRender`、`agentPlanAskRender`、`buildCheck`、`planCheck`、`cameraLook`、`cameraPath`、`cameraPlacement`、`maskFind`、`blockoutChange`、`nextSteps`、`compact`、`kitNames`、`styleBrief`。不同用途给的工具集不同（例如 plan 模式拿不到 `create_wall`）。
- 「单次强制调用」的子任务：`place_cameras`、`report_frames`（规划相机路径）、`review_build`，描述里都写着「Call this exactly once … Do not explain first」，用来拿结构化结果。
- 主 agent 共有 **89 个工具**：
  - 场景读写：`get_scene`、`run_edits`（批量编辑）、`create_node`、`update_node`、`move_nodes`、`duplicate_as_instances`
  - 建筑：`create_wall`、`add_opening`、`set_room_slab`、`set_room_trim`、`set_room_cap`
  - 曲线与造型：`create_curve`、`create_extrusion`、`revolve_curve`、`loft_curves`、`shape_sweep`、`punch_pattern`
  - 场地：`add_site`、`probe_site`、`probe_ground`
  - 物理检查：`check_layout`、`ground`、`unbury`、`place_on`、`contact`、`measure`
  - 相机：`add_camera`、`auto_cameras`、`check_cameras`、`set_camera_path`、`auto_camera_path`、`render_camera_path`
  - 看图：`capture_scene_view`、`capture_camera_view`、`read_iteration_image`、`read_picture`
  - 生成：`create_iteration`、`process_iteration`、`set_iteration_style`、`start_flythrough`
  - 模型库：`list_kit`、`place_kit`、`import_kit_piece`
  - 其他：`ask_user`、`propose_memory`、`web_search`、`fetch_url`、`read_design_note`

## 5. Relight（splat 重新打光）

界面：左边是场景树（导入的 splat 和灯光），中间是视口，右边是属性面板；可以加环境光、点光、聚光、面光，生成 Shadow mesh，导出。

| 部分 | 前端 | 后端 |
|---|---|---|
| 打光和阴影 | **全部在前端实时计算**：`radix-shadow-budget`（85 KB）里有 light / lamp / radix 多个渲染 pass，还有 `relightSplatMap`、`relightContact`、`relightDeep`、`relightVolume`、`relightSmoothNormal` 等。阴影是在 splat 上算的深阴影和接触阴影。光源类型、强度、颜色、曝光、环境光都只是前端状态 | — |
| 法线、AO、材质 | 前端生成：`normalBuilds`、`occlusionBuilds`、`albedoBuilds`，材质预设（Matte / Satin / Gloss / Metal / Mirror，就是 roughness / metallic 组合），还能用笔刷刷自发光、粗糙度和材质 mask（深度感知笔刷，见 `relight-store`） | — |
| **AI 去光照（albedo）** | 先在前端把原图的光照拉平（「Flattening lighting」），从多个视角渲染出图，每张送去服务端；拿回的去光照图再投影回每个 splat，做一致性投票、去噪点和扩散（「Cleaning up」），最后写成新的颜色 | 服务端函数（`createServerFn`）调用第三方图像模型做 delight，按模型商的价格扣额度（文档：「Relight image edit costs what the model provider charged」）。材质估计（roughness / metallic）走另一个服务端函数，流程相同 |
| Shadow mesh | 前端发起，状态记在 `sceneMeshJobs` | 复用 `splats2Mesh` |
| 导出 | 前端生成文件：烘焙了光照的 splat（PLY / SPZ）、splat + shadow mesh 的 zip、可以重新打光的 PBR splat（PLY） | — |

结论：Relight 基本是一个**前端渲染器**，只有「去光照」和「生成阴影用的网格」需要后端。

## 6. Splat to mesh

| 部分 | 前端 | 后端 |
|---|---|---|
| 输入 | 选 `.spz` 或 `.ply` 文件；可以用前端交互画一个有朝向的包围盒（只提取盒子里的部分）；相机方案三选一：自动锚点、手动锚点（在视口里点出来）、外部球面；选择纹理模式、分辨率、面数上限、是否生成碰撞盒 | — |
| 计算 | 只负责提交 `splats2Mesh` 并等待，超时 65 分钟（`39e5` 毫秒，文档说高质量网格大约要 1 小时），有 journal 和幂等键 | **全部在后端**：从相机渲染 splat → 深度（`render`，或 `stereo` 立体匹配，更清晰但更慢）→ 法线（从深度估计，或用 splat 自带的）→ 在 `resolution` 网格上重建隐式曲面并提取网格 → 按 `trimQuantile` 剪掉凭空补出来的面 → 减面到 `targetFaces` → 贴图（UV 图集，`textureSize` 最大 8192）或写顶点色 → 可选拟合直立的碰撞盒（`colliderBoxes`，地板高度对齐，便于行走） |
| 结果查看 | 加载 GLB，和 splat 叠在一起对比（分屏）、线框、背面剔除、光照方向 | 返回 `mesh`（GLB）、`colliderBoxes`（GLB，每个盒子一个节点）、`anchorPositions` |

## 7. 前后端划分汇总

| 功能 | 前端负责 | 后端负责 |
|---|---|---|
| Viewfinder | 相机摆放和路径、RGBD 点云 / depth 级 splat 预览、抽帧、prompt 复用、拼视频 | 估计相机与深度、文字出图、扩写 prompt、生成新视角（RGBD）、重建 splat |
| Chisel | 白模建模（89 个 agent 工具都在前端执行）、渲染深度图和物体 ID 图、画 mask、调色 | caption compiler、深度引导生成（`atlasChisel` / Flash 视频）、大模型转发、重建 splat |
| Relight | 灯光、阴影、PBR 着色、法线 / AO / 材质、笔刷、烘焙和导出 | AI 去光照、材质估计（第三方图像模型）、阴影网格（`splats2Mesh`） |
| Splat to mesh | 参数设置、包围盒、手动锚点、结果查看 | 整个网格提取管线 |

## 8. 对导演 agent（JST-2）的启示

本项目现在的场景链路（`app/server/plugin.ts`，Viggle 公共 API，模型是 JST-2）：
- 生成：`/v1/scenes/pano` 文字出全景图，并重建成 `.spz`。
- 补全：`find_scene_gaps`（前端检测空洞和模糊）→ `fill_scene_view` = `/v1/scenes/generate`（目标视角）+ `/v1/scenes/reconstruct`。

这条链路和 Atlas 的 Viewfinder 很像：前端决定相机，后端出图并重建。可以借鉴的地方：

1. **相机交给 agent 决定**。`fill_scene_view` 现在一次只补一个视角。可以仿照 `place_cameras` 和 `report_frames`，加一个「只调用一次、返回一组相机」的结构化子调用，让 agent 先规划一组补全视角（覆盖缺口，同时考虑镜头需要），再交给 JST-2。
2. **分级重建**。Atlas 有 depth（前端免费）/ draft / refined 三级。导演里可以在付费重建前，先用 JST-2 返回的视角加深度在前端拼一个预览，确认后再重建。前提是 JST-2 能返回深度，需要确认。
3. **按用途拆开子调用**。Chisel 把 `cameraPlacement`、`cameraPath`、`buildCheck`、`planCheck` 都做成独立的调用，各自给不同的工具集和强制输出格式。导演 agent 里的机位规划、自检（`check_framing`、`contact_sheet`）可以照这个方式拆。
4. **任务 journal 和幂等**。Atlas 把「请求 + operation id + 幂等键」存进会话，刷新页面后能接着等而不重复扣费。导演现在由服务端轮询，`GenJob` 已经持久化，但提交给 Viggle 时没有带幂等键。
5. **白模 → 深度引导生成（Chisel 的思路）**。导演已经有片场和渲染器，可以从机位渲染深度。如果 JST-2 支持用深度或 mask 做条件生成，就能实现「agent 先摆粗略布局，再生成场景」。需要确认 JST-2 接口是否支持。
6. **网格和碰撞**。现在的碰撞体（`src/stage/collider.ts`）是在前端从点云构建的。`splats2Mesh` 的直立碰撞盒加地板高度对齐，正好是「人站在地面上、不穿墙」需要的东西，可以作为服务端的备选方案。
7. **Relight 不需要后端**。导演已经有 `set_lighting`。Atlas 的做法说明前端打光可以做到 PBR 加阴影这个程度；只有「去掉原图里烤进去的光照」需要图像模型。

### 待确认的问题

- JST-2（`/v1/scenes/*`）能否返回每个视角的相机加深度？能否接受深度或 mask 作为条件？
- 一个 Viggle 场景会话最多能放多少个视角？`reconstruct` 有没有 draft 这类便宜档？
