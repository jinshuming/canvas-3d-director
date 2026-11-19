# scenegen/server — HTTP API and the generation pipeline

Loaded by Vite as middleware (`vite.config.ts` → `scenegenServer(...)`), so there is no separate process:
`npm run dev` serves `/scenegen/api/*` and `/scenegen/files/*`.

## The text / picture → scene pipeline (read in this order)

| File | Responsibility |
|---|---|
| `plugin.ts` | **HTTP API** (route list in its header), project storage (`.data/scenegen/projects/<id>/project.json`), one job per project, export to the director |
| `quickLayout.ts` | ① One strict-JSON GPT call → `LayoutSpec` → deterministic `Layout` (`requestSpec`, `buildLayout`) |
| `textScene.ts` | **The orchestrator `textToScene`**: ② conditions → ③ panorama candidates → ④ environment ∥ ⑤ objects → compose → verify. Also `composeScene`, `retryObjects`, `renderConditions` |
| `pano.ts` | Panorama providers (`openai-image` default, `jst2-reference`, `fal-flux-depth`); `peopleCheck`; `paintObject` (paint one object into a crop) |
| `alignScore.ts` | Scores candidate panoramas against the blockout via `py/panoalign.py` (null without the Python env: first clean candidate wins) |
| `jst2.ts` | JST-2 (Viggle Scene API) client: `customPano`, `generate`, `reconstruct`, task polling, `posedImages` |
| `fill.ts` | Automatic gap fill: find the worst views, have JST-2 generate them, rebuild; `metersPerUnitFromFloor`, `fillBudget` |
| `objects.ts` | ⑤ `planObjects` (which objects get SAM 3D), `cropFor`/`cropPanorama`, `generateObjects`, `sam3d` (fal) |
| `seatScene.ts` | `placeScene`: runs `core/place.ts` + `core/seat.ts` on the environment's real floor collider |
| `expand.ts` | Scene editor "Expand from here": generate the view at the user's camera, rebuild, recompose |

## Video routes (not part of the text/picture focus)

`videoScene.ts` (Python poses → scene), `videoGen.ts` (default: anchor panorama from real frames + JST-2 generate),
`keyframes.ts` (ffmpeg keyframes, also used to read a picture-sequence layout), `mockjst2.ts` (stand-in for the
not-yet-open `posed-images` endpoint).

## Misc

`png.ts` — minimal PNG encoder, so the server needs no image library. `server.test.ts` — agent tools/loop, GPT-image
provider, fill/crop helpers, posed-images mock.

## Adding a service or a stage

External calls are injected (`Jst2Client`, `PanoProvider`, `Sam3dFn`, `PeopleCheck`); `plugin.ts` builds the real
ones from env keys and passes them to `textToScene`. Add a new panorama model as a `PanoProvider` in `pano.ts` and
register it in `plugin.ts` `providers` — it then appears in `/scenegen/api/config` and the test page.
