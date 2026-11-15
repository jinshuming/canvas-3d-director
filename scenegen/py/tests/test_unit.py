import json
import os

import cv2
import numpy as np
import pytest

from videoscene import geometry as G
from videoscene import sampling as S


def _texture(h=480, w=1600, seed=0):
    rng = np.random.default_rng(seed)
    base = rng.integers(0, 255, (h // 8, w // 8), dtype=np.uint8)
    img = cv2.resize(base, (w, h), interpolation=cv2.INTER_CUBIC)
    for _ in range(300):  # add corners / edges
        x, y = rng.integers(0, w), rng.integers(0, h)
        cv2.rectangle(img, (int(x), int(y)), (int(x) + 12, int(y) + 9), int(rng.integers(0, 255)), -1)
    return img


# ---------------- blur ----------------
def test_blur_filter_drops_blurred_frames():
    tex = _texture()[:, :640]
    frames, blurred = [], {3, 8, 9}
    for i in range(14):
        f = np.roll(tex, i * 3, axis=1)
        if i in blurred:
            f = cv2.GaussianBlur(f, (0, 0), 3.0)
        frames.append(f)
    scores = [S.sharpness(f) for f in frames]
    keep = S.blur_filter(scores, ratio=0.6)
    assert set(np.where(~keep)[0].tolist()) == blurred


def test_blur_filter_keeps_uniform_sequence():
    keep = S.blur_filter([100, 105, 98, 101, 99, 102], ratio=0.6)
    assert keep.all()


# ---------------- keyframes ----------------
def test_keyframe_selector_on_translating_texture():
    tex = _texture()
    W = 640
    step = 8  # px per frame
    grays = [tex[:, i * step:i * step + W].copy() for i in range((tex.shape[1] - W) // step)]
    keys = S.KeyframeSelector(min_overlap=0.7, max_flow=0.5).select(grays)
    assert keys[0] == 0 and keys == sorted(keys) and len(keys) >= 3
    gaps = np.diff(keys) * step / W  # fraction of width between consecutive keyframes
    # overlap 1 - gap should be ~60-80%
    overlap = 1 - gaps[:-1] if len(gaps) > 1 else 1 - gaps
    assert np.all(overlap >= 0.6) and np.all(overlap <= 0.85), overlap


def test_keyframe_selector_static_returns_single():
    g = _texture()[:, :640]
    assert S.KeyframeSelector().select([g] * 10) == [0]


def test_fill_and_cap():
    keys = S.fill_and_cap([0, 50], 100, np.ones(100), min_count=10, max_count=200)
    assert len(keys) == 10 and keys == sorted(keys)
    keys = S.fill_and_cap(list(range(100)), 100, np.ones(100), min_count=10, max_count=20)
    assert len(keys) == 20 and keys[0] == 0 and keys[-1] == 99


# ---------------- pose math ----------------
def _rand_rot(rng):
    q = rng.normal(size=4)
    q /= np.linalg.norm(q)
    w, x, y, z = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def test_w2c_to_c2w_inverts():
    rng = np.random.default_rng(1)
    R, t = _rand_rot(rng), rng.normal(size=3)
    M = G.w2c_to_c2w(R, t)
    W = np.eye(4)
    W[:3, :3], W[:3, 3] = R, t
    assert np.allclose(M @ W, np.eye(4), atol=1e-12)
    assert G.is_rigid(M)


def _level_rig(n=30, seed=2, height=1.5):
    """Upright cameras (OpenCV axes, world Y down, floor at y=+height) walking a loop,
    each with small pitch/roll noise. Returns c2ws and floor points."""
    rng = np.random.default_rng(seed)
    c2ws = []
    for i in range(n):
        yaw = 2 * np.pi * i / n
        Ry = G.rot_y(yaw)
        pitch, roll = rng.normal(0, 0.08, 2)
        Rx = np.array([[1, 0, 0], [0, np.cos(pitch), -np.sin(pitch)], [0, np.sin(pitch), np.cos(pitch)]])
        Rz = np.array([[np.cos(roll), -np.sin(roll), 0], [np.sin(roll), np.cos(roll), 0], [0, 0, 1]])
        M = np.eye(4)
        M[:3, :3] = Ry @ Rx @ Rz
        M[:3, 3] = [2 * np.cos(yaw), rng.normal(0, 0.02), 2 * np.sin(yaw)]
        c2ws.append(M)
    floor = np.c_[rng.uniform(-4, 4, 3000), height + rng.normal(0, 0.003, 3000), rng.uniform(-4, 4, 3000)]
    clutter = rng.uniform(-4, 4, (500, 3))
    return c2ws, np.vstack([floor, clutter])


def _scramble(c2ws, pts, s=0.37, seed=3):
    rng = np.random.default_rng(seed)
    R, t = _rand_rot(rng), rng.normal(size=3) * 5
    T = np.eye(4)
    T[:3, :3], T[:3, 3] = s * R, t
    out = []
    for M in c2ws:
        N = np.eye(4)
        N[:3, :3] = R @ M[:3, :3]
        N[:3, 3] = T[:3, :3] @ M[:3, 3] + t
        out.append(N)
    return out, pts @ T[:3, :3].T + t


@pytest.mark.parametrize("with_floor", [True, False])
def test_gravity_alignment_levels_tilted_cameras(with_floor):
    c2ws, pts = _level_rig()
    tc, tp = _scramble(c2ws, pts)
    res = G.normalise(tc, tp if with_floor else None, cam_height=1.5, assumed_step=0.3)
    up_cams = -np.mean([M[:3, 1] for M in res["c2ws"]], axis=0)
    up_cams /= np.linalg.norm(up_cams)
    assert np.degrees(np.arccos(up_cams @ [0, -1, 0])) < 2.0  # level, Y down
    for M in res["c2ws"]:
        assert G.is_rigid(M)
        assert M[1, 1] > 0.9  # camera y axis (image down) ~ world +Y (down)
    C = np.array([M[:3, 3] for M in res["c2ws"]])
    assert np.allclose(np.median(C, axis=0), 0, atol=0.05)
    if with_floor:
        assert res["scale_mode"] == "floor" and res["up_source"] == "floor"
        assert abs(res["floor_y"] - 1.5) < 0.03
        floor_pts = res["points"][:3000]
        assert abs(np.median(floor_pts[:, 1]) - 1.5) < 0.03
        assert abs(np.std(C[:, 1])) < 0.05
    else:
        assert res["scale_mode"] == "assumed"
        assert abs(np.median(np.linalg.norm(np.diff(C, axis=0), axis=1)) - 0.3) < 1e-6


def test_rotation_between_antiparallel():
    R = G.rotation_between(np.array([0, 1.0, 0]), np.array([0, -1.0, 0]))
    assert np.allclose(R @ [0, 1, 0], [0, -1, 0]) and abs(np.linalg.det(R) - 1) < 1e-9


# ---------------- subset ----------------
def test_farthest_point_subset():
    c2ws, _ = _level_rig(n=120, seed=5)
    a = G.farthest_point_subset(c2ws, cap=40)
    b = G.farthest_point_subset(c2ws, cap=40)
    assert a == b and len(a) == 40 and a == sorted(a) and len(set(a)) == 40
    assert G.farthest_point_subset(c2ws[:10], cap=40) == list(range(10))
    c = G.farthest_point_subset(c2ws, cap=34)
    assert len(c) == 34
    # spread: should cover the loop, not cluster
    yaws = sorted(np.degrees(np.arctan2(c2ws[i][2, 3], c2ws[i][0, 3])) % 360 for i in a)
    assert max(np.diff(yaws + [yaws[0] + 360])) < 30


def test_square_crop_intrinsics():
    fx, fy, cx, cy, x0, y0, s = G.square_crop_intrinsics(1000, 1000, 640, 360, 1280, 720, 1024)
    assert (x0, y0, s) == (280, 0, 720)
    assert np.isclose(cx, 512) and np.isclose(cy, 512) and np.isclose(fx, 1000 * 1024 / 720)


# ---------------- views.json schema ----------------
def check_views_schema(doc, root=None):
    assert doc["version"] == 1
    assert doc["frame"]["convention"] == "opencv" and doc["frame"]["worldUp"] == [0, -1, 0]
    assert doc["frame"]["scale"] in ("floor", "assumed")
    for k in ("candidates", "sharp", "keyframes", "registered", "selected", "reprojErrorPx", "seconds"):
        assert k in doc["stats"]
    assert len(doc["views"]) == doc["stats"]["selected"]
    for i, v in enumerate(doc["views"]):
        assert v["index"] == i and v["file"] == f"images/{i:04d}.jpg"
        M = np.array(v["c2w"], float)
        assert M.shape == (4, 4) and M[3].tolist() == [0, 0, 0, 1]
        R = M[:3, :3]
        assert np.allclose(R @ R.T, np.eye(3), atol=1e-5) and abs(np.linalg.det(R) - 1) < 1e-5
        assert len(v["intrinsic"]) == 4 and all(0 < x < 2 for x in v["intrinsic"])
        assert v["width"] > 0 and v["height"] > 0
        if root:
            assert os.path.exists(os.path.join(root, v["file"]))
    if root:
        assert os.path.exists(os.path.join(root, doc["points"]))


def test_views_schema_on_synthetic_doc():
    c2ws, _ = _level_rig(n=5)
    doc = {"version": 1, "source": {}, "frame": {"convention": "opencv", "worldUp": [0, -1, 0], "units": "metres",
                                               "scale": "floor", "metersPerUnit": 1},
           "stats": {"candidates": 5, "sharp": 5, "keyframes": 5, "registered": 5, "selected": 5,
                     "reprojErrorPx": 0.5, "seconds": {}},
           "views": [{"index": i, "file": f"images/{i:04d}.jpg", "frameTime": i, "width": 1024, "height": 1024,
                      "c2w": M.tolist(), "intrinsic": [0.8, 0.8, 0.5, 0.5]} for i, M in enumerate(c2ws)],
           "points": "points.ply"}
    check_views_schema(json.loads(json.dumps(doc)))
    bad = json.loads(json.dumps(doc))
    bad["views"][0]["c2w"][0][0] *= 1.1
    with pytest.raises(AssertionError):
        check_views_schema(bad)
