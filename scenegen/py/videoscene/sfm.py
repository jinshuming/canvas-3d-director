"""COLMAP via pycolmap: SIFT -> sequential matching -> incremental mapper -> undistort."""
import os
import shutil

import numpy as np
import pycolmap


def run_colmap(image_dir, work_dir, camera_model="SIMPLE_RADIAL", overlap=15, loop_detection=False,
               vocab_tree=None, max_image_size=1600, progress=None):
    """Returns dict(rec=undistorted pycolmap.Reconstruction, undist_dir, registered, mean_reproj)."""
    def p(x, msg):
        if progress:
            progress(x, msg)

    db = os.path.join(work_dir, "database.db")
    if os.path.exists(db):
        os.remove(db)
    sparse = os.path.join(work_dir, "sparse")
    shutil.rmtree(sparse, ignore_errors=True)
    os.makedirs(sparse)

    reader = pycolmap.ImageReaderOptions()
    reader.camera_model = camera_model
    ext = pycolmap.FeatureExtractionOptions()
    ext.max_image_size = max_image_size
    ext.sift.max_num_features = 8192
    p(0.05, "SIFT extraction")
    pycolmap.extract_features(db, image_dir, camera_mode=pycolmap.CameraMode.SINGLE,
                              reader_options=reader, extraction_options=ext,
                              device=pycolmap.Device.auto)

    pair = pycolmap.SequentialPairingOptions()
    pair.overlap = overlap
    pair.quadratic_overlap = True
    if loop_detection and vocab_tree:
        pair.loop_detection = True
        pair.vocab_tree_path = vocab_tree
    p(0.3, f"sequential matching (overlap {overlap})")
    pycolmap.match_sequential(db, pairing_options=pair)

    opts = pycolmap.IncrementalPipelineOptions()
    opts.multiple_models = True
    opts.min_model_size = 5
    opts.random_seed = 0
    n_img = len([f for f in os.listdir(image_dir) if f.lower().endswith((".jpg", ".png"))])
    counter = {"n": 0}

    def on_next():
        counter["n"] += 1
        if counter["n"] % 5 and counter["n"] != n_img:
            return
        p(0.5 + 0.35 * min(1.0, counter["n"] / max(1, n_img)), f"registered {counter['n']}/{n_img}")

    p(0.5, "incremental mapping")
    recs = pycolmap.incremental_mapping(db, image_dir, sparse, options=opts, next_image_callback=on_next)
    if not recs:
        raise RuntimeError("COLMAP failed to reconstruct (no model). Is the video textured and moving?")
    best_id = max(recs, key=lambda k: recs[k].num_reg_images())
    rec = recs[best_id]
    best_dir = os.path.join(sparse, str(best_id))
    if not os.path.isdir(best_dir):
        best_dir = os.path.join(sparse, "best")
        os.makedirs(best_dir, exist_ok=True)
        rec.write(best_dir)
    raw_reproj = float(rec.compute_mean_reprojection_error())

    p(0.9, "undistorting to PINHOLE")
    undist = os.path.join(work_dir, "undistorted")
    shutil.rmtree(undist, ignore_errors=True)
    pycolmap.undistort_images(undist, best_dir, image_dir, output_type="COLMAP", jpeg_quality=97)
    urec = pycolmap.Reconstruction(os.path.join(undist, "sparse"))
    return {"rec": urec, "undist_dir": undist, "registered": urec.num_reg_images(),
            "models": len(recs), "mean_reproj": float(urec.compute_mean_reprojection_error()),
            "raw_reproj": raw_reproj, "images": n_img}


def extract(rec):
    """-> list of per-image dicts (sorted by name) + points (N,3) + colors (N,3 uint8)."""
    views = []
    for iid in rec.reg_image_ids():
        im = rec.image(iid)
        cam = rec.camera(im.camera_id)
        M = im.cam_from_world().matrix()
        fx, fy, cx, cy = _pinhole(cam)
        views.append({"name": im.name, "image_id": iid, "R": M[:, :3], "t": M[:, 3],
                      "fx": fx, "fy": fy, "cx": cx, "cy": cy, "width": cam.width, "height": cam.height})
    views.sort(key=lambda v: v["name"])
    pts = rec.points3D
    ids = list(pts.keys())
    xyz = np.array([pts[i].xyz for i in ids]) if ids else np.zeros((0, 3))
    rgb = np.array([pts[i].color for i in ids], dtype=np.uint8) if ids else np.zeros((0, 3), np.uint8)
    return views, xyz, rgb, ids


def _pinhole(cam):
    name = cam.model_name if hasattr(cam, "model_name") else str(cam.model)
    pr = list(cam.params)
    if name.endswith("PINHOLE") and name != "SIMPLE_PINHOLE":
        return pr[0], pr[1], pr[2], pr[3]
    if name == "SIMPLE_PINHOLE":
        return pr[0], pr[0], pr[1], pr[2]
    raise RuntimeError(f"expected undistorted PINHOLE camera, got {name}")
