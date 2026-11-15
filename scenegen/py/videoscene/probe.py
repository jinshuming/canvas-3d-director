"""ffprobe wrapper."""
import json
import os
import shutil
import subprocess


def _tool(name):
    for cand in (shutil.which(name), f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}"):
        if cand and os.path.exists(cand):
            return cand
    raise RuntimeError(f"{name} not found (install ffmpeg)")


FFPROBE = None
FFMPEG = None


def ffprobe():
    global FFPROBE
    FFPROBE = FFPROBE or _tool("ffprobe")
    return FFPROBE


def ffmpeg():
    global FFMPEG
    FFMPEG = FFMPEG or _tool("ffmpeg")
    return FFMPEG


def _rate(s):
    if not s or s == "0/0":
        return 0.0
    if "/" in s:
        a, b = s.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(s)


def probe(video):
    r = subprocess.run(
        [ffprobe(), "-v", "error", "-print_format", "json", "-show_format", "-show_streams", video],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {r.stderr.strip()[:300]}")
    out = r.stdout
    info = json.loads(out)
    vs = next((s for s in info.get("streams", []) if s.get("codec_type") == "video"), None)
    if vs is None:
        raise RuntimeError("no video stream")
    rotation = 0
    tags = vs.get("tags", {}) or {}
    if "rotate" in tags:
        rotation = int(float(tags["rotate"]))
    for sd in vs.get("side_data_list", []) or []:
        if "rotation" in sd:
            rotation = int(float(sd["rotation"]))
    rotation %= 360
    w, h = int(vs["width"]), int(vs["height"])
    if rotation in (90, 270):  # ffmpeg auto-rotates on decode
        w, h = h, w
    duration = float(vs.get("duration") or info.get("format", {}).get("duration") or 0.0)
    fps = _rate(vs.get("avg_frame_rate")) or _rate(vs.get("r_frame_rate"))
    start = float(vs.get("start_time") or 0.0)
    return {"durationSec": duration, "fps": fps, "size": [w, h], "rotation": rotation, "startTime": start,
            "codec": vs.get("codec_name")}
