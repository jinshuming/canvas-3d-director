# The scene-generation pipeline: text / picture → blockout → panorama → 3DGS

This is the module to read first. It turns a **text description and/or a reference picture** into a
**3D Gaussian-splat scene** (`scene.spz`, metres, floor known) in five stages. Everything lives in
`scenegen/`; the only outside dependencies are `app/server/openaiRelay.ts` (agent streaming) and
`src/stage/scenecheck.ts` (gap detection, shared with the director).

```
 text / picture
      │  ① quick layout        server/quickLayout.ts      1 structured GPT call → Layout (blockout)
      ▼
 Layout (core/types.ts) ── the single source of truth: room, openings, objects, style, capture point
      │  ② conditions          core/{capture,render,caption}.ts   capture point + equirect depth/semantic/clay renders + prompt
      ▼
 depth.png / semantic.png / shaded.png + prompt.txt
      │  ③ panorama            server/{pano,alignScore}.ts        GPT-image-2 paints a 2:1 panorama, best-of-N by alignment
      ▼
 panorama.png
      │  ④ environment (JST-2) server/{textScene,fill,jst2}.ts    custom-pano → .spz, scaled to metres, gaps filled   ┐ in
      │  ⑤ objects (SAM 3D)    server/{objects,seatScene}.ts      crop → paint → SAM 3D → place in the environment   ┘ parallel
      ▼
 environment.spz + objects/<id>-sam.spz  →  composeScene()  →  scene.spz
```

The orchestrator is **`textToScene()` in `server/textScene.ts`** (≈400 lines, readable top to bottom,
with a stage list in its header). Read it before anything else.

## Run it

```bash
npm install
cp .env.example .env.local     # OPENAI_API_KEY, VIGGLE_API_KEY, FAL_KEY (see "Keys")
npm run dev                    # http://localhost:5193  (/canvas = product UI, /scenegen/ = batch test page)

# headless, same calls the canvas node makes:
npx tsx scenegen/eval/generate.mts --text "A Nordic living room ..." --out out/room
npx tsx scenegen/eval/generate.mts --image ref.jpg --text "build this place" --out out/room
npx tsx scenegen/eval/generate.mts --text "..." --stop-after layout --out out/room   # blockout only, ~1 model call
```

Behind a proxy, start the server with `NODE_USE_ENV_PROXY=1 HTTPS_PROXY=<url>` (Node's `fetch` ignores
proxies otherwise; `.claude/launch.json` does this for the in-app preview).

## Stages in detail

| # | Stage | Code | In → out | Notes an agent should know |
|---|---|---|---|---|
| ① | **Quick layout** | `quickLayout.ts` `requestSpec` → `buildLayout` | text (+ picture or video keyframes) → `Layout` | One strict-JSON model call returns room, openings, objects with *relations* ("against north wall", "in front of sofa"), style, `key` flags. Placement is then **deterministic** (`core/layout.ts` `placeObject`), overlaps pushed apart (`separate`), capture point searched. A picture is sent to the model as an image; it is **not** sent to the panorama painter (see ③). Editing the blockout afterwards is the layout agent's job (`agent/`). |
| ② | **Conditions** | `textScene.ts` `renderConditions`; `core/capture.ts` `findCapturePoint`; `core/render.ts`; `core/caption.ts` | `Layout` → capture pose, `depth.png`, `semantic.png`, `shaded.png`, caption | CPU equirect renders (2048×1024) of the blockout from the capture point. The capture point is searched so the key objects are visible and not occluded (JST-2 rebuilds from **one** viewpoint; whatever it cannot see becomes a hole). |
| ③ | **Panorama** | `textScene.ts` (the candidate loop), `pano.ts` `openaiImageProvider`, `alignScore.ts` + `py/panoalign.py` | conditions → `panorama.png` | Painted **from depth + clay render, not from the user's picture**: measured, with the picture GPT-image-2 copies its composition and ignores the blockout (alignment 0.05–0.08 vs 0.55–0.64). The picture's *look* reaches the model through the style text. **On demand**: paint 1; if alignment with the blockout ≥ 0.8 (`GOOD_ENOUGH`) and no life-size person (`peopleCheck`), keep it; else paint 2 more, keep the best clean one; up to 5. Other providers: `jst2-reference`, `fal-flux-depth`. |
| ④ | **Environment** | `textScene.ts`, `jst2.ts` `customPano`, `fill.ts` `autoFill`, `metersPerUnitFromFloor` | panorama → `environment.spz` | Built **once at 1 unit = 1**; the camera is `EYE_HEIGHT` (1.5 m) above the floor, so measuring the floor distance gives `metersPerUnit`, and the file is scaled to metres. The JST-2 *session* stays in its own units (`sessionInUnits: true`): poses sent to it are divided by `metersPerUnit`. Gaps (holes/blur seen from other views, via `src/stage/scenecheck.ts`) get generated views and a rebuild, `maxFills` default `auto` (1–3 views by room area, `fillBudget`; the API clamps explicit values to 0–4). |
| ⑤ | **Objects** | `objects.ts` `planObjects` / `generateObjects` / `sam3d`, `pano.ts` `paintObject`, `core/place.ts`, `core/seat.ts`, `seatScene.ts` `placeScene` | blockout + panorama → `objects/<id>-sam.spz`, placed into `scene.spz` | Free-standing objects (≤ 12) get their own SAM 3D asset; wall-backed ones are painted into the panorama and become part of the environment. **The environment panorama is painted from the blockout *without* the SAM 3D objects** (and a caption that names none of them), otherwise the model paints them back in. Each object is then painted into a perspective crop of the panorama, SAM 3D runs on the crop with the painted box as prompt. **Placement is a search** (`place.ts`: clean → stand up → level ±20° → square with the box → size → seat on the real floor → keep out of walls/other objects) run from the raw `-sam.spz` every time the scene is composed, so recomposing never compounds a move. |
| — | **Compose + verify** | `textScene.ts` `composeScene`, `verifyAlignment`; `core/align.ts` | environment + placed objects → `scene.spz` | `alignment` in `result.json` = share of directions within 25 % of the blockout depth, and the floor height. |

Video input has two other routes (`videoScene.ts` + `py/videoscene/` for COLMAP poses; `videoGen.ts`
for the default "generate" route) — out of scope for the image/text focus; see `README.md`.

## Where the data goes

```
.data/scenegen/projects/<id>/            (gitignored; <id> like sgmwhxeone96b4)
  project.json        Project: {layout, chat, reference, result, job, lighting, exported}
  reference.<ext>     the user's picture, if any
  preview/            conditions rendered for the page (not used by generation)
  out/                one generation's files
    layout.json         final Layout + sceneFrame.origin (the capture point)
    depth.png semantic.png shaded.png   conditions of the ENVIRONMENT blockout (objects removed)
    blockout-full/      conditions of the full blockout (guide for painting objects)
    prompt.txt          the panorama prompt actually sent
    candidates/cand-*.png  every panorama painted
    panorama.png        the one kept
    environment.spz     JST-2 environment, metres
    objects/<id>-sam.spz   raw SAM 3D object (source of truth for placement)
    objects/<id>.spz       the same, placed in the scene
    objects/<id>-env.jpg / <id>.png   the crop before / after painting the object
    scene.spz           environment + placed objects, THE OUTPUT
    result.json         TextSceneResult (textScene.ts): scale, alignment, objects, credits, seconds, candidates
```

`result.json` is typed by `TextSceneResult` in `server/textScene.ts`; `project.json` by `Project` in
`server/plugin.ts`. A project's HTTP surface is listed at the top of `server/plugin.ts`.

## Coordinate frames (get these wrong and nothing lines up)

- **Blockout world**: metres, +Y up, floor y = 0, -Z north, +X east. Camera `yaw` degrees clockwise from
  above, 0 = north. Defined in `core/frame.ts`.
- **Scene file** (`scene.spz`, `environment.spz`): the capture point is the origin, metres, +Y up, floor at
  y = -1.5. `layout.json.sceneFrame.origin` says where that point is in blockout world.
- **JST-2 wire format** is OpenCV-style (Y down): every pose goes through `toServiceC2W` (`core/frame.ts`).
- **Director stage** (when exporting): capture point at x = z = 0, floor y = 0, `sessionInUnits` scenes divided
  back by `metersPerUnit` (`exportFiles` in `plugin.ts`).

## Keys (`.env.local`, read by the dev server only — never sent to the page)

| Key | Used for | Missing → |
|---|---|---|
| `OPENAI_API_KEY` (+ `OPENAI_MODEL`, `OPENAI_BASE_URL`) | quick layout, layout agent, people check, panorama and object painting (`SCENEGEN_IMAGE_MODEL`, default `gpt-image-2`) | no text/picture input at all |
| `VIGGLE_API_KEY` (+ `VIGGLE_API_BASE_URL`) | JST-2 `custom-pano`, gap fill, expansion | cannot build a scene |
| `FAL_KEY` | SAM 3D objects; optional FLUX depth panorama | no separate objects (everything is one environment splat) |
| `SCENEGEN_POSED_IMAGES_BASE` | real JST-2 `posed-images` for the video route | built-in mock |

## Where to change what

| I want to… | Edit |
|---|---|
| change what the model is asked to lay out | `QUICK_INSTRUCTIONS` / `LAYOUT_SCHEMA` in `quickLayout.ts` |
| add a blockout shape | `core/catalog.ts` (parametric boxes/cylinders; add an alias in the same file) |
| change how objects are positioned from relations | `core/layout.ts` `placeObject` |
| change capture-point choice | `core/capture.ts` |
| change the panorama prompt | `core/caption.ts` (caption) and `pano.ts` `depthPrompt` (instructions) |
| change when to repaint / accept a panorama | the candidate loop in `textScene.ts`, `GOOD_ENOUGH` |
| swap the panorama model | add a `PanoProvider` in `pano.ts`, register it in `server/plugin.ts` (`providers`) |
| change which objects become SAM 3D assets | `planObjects` / `wallBacked` in `objects.ts` |
| fix an object standing wrong | `core/place.ts` (search), `core/seat.ts` (floor contact); re-run existing scenes with `eval/replace.mts` (no credits) |
| change gap detection / fill | `fill.ts`, `src/stage/scenecheck.ts` |
| add an HTTP route | `server/plugin.ts` `route()` + `web/api.ts` client method |

## Tests and tools

```bash
npm test               # all TS tests (core geometry/placement, server pipeline with mocked JST-2/SAM 3D/OpenAI)
npm run typecheck
npx tsx scenegen/eval/replace.mts <project-id>   # re-place objects of a finished scene with the current algorithm (free; restart the dev server after)
npx tsx scenegen/eval/topdown.mts <outDir> <png>  # top-down picture: objects vs blockout boxes (free)
npx tsx scenegen/eval/panoab.mts <out> <projectId:label> ...   # compare panorama painting modes (GPT-image calls only)
npx tsx scenegen/eval/e2e.mts <out> [case]       # full real runs (spends credits)
```

What the tests cover: `core/*.test.ts` (frames, layout relations, ray caster, renders, capture point, SPZ,
alignment, placement and seating of SAM 3D objects on synthetic splats) and `server/server.test.ts` (agent tools
and loop, the GPT-image provider's resizing, gap-view poses, `planObjects`, `paintedBox`, the posed-images mock).
**There is no credit-free end-to-end test of `textToScene` itself** — `eval/generate.mts` / `eval/e2e.mts`
against real services are the end-to-end check. If you change the orchestration, run `generate.mts` once.

Design history and measurements behind these choices: `docs/SCENEGEN_DESIGN.md`.
