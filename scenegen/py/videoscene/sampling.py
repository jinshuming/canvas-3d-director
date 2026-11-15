"""Two-tier frame sampling: decode candidates -> drop blurry -> overlap-based keyframes."""
import os
import subprocess

import cv2
import numpy as np

from .probe import ffmpeg

TRACK_WIDTH = 640  # analysis resolution for blur + tracking


def sharpness(gray):
    """Variance of the Laplacian (higher = sharper)."""
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def blur_filter(scores, ratio=0.6, window=7):
    """Keep-mask: frame i is dropped when score < ratio * median of its neighbours
    (window frames centred on i, excluding i)."""
    s = np.asarray(scores, dtype=np.float64)
    n = len(s)
    keep = np.ones(n, dtype=bool)
    half = max(1, window // 2)
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        nb = np.concatenate([s[lo:i], s[i + 1:hi]])
        if len(nb) == 0:
            continue
        if s[i] < ratio * np.median(nb):
            keep[i] = False
    return keep


def _to_track_gray(img):
    g = img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    if g.shape[1] > TRACK_WIDTH:
        sc = TRACK_WIDTH / g.shape[1]
        g = cv2.resize(g, (TRACK_WIDTH, int(round(g.shape[0] * sc))), interpolation=cv2.INTER_AREA)
    return g


class KeyframeSelector:
    """Chained LK tracking from the last keyframe. A new keyframe is declared when the
    fraction of keyframe features still tracked drops below `min_overlap` or the median
    flow exceeds `max_flow` (fraction of image width). The frame *before* the threshold is
    crossed becomes the keyframe, so consecutive keyframes overlap >= min_overlap-ish."""

    def __init__(self, min_overlap=0.7, max_flow=0.2, max_corners=400):
        self.min_overlap = min_overlap
        self.max_flow = max_flow
        self.max_corners = max_corners
        self.lk = dict(winSize=(21, 21), maxLevel=4,
                       criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))

    def _detect(self, g):
        h, w = g.shape
        pts = cv2.goodFeaturesToTrack(g, self.max_corners, 0.01, max(8, w // 40), blockSize=7)
        if pts is None:
            return np.zeros((0, 1, 2), np.float32)
        return pts.astype(np.float32)

    def select(self, grays):
        """grays: list of grayscale frames (already sharp-filtered). Returns kept indices."""
        n = len(grays)
        if n == 0:
            return []
        keys = [0]
        k = 0
        i = 1
        while i < n:
            ref = grays[k]
            p0 = self._detect(ref)
            n0 = len(p0)
            if n0 < 10:
                keys.append(i)
                k = i
                i += 1
                continue
            alive = np.ones(n0, bool)
            cur = p0.copy()
            prev_g = ref
            last_ok = k
            w = ref.shape[1]
            crossed = None
            overlap, flow = 1.0, 0.0
            j = k + 1
            while j < n:
                g = grays[j]
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev_g, g, cur, None, **self.lk)
                back, st2, _ = cv2.calcOpticalFlowPyrLK(g, prev_g, nxt, None, **self.lk)
                fb = np.linalg.norm((back - cur).reshape(-1, 2), axis=1)
                hh, ww = g.shape
                xy = nxt.reshape(-1, 2)
                inside = (xy[:, 0] >= 0) & (xy[:, 0] < ww) & (xy[:, 1] >= 0) & (xy[:, 1] < hh)
                ok = (st.ravel() == 1) & (st2.ravel() == 1) & (fb < 1.0) & inside
                alive &= ok
                cur = nxt
                prev_g = g
                overlap = alive.sum() / n0
                if alive.any():
                    flow = np.median(np.linalg.norm((cur - p0).reshape(-1, 2)[alive], axis=1)) / w
                else:
                    flow = np.inf
                if overlap < self.min_overlap or flow > self.max_flow:
                    crossed = j
                    break
                last_ok = j
                j += 1
            if crossed is None:
                # reached the end: keep the last frame if it moved meaningfully
                moved = overlap < 0.5 * (1 + self.min_overlap) or flow > 0.25 * self.max_flow
                if last_ok != k and last_ok == n - 1 and moved:
                    keys.append(last_ok)
                break
            nk = last_ok if last_ok != k else crossed
            keys.append(nk)
            k = nk
            i = nk + 1
        return keys


def fill_and_cap(keys, n_total, scores, min_count, max_count):
    """Ensure min_count <= len(keys) <= max_count (when possible). Fill by inserting the
    sharpest frame in the largest temporal gap; cap by uniform thinning."""
    keys = sorted(set(keys))
    scores = np.asarray(scores)
    while len(keys) < min(min_count, n_total):
        gaps = [(keys[t + 1] - keys[t], t) for t in range(len(keys) - 1)]
        if keys[0] > 0:
            gaps.append((keys[0] + 1, -1))
        if keys[-1] < n_total - 1:
            gaps.append((n_total - keys[-1], len(keys) - 1))
        gaps.sort(reverse=True)
        size, t = gaps[0]
        if size <= 1:
            break
        lo = 0 if t == -1 else keys[t] + 1
        hi = keys[0] if t == -1 else (keys[t + 1] if t + 1 < len(keys) else n_total)
        if hi <= lo:
            break
        # prefer the middle third of the gap, sharpest frame there
        a = lo + (hi - lo) // 3
        b = max(a + 1, hi - (hi - lo) // 3)
        cand = range(a, min(b, hi))
        best = max(cand, key=lambda q: scores[q])
        keys = sorted(set(keys + [best]))
    if len(keys) > max_count:
        idx = np.round(np.linspace(0, len(keys) - 1, max_count)).astype(int)
        keys = [keys[q] for q in sorted(set(idx.tolist()))]
    return keys


def decode_candidates(video, info, sample_fps, out_dir, on_frame=None):
    """Decode at sample_fps via ffmpeg (auto-rotated), write JPEGs, return list of
    dicts {path, time, sharp, gray}."""
    os.makedirs(out_dir, exist_ok=True)
    w, h = info["size"]
    cmd = [ffmpeg(), "-v", "error", "-i", video, "-vf", f"fps={sample_fps}",
           "-f", "rawvideo", "-pix_fmt", "bgr24", "-"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    frames = []
    nbytes = w * h * 3
    expected = max(1, int(info["durationSec"] * sample_fps))
    i = 0
    try:
        while True:
            buf = proc.stdout.read(nbytes)
            if len(buf) < nbytes:
                break
            img = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            path = os.path.join(out_dir, f"c{i:05d}.jpg")
            cv2.imwrite(path, img, [cv2.IMWRITE_JPEG_QUALITY, 97])
            g = _to_track_gray(img)
            frames.append({"path": path, "time": round(i / sample_fps, 4), "sharp": sharpness(g), "gray": g})
            i += 1
            if on_frame:
                on_frame(i, expected)
    finally:
        proc.stdout.close()
        err = proc.stderr.read().decode(errors="replace")
        proc.wait()
    if proc.returncode != 0 and not frames:
        raise RuntimeError(f"ffmpeg decode failed: {err.strip()[:500]}")
    return frames
