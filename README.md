# TapNow 3D Director

一个仿 TapNow 3D Studio 的 3D 导演台（World）。场景（splat）、角色（vsplat）和动作（motion glb）都用 Viggle 生成。可以手动搭戏，也可以用自然语言让 Agent 搭：放角色、编排动作和走位、架机位、设计运镜，最后导出画面和视频。

```bash
npm install
cp .env.example .env.local   # 填上 key，见下文
npm run dev                  # http://localhost:5193/canvas
```

- `.env.local`（已 gitignore）放两个 key，都只在 dev server 的中间件里使用，不会进页面：
  - `VIGGLE_API_KEY`：用来生成场景、角色、动作。没有这个 key 时只能用预置素材。
  - `OPENAI_API_KEY`：World Agent 使用，模型默认 `gpt-6-luna`。
- 如果本机访问 OpenAI 需要代理，Node 进程要带上 `NODE_USE_ENV_PROXY=1` 和 `HTTPS_PROXY=http://127.0.0.1:7897`。
- 首次启动时，会把 `assets/seed/` 里的「Modern living room」导入素材库。

## 路由

| 路径 | 页面 |
|---|---|
| `/canvas` | 仿 TapNow 画布，用于演示。左侧 ＋ → World 新建一个世界节点，点「Enter World」进入导演台 |
| `/canvas/world` | 所有 World（片场）的列表 |
| `/canvas/world/<id>` | 3D 导演台，右侧是 Agent 对话面板 |

## 结构

| 位置 | 内容 |
|---|---|
| `src/stage/` | 片场核心（别名 `@stage`）：<br>- Stage 文档类型，相机关键帧插值，动作片段和走位的时间计算<br>- 景别、角度、方位，以及过肩、双人构图<br>- `StageRenderer`：多角色、由时间轴驱动、拾取、截图、地面和视线检测 |
| `src/stage/tools/` | Agent 工具，共 27 个，分观察、素材、角色、动作、走位、镜头、编辑器几类。说明见 `docs/AGENT_TOOLS.md` |
| `src/engine/probes.ts` | 在 `@viggle/splat-engine` 之上补两个探针：动作片段的根运动位移、身体初始朝向 |
| `src/walk/` | 场景摆放（地面放在 y=0、单位为米）和地面索引 |
| `app/` | 界面：画布、导演台、时间轴、属性卡片、素材库、Agent 面板 |
| `app/server/plugin.ts` | Vite 中间件：<br>- 片场存储，带版本号乐观锁，冲突返回 409<br>- 素材库<br>- Viggle 生成任务：服务端轮询，完成后把文件转存到 `.data/files`<br>- Agent 请求转发到 OpenAI Responses API，流式返回 |
| `app/agent/` | Agent 循环（在页面里执行工具，结果连同截图回传给模型）和对话面板 |
| `eval/` | 评测：在页面里像用户一样发需求，再用程序检查片场。结果见 `eval/REPORT.md` |
| `docs/` | MVP 方案（`MVP.md`）、Agent 工具目录（`AGENT_TOOLS.md`） |

运行数据都在 `.data/`（已 gitignore）：`stages/*.json`、`library.json`、`files/`。

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
