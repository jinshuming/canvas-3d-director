# Viggle 3D 导演台 MVP 方案

状态：方案稿，未开发。日期：2026-10-29。

## 1. 一句话

用一句话描述一场戏，Agent 用 Viggle API 生成场景（splat）、角色（vsplat）和动作（motion），把它们摆进同一个 3D 片场，加机位、设计运镜。用户可以在浏览器里预览、微调，然后导出画面或视频，交给 Viggle 的视频模型出成片。

## 2. 从 the reference product 3D 导演台学到的设计要点

| the reference product 的做法 | 我们的对应做法 |
|---|---|
| 整个片场就是一份 glTF，人、Agent、外部工具都读写这同一份文件 | 一份 **Stage 文档**（JSON）作为唯一数据源，导出时转成 glTF（相机和运镜部分） |
| 镜头 = glTF camera 节点，运镜 = glTF animation | 镜头和运镜都是一等对象，字段语义和 glTF 的 camera / animation 对齐 |
| 粗活交给 Agent（搭景、加镜头、初版运镜），细活交给编辑器（曲线、缓动） | 同样两层：对话生成，加关键帧 / 缓动的手动精修 |
| 用户选中物体时，告诉 Agent `node_index + scene_version + sha256` | 选中引用：`{ objectId, docVersion }`，Agent 改之前必须读最新版本 |
| 用版本号 + 乐观锁，保存失败时保留本地修改 | 文档带 `version`，服务端用 CAS 写入；冲突时 Agent 重新读取后重试 |
| Agent 能调用浏览器端工具（聚焦、导出帧、导出视频） | 浏览器端工具：`focus`、`capture_frame`、`render_shot` |
| 导出帧和视频，自动生成画布节点，接视频模型 | 导出后直接调 Viggle 视频生成（首帧、参考视频），结果作为成片 |
| 路径和时间节奏分开（路径曲线 + 时间缓动） | MVP 只做关键帧 + 缓动预设；切线编辑器放到 V2 |

**我们的差异化**：the reference product 的片场是白模，真实感全靠下游模型。Viggle 的场景、角色、动作都是真实生成的 3D 资产（照片级 splat 场景、可驱动的 splat 角色、AI 动作），**预演画面本身就接近成片**，下游视频模型只需要"润色"，不需要"重新想象"。

## 3. MVP 范围

### 要做

1. **一个场景**：用一句话（可以附参考图）生成 splat 场景，支持对一个视角补图（Fill view）。
2. **1–3 个角色**：用一张图生成 vsplat 角色，可以摆放位置和朝向。
3. **动作**：用文字生成动作（text-to-motion），或从动作库里选，在时间轴上分配给角色（每个角色一段动作，可以设开始时间和循环）。
4. **镜头和运镜**：可以有多个镜头。每个镜头一条相机关键帧轨道，包括位置、朝向、FOV、时间，加缓动预设。
5. **Agent 对话**：负责以上所有生成和编排，也支持选中物体后说"让他往左走两米"。
6. **预览**：实时播放整场戏（角色动作 + 运镜同步），可以拖动播放头。
7. **导出**：
   - 当前帧 PNG；
   - 镜头视频 MP4，在浏览器本地离线逐帧渲染，保证帧率；
   - 一键送去 Viggle 视频生成（用首帧或参考视频），得到成片。
8. **保存和恢复**：Stage 文档存服务端；资产的签名链接过期后自动刷新。

### 不做（V2 及以后）

- 切线、曲线编辑器，多段剪辑时间轴，镜头之间的转场
- 角色之间的交互（拥抱、对打）、物理效果、IK 落脚
- 多人协作、评论
- 在场景里放道具模型（glTF 道具）
- 灯光编辑（MVP 只用 `SceneLighting` 的太阳光加影子预设）

## 4. 用户流程

```
① 说一句话：「雨夜的霓虹街角，一个穿风衣的人走过来停下回头，镜头从远处推近」
② Agent 拆解：场景 / 角色 / 动作 / 镜头，先给出计划和预估额度，等用户确认
③ 并行生成：场景（pano，约 10 秒，6 额度） + 角色（约 1–2 分钟） + 动作（text-to-motion，10 额度）
④ 自动摆放：角色放在地面上（复用 walk/placement 的地面探测），面朝镜头
⑤ Agent 加镜头 + 运镜（关键帧），预览自动播放
⑥ 用户微调：拖动角色、移动相机、加减关键帧、改缓动、换动作
⑦ 导出：PNG 或 MP4 → 送 Viggle 视频生成 → 得到成片
```

生成的东西还没好时，界面上先放占位：场景用全景图，角色用缩略图做成的平面人形，动作用 T-pose。这样用户可以先摆机位，不用干等。

## 5. 系统架构

```
┌────────────────────── 浏览器 ──────────────────────┐
│  React 应用                                         │
│  ├─ Stage 视口（world SDK 引擎：splat 场景 + vsplat 角色 + 动作）│
│  ├─ 时间轴（播放头、角色动作片段、相机关键帧）          │
│  ├─ 检查器（选中对象的变换和参数）                     │
│  ├─ Agent 对话面板（流式输出）                        │
│  └─ 浏览器端工具：focus / capture_frame / render_shot │
└───────────────┬─────────────────────────────────────┘
                │ REST + SSE
┌───────────────▼──────── 服务端（Node） ──────────────┐
│  Stage 服务：文档的版本化存储（CAS）                  │
│  Agent 服务：Claude + 工具调用（见第 7 节）            │
│  Viggle 代理：持有 API key，提交任务、轮询、重新签名     │
│  资产缓存：把 spz / vsplat / glb 转存到自己的对象存储    │
└───────────────┬─────────────────────────────────────┘
                │
        apis.viggle.ai（Scenes / Characters / Motions / Videos）
```

- **API key 只放在服务端**，和 world SDK README 的要求一致。
- **资产要转存**：Viggle 的签名链接只有 1–3 小时有效，生成完就转存到自己的存储（R2 或 S3），Stage 里存的是永久地址加 Viggle ID。

## 6. 数据模型：Stage 文档

```jsonc
{
  "id": "stg_…",
  "version": 12,                       // 每次写入 +1，CAS
  "title": "雨夜街角",
  "fps": 24,
  "duration": 8.0,                     // 秒
  "aspect": "16:9",

  "scene": {
    "viggle": { "sessionId": "…", "batchIds": ["…"] },   // 可以继续补图
    "splatUrl": "https://cdn…/scene_v2.spz",
    "panoramaUrl": "https://cdn…/pano.png",
    "placement": { "metersPerUnit": 0.42, "floorY": -1.5 }  // 复用 walk/placement 的测量结果
  },

  "characters": [{
    "id": "chr_a",
    "name": "风衣男",
    "viggleId": "char_…",
    "vsplatUrl": "https://cdn…/char_a.vsplat",
    "transform": { "position": [1.2, 0, -3], "yaw": 180, "scale": 1 },
    "clips": [                          // 时间轴上的动作片段
      { "motionId": "mot_…", "glbUrl": "https://cdn…/walk.glb", "start": 0, "end": 4, "loop": false, "rootMotion": true },
      { "motionId": "mot_…", "glbUrl": "https://cdn…/look_back.glb", "start": 4, "end": 8, "blendIn": 0.3 }
    ]
  }],

  "shots": [{
    "id": "shot_1",
    "name": "推近",
    "keys": [                           // 语义对齐 glTF camera + animation
      { "t": 0, "position": [0, 1.6, 8], "target": [1.2, 1.4, -3], "fov": 40 },
      { "t": 8, "position": [0.8, 1.5, 0], "target": [1.2, 1.5, -3], "fov": 32 }
    ],
    "interpolation": "smooth",          // linear | smooth | step
    "easing": "easeInOut"               // linear | easeIn | easeOut | easeInOut
  }],

  "jobs": [ { "id": "…", "kind": "character", "status": "processing", "credits": null } ],
  "outputs": [ { "shotId": "shot_1", "type": "video", "url": "…", "viggleVideoId": "vid_…" } ]
}
```

设计原则：
- **镜头用 `target`（看向的点）而不是旋转角**：Agent 写 `target` 比写四元数稳定得多。内部统一换算成 world SDK 的 `ScenePose { position, forward }`。
- **坐标统一用米、Y 轴朝上**：场景的 splat 单位不固定，用 `placement.metersPerUnit` 换算。Agent 和用户都只看到"米"。
- **导出 glTF**：shots 转成 glTF 的 camera + animation，可以在 Blender 里打开。

## 7. Agent 设计

模型：Claude（`claude-opus-5-5`），开启工具调用，流式输出。

### 服务端工具（改数据、调 Viggle）

| 工具 | 作用 | 对应的 Viggle API |
|---|---|---|
| `read_stage()` | 读最新的 Stage 文档和版本号 | — |
| `plan(brief)` | 拆解需求，输出计划和预估额度，等用户确认 | — |
| `create_scene(prompt, refImages?)` | 生成场景 | `POST /v1/scenes/pano` |
| `fill_scene_view(pose)` | 对一个视角补图 | `POST /v1/scenes/generate` |
| `create_character(imageUrl)` | 用图生成角色 | `POST /v1/characters` → export `vsplat` |
| `create_motion(text, seconds)` | 文字生成动作 | `POST /v1/motions` → export `glb`（metahuman 骨骼） |
| `list_motions(query)` | 搜动作库和已生成的动作 | `GET /v1/motions` |
| `place_character(id, position, yaw)` | 摆放角色 | — |
| `set_clips(characterId, clips[])` | 设置角色的动作片段 | — |
| `upsert_shot(shot)` | 新建或修改镜头和关键帧 | — |
| `generate_video(shotId, mode, prompt)` | 把渲染结果送去出成片 | Videos（首帧 / 参考视频） |

所有写操作都带上 `baseVersion`，版本对不上就失败，Agent 重新 `read_stage` 后再试。这一点照搬 the reference product 的做法。

### 浏览器端工具（Agent 请求，前端执行）

| 工具 | 作用 |
|---|---|
| `focus(objectId)` | 视角飞到物体 |
| `capture_frame(shotId, t)` | 截一帧给 Agent 看，让它能"看见"构图是否合理 |
| `render_shot(shotId)` | 离线渲染整段镜头为 MP4 |
| `measure_gaps()` | 调 `findGaps`，告诉 Agent 哪里有空洞，需要补图 |

`capture_frame` 是关键：**Agent 能看到自己摆的机位截图**，自己检查构图（角色有没有出画、背后是不是空洞），然后修正。这是 the reference product 没做而我们可以做的。

### 选中引用

用户在视口里选中一个物体后发消息，消息里自动带上 `{ objectId, docVersion }`。"把他往左挪一点"、"镜头再低一点"这类指令就能精确定位。

## 8. 前端：在 world SDK 上要补的东西

| 能力 | world SDK 现状 | 需要做 |
|---|---|---|
| splat 场景渲染、补图、找空洞 | 有（`SceneRenderer`、`findGaps`、`expandScene`） | 直接复用 |
| 地面探测、比例换算 | 有（`walk/placement`、`floorIndex`） | 复用，把角色放到地面上 |
| 太阳光和影子 | 有（`SceneLighting`） | 复用 |
| 单个角色加动作 | 有（`SceneExplorer.setCharacter / playAction`），但是第三人称、只支持一个角色 | **新建 `StageRenderer`**：直接用 engine 的 `Scene` + `Character` + `Animation`，支持多个角色、按时间轴驱动 |
| 时间驱动的播放 | 没有（实时游戏循环） | `StageClock`：播放、暂停、拖动；动作采样跟着时间走，可以倒放 |
| 相机关键帧和插值 | 只有 `flyTo` | `CameraTrack`：位置用样条插值，`target` 单独插值，FOV 线性插值，外加缓动 |
| 物体变换手柄 | 没有 | 平移和旋转手柄（地面上的平移 + 绕 Y 轴旋转就够 MVP） |
| 视频导出 | engine 支持 canvas 回读（`preserveDrawingBuffer`） | 离线逐帧：时钟走固定步长 → 渲染 → `VideoEncoder`（WebCodecs）→ MP4 封装（mp4-muxer） |

`StageRenderer` 建议做成 world SDK 新增的一个入口（比如 `@stage`），这样以后对外也能卖。

## 9. 成本和时间预估（单场戏）

| 项目 | 额度 | 时间 |
|---|---|---|
| 场景（low） | 6 | 约 10 秒（实测） |
| 补图 1 次 | 约 1 | 约 10 秒 |
| 角色 1 个 | 文档没写价格，待确认 | 约 1–2 分钟（文档示例约 78 秒） |
| 文字生成动作 1 段 | 10 | 文档没写，示例最多轮询 5 分钟 |
| 视频生成 1 段 | 待确认 | 待确认 |

**一场一人一段动作，大约 16 额度加上角色和视频的费用**。角色和视频的价格需要查 pricing 页面确认。

Agent 必须在生成前展示预估额度，等用户确认后再花钱，这是 MVP 的硬规则。

## 10. 风险和待验证的问题

1. **角色和场景的比例、光照不一致**：splat 角色放进 splat 场景，可能看起来"贴上去的"。需要验证 `SceneLighting` 的影子和色调是否够用。
2. **动作的根位移（root motion）**：文字生成的"走过来"会不会带位移？位移方向怎么和摆放朝向对齐？要做原型验证。
3. **运动中的角色穿过场景空洞**：远离拍摄点的地方 splat 会糊或空。解决办法：限制可摆放区域，或者让 Agent 用 `measure_gaps` 后自动补图。
4. **离线渲染性能**：大场景加多个角色，逐帧渲染 1080p 的速度。先支持 720p。
5. **视频模型对 splat 预演画面的"润色"效果**：首帧模式和参考视频模式哪个更好，需要做对比实验。
6. **角色价格和生成时长**：影响交互节奏和单场成本。

## 11. 里程碑（建议）

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 技术验证（1 周） | 一个 spz 场景 + 一个 vsplat 角色 + 一段 motion glb，用 engine 同屏播放；相机两点插值；导出 MP4 | 验证第 10 节的风险 1、2、4 |
| M1 手动导演台（2 周） | Stage 文档、时间轴、关键帧、变换手柄、保存；资产手动生成 | 不用 Agent 也能完整做一场戏 |
| M2 Agent（2 周） | 服务端工具、浏览器端工具、选中引用、计划和额度确认 | 一句话出一场戏 |
| M3 成片（1 周） | 接 Viggle 视频生成，对比首帧和参考视频两种模式 | 预演 → 成片的闭环 |

先做 M0：它决定了"Viggle 资产拼成的片场看起来像不像真的"，这是整个方案成立的前提。
