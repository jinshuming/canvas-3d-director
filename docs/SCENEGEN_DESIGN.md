# 场景生成模块（scenegen）方案

分支 `atlas-workflow`，2026-11-15。参考了 Atlas（见 `docs/ATLAS_ANALYSIS.md`）和 JST-2 的接口说明（`/v1/scenes/*` 的 OpenAPI 与接入指南）。

**目标**：做一个和导演台解耦、只负责生成 3D 场景的模块，有两个入口：
1. **文本 → 场景**：agent 读懂文字，用白模把场景摆出来 → 选一个能覆盖主要空间要素的拍摄点 → 生成全景（色彩风格 + 空间关系）→ 交给 JST-2 生成完整场景。
2. **视频 → 场景**：用户上传视频 → 抽帧 → 用 COLMAP 估计相机位姿 → 交给 JST-2 重建。

**输出**：一个能导入导演台素材库的场景资产。

---

## 0. 先说结论

| | 文本 → 场景 | 视频 → 场景 |
|---|---|---|
| JST-2 现在能不能接 | **能**。`POST /v1/scenes/custom-pano` 接收全景图和它在**我们世界坐标中的位姿**，生成的 splat 会直接落在白模的坐标系里 | **不能直接接**。接入指南「不能做」一栏写着：「上传自己的多张照片或修改历史图片的相机」「估计照片的相机位姿」。所有批次只能由 `pano` 或 `generate` 产生。公共 API 上也没有对应的上传接口（试了 `/v1/scenes/posed-images` 返回 405） |
| 最大的风险 | 「白模 → 全景」这一步：图像模型对布局（深度）的遵循程度，以及全景接缝和两极的质量 | 需要 JST-2 新增「上传带位姿的图片批次」接口；在那之前只能用折中方案 |
| 能直接复用的东西 | `scene-test-prompts`：`jst2-client.mjs`、`scripts/pano_check.py`（接缝、倾斜检查和修复）、`interactive-world` 的 `pano.js`（全景像素和射线互换）；导演台的 OpenAI 转发、任务轮询、素材库格式 | `scene-test-prompts/scripts/phone_pano_to_equirect.py` 的补边逻辑（把没拍到的上下和两端用模糊填满，并输出 mask）。注意它处理的是手机全景照片（柱面），不是视频帧 |

---

## 1. JST-2 接口能力（和本模块相关的部分）

| 接口 | 输入 | 输出 | 本模块的用法 |
|---|---|---|---|
| `POST /v1/scenes/pano` | `panoramaUri`（2:1 等距柱状全景，≤36 MP），或者 `prompt` 加最多 8 张 `referenceImages`，可选 `quality` | 初始批次 B1（全景的 6 个立方体面 + 每面的相机）、`spz`、`panorama` | 对照组：文字或参考图直接出场景 |
| `POST /v1/scenes/custom-pano` | `panoramaUri` + `panoramaC2w`（全景「正前方」相机在**我们世界里**的 4×4 c2w）+ 可选 `metersPerUnit` | 和 pano 一样，但返回的相机和 spz 都在我们的世界坐标里；之后的 generate / reconstruct 也用这个坐标系 | **文本路径的主接口** |
| `POST /v1/scenes/generate` | `referenceBatchIds` + `targetC2w`，可选 `projection`（perspective 或 pano）、`fov`（20–140°）、`seed` | 新增一个批次，并用全部批次重建 | 补被遮挡的区域（导演台现有的「扩展场景」就是用的它） |
| `POST /v1/scenes/reconstruct` | `referenceBatchIds`（总共 6–40 张图） | 只重建，不新增批次 | 撤回、剔除某个批次后重建 |
| `GET /v1/scenes/{id}` | — | 任务状态和结果 | 轮询 |

几个约束：
- 一次计算最多用 40 张图（一张全景占 6 张，一次 perspective generate 占 1 张）。
- 同一个 session 同时只能跑一个任务，否则返回 409。
- 相机用 OpenCV 约定：x 向右，**y 向下**，z 向前。内参 `[fx, fy, cx, cy]` 按图像边长归一化，`fx = 0.5 / tan(FOV / 2)`。
- `metersPerUnit` 的物理含义「尚待算法组确认」，需要我们自己标定（见 §2.6）。

---

## 2. 文本 → 场景

### 2.1 流程

```
用户文字
  │ ① 布局 agent：读懂文字 → 房间外壳 + 白模资产摆放 + 风格设定
  ▼
layout.json（物体：类别、尺寸、位姿、重要程度；风格：色板、材质、光照、时间）
  │ ② 选拍摄点（算法）：在可站立区域采样候选点，按覆盖度打分 → 拍摄点 + 正前方朝向
  ▼
从拍摄点渲染等距柱状图：深度 / 语义色块 / 法线或线稿 / 白模着色
  │ ③ caption 编译：由 LLM 根据「图例 + 用户文字 + 风格」写出全景 prompt
  │ ④ 生成全景：深度引导的图像模型出 2:1 全景 → pano_check 检查 → 修接缝、校正水平 → 布局一致性评分
  ▼
pano.png（4096×2048）
  │ ⑤ JST-2 custom-pano（panoramaC2w = 拍摄点位姿，metersPerUnit = 标定值）
  ▼
scene.spz（和白模在同一个世界坐标里）+ session / batchIds
  │ ⑥（可选）找出被遮挡的缺口 → generate 补视角
  │ ⑦ 导出到导演台素材库（场景 + layout，详见 §4）
```

### 2.2 ① 布局 agent

思路照搬 Atlas Chisel：**大模型调用走服务端，agent 循环和工具执行都在浏览器里**，工具直接修改白模场景。导演台已经是这种结构（`app/agent`、OpenAI Responses 转发），可以复用这套骨架，换成新的系统提示词和工具集。

**白模资产（v1 用参数化基本体，不依赖外部模型）**：每个类别是一组盒子和圆柱，带真实尺寸默认值和语义类别。

| 分组 | 类别（示例） |
|---|---|
| 建筑 | 房间外壳（矩形或多边形平面、层高、地板和天花板）、墙、门洞、窗洞、楼梯、柱子 |
| 室内 | 沙发、床、桌、椅、柜、书架、台面、灶台、电视、灯、地毯、绿植、窗帘 |
| 室外 | 地形块、道路、建筑体块、树、灌木、岩石、车、路灯、长椅、围栏 |
| 通用 | box / cylinder / sphere，可以自定义类别名（在 caption 里当普通名词用） |

v2 可以支持导入 GLB 模型库（类似 Chisel 的 kit）：CC0 低模资产，或者用 3D 生成工具现做。

**工具（从 Chisel 的 89 个里挑出这个场景需要的）**：

| 类别 | 工具 |
|---|---|
| 读 | `get_layout`（物体列表、包围盒、关系）、`render_view`（从某个相机截白模图给模型看）、`probe_floor` |
| 写 | `create_room`、`add_opening`、`place_object`（类别 + 尺寸，可选 + 关系：`on` / `against` / `near` / `facing` / `between`，或直接给位姿）、`update_object`、`remove_objects`、`arrange`（对齐、均分）、`set_style`（色板、材质、光照、时间、天气） |
| 检查 | `check_layout`：穿插、悬空、埋进地里、出了房间、通道宽度（<0.6 m 报警）、物体过密；返回编号的问题清单，可以接 `fix_layout`（自动落地、推开）|
| 流程 | `choose_capture_point`、`compile_caption`、`generate_pano`、`check_pano`、`create_scene`、`export_to_director` |

做法参考 Chisel：
- 「规划」和「执行」分成两次调用：先单独调一次 `plan`，强制输出结构化的物体清单和空间关系，再去执行摆放。
- 自检（`review_layout`）也单独调用一次，要求「只调用一次」并给出每一项的结论。
- 每次布局改动后自动跑 `check_layout`，不让模型自己决定要不要检查。

### 2.3 ② 选拍摄点

JST-2 是从**一个拍摄点**重建的，这个点看不到的地方就是空洞。所以这一步的目标是：**一个点尽量看清所有重要的物体，而且彼此不遮挡、距离合适**。

1. **候选点**：在可站立区域按 0.25 m 间距采样；高度取人眼高度 1.5 m（PINOC 的约定：地面在原点下方约 1.5 m）；离任何物体 ≥ 0.6 m，离墙最好 ≥ 1 m。
2. **每个候选点渲染一个小立方体图**（6 × 128²），输出物体 ID 和深度。全部候选可以放在 GPU 上一批渲染，几百个点大约 1 秒。
3. **打分**：对每个物体 i，按重要程度 w_i（agent 给，默认按体积）累加
   `可见度_i × (1 − 遮挡率_i) × 距离因子_i`。
   - 遮挡率 = 1 − 实际可见像素 / 单独渲染这个物体时的像素。
   - 距离因子：在 1–6 m 之间最好，太近会被放大变糊，太远细节不够。
   - 再加上：地面可见的比例，和整体覆盖度（看到的已建模表面占比）。
   - 扣分：画面被单个物体占满、离墙太近。
4. **定朝向**：全景的正前方对准权重最大的那组物体，让接缝（背后）落在最不重要的方向。这样接缝修复带来的瑕疵不会落在主体上。
5. **输出**：最佳点，外加按「补充覆盖」排序的 2–3 个次优点，留给 ⑥ 补视角用。

这和 Atlas `splats2Mesh` 的 `auto_anchors`（在几何围出的空间里找锚点）、导演台 `scenecheck.ts` 的视角打分是同一类问题，打分因子可以共用。

### 2.4 ③④ 白模 → 全景（关键风险）

**在拍摄点渲染的条件图**（都是 2:1 等距柱状，至少 2048×1024）：
- **深度**：度量深度，编码为 inverted log depth，并记录 zMin / zMax（和 Atlas 的格式一样）。
- **语义色块**：每个类别一种颜色，同时输出图例。
- **线稿或法线**：物体边缘。
- **白模着色预览**：给人和 VLM 看。

**caption 编译**：参考 Atlas 的 `chiselCaption`。把「用户原文 + 风格设定 + 物体清单（类别、方位角、距离）+ 图例」交给 LLM，写出一段只描述成品场景的全景 prompt（材质、光照、氛围），加上固定后缀（"360° equirectangular panorama, level horizon, …"）。

**生成方案（需要实测比较，不预设结论）**：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| A. 深度 ControlNet + 全景 LoRA | Flux 深度控制（fal 上有托管）+ 等距柱状全景 LoRA，直接出 2048×1024 | 布局遵循最好，原生 2:1 | 接缝需要「平移一半 + 局部重绘」来修；两极畸变；LoRA 质量参差 |
| B. Atlas `atlasChisel` 分视角生成后拼接 | 拍摄点处 8–10 个机位（含朝上、朝下），每个用深度引导、多视角一致的方式生成 1280×720，然后拼成等距柱状 | 多视角一致性有保证；成本低（第一帧 50 额度，之后每帧 10，约 0.15 美元一张全景） | 依赖 World Labs；拼接缝和曝光一致性需要处理；分辨率上限 |
| C. 通用图像编辑模型 | Seedream 4 / Gemini Image / gpt-image，把白模着色全景作为输入图，加上 prompt「写实化，保持布局」 | 接入最简单，风格控制好 | 布局容易漂；gpt-image 不支持 2:1 输出 |
| D. 对照组 JST-2 `/pano` | prompt + `referenceImages`（白模渲染图）直接交给 JST-2 | 零开发 | 基本不遵循布局，用来量化 A–C 的提升 |

**评测**：10 个白模布局 × 每个方案 3 个种子，比较以下指标。
- **布局一致性**：对生成的全景做单目深度估计，和白模深度做相关系数；语义区域 IoU。
- **几何**：`pano_check` 严重缺陷率、接缝分、倾斜。
- **下游**：JST-2 重建后，从拍摄点附近渲染，算空洞比例。
- 速度和成本。

**后处理**：`pano_check fix`（接缝颜色融合、整体校正水平）→ 放大到 4096×2048 → 再检查一遍。

### 2.5 ⑤ 交给 JST-2

```jsonc
POST /v1/scenes/custom-pano
{ "sessionId": "sg_<id>",
  "panoramaUri": "<上传后的地址或 multipart 文件>",
  "panoramaC2w": C2W_opencv(拍摄点, 正前方朝向),   // 我们是 Y 向上（米），要换成 OpenCV 的 Y 向下
  "metersPerUnit": <标定值> }
```

好处：生成的 spz 和白模**在同一个坐标系里**。所以 `layout.json` 里沙发在哪，splat 里的沙发就在哪。导演台拿到这个场景后，可以直接按物体名称给角色站位（「坐到沙发上」），不用再猜。

### 2.6 标定（M0 要先做的实验）

- `metersPerUnit` 和坐标轴：用一张已知的全景，以不同的 `panoramaC2w` 和 `metersPerUnit` 各调一次 custom-pano。从拍摄点垂直向下找地面（PINOC 的说明里给了沿哪个轴找、怎么区分新旧格式），看「拍摄点到地面的距离」是不是 1.5 m，以及模型单位和米的比例。确定后写死，并在每个场景里记录。
- 白模的尺度要和这个标定对上：拍摄点高度要和全景的视点一致，否则地面会错位。

### 2.7 ⑥ 补视角（可选）

找出拍摄点看不到、但在白模里存在的表面（用次优点打分），调 `generate` 补上。注意：`generate` 只看已有的批次，**不看白模**，补出来的内容是模型自己想象的，不保证和布局一致。如果需要「按白模补」，要请 JST-2 支持在 generate 时传入条件图（深度 / 参考图）。

---

## 3. 视频 → 场景

### 3.1 流程

```
上传视频（mp4 / mov）
  │ ① ffprobe：时长、帧率、分辨率、旋转方向；转成统一的方向
  │ ② 抽帧（两级）
  │    a. 粗抽：按 2–4 fps 解码
  │    b. 去模糊：Laplacian 方差低于局部中位数 × 0.6 的帧丢掉（运动模糊）
  │    c. 关键帧：用特征点跟踪（ORB / 光流）算相邻帧的重叠度，保持 60–80% 重叠，约 80–200 帧给 COLMAP
  │ ③ COLMAP
  │    feature_extractor --ImageReader.single_camera 1 --ImageReader.camera_model OPENCV
  │    sequential_matcher --SequentialMatching.overlap 15 --SequentialMatching.loop_detection 1
  │    mapper（或 COLMAP 4 的全局建图）
  │    image_undistorter → 针孔相机（JST-2 只接受 fx, fy, cx, cy）
  │ ④ 规范化
  │    - 世界坐标：把相机位置和稀疏点云对齐重力（用 RANSAC 拟合地面平面，或用相机平均的 up 方向），水平拉平
  │    - 尺度：COLMAP 的尺度是任意的。假设相机高度约 1.5 m（地面平面到相机的中位距离），或用单目度量深度（Depth Pro 一类）和稀疏点对齐来估算
  │    - 转换：COLMAP 的 images.txt 是 world-to-camera（qvec, tvec）→ 取逆得到 c2w；COLMAP 本身就是 OpenCV 约定，和 JST-2 一致
  │ ⑤ 选给 JST-2 的子集：≤ 40 张（如果还要加全景，≤ 34 张）。在已注册的位姿上做「最远点采样」（位置 + 朝向），保证覆盖
  │ ⑥ 上传给 JST-2 重建
  ▼
scene.spz（在视频的世界坐标里，经过重力对齐、单位接近米）
```

COLMAP 在 M2 的 CPU 上（没有 CUDA）处理 150 帧 1080p：特征提取 1–3 分钟，顺序匹配 1–2 分钟，建图 1–3 分钟，可以接受。安装二选一：`brew install colmap`（4.2.1），或在 venv 里 `pip install pycolmap`（更方便由 Python 直接调用）。以后放到 GPU 服务器上会快很多。

### 3.2 ⑥ 怎么交给 JST-2：需要新接口

**建议向 JST-2 申请**（接口形状和现有的批次模型一致）：

```jsonc
POST /v1/scenes/posed-images
{ "sessionId": "sg_<id>",
  "views": [ { "imageUri": "...", "c2w": [[...4x4, OpenCV...]], "intrinsic": [fx, fy, cx, cy] } ],  // 6–40 张
  "metersPerUnit": 1 }
→ SceneResult：outputBatch.kind = "uploaded"，views 原样回显，spz 是用这些视角重建的结果
```

理由：现有的批次本来就是「图片 + c2w + 内参」，`reconstruct` 也是拿任意一组批次重建的。所以只缺「由用户创建批次」这个入口。有了它，视频场景还能继续用 `generate` 补拍摄没覆盖到的地方，和文本路径共用后面的全部流程。

**需要和 JST-2 确认**：
- 模型对真实照片（曝光不一致、有动态物体、有畸变残留）的鲁棒性。
- 输入图分辨率上限。
- 位姿精度要求有多高。

### 3.3 接口出来之前的折中方案

| 方案 | 适用 | 做法 | 缺点 |
|---|---|---|---|
| a. 视频 → 全景 → custom-pano | 原地转一圈拍的视频 | 用 COLMAP 估出的旋转，把每帧投影到等距柱状图上融合；没拍到的区域照 `phone_pano_to_equirect.py` 的做法补边并输出 mask；`panoramaC2w` = 视频中心点的位姿 | 只适合原地旋转；边走边拍时视差会造成重影 |
| b. 关键帧作为参考图 → `/pano` | 任意视频 | 选 ≤ 8 张覆盖最广的帧作为 `referenceImages`，再加 VLM 写的 prompt | 几何不保真，JST-2 会自己想象一张新全景 |
| c. 本地训练 3DGS | 任意视频 | COLMAP 的结果交给 Brush（Mac 上能跑）/ OpenSplat / gsplat 训练，导出 ply 再转 spz | 不经过 JST-2，没有生成式补全，之后也没法用 `generate` 补；训练时间较长 |

建议：M3 先做好 ①–⑤ 并可视化位姿，交付方案 a 和 b；新接口一上线就切到 §3.2。

---

## 4. 模块形态和导入导演台

**位置**：放在本仓库的 `scenegen/` 目录（和 `app/` 并列），有独立的页面路由 `/scenegen`、独立的 Vite 中间件和独立的数据目录 `.data/scenegen/`。不 import 导演台的 `src/stage`，只共享两样东西：Viggle / OpenAI 的密钥配置，以及素材库的写入接口。

```
scenegen/
  web/        页面：文本 / 视频两个入口；白模编辑视口；全景查看（2D + 球面）；结果 splat 预览
  agent/      布局 agent 的系统提示词和工具（在页面里执行）
  layout/     白模资产库（参数化基本体）、碰撞和落地检查、拍摄点打分、条件图渲染（等距柱状）
  server/     任务队列和持久化、JST-2 客户端、全景模型适配器（A / B / C / D）、视频任务（调起 Python worker）
  py/         视频：抽帧、COLMAP、规范化、子集选择；全景：pano_check（从 scene-test-prompts 引入）
```

**渲染**：白模和条件图用 three.js（`CubeCamera` 加转等距柱状的 shader，深度、ID、法线各一个 pass）。结果预览用导演台同一个 `@viggle/splat-engine`，保证看到的效果和导演台里一致。

**导出给导演台**：在 `.data/library.json` 写一条 `LibraryScene`。
- `url`（spz）、`panoramaUrl` 照常填。
- `viggle: { sessionId, batchIds }` 也写上，这样导演台的「扩展场景 / 补全」照常可用。
- 新增两个可选字段：
  - `layout`：指向 `layout.json`，包含物体名称、类别、包围盒，坐标和 spz 一致。
  - `frame`：坐标约定和 `metersPerUnit`。

导演台的 agent 读到 `layout` 后，`get_world_layout` 能直接报出「沙发在 (x, z)」。这一项改动放到 M4，在那之前不碰导演台的代码。

---

## 5. 里程碑

| 阶段 | 内容 | 完成的标准 |
|---|---|---|
| **M0 技术验证** | ① custom-pano 坐标和 `metersPerUnit` 标定；② 白模 → 全景，方案 A / B / C / D 小规模实测（5 个布局）；③ 3 段样例视频在 M2 上跑 COLMAP（注册率、耗时）；④ 和 JST-2 团队确认 posed-images 接口 | 一页数据结论：选哪个全景方案；视频路径的依赖和预计时间 |
| M1 文本路径打通（手动） | 基本体资产库 + 手动摆放 + 手动选点 → 条件图 → 选定的全景方案 → custom-pano → 预览 | 3 个场景从文字到 spz，白模和 splat 对齐误差 < 0.3 m |
| M2 agent 化 | 布局 agent（规划 / 执行 / 自检）、自动选点、caption 编译、pano_check 自动重试、评测集（20 条文字） | 评测集通过率和平均耗时达标 |
| M3 视频路径 | 抽帧、COLMAP、规范化、位姿可视化；折中方案 a / b；接口上线后接 §3.2 | 5 段视频 ≥ 80% 帧注册，能产出场景 |
| M4 接入导演台 | 导出到素材库 + `layout` 附件；导演台读取 layout | 导演台里能按物体名给角色站位 |

## 6. 待确认

1. JST-2：posed-images 接口能不能做、什么时候；custom-pano 的扣费；`metersPerUnit` 的定义。
2. 全景生成用哪家模型（M0 实测之后再定），以及第三方模型的预算。
3. 白模资产 v1 只用参数化基本体，是否可以接受（v2 再接 GLB 模型库）。
4. 视频路径对拍法有没有要求（例如「原地转一圈」「慢速平移、不要快速转头」），是否需要在上传页上提示用户。
