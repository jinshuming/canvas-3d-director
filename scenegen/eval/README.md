# scenegen/eval — scripts (run with `npx tsx`)

All of these need the dev server running (`npm run dev`) unless noted, and read keys from `.env.local`.

| Script | Spends credits? | Does |
|---|---|---|
| `generate.mts` | **yes** (unless `--stop-after layout`) | Headless text / picture → scene; writes `layout.json`, conditions, `panorama.*`, `environment.spz`, `scene.spz`, objects, `result.json`. **The reference for driving the API from a script** |
| `e2e.mts` | **yes** | The 12 real end-to-end cases (text, picture, video-layout, video-poses) incl. the layout agent; writes `results.json` |
| `panoab.mts` | OpenAI image calls only | A/B of panorama prompting variants on finished projects, scored with `py/panoalign.py` |
| `replace.mts` | no | Re-place a finished scene's SAM 3D objects with the current `core/place.ts`; rewrites `scene.spz` (restart the dev server after) |
| `topdown.mts` | no | Top-down PNG: object splats over blockout boxes — to eyeball placement |
| `env.ts` | — | Reads `.env.local` for the scripts |
