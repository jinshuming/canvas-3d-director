# 3D Director

一个通用的 3D 导演台（World）。场景（splat）、角色（vsplat）和动作（motion glb）都用 Viggle 生成。可以手动搭戏，也可以用自然语言让 Agent 搭：放角色、编排动作和走位、架机位、设计运镜，最后导出画面和视频。

```bash
npm install
cp .env.example .env.local   # 填上 key，见下文
npm run dev                  # http://localhost:5193/canvas
```

- `.env.local`（已 gitignore）放 key，只在 dev server 的中间件里使用，不会进页面（完整列表见 `.env.example`）：
  - `VIGGLE_API_KEY`：生成场景、角色、动作，也用于场景生成的 JST-2。没有这个 key 时只能用预置素材。
  - `OPENAI_API_KEY`：导演台 Agent，以及场景生成的白模布局和全景图。模型默认 `gpt-6-luna`。
  - `FAL_KEY`：场景生成里的 SAM 3D 物体。没有这个 key 时，场景不带单独的物体。
- 如果访问 OpenAI 需要代理，Node 进程要带上 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY=<你的代理地址>`。
- 场景生成（画布上的「场景生成」「场景重建」节点）的说明见 [scenegen/README.md](scenegen/README.md)。
- 首次启动时，会把 `assets/seed/` 里的「Modern living room」导入素材库。

## 路由

| 路径 | 页面 |
|---|---|
| `/canvas` | 画布，用于演示。左侧 ＋ → World 新建一个 World 节点（同时新建一个 World 工程），点「开始搭建」进入 |
| `/canvas/world` | 所有 World 工程：搜索、打开、复制、删除（移到回收站） |
| `/canvas/world/<id>?node=<节点>` | 3D 导演台，右侧是 Agent 对话面板。左上角「历史」按钮可以把以前的 World 加载到当前节点 |

编辑器里的镜头和剪辑：
- **剪辑轨**：时间轴最上面一行，决定成片在每段时间看哪个镜头。按 ＋ 在播放头切到当前镜头；拖动片段右边缘调整切点；「剪辑」视角按剪辑轨播放，「导出成片」把整条剪辑导出成一个 MP4。Agent 拍了多个镜头后会自己剪（`set_edit`）。
- **扩展场景**：左侧栏的「扩展场景」按钮。「检测场景缺口」（免费，约 1 秒）列出场景里空洞和模糊最明显的几个视角；点一个视角，自由相机飞过去看；觉得有问题点「补全」（约 8 额度，首次；之后每次多 1），Viggle 生成这个视角并重建场景，约 1–3 分钟，完成后点「应用到这个 World」。也可以先把相机摆到想补的位置，点「从当前视角补全」。只有用文字生成的场景能补全，预设和导入的场景只能检测。
- **光影**：工具栏的「光影」按钮。选一个预设（清晨、正午、黄昏、夜晚、阴天），或自己调光的方位、高度、强度、颜色、环境光和影子深浅；角色会站在场景的光里，并在地面上留下影子。「关」回到场景和角色原本的样子。随 World 一起保存，Agent 也能用 `set_lighting` 按「黄昏」「夜晚」这类氛围自己打光。
- **导出成片**：右上角「导出成片」，在弹窗里选画幅、帧率，再二选一：**输出 MP4 · 不渲染**（直接导出预演画面，免费）；**输出 MP4 · 使用 H3 渲染**（把预演视频作为参考交给 Viggle 的 MiniMax H3，生成画面更精致的视频，按秒收额度，预演最长取前 15 秒；渲染在服务端进行，工具栏上会显示「H3 渲染中…」，完成后出现「下载 H3 成片」）。
- **镜头卡片**：选中镜头后，在属性卡片里用按钮取景（单人 / 过肩 / 双人、景别、机位高度、方位），上方显示这个镜头在播放头时刻的白模预览。

新的 World 打开后默认由 Agent 主导：素材库先收起，输入框自动获得焦点，点一下示例卡片就能让 Agent 从零搭出一场戏，Agent 还会给 World 起名。每个 World 是一个工程文件，保存片场、对话和封面，格式见 `docs/WORLD_FORMAT.md`。

## 结构

| 位置 | 内容 |
|---|---|
| `src/stage/` | 片场核心（别名 `@stage`）：<br>- Stage 文档类型，相机关键帧插值，动作片段和走位的时间计算<br>- 景别、角度、方位，以及过肩、双人构图<br>- `StageRenderer`：多角色、由时间轴驱动、拾取、截图、地面和视线检测 |
| `src/stage/tools/` | Agent 工具，共 28 个，分观察、素材、角色、动作、走位、镜头、编辑器几类。说明见 `docs/AGENT_TOOLS.md` |
| `src/engine/probes.ts` | 在 `@viggle/splat-engine` 之上补两个探针：动作片段的根运动位移、身体初始朝向 |
| `src/walk/` | 场景摆放（地面放在 y=0、单位为米）和地面索引 |
| `app/` | 界面：画布、导演台、时间轴、属性卡片、素材库、Agent 面板 |
| `app/server/plugin.ts` | Vite 中间件：<br>- 片场存储，带版本号乐观锁，冲突返回 409<br>- 素材库<br>- Viggle 生成任务：服务端轮询，完成后把文件转存到 `.data/files`<br>- Agent 请求转发到 OpenAI Responses API，流式返回 |
| `app/agent/` | Agent 循环（在页面里执行工具，结果连同截图回传给模型）和对话面板 |
| `eval/` | 评测：在页面里像用户一样发需求，再用程序检查片场。结果见 `eval/REPORT.md` |
| `app/shared/world.ts` | World 工程文件的类型、读取与升级、复制、摘要（测试在 `world.test.ts`） |
| `docs/` | MVP 方案（`MVP.md`）、Agent 工具目录（`AGENT_TOOLS.md`）、World 工程文件格式（`WORLD_FORMAT.md`） |

运行数据都在 `.data/`（已 gitignore）：`worlds/<id>/`（World 工程文件和封面）、`trash/`、`library.json`、`files/`。

## 操作

- **自由相机**：拖动转视角，WASD / QE 移动，滚轮推拉
- **角色**：拖动移动，Shift+拖动旋转，F 聚焦选中的角色
- **镜头**：K 把当前机位记成播放头所在时刻的关键帧；C 在自由相机和镜头视角之间切换
- **播放与撤销**：空格播放，⌘Z / ⇧⌘Z 撤销、重做

## 测试与评测

```bash
npm test            # 片场和工具的单元测试
npm run typecheck
```

页面评测在开发模式下运行。在浏览器控制台里：

```js
await import('/eval/grade.js'); await import('/eval/tasks.js'); await import('/eval/harness.js');
await __eval.run('在现代客厅里拍一段两人对话……');
await __tasks.coverage();
```

## 来历

这个项目从 `viggle-world-sdk` 的 `director-m1` 分支拆出来：
- 片场核心原本是 SDK 里的 `@viggle/scene-sdk/stage`；
- 引擎改用 npm 上公开的 `@viggle/splat-engine@0.3.2`；
- 原来改在引擎里的两个探针，移到了 `src/engine/probes.ts`。
