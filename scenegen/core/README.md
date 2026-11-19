# scenegen/core — pure geometry and splat tools

Runs in Node **and** in the page, except the splat file I/O (`spz.ts`, `spzwrite.ts`, `gaussians.ts` use `node:zlib` /
`node:fs` types and are server-only). No network, no credits. Everything is unit-tested in `core.test.ts` / `place.test.ts`.

| File | Responsibility |
|---|---|
| `types.ts` | `Layout` (room, openings, objects, style, capture) — the single source of truth of a project; `emptyLayout`, `EYE_HEIGHT` |
| `frame.ts` | Coordinate conventions and conversions: world ↔ scene file, c2w poses, `toServiceC2W` (JST-2's OpenCV axes), equirect pixel ↔ direction |
| `catalog.ts` | Parametric blockout shapes (boxes + cylinders) with default sizes and aliases; `catalogSummary()` feeds the model prompt |
| `layout.ts` | Layout edits as relations (`placeObject`: against / on / in_front_of / near …), `checkLayout` (overlap, floating, out of room, blocked walkway) — each op returns text the agent reads |
| `geometry.ts` | Layout → world solids + room shell; CPU ray caster |
| `render.ts` | Equirect depth / semantic / shaded renders of the blockout; per-object pixel counts |
| `capture.ts` | `findCapturePoint`: where to stand so the key objects are visible; `importanceOf` ranks objects |
| `caption.ts` | `compileCaption`: the deterministic panorama prompt (places objects as seen from the capture point) |
| `align.ts` | `measureAlignment` / `horizontalScale`: how closely a splat scene follows the blockout depth; where its floor is |
| `spz.ts`, `spzwrite.ts` | Read centres/colours/opacities from `.spz` (v2–4); write a minimal v2 (used by the mock) |
| `gaussians.ts` | Full splat arrays (PLY/SPZ in, SPZ v3 out); transform, thin, concat, scale (`scaleSpz`) |
| `fit.ts` | Rough fit of a fresh SAM 3D object to its blockout box (once, at generation) |
| `place.ts` | **Placement search** for SAM 3D objects: clean → stand up → level → square → size (see its header and `PIPELINE.md` ⑤) |
| `seat.ts` | Seat objects on the real floor / on other objects, never stretched |
| `fixtures.ts` | Sample layouts for tests and the demo button |

Rule of thumb: if a function needs the dev server, an API key or a file path, it does not belong here.
