# World 工程文件

画布上的每个 World 节点对应一个 World 工程文件。一个 World 工程文件包含三部分：
- 片场：场景、角色、动作、走位、镜头；
- 搭建它的 Agent 对话；
- 一张封面。

类型和读写函数在 `app/shared/world.ts`，测试在 `app/shared/world.test.ts`。

## 磁盘布局

```
.data/
  worlds/<id>/world.json   工程文件
  worlds/<id>/cover.jpg    封面（编辑器自动截取）
  trash/<id>-<时间戳>/      删除的 World（整个文件夹移过来，可手动找回）
  files/                   素材库文件（场景 spz、角色 vsplat、动作 glb），World 通过 URL 引用
  library.json             素材库与生成任务
```

素材不复制进 World 的文件夹，World 只通过 URL 引用 `/files/...`。好处是多个 World 共用同一个场景时不会重复占用空间；代价是 World 文件夹不能单独拷走使用。

## world.json

```jsonc
{
  "format": "director.world",     // 格式标记：不是这个值的文件会被拒绝读取
  "schema": 1,                  // 结构版本：比代码支持的版本还新时，拒绝读取
  "id": "wld_…",                // 和 stage.id 相同；由旧片场迁移来的 World 保留原来的 stg_… id
  "title": "客厅里的两人对话",
  "createdAt": "…", "updatedAt": "…",   // 片场、对话、标题、封面，任何一项写入都会更新 updatedAt
  "origin": { "kind": "blank" }          // 也可能是 { kind: "copy", from, fromTitle } 或 { kind: "stage", from }
  "cover": { "file": "cover.jpg", "updatedAt": "…" } | null,
  "stage": { /* StageDoc：src/stage/types.ts */ },
  "chat": {
    "previousResponseId": "resp_…" | null,   // 下一轮对话接在哪个模型回复之后（OpenAI Responses 的 previous_response_id）
    "items": [ /* user / assistant / tool / confirm / error */ ],
    "updatedAt": "…"
  }
}
```

### 设计取舍

- **片场沿用 `StageDoc`**：片场核心、渲染器和 Agent 工具都以 StageDoc 为准，World 只在它外面再包一层。`stage.title` 和 World 的 `title` 保持同步：编辑器里改的是片场标题，服务端保存片场时把它同步给 World。
- **分块写入，一个文件**：
  - 片场每次编辑都会保存，带乐观锁：编辑器提交时附上自己基于的 `stage.version`，与服务端当前版本不一致就返回 409 冲突。
  - 对话在每轮之后（以及进行中每隔几秒）保存。
  - 标题和封面单独保存。
  - 服务端对同一个 World 的写入逐个排队执行：读出文件、改动其中一块、整个文件原子写回。所以这几类写入之间不会互相覆盖。
- **对话只存文字**：
  - 工具调用的截图不存，因为体积大，而且模型已经看过了。
  - 不存没回答的确认卡：重新打开后已经无法回答。
  - 中断的工具调用记为失败。
  - 这些处理由 `storableChat` 完成。
- **复制**：生成一个新 id 和一份片场副本，带上原来的封面；对话从头开始，因为模型的上下文属于原来那个 World。
- **兼容旧数据**：
  - 服务端启动时，把旧的 `.data/stages/*.json` 迁移成 World，并保留原 id，所以画布上已有的节点和链接仍然有效。迁移完成后，旧文件夹改名为 `stages-migrated-<时间戳>` 保留。
  - 浏览器 localStorage 里旧版保存的对话，在第一次打开对应 World 时自动并入工程文件。
  - `readWorld` 负责补齐旧版本缺少的字段。schema 升级时只需要修改这一个函数。

## API

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/api/worlds` | 所有 World 的摘要，按最近修改排序：标题、封面、场景名、角色数、镜头数、对话轮数、最后一句需求、来源 |
| POST | `/api/worlds` | 新建空 World；传 `{copyOf: id}` 时复制一个已有的 World |
| GET | `/api/worlds/:id` | 读取整个工程文件 |
| PATCH | `/api/worlds/:id` | 改名 `{title}` |
| DELETE | `/api/worlds/:id` | 移到回收站 |
| GET / PUT | `/api/worlds/:id/stage` | 读取或保存片场；PUT 的请求体是 `{baseVersion, doc}`，版本冲突时返回 409，并带上服务端的最新版本 |
| PUT | `/api/worlds/:id/chat` | 保存对话 `{chat}` |
| GET / PUT | `/api/worlds/:id/cover` | 读取封面，或上传封面 `{dataUrl}`（JPEG，最大 2 MB） |

## 画布与编辑器

- **画布节点**：节点上存 `worldId`（画布的数据存在浏览器里）。新建 World 节点时，会同时新建一个 World 工程。
- **进入编辑器**：地址是 `/canvas/world/<id>?node=<节点 id>`，编辑器由此知道自己是从哪个节点进来的。
- **历史 World**：在编辑器左上角打开历史抽屉，点「加载」后：
  - 当前节点改为指向选中的 World，回到画布时节点显示的就是它；
  - 原来那个 World 仍然保留在历史里。
- **复制**：以选中的 World 为起点新建一个 World，加载到当前节点。
- **封面**：编辑器在片场有改动、并且停下来几秒之后截取一张封面。规则：
  - 只在片场比上一张封面新的时候才截，所以打开一个 World 不会覆盖它的封面；
  - 有镜头的 World 只在「镜头视角」下截取；Agent 每轮结束时会预览主镜头，那一帧正好用作封面；
  - 场景加载后会先淡入，封面要等淡入结束再截。
