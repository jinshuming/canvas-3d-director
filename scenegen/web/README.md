# scenegen/web — the `/scenegen/` test page and shared client code

The product UI for scene generation lives in `app/canvas/` (the 场景生成 node and the full-screen scene editor).
This folder is the **batch test page** (`/scenegen/`: pick a project, see input → blockout → panorama candidates →
3D scene → metrics) plus code the canvas reuses.

| File | Responsibility |
|---|---|
| `api.ts` | **Project API client** (`api.create / quickLayout / generate / get / expand / export …`) used by the page, the canvas, and the Node scripts in `eval/` (they patch `fetch` to resolve page-relative URLs) |
| `runner.ts` | `generateScene` (picture/video upload → quick layout → generate), `reconstructScene`, `watchProject` (poll a job), `STAGE_LABEL` (stage → UI label) |
| `agentHost.ts` | Connects the layout agent's tools to a project's API (shared by three callers) |
| `SplatViewer.tsx` | Loads `environment.spz` + objects with `@viggle/splat-engine` (same engine as the director); layered, with deadline and retry |
| `Viewport.tsx` | three.js view of the blockout: room outlines, object solids, capture point |
| `TextProject.tsx`, `VideoProject.tsx` | The two project pages of the test UI |
| `main.tsx`, `styles.css`, `../index.html` | Page shell |
