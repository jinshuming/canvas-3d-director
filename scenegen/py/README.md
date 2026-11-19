# scenegen/py — Python helpers

Optional for the text/picture pipeline; required for the video route. The server shells out to these.

| File | Responsibility |
|---|---|
| `panoalign.py` | Scores how well a generated panorama follows the blockout (edge distance above a 90°-turned baseline, 0 = chance, 1 = perfect). Used by `server/alignScore.ts` to choose between panorama candidates. Without it the first clean candidate is kept |
| `videoscene/run.py` | CLI `python -m videoscene.run <video> --out <dir>`: video → sharp keyframes → COLMAP → gravity- and scale-normalised poses → ≤ 40 views bundle. Progress as JSON lines on stdout |
| `videoscene/sampling.py`, `sfm.py`, `geometry.py`, `probe.py`, `progress.py` | Frame sampling, pycolmap, pose math (floor fit, 1.5 m camera-height scale), ffprobe, progress events |
| `tests/` | `npm run test:video` (unit + a ~30 s integration test on a walkthrough video) |

Setup: `cd scenegen/py && uv venv -p 3.12 .venv && uv pip install -p .venv -r requirements.txt`
(pycolmap, numpy, opencv; `ffmpeg`/`ffprobe` on PATH).
