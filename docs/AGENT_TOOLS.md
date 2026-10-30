# 3D 导演台的 Agent 工具

把导演台的全部编辑能力做成 Agent 可以调用的工具：选角、站位、编排动作、走位、架机位、设计运镜，再加上一组"看"的工具，让 Agent 能检查自己的结果、自我修正。

- **代码**：`src/stage/tools/`（别名 `@stage`）
- **测试**：`src/stage/tools/tools.test.ts`
- **导演台接入**：`app/agentHost.ts`、右侧栏的「Agent 工具台」

## 设计

| 原则 | 做法 |
|---|---|
| 唯一数据源 | 所有工具都只改 Stage 文档（JSON），一次调用就是一步撤销。人和 Agent 改的是同一份，互相可见 |
| 用电影语言，不用坐标 | `frame_shot` / `camera_move` 收的是景别、角度、方位，比如"中景、低角度、左前四分之三"，由 `framing.ts` 换算成相机位置。坐标也收，用 `set_camera_keys` |
| 先看再说完成 | 每次编辑后都能用 `look` / `contact_sheet` 看画面，用 `check_framing` 拿数字（入画比例、头在不在画面里、视线有没有被挡、相机有没有出场景），发现问题自己改 |
| 错误可读 | 工具从不抛异常。调用写错了，会返回 `is_error` 和可以改正的信息，比如"没有这个角色，场上有：…" |
| 花钱要确认 | 每个工具标了 `effect`：`read` 只读、`edit` 改片场、`cost` 扣额度（先问用户）、`ui` 操作界面 |
| 宿主无关 | 工具只依赖 `StageToolHost`：读写文档、渲染器、素材库、界面钩子。浏览器里跑全部工具；服务端 agent loop 可以把"看"的工具转发给页面执行（the reference product 叫 client tools），编辑工具是纯函数，在哪都能跑 |

返回格式就是 Messages API 的 `tool_result` 内容：文字加 base64 JPEG。把 `stageToolDefinitions()` 直接作为 `tools` 传给模型，用 `runStageTool(name, input, host)` 执行。

## 工具清单（28 个）

### 观察世界（只读）
| 工具 | 用途 |
|---|---|
| `get_stage` | 片场全貌（JSON）。传 `time` 时，附带每个角色在那一刻的位置和朝向 |
| `get_world_layout` | 地面俯视网格：`.` 表示地面，`#` 表示墙、家具、空洞；角色用首字母标在格子上。用于判断能站在哪、能往哪走 |
| `look` | 渲染一张图给 Agent 看。视角可选：镜头视角、任意相机、俯视（从天花板下往下看）、角色第一人称、用户当前视口。画面里标出角色名字，并附带构图数据 |
| `check_framing` | 不出图，只给数字：每个时间点各角色的画面框、可见比例、被哪条边裁、头是否在画面内、视线是否被挡（clear / partly_blocked / blocked）、相机是否还在场景地面上方 |
| `contact_sheet` | 一个镜头的若干帧拼成一张联系表，用来整体判断一段运镜 |
| `probe_floor` | 查询几个点有没有地面 |

### 素材
| 工具 | 用途 |
|---|---|
| `list_assets` | 场景、角色、动作，包括 Viggle 预置和本项目生成的 |
| `generate_asset` | **扣额度**：生成场景（6）、角色（30）、动作（10） |
| `check_jobs` | 生成任务状态，完成后给出素材 id |

### 片场
| 工具 | 用途 |
|---|---|
| `set_scene` | 换场景，首次加载会自动测量地面和比例 |
| `set_timeline` | 时长、帧率、画幅 |

### 角色
| 工具 | 用途 |
|---|---|
| `add_character` | 选角入场。位置可以给坐标，也可以相对某人或某物（`near` + 距离 + 方位）；朝向可以给角度，也可以面向某个角色、某个点或镜头 |
| `update_character` | 改初始位置、朝向、身高、名字 |
| `remove_character` | 移除角色 |

### 动作编排
| 工具 | 用途 |
|---|---|
| `set_motion_sequence` | 一个角色按顺序做的一串动作，每段可以设间隔、时长、循环、是否跟随位移。这是"编排播放顺序"的主要工具 |
| `add_motion` | 加一段动作（某个时间点，或接在最后） |
| `edit_motion_clip` | 改时间、循环、根位移开关，或删除 |

### 走位（移动轨迹）
| 工具 | 用途 |
|---|---|
| `move_character` | 从当前位置经过途经点走到终点（也可以 `toward` 走到某人面前，停在指定距离）。参数包括开始时间、时长（或按步态推算：走 1.3 m/s，跑 3.4 m/s）、缓动、到达后面向谁。会自动在下面铺一段原地走或跑的动作，脚步和位移对得上。终点没有地面时给出警告；和已有走位时间重叠时拒绝执行 |
| `clear_moves` | 清除走位 |

### 相机
| 工具 | 用途 |
|---|---|
| `add_shot` | 新建镜头 |
| `frame_shot` | 用景别、角度、方位、焦距、偏移（三分法）在某个时刻架一个机位，会跟随主体当时的位置 |
| `frame_shot` 双人构图 | `framing: "over_shoulder"` + `with`：从 `with` 的肩后拍 `subject`，机位和长焦镜头自动算；`framing: "two_shot"`：两人同框，镜头太远时自动换广角而不是退出房间。同一对人的所有镜头自动站在轴线同一侧（180° 规则），`line_side: "other_side"` 整体换边 |
| `camera_move` | 预设运镜：static 固定、push_in 推、pull_out 拉、orbit 环绕、crane_up / crane_down 升降、pan 摇、track 跟拍（跟随移动中的角色，保持构图）。也收双人构图（orbit 只能配 two_shot） |
| `set_camera_keys` | 精确控制：自己给关键帧，`target` 可以写坐标，也可以 `look_at` 一个角色 |
| `edit_shot` | 改名、改关键帧连接方式（平滑 / 线性 / 硬切）、时间缓动，删除关键帧，删除镜头 |
| `set_edit` | 剪辑：按顺序给出 `{shot_id, start}`，每个镜头一直播到下一个镜头开始，最后一个播到 `end`。所有镜头拍的是同一场表演、共用一条时钟，所以切换只是换机位。`clear: true` 清空剪辑；`preview` / `export_shot` 传 `edit: true` 可以预览、导出整条成片 |

### 界面
| 工具 | 用途 |
|---|---|
| `preview` | 把视口切到某个镜头、移动播放头、开始播放，让用户马上看到 |
| `undo` | 撤销 |
| `export_shot` | 导出 MP4 或 PNG |

## 一个完整的例子（已在浏览器里实测）

需求：*现代客厅里，Frodo 从窗边走过来，停下面向镜头挥手；镜头跟拍，然后推到中近景。*

```text
set_scene        {scene: "Modern living room"}
get_world_layout {radius: 5}                      → 看出茶几挡在正前方，左侧窗边有空地
add_character    {asset: "Frodo", position: [-2.5,-3.5], face: [-1.5,-1.5]}
move_character   {character: "Frodo", start: 0.5, waypoints: [[-1.5,-1.5],[0.5,-1.5]], end_face: [0,0]}
                                                   → 4.24 m，0.5–3.76 s，自动铺了 Walk
add_motion       {character: "Frodo", motion: "Wave", start: 3.96}
add_shot         {name: "跟拍推近"}
camera_move      {kind: "track", subject: "Frodo", size: "full", side: "three_quarter_left", start: 0.5, end: 3.76}
check_framing    → 14 帧里有 8 帧 line_of_sight 不是 clear（被植物、扶手椅挡住，或者相机钻进了墙）
camera_move      {..., size: "medium_full"}       → 换成更近的跟拍；check_framing 显示只剩 1 帧
camera_move      {kind: "push_in", size: "full", to_size: "medium_close", side: "front", start: 3.96, end: 6.36}
contact_sheet    {frames: 6}                      → 走路、转身、挥手、中近景，没有遮挡
```

## 接 Agent（M2）还需要做的

1. **服务端 agent loop**：Claude 加上 `stageToolDefinitions()`。`effect: 'cost'` 的工具先暂停，等用户确认。
2. **转发"看"的工具**：`look` / `contact_sheet` / `check_framing` / `get_world_layout` / `probe_floor` 需要渲染器，由服务端转发给页面执行（`client_tool_request`）后再回传结果。
3. **选中引用**：用户选中角色或镜头后发消息时，消息里带上它的 id。
4. **建议的系统提示要点**：
   - 先 `get_stage` + `get_world_layout`。
   - 每次布置完先 `check_framing` 或 `contact_sheet` 自检，再告诉用户完成了。
   - 生成素材前先报价。
   - 只在 `get_world_layout` 显示有地面的地方站位和走位。

## 已知局限

- 视线遮挡检测基于场景点云抽样，阈值是在一个客厅场景上标定的，其他场景可能需要调整。
- `get_world_layout` 的地面判断会把地毯上的小物件也当成障碍。
- 根位移（动作自带的位移）和走位叠加时，按当前朝向近似合成。
- 角色之间的交互（拥抱、递东西）和避让还没有做。
