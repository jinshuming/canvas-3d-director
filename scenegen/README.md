# 场景生成（scenegen）

和导演台解耦的 3D 场景生成模块。日常在**画布**上用：左侧 ＋ →「场景生成」（文本 / 图片 / 视频）或「场景重建」（视频），完成后「送到 World」。`http://localhost:5193/scenegen/` 是**批量测试页**：逐个项目看输入、白模、全景候选、3D 场景和指标。

| 入口 | 流程 |
|---|---|
| **文本 / 图片 / 视频 → 场景** | **快速白模**（`quickLayout.ts`）：一次结构化模型调用给出房间、开口、物体（含相对关系、关键物体标记）和风格，确定性地摆放、推开重叠、选拍摄点（约 15 秒；之后的对话由 agent 改白模）→ 渲染等距深度图和白模图 → GPT-image-2 **按需画全景**：先画 1 张，与白模的对齐分 ≥ 0.8 且没有显眼人物就用；否则再并行画 2 张，选没有人物、对齐分最高的一张（3 张都有人物再画最后 2 张，最多 5 张）→ 交给 SAM 3D 的物体**不进环境的白模**：环境全景从去掉它们的白模画，提示词也去掉用户原话、风格概述和材质（否则模型会照着文字把它们画回来），所以不需要擦除 → **分两路并行**：① 环境：全景图给 JST-2 `custom-pano`，按 1 单位 = 1 建一次，从拍摄点到地面的距离量出 `metersPerUnit`，缩放成米 → 自动补缺口（`fill.ts`），得到 `environment.spz`；② 物体（`objects.ts`）：每个物体在环境全景的透视裁图里单独画进去（完整白模同视角作位置参考，遮罩限定在投影框内；一次只画一个，几个一起画会错位）→ 用「画进去的东西」的包围框作提示 → fal SAM 3D 生成高斯物体，原样存为 `objects/<id>-sam.spz` → 量出环境相对白模的水平尺度（常见 0.83–0.95）→ `composeScene` 把每个物体摆进环境（见下文「摆放」），合成 `scene.spz`；3D 查看器分层加载 |
| **视频 → 场景** | 抽帧（去模糊、按重叠度选关键帧）→ COLMAP 估计位姿 → 重力对齐、按相机高 1.5 m 定尺度。JST-2 还不能上传图片+位姿，所以默认走 `videoGen.ts`：选视频里环顾最多的位置作锚点，把附近帧按位姿拼成 360° 全景（真实像素）→ GPT-image-2 只补视频没拍到的部分 → `custom-pano` 在锚点建场景（1 单位 = 1，按锚点相机高度换算成米，与视频同一坐标系）→ 在视频自己的相机位置 `generate` 视角 → `reconstruct` → 补缺口 → 与 COLMAP 点对比（风车村：83% 的点在 ±25% 内）。离锚点越远，画面越多是模型补的。`posed-images`（**接口待开放，目前由内置 mock 代替**）上线后改走真实帧 |

方案和调研见 `docs/SCENEGEN_DESIGN.md`、`docs/ATLAS_ANALYSIS.md`。

## 运行

```bash
npm install
npm run dev            # http://localhost:5193/scenegen/
```

如果访问 OpenAI 需要代理，启动前设置 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY`。

`.env.local` 里需要的 key（只在服务端用，不会进页面）：

| key | 用途 | 没有时 |
|---|---|---|
| `VIGGLE_API_KEY` | JST-2：建场景、补缺口 | 不能生成 |
| `FAL_KEY` | SAM 3D 生成关键物体；可选的 FLUX.1 Depth 全景图 | 关键物体不单独生成（整个场景一份 3DGS）；FLUX 选项不可用 |
| `OPENAI_API_KEY` | 布局 agent（`OPENAI_MODEL`，默认 gpt-6-luna）和 GPT-image-2 全景图 | agent 不可用；全景图可以改用「JST-2（白模作参考）」 |
| `SCENEGEN_IMAGE_MODEL` | 全景图模型，默认 `gpt-image-2` | — |
| `SCENEGEN_POSED_IMAGES_BASE` | posed-images 接口上线后填它的地址（例如 `https://apis.viggle.ai`） | 用内置 mock |

视频管线（Python）：

```bash
cd scenegen/py
uv venv -p 3.12 .venv && uv pip install -p .venv -r requirements.txt   # pycolmap 4.2.1（CPU）、numpy、opencv
.venv/bin/python -m videoscene.run <video.mp4> --out out/x                 # 单独跑也可以
```

## 测试

```bash
npm test               # 导演台 + scenegen 的 TS 测试
npm run test:video     # 视频管线 pytest（含在 livingRoom 漫游视频上的集成测试，约 30 s）
SCENEGEN_E2E_VIDEOS=<视频目录> npx tsx scenegen/eval/e2e.mts .data/scenegen/eval/<run> [组 id|功能]   # 真实端到端（dev server 运行时，花额度）
npm run typecheck
```

## 结构

| 位置 | 内容 |
|---|---|
| `core/` | Node 和页面都能跑：白模资产库（`catalog.ts`，36 类参数化形体）、按关系摆放和布局检查（`layout.ts`）、CPU 射线求交（`geometry.ts`）、等距柱状深度 / 语义 / 白模渲染（`render.ts`）、拍摄点搜索（`capture.ts`）、全景 prompt（`caption.ts`）、坐标约定（`frame.ts`）、SPZ 读写、与白模的深度一致性（`align.ts`） |
| `agent/` | 布局 agent：系统提示词、14 个工具、对话循环（在页面里执行工具，服务端只转发模型） |
| `web/` | 批量测试页；`api.ts` 是项目 API 客户端（页面、画布节点、评测脚本共用），`agentHost.ts` 是 agent 工具和项目 API 之间的桥（三处共用），`runner.ts` 供画布节点调用 |
| `server/` | Vite 中间件和 HTTP API（`plugin.ts`）、JST-2 客户端（含 posed-images）和 mock、快速白模（`quickLayout.ts`）、全景图 provider 和物体重绘（`pano.ts`）、全景对齐打分（`alignScore.ts`）、文本管线（`textScene.ts`）、SAM 3D 物体（`objects.ts`）和摆放（`seatScene.ts`）、自动补缺口（`fill.ts`，复用 `src/stage/scenecheck.ts` 的 PINOC 检测）、扩展场景（`expand.ts`）、视频管线（`videoScene.ts`、`videoGen.ts`、`keyframes.ts`） |
| `py/` | `videoscene/`：视频 → 图片 + 位姿（抽帧、COLMAP、规范化、选视角）；`panoalign.py`：全景图与白模的对齐打分 |
| `eval/` | `e2e.mts`：真实端到端测试（花额度）；`panoab.mts`：出图方式对比（只花 GPT-image 调用）；`replace.mts`、`topdown.mts`：重摆物体、画俯视图（不花额度） |
| `../app/canvas/SceneNodes.tsx` | 画布上的「场景生成」「场景重建」节点：每个节点对应一个 scenegen 项目 |
| `../app/server/openaiRelay.ts` | 导演台 agent 和场景 agent 共用的 OpenAI Responses 流式转发 |

数据在 `.data/scenegen/projects/<id>/`。

## 物体落座、重打光、送到导演台

- **哪些物体用 SAM 3D**（`server/objects.ts` 的 `planObjects`）：房间中间的、能看到四周的物体（沙发、茶几、椅子、落地灯、绿植……）都用 SAM 3D 单独生成，每个场景最多 12 个。靠墙、背后不露的物体画进全景，随环境一起重建成 3DGS：背面离墙不到 20 cm，或者塞在墙角。放在物体上面的东西跟着它所在的物体走。白模的 `key` 只决定先后顺序。室外没有墙，仍按 `key` 或重要度选。
- **摆放**（`core/place.ts`、`server/seatScene.ts` 的 `placeScene`）：每次合成场景时，从 SAM 3D 的原始物体 `objects/<id>-sam.spz` 重新求解，不信任 SAM 3D 自己估的姿态。
  1. **清理**：只保留主体，即不透明高斯体素化后的连通块。若有多个大块（例如 SAM 3D 把椅子和它旁边的桌子一起给了），只保留比例最接近白模框的那块。站正之后再去掉底部的地面薄片。
  2. **站正**：SAM 3D 的上方向一般保留；只有它没有水平的底，或者另一个轴向比它吻合白模两倍以上时才换（不考虑尺寸，避免把“桌带椅”放倒）。尺寸差不多的候选里，选底面接触面积比顶面小的（腿朝下）。
  3. **调平**：在 ±20° 内搜索让水平面（桌面、座面、底面）最“薄”的倾角，并且要求包围盒不变大（植物不会被歪着放）。
  4. **转向**：用最小外接矩形把物体和白模框对齐。90° 的改向要尺寸或剪影明显更好才采用（剪影 = 从裁图相机看，与画进裁图的物体比较）；从不做 180°。
  5. **尺寸和位置**：统一缩放（三个比例取中位数），底面中心对到白模框的底面中心（乘以环境的水平比例）。
  6. **约束**：落在环境的真实地面上；推回墙内；两个物体共享超过 3% 的 5 cm 体素就沿白模中心连线推开；放在别的物体上的东西最后落到那个物体的顶面上。
  7. 摆好后形状仍和白模框差很多（比例差 > 2.5 倍）的标为 `suspect`，交给重新生成。
  - 工具：`eval/replace.mts` 用当前算法重摆已有场景（不花额度）；`eval/topdown.mts` 画俯视图，显示物体和白模框。
- **重打光**（编辑器「光照」，仿 Atlas Relight）：
  - 预设、光的方向 / 高度 / 强度 / 颜色、环境光、影子深浅、场景受光、角色受光；
  - 用 Splat Engine 的 `SplatRelight` 渲染：环境的接收体裁到房间盒子（墙外 30 cm），所以没有方形的色块边；
  - 设置存在项目的 `lighting` 上。
- **送到导演台**（`POST /projects/:id/export` → 导演台 `POST /api/library/import-scene`）：
  - 场景文件只含**环境**，并换回 JST-2 会话的单位（`sessionInUnits` 的场景要除以 metersPerUnit）。导演台从地面自己测比例，「扩展场景」按文件坐标向同一个会话要新视角。
  - SAM 3D 物体合成**另一个 splat**（`objectsUrl`），坐标系相同，用场景的 placement 挂载。导演台补全只重建环境，物体会被继承下来。
  - 光照成为世界的 `StageLighting`；场景受光和房间盒子成为 `scene.relight`（单位是导演台的米，地面 y = 0）。
  - 视频场景也会带上 Viggle 会话。

## 坐标约定（实测，2026-11-15）

- 白模世界：米，+Y 向上，地面 y = 0，-Z 为北。
- **场景文件**：拍摄点在原点，米，+Y 向上，地面在 y = -1.5。这正是导演台对生成场景的假设，所以导入后比例 ≈ 1，导演台的「扩展场景」也能直接用。`layout.json` 的 `sceneFrame.origin` 记录拍摄点在白模世界里的位置。
- JST-2 `custom-pano` 把调用方的世界当作 OpenCV 风格（Y 向下），写文件时翻转 Y、Z。所以发给它的位姿要先翻转（`toServiceC2W`），文件才是 Y 向上。
- 每张全景重建出来的单位不同。所以按 1 单位 = 1 只建一次，量出拍摄点到地面的距离，`metersPerUnit` = 1.5 / 距离，把文件缩放成米。JST-2 会话仍是原单位（`sessionInUnits`）：补缺口、扩展场景发出的位姿要除以 `metersPerUnit`，重建结果再乘回来。没有 `sessionInUnits` 的旧场景，会话本身就是米。

## 给 JST-2 后端：`POST /v1/scenes/posed-images`（待开放）

和现有批次模型一致：由调用方自己的图片和相机组成一个批次，并用它重建场景。

**请求**（`multipart/form-data`，鉴权与其它 `/v1/scenes/*` 相同）

| 字段 | 说明 |
|---|---|
| `sessionId` | 1–128 个 `[A-Za-z0-9_-]` |
| `views` | JSON 数组，与 `imageFiles` 一一对应：`[{ "c2w": 4×4, "intrinsic": [fx, fy, cx, cy] }]` |
| `imageFiles` | 每个视角一张 JPEG / PNG，按 `views` 的顺序 |
| `metersPerUnit` | 可选，同 `custom-pano` |

- `c2w`：camera-to-world，OpenCV 轴（x 右、y 下、z 前），最后一行 `[0,0,0,1]`；调用方世界即 COLMAP 规范化后的世界（Y 向下，单位约为米）。
- `intrinsic`：针孔内参，`fx`、`cx` 除以图像宽，`fy`、`cy` 除以图像高（与现有 `views[].intrinsic` 一致；图像不要求是正方形，视频帧通常是 16:9）。
- 视角数 1–40（与单次计算上限一致）。

**响应**：与其它接口相同的任务信封，`GET /v1/scenes/{id}` 轮询。完成后：
- `result.outputBatch = { batchId, createdAt, kind: "uploaded", views: [{ index, url, c2w, intrinsic }] }`
- `result.spz`：用这些视角重建的场景。之后可以照常用 `generate`（把 `batchId` 放进 `referenceBatchIds`）补拍摄没覆盖到的地方，用 `reconstruct` 撤回。

**错误**：`400`（`invalid_session` / `invalid_views` / `too_many_views` / `files_mismatch` / `invalid_c2w` / `invalid_intrinsic` / `invalid_image`），`401`，`409`（同一 session 已有任务在跑）。

内置 mock（`server/mockjst2.ts`）严格按这份规格校验和应答，只是不做真正的重建：返回的场景是 COLMAP 稀疏点云的预览。上线后设置 `SCENEGEN_POSED_IMAGES_BASE` 即可切换，代码不用改。视频管线输出的 `bundle/request.json` 就是这个请求体（图片按路径引用）。
