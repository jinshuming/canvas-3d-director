"""Pose math: c2w conversion, gravity alignment, floor fit, scale, view subset."""
import numpy as np

TARGET_UP = np.array([0.0, -1.0, 0.0])  # OpenCV-style world: +Y points down


def w2c_to_c2w(R, t):
    """COLMAP world-to-camera (x_cam = R x_world + t) -> 4x4 camera-to-world."""
    R = np.asarray(R, float)
    t = np.asarray(t, float).reshape(3)
    M = np.eye(4)
    M[:3, :3] = R.T
    M[:3, 3] = -R.T @ t
    return M


def rotation_between(a, b):
    """Smallest rotation taking unit vector a onto unit vector b."""
    a = a / np.linalg.norm(a)
    b = b / np.linalg.norm(b)
    v = np.cross(a, b)
    c = float(np.dot(a, b))
    if c < -1 + 1e-9:
        # 180 deg: rotate about any axis orthogonal to a
        axis = np.cross(a, [1.0, 0, 0])
        if np.linalg.norm(axis) < 1e-6:
            axis = np.cross(a, [0, 1.0, 0])
        axis /= np.linalg.norm(axis)
        return 2 * np.outer(axis, axis) - np.eye(3)
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    return np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))


def rot_y(theta):
    c, s = np.cos(theta), np.sin(theta)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def estimate_up_from_cameras(c2ws):
    """Up = negative mean of camera y-axes (image-down direction in world)."""
    ys = np.array([M[:3, 1] for M in c2ws])
    up = -ys.mean(axis=0)
    return up / np.linalg.norm(up)


def fit_floor_plane(points, cam_centers, up, max_tilt_deg=20.0, iters=600, seed=0):
    """RANSAC plane fit on sparse points below the cameras with normal near `up`.
    Returns (normal pointing toward cameras, d) with plane n.x + d = 0, or None.
    Picks the best-supported horizontal plane among the lower points (floor, not tables:
    candidates are restricted to the lowest 40% of below-camera points by height)."""
    if points is None or len(points) < 50:
        return None
    rng = np.random.default_rng(seed)
    h_pts = points @ up
    h_cam = cam_centers @ up
    cam_h = np.median(h_cam)
    spread = np.percentile(np.linalg.norm(points - np.median(cam_centers, axis=0), axis=1), 80)
    below = points[h_pts < cam_h - 0.05 * spread]
    if len(below) < 50:
        return None
    hb = below @ up
    low = below[hb <= np.percentile(hb, 40)]
    if len(low) < 30:
        low = below
    thr = 0.01 * spread
    cos_tilt = np.cos(np.radians(max_tilt_deg))
    best, best_n = None, 0
    for _ in range(iters):
        s = low[rng.choice(len(low), 3, replace=False)]
        n = np.cross(s[1] - s[0], s[2] - s[0])
        nn = np.linalg.norm(n)
        if nn < 1e-12:
            continue
        n /= nn
        if abs(n @ up) < cos_tilt:
            continue
        if n @ up < 0:
            n = -n
        d = -n @ s[0]
        inl = np.abs(below @ n + d) < thr
        c = int(inl.sum())
        if c > best_n:
            best_n, best = c, inl
    if best is None or best_n < max(40, 0.05 * len(below)):
        return None
    P = below[best]
    ctr = P.mean(axis=0)
    _, _, vt = np.linalg.svd(P - ctr)
    n = vt[2]
    if n @ up < 0:
        n = -n
    if n @ up < cos_tilt:
        return None
    d = -n @ ctr
    # cameras must be above the plane
    if np.median(cam_centers @ n + d) <= 0:
        return None
    return n, float(d), int(best_n)


def normalise(c2ws, points, cam_height=1.5, assumed_step=0.3, use_floor=True):
    """Return dict(c2ws, points, S (4x4 similarity colmap->world), scale_mode, up_source, ...).
    World: +Y down (gravity), origin at median camera position, metres (approx)."""
    c2ws = [np.asarray(M, float) for M in c2ws]
    C = np.array([M[:3, 3] for M in c2ws])
    up = estimate_up_from_cameras(c2ws)
    up_source = "cameras"
    plane = fit_floor_plane(points, C, up) if use_floor else None
    if plane is not None:
        n, d, _ = plane
        ang = np.degrees(np.arccos(np.clip(n @ up, -1, 1)))
        if ang < 15.0:
            up = n
            up_source = "floor"
        else:
            plane = None
    R_up = rotation_between(up, TARGET_UP)
    # yaw: first camera's forward (projected onto the horizontal plane) -> +Z
    f = R_up @ c2ws[0][:3, 2]
    f[1] = 0.0
    if np.linalg.norm(f) > 1e-6:
        theta = np.arctan2(f[0], f[2])
        R_up = rot_y(-theta) @ R_up
    origin = np.median(C, axis=0)
    if plane is not None:
        n, d, _ = plane
        heights = C @ n + d
        med_h = float(np.median(heights))
        scale = cam_height / med_h
        scale_mode = "floor"
    else:
        steps = np.linalg.norm(np.diff(C, axis=0), axis=1)
        med = float(np.median(steps)) if len(steps) else 1.0
        scale = assumed_step / med if med > 1e-12 else 1.0
        scale_mode = "assumed"
    S = np.eye(4)
    S[:3, :3] = scale * R_up
    S[:3, 3] = -scale * R_up @ origin
    out = []
    for M in c2ws:
        N = np.eye(4)
        N[:3, :3] = R_up @ M[:3, :3]
        N[:3, 3] = S[:3, :3] @ M[:3, 3] + S[:3, 3]
        out.append(N)
    pts = None if points is None else (points @ S[:3, :3].T + S[:3, 3])
    floor_y = None
    if plane is not None:
        n, d, _ = plane
        # world y of floor below origin: distance from origin to plane, scaled (Y down)
        floor_y = float(scale * (origin @ n + d))
    return {"c2ws": out, "points": pts, "S": S, "scale": float(scale), "scale_mode": scale_mode,
            "up_source": up_source, "floor_y": floor_y}


def view_distance_matrix(c2ws, metres_per_radian=0.5):
    P = np.array([M[:3, 3] for M in c2ws])
    F = np.array([M[:3, 2] for M in c2ws])
    F = F / np.linalg.norm(F, axis=1, keepdims=True)
    dp = np.linalg.norm(P[:, None] - P[None], axis=2)
    ang = np.arccos(np.clip(F @ F.T, -1, 1))
    return dp + metres_per_radian * ang


def farthest_point_subset(c2ws, cap=40, metres_per_radian=0.5):
    """Farthest-point sampling seeded at the camera nearest the median position.
    Returns sorted indices (video order), len <= cap. Deterministic."""
    n = len(c2ws)
    if n <= cap:
        return list(range(n))
    D = view_distance_matrix(c2ws, metres_per_radian)
    P = np.array([M[:3, 3] for M in c2ws])
    seed = int(np.argmin(np.linalg.norm(P - np.median(P, axis=0), axis=1)))
    chosen = [seed]
    mind = D[seed].copy()
    while len(chosen) < cap:
        nxt = int(np.argmax(mind))  # argmax picks the lowest index on ties -> deterministic
        if mind[nxt] <= 0:
            break
        chosen.append(nxt)
        mind = np.minimum(mind, D[nxt])
    return sorted(chosen)


def is_rigid(M, tol=1e-5):
    M = np.asarray(M, float)
    R = M[:3, :3]
    return (M.shape == (4, 4) and np.allclose(M[3], [0, 0, 0, 1], atol=tol)
            and np.allclose(R @ R.T, np.eye(3), atol=tol) and abs(np.linalg.det(R) - 1) < tol)


def square_crop_intrinsics(fx, fy, cx, cy, w, h, size):
    s = min(w, h)
    x0, y0 = (w - s) // 2, (h - s) // 2
    k = size / s
    return fx * k, fy * k, (cx - x0) * k, (cy - y0) * k, x0, y0, s
