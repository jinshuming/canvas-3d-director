import json
import os
import subprocess
import sys

import numpy as np
import pytest

from test_unit import check_views_schema

# A walk-through video of a living room; set SCENEGEN_TEST_VIDEOS to the folder that has it.
VIDEO_DIR = os.environ.get("SCENEGEN_TEST_VIDEOS", "")
VIDEO = os.path.join(VIDEO_DIR, "livingRoom-explore.mp4")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

pytestmark = [pytest.mark.slow,
              pytest.mark.skipif(not os.path.exists(VIDEO), reason="test video not available")]


@pytest.fixture(scope="module")
def bundle(tmp_path_factory):
    out = tmp_path_factory.mktemp("livingRoom")
    proc = subprocess.run([sys.executable, "-m", "videoscene.run", VIDEO, "--out", str(out), "--keep-work",
                           "--session-id", "test-session"],
                          cwd=ROOT, capture_output=True, text=True, timeout=900)
    lines = [json.loads(l) for l in proc.stdout.splitlines() if l.strip()]
    assert proc.returncode == 0, (proc.stdout[-2000:], proc.stderr[-2000:])
    with open(out / "views.json") as f:
        doc = json.load(f)
    return out, doc, lines


def test_progress_protocol(bundle):
    _, _, lines = bundle
    stages = [l["stage"] for l in lines]
    assert stages[-1] == "done" and "stats" in lines[-1]
    for s in ("sample", "colmap", "normalise", "select", "write"):
        assert s in stages
    assert all(0 <= l["progress"] <= 1 for l in lines if "progress" in l)


def test_bundle_numbers(bundle):
    out, doc, _ = bundle
    check_views_schema(doc, root=str(out))
    st = doc["stats"]
    print("\nSTATS", json.dumps(st))
    assert st["registered"] >= 0.8 * st["keyframes"]
    assert 1 <= st["selected"] <= 40
    assert st["reprojErrorPx"] < 2.0
    times = [v["frameTime"] for v in doc["views"]]
    assert times == sorted(times) and len(set(times)) == len(times)
    req = json.load(open(out / "request.json"))
    assert req["sessionId"] == "test-session" and req["metersPerUnit"] == 1
    assert len(req["views"]) == len(doc["views"])


def test_metric_scale(bundle):
    _, doc, _ = bundle
    assert doc["frame"]["scale"] == "floor"
    floor_y = doc["frame"]["floorY"]
    heights = [floor_y - v["c2w"][1][3] for v in doc["views"]]  # Y down: floor below = larger y
    assert abs(np.median(heights) - 1.5) < 0.15, heights
    # points: the floor (bulk of the low points) sits ~1.5 m below the cameras
    ups = np.array([-np.array(v["c2w"])[:3, 1] for v in doc["views"]]).mean(0)
    assert ups[1] < -0.95  # cameras upright in a Y-down world


def test_reprojection_with_written_poses(bundle):
    import pycolmap
    out, doc, _ = bundle
    rec = pycolmap.Reconstruction(str(out / "work" / "undistorted" / "sparse"))
    S = np.array(doc["frame"]["colmapToWorld"])
    picks = [doc["views"][0], doc["views"][len(doc["views"]) // 2]]
    for v in picks:
        im = rec.find_image_with_name(v["colmapName"])
        obs = [(p.xy, rec.points3D[p.point3D_id].xyz) for p in im.points2D if p.has_point3D()]
        assert len(obs) > 100
        xy = np.array([o[0] for o in obs])
        X = np.array([o[1] for o in obs])
        Xw = X @ S[:3, :3].T + S[:3, 3]
        c2w = np.array(v["c2w"])
        w2c = np.linalg.inv(c2w)
        Xc = Xw @ w2c[:3, :3].T + w2c[:3, 3]
        assert (Xc[:, 2] > 0).all()
        fx, fy, cx, cy = np.array(v["intrinsic"]) * [v["width"], v["height"], v["width"], v["height"]]
        u = fx * Xc[:, 0] / Xc[:, 2] + cx
        vv = fy * Xc[:, 1] / Xc[:, 2] + cy
        inside = (u >= 0) & (u < v["width"]) & (vv >= 0) & (vv < v["height"])
        assert inside.mean() > 0.99
        err = np.hypot(u - xy[:, 0], vv - xy[:, 1])
        print(f"\nREPROJ {v['file']}: n={len(err)} median={np.median(err):.3f}px mean={err.mean():.3f}px")
        assert np.median(err) < 1.0 and err.mean() < 2.0
