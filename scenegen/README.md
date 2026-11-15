# 场景生成（scenegen）

和导演台解耦的 3D 场景生成模块，打开 `http://localhost:5193/scenegen/`（和导演台同一个 dev server）。生成的场景可以一键导入导演台素材库。

| 入口 | 流程 |
|---|---|
| **文本 / 图片 → 场景** | agent 读懂文字或图片，用白模资产摆出布局 → 自动选拍摄点 → 渲染等距深度图 → GPT-image-2 以深度图为参考画全景图 → JST-2 `custom-pano` 建场景 → 检测缺口，自动补视角（`generate` + `reconstruct`） |
| **视频 → 场景** | 抽帧（去模糊、按重叠度选关键帧）→ COLMAP 估计位姿 → 重力对齐、按相机高 1.5 m 定尺度 → 选出 ≤ 40 张图片 + 位姿 → JST-2 `posed-images`（**接口待开放，目前由内置 mock 代替**） |

方案和调研见 `docs/SCENEGEN_DESIGN.md`、`docs/ATLAS_ANALYSIS.md`。

## 运行

```bash
npm install
npm run dev            # http://localhost:5193/scenegen/
```

`.env.local` 里需要的 key（只在服务端用，不会进页面）：

| key | 用途 | 没有时 |
|---|---|---|
| `VIGGLE_API_KEY` | JST-2：建场景、补缺口 | 不能生成 |
| `OPENAI_API_KEY` | 布局 agent（`OPENAI_MODEL`，默认 gpt-6-luna）和 GPT-image-2 全景图 | agent 不可用；全景图可以改用「JST-2（白模作参考）」 |
| `SCENEGEN_IMAGE_MODEL` | 全景图模型，默认 `gpt-image-2` | — |
| `FAL_KEY` | 可选：FLUX.1 Depth 全景图 | 该选项不可用 |
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
npm run typecheck
```

## 结构

| 位置 | 内容 |
|---|---|
| `core/` | Node 和页面都能跑：白模资产库（`catalog.ts`，36 类参数化形体）、按关系摆放和布局检查（`layout.ts`）、CPU 射线求交（`geometry.ts`）、等距柱状深度 / 语义 / 白模渲染（`render.ts`）、拍摄点搜索（`capture.ts`）、全景 prompt（`caption.ts`）、坐标约定（`frame.ts`）、SPZ 读写、与白模的深度一致性（`align.ts`） |
| `agent/` | 布局 agent：系统提示词、14 个工具、对话循环（在页面里执行工具，服务端只转发模型） |
| `server/` | Vite 中间件（`plugin.ts`）、JST-2 客户端（含 posed-images）、全景图 provider（GPT-image-2 / JST-2 / FLUX）、文本管线（`textScene.ts`）、自动补缺口（`fill.ts`，复用 `src/stage/scenecheck.ts` 的 PINOC 检测）、视频管线（`videoScene.ts`）、posed-images mock |
| `web/` | 页面 |
| `py/` | 视频 → 图片 + 位姿 |

数据在 `.data/scenegen/projects/<id>/`。导出时调用导演台新加的 `POST /api/library/import-scene`，复制 `.spz`、全景图和 `layout.json`。

## 坐标约定（实测，2026-11-15）

- 白模世界：米，+Y 向上，地面 y = 0，-Z 为北。
- **场景文件**：拍摄点在原点，米，+Y 向上，地面在 y = -1.5。这正是导演台对生成场景的假设，所以导入后比例 ≈ 1，导演台的「扩展场景」也能直接用。`layout.json` 的 `sceneFrame.origin` 记录拍摄点在白模世界里的位置。
- JST-2 `custom-pano` 把调用方的世界当作 OpenCV 风格（Y 向下），写文件时翻转 Y、Z。所以发给它的位姿要先翻转（`toServiceC2W`），文件才是 Y 向上。
- `metersPerUnit` 以拍摄点为中心缩放；每张全景的单位不同，所以先从 provider 自己的重建（或一次 mpu=1 的标定调用）量出拍摄点到地面的距离，再用 1.5 / 距离 正式生成。

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
