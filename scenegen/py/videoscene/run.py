"""CLI: python -m videoscene.run <video> --out <dir>

Video -> sharp keyframes -> COLMAP -> gravity/metric-normalised poses -> <=40 views bundle
for JST-2. Progress is printed as JSON lines on stdout.
"""
import argparse
import json
import os
import shutil
import sys
import time
import uuid

import cv2
import numpy as np

from . import geometry as G
from . import sampling as S
from .probe import probe
from .progress import emit


def parse_args(argv=None):
    ap = argparse.ArgumentParser(prog="videoscene.run", description=__doc__)
    ap.add_argument("video")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=float, default=3.0, help="candidate sampling fps (raised automatically "
                    "for short clips so there are ~2.5x min-keyframes candidates)")
    ap.add_argument("--blur-ratio", type=float, default=0.6)
    ap.add_argument("--min-overlap", type=float, default=0.7)
    ap.add_argument("--max-flow", type=float, default=0.2, help="median flow (fraction of width) forcing a keyframe")
    ap.add_argument("--min-keyframes", type=int, default=60)
    ap.add_argument("--max-keyframes", type=int, default=200)
    ap.add_argument("--camera-model", default="SIMPLE_RADIAL", choices=["SIMPLE_RADIAL", "OPENCV", "RADIAL"])
    ap.add_argument("--match-overlap", type=int, default=15)
    ap.add_argument("--vocab-tree", default=None, help="enables loop detection when given")
    ap.add_argument("--max-views", type=int, default=40)
    ap.add_argument("--metres-per-radian", type=float, default=0.5, help="FPS distance weight for view angle")
    ap.add_argument("--cam-height", type=float, default=1.5)
    ap.add_argument("--assumed-step", type=float, default=0.3,
                    help="metres between consecutive keyframes when no floor is found")
    ap.add_argument("--square", type=int, default=0, help="center-crop + resize to NxN (e.g. 1024)")
    ap.add_argument("--session-id", default=None)
    ap.add_argument("--keep-work", action="store_true", help="keep <out>/work (frames, COLMAP db/models)")
    return ap.parse_args(argv)


def write_ply(path, xyz, rgb):
    xyz = np.asarray(xyz, np.float32)
    rgb = np.asarray(rgb, np.uint8)
    with open(path, "wb") as f:
        f.write((f"ply\nformat binary_little_endian 1.0\nelement vertex {len(xyz)}\n"
                 "property float x\nproperty float y\nproperty float z\n"
                 "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n").encode())
        rec = np.zeros(len(xyz), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
        rec["p"] = xyz
        rec["c"] = rgb
        f.write(rec.tobytes())


def main(argv=None):
    a = parse_args(argv)
    t_all = time.time()
    secs = {}
    out = os.path.abspath(a.out)
    work = os.path.join(out, "work")
    os.makedirs(out, exist_ok=True)
    for sub in ("images",):
        shutil.rmtree(os.path.join(out, sub), ignore_errors=True)
    os.makedirs(os.path.join(out, "images"))
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)

    # ---------- probe + sample ----------
    t0 = time.time()
    info = probe(a.video)
    dur = max(info["durationSec"], 1e-3)
    sample_fps = max(a.fps, 2.5 * a.min_keyframes / dur)
    if info["fps"]:
        sample_fps = min(sample_fps, info["fps"])
    sample_fps = round(sample_fps, 3)
    emit("sample", 0.0, f"probe: {info['size'][0]}x{info['size'][1]} {info['fps']:.2f}fps {dur:.2f}s "
         f"rot={info['rotation']}; decoding at {sample_fps} fps")
    cands = S.decode_candidates(a.video, info, sample_fps, os.path.join(work, "candidates"),
                                on_frame=lambda i, n: emit("sample", 0.6 * min(1, i / n), f"decoded {i}")
                                if i % 20 == 0 else None)
    keep = S.blur_filter([c["sharp"] for c in cands], ratio=a.blur_ratio)
    sharp = [c for c, k in zip(cands, keep) if k]
    emit("sample", 0.7, f"{len(cands)} candidates, {len(sharp)} sharp")
    sel = S.KeyframeSelector(min_overlap=a.min_overlap, max_flow=a.max_flow)
    kidx = sel.select([c["gray"] for c in sharp])
    n_overlap = len(kidx)
    kidx = S.fill_and_cap(kidx, len(sharp), [c["sharp"] for c in sharp], a.min_keyframes, a.max_keyframes)
    keyframes = [sharp[i] for i in kidx]
    kdir = os.path.join(work, "keyframes")
    os.makedirs(kdir)
    name_to_frame = {}
    for j, c in enumerate(keyframes):
        name = f"kf_{j:04d}.jpg"
        os.link(c["path"], os.path.join(kdir, name))
        name_to_frame[name] = c
    secs["sample"] = round(time.time() - t0, 2)
    emit("sample", 1.0, f"{len(keyframes)} keyframes ({n_overlap} by overlap)")
    if len(keyframes) < 3:
        raise RuntimeError("too few usable frames")

    # ---------- colmap ----------
    t0 = time.time()
    from . import sfm  # heavy import
    res = sfm.run_colmap(kdir, work, camera_model=a.camera_model, overlap=a.match_overlap,
                         loop_detection=bool(a.vocab_tree), vocab_tree=a.vocab_tree,
                         progress=lambda x, m: emit("colmap", x, m))
    views, xyz, rgb, _ = sfm.extract(res["rec"])
    secs["colmap"] = round(time.time() - t0, 2)
    reg_rate = len(views) / len(keyframes)
    emit("colmap", 1.0, f"registered {len(views)}/{len(keyframes)} ({100 * reg_rate:.0f}%), "
         f"{len(xyz)} points, reproj {res['mean_reproj']:.3f}px, models={res['models']}")
    if len(views) < 3:
        raise RuntimeError("COLMAP registered fewer than 3 images")

    # ---------- normalise ----------
    t0 = time.time()
    emit("normalise", 0.0, "gravity / origin / scale")
    c2ws = [G.w2c_to_c2w(v["R"], v["t"]) for v in views]
    norm = G.normalise(c2ws, xyz, cam_height=a.cam_height, assumed_step=a.assumed_step)
    secs["normalise"] = round(time.time() - t0, 2)
    emit("normalise", 1.0, f"scale={norm['scale_mode']} up={norm['up_source']} "
         f"floorY={norm['floor_y'] if norm['floor_y'] is None else round(norm['floor_y'], 3)}")

    # ---------- select ----------
    t0 = time.time()
    sub = G.farthest_point_subset(norm["c2ws"], cap=a.max_views, metres_per_radian=a.metres_per_radian)
    secs["select"] = round(time.time() - t0, 2)
    emit("select", 1.0, f"{len(sub)} of {len(views)} views")

    # ---------- write ----------
    t0 = time.time()
    out_views, req_views = [], []
    for k, vi in enumerate(sub):
        v = views[vi]
        img = cv2.imread(os.path.join(res["undist_dir"], "images", v["name"]), cv2.IMREAD_COLOR)
        if img is None:
            raise RuntimeError(f"missing undistorted image {v['name']}")
        h, w = img.shape[:2]
        fx, fy, cx, cy = v["fx"], v["fy"], v["cx"], v["cy"]
        if a.square:
            fx, fy, cx, cy, x0, y0, s = G.square_crop_intrinsics(fx, fy, cx, cy, w, h, a.square)
            img = cv2.resize(img[y0:y0 + s, x0:x0 + s], (a.square, a.square), interpolation=cv2.INTER_AREA)
            h = w = a.square
        rel = f"images/{k:04d}.jpg"
        cv2.imwrite(os.path.join(out, rel), img, [cv2.IMWRITE_JPEG_QUALITY, 92])
        c2w = [[round(float(x), 7) for x in row] for row in norm["c2ws"][vi]]
        c2w[3] = [0, 0, 0, 1]
        intr = [fx / w, fy / h, cx / w, cy / h]
        intr = [round(float(x), 7) for x in intr]
        out_views.append({"index": k, "file": rel, "frameTime": name_to_frame[v["name"]]["time"],
                          "width": w, "height": h, "c2w": c2w, "intrinsic": intr, "colmapName": v["name"]})
        req_views.append({"image": rel, "c2w": c2w, "intrinsic": intr})
        emit("write", 0.9 * (k + 1) / len(sub), f"wrote {rel}")
    write_ply(os.path.join(out, "points.ply"), norm["points"], rgb)
    secs["write"] = round(time.time() - t0, 2)
    secs["total"] = round(time.time() - t_all, 2)
    stats = {"candidates": len(cands), "sharp": len(sharp), "keyframesByOverlap": n_overlap,
             "keyframes": len(keyframes), "registered": len(views), "registrationRate": round(reg_rate, 4),
             "selected": len(sub), "points": int(len(xyz)), "reprojErrorPx": round(res["mean_reproj"], 4),
             "sampleFps": sample_fps, "seconds": secs}
    doc = {
        "version": 1,
        "source": {"video": os.path.abspath(a.video), "durationSec": info["durationSec"], "fps": info["fps"],
                   "size": info["size"], "rotation": info["rotation"]},
        "frame": {"convention": "opencv", "worldUp": [0, -1, 0], "units": "metres", "scale": norm["scale_mode"],
                  "metersPerUnit": 1, "upSource": norm["up_source"], "floorY": norm["floor_y"],
                  "colmapToWorld": [[float(x) for x in r] for r in norm["S"]]},
        "stats": stats,
        "views": out_views,
        "points": "points.ply",
    }
    with open(os.path.join(out, "views.json"), "w") as f:
        json.dump(doc, f, indent=1)
    session = a.session_id or uuid.uuid4().hex
    with open(os.path.join(out, "request.json"), "w") as f:
        json.dump({"sessionId": session, "views": req_views, "metersPerUnit": 1}, f, indent=1)
    if not a.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    emit("write", 1.0, "bundle written")
    emit("done", out=out, stats=stats)
    return doc


def cli():
    try:
        main()
    except KeyboardInterrupt:
        emit("error", message="interrupted")
        sys.exit(130)
    except Exception as e:  # noqa: BLE001
        emit("error", message=f"{type(e).__name__}: {e}")
        sys.exit(1)


if __name__ == "__main__":
    cli()
