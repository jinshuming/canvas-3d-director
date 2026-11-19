# AGENTS.md — read this first

Two products share one Vite dev server (`npm run dev`, port 5193):

1. **`scenegen/` — scene generation (the part most readers want).** Text and/or a reference picture →
   3D blockout → GPT-image-2 panorama → 3D Gaussian-splat scene (`scene.spz`), with separate SAM 3D objects.
   **Start at [`scenegen/PIPELINE.md`](scenegen/PIPELINE.md)**, then `server/textScene.ts` (`textToScene`).
2. **The 3D director (`app/`, `src/`)** — a canvas of "World" nodes and a stage editor where characters,
   motions and cameras are arranged, by hand or by an agent. Scene generation hands scenes to it
   (`POST /scenegen/api/projects/:id/export`). You can ignore it for scene-generation work.

## Commands

```bash
npm install
cp .env.example .env.local        # OPENAI_API_KEY, VIGGLE_API_KEY, FAL_KEY; see scenegen/PIPELINE.md "Keys"
npm run dev                       # http://localhost:5193/canvas (product UI), /scenegen/ (batch test page)
npm run typecheck                 # tsc --noEmit over src, app, scenegen
npm test                          # tsx --test, ~10 s, needs no keys and no network
npx tsx scenegen/eval/generate.mts --text "..." --out out/x    # headless text/picture → scene (spends credits)
npm run test:video                # Python video pipeline (needs scenegen/py/.venv)
```

Node ≥ 22. Behind a proxy start with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<url>` (Node `fetch` ignores proxies
otherwise). Runtime data is in `.data/` (gitignored). `.env.local` is gitignored and read only by the dev
server middleware — keys never reach the page.

## Map

| Path | What | Entry point |
|---|---|---|
| `scenegen/core/` | Pure TS (Node + browser): layout model, blockout assets, ray caster, equirect renders, capture-point search, SPZ/PLY I/O, SAM 3D object placement | `types.ts` (Layout), `frame.ts` (coordinates) |
| `scenegen/server/` | Dev-server middleware + the generation pipeline (JST-2, GPT-image, SAM 3D, gap fill) | `plugin.ts` (HTTP API), `textScene.ts` (pipeline) |
| `scenegen/agent/` | Layout agent: edits the blockout by conversation (tools run in the page, the server only relays the model) | `tools.ts`, `prompt.ts`, `loop.ts` |
| `scenegen/web/` | `/scenegen/` test page and the shared project API client | `api.ts`, `runner.ts` |
| `scenegen/py/` | Python: video → COLMAP poses; panorama/blockout alignment scorer | `panoalign.py`, `videoscene/run.py` |
| `scenegen/eval/` | Scripts: headless generate, e2e, panorama A/B, re-place, top-down | `generate.mts` |
| `app/canvas/` | The canvas UI incl. 场景生成 / 场景重建 nodes and the full-screen scene editor | `SceneNodes.tsx`, `SceneEditor.tsx` |
| `app/server/` | Director's middleware (worlds, library, Viggle jobs) and the shared OpenAI relay | `plugin.ts`, `openaiRelay.ts` |
| `app/` (rest), `src/stage/`, `src/walk/`, `src/engine/` | Director editor, stage core (`@stage`), floor/placement, engine probes | see `README.md` |
| `docs/` | Design notes: `SCENEGEN_DESIGN.md` (why, with measurements), `AGENT_TOOLS.md`, `WORLD_FORMAT.md`, `MVP.md` | |

Each `scenegen/` subfolder has a `README.md` listing its files and what each is for.

## Conventions

- **TypeScript with `.ts` import extensions**, ES modules, no build step for `scenegen/server` and `core` — Node
  runs them through `tsx`, Vite loads the middleware directly. Keep the layout/geometry files of `core/` free of Node-only
  imports (they run in the page too); only the splat file I/O is server-only.
- **Every module starts with a header comment** saying what it does and why; keep that true when you change it.
- **Coordinates**: metres, +Y up, floor y = 0, -Z north (blockout world); scene files have the capture point at
  the origin with the floor at y = -1.5. JST-2 wants OpenCV axes — always go through `toServiceC2W`. See
  `scenegen/PIPELINE.md` "Coordinate frames".
- **Everything external is injected** (`Jst2Client`, `PanoProvider`, `Sam3dFn`, `PeopleCheck`, `fetch`), so
  pipeline pieces are testable with fakes. Follow that when adding a service.
- **Generation steps are measured, not guessed.** Comments cite the measurement behind a rule
  (e.g. why the panorama is painted from depth and not from the user's picture). Do not "simplify" such a rule
  without re-measuring (`eval/panoab.mts` for panoramas).
- Tests sit next to the code as `*.test.ts`; `npm test` globs `src`, `app`, `scenegen`.
- Paid calls (OpenAI image, JST-2 credits, fal SAM 3D) happen only in `eval/generate.mts`, `eval/e2e.mts`,
  `eval/panoab.mts` and through the running app. Unit tests never spend credits.

## Gotchas

- The dev server caches projects in memory (`plugin.ts` `cache`); after editing `.data/scenegen/projects/*` by
  script (e.g. `eval/replace.mts`) restart it.
- Only one job runs per project (`409` otherwise); a job that was running when the server stopped is shown failed.
- `posed-images` (video route) is served by a **mock** until `SCENEGEN_POSED_IMAGES_BASE` is set; the mock returns
  a COLMAP point-cloud preview, not a real reconstruction.
- JST-2 sessions stay in their own units (`sessionInUnits`, `metersPerUnit`): poses sent to a session are divided by
  the scale, scene files are in metres.
