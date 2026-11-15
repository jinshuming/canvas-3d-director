"""How well a generated panorama follows its blockout, from the images alone (no 3D reconstruction).

The blockout's semantic map gives the edges that MUST appear in the panorama: object outlines and
the wall / floor / ceiling lines. For each such edge pixel, how far (in degrees of longitude) is the
nearest strong edge of the generated panorama? A busy, textured panorama has edges everywhere and
would look aligned by chance, so the same distance is also measured with the blockout turned by 90°
and 180° (where nothing should line up), and the score is the ratio:

    lift = (recall as placed - recall turned) / (1 - recall turned)

where recall = share of blockout edge pixels with a panorama edge within 1.5°, and the panorama's
edges are its strongest 8% gradients (the same density for every image). 0 = chance, 1 = perfect. Reported separately for object outlines and for
the room's own lines (shell).

    python -m panoalign <semantic.png> <panorama.png> [...more panoramas] [--json]
"""
import argparse
import json
import sys

import cv2
import numpy as np

SHELL = {(200, 200, 200), (120, 100, 80), (230, 230, 240), (110, 130, 80), (0, 0, 0), (255, 255, 255)}  # wall floor ceiling ground sky opening


def blockout_edges(sem_bgr):
    rgb = sem_bgr[:, :, ::-1].astype(np.int32)
    lab = rgb[:, :, 0] * 65536 + rgb[:, :, 1] * 256 + rgb[:, :, 2]
    shell_keys = {r * 65536 + g * 256 + b for r, g, b in SHELL}
    is_shell = np.isin(lab, list(shell_keys))
    edge = np.zeros(lab.shape, bool)
    diff_x = lab[:, 1:] != lab[:, :-1]
    diff_y = lab[1:, :] != lab[:-1, :]
    edge[:, 1:] |= diff_x
    edge[1:, :] |= diff_y
    # An edge belongs to an object when either side of it is an object.
    obj = ~is_shell
    near_obj = cv2.dilate(obj.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
    h = lab.shape[0]
    band = np.zeros_like(edge)
    band[int(h * 0.08):int(h * 0.92), :] = True  # the poles are stretched beyond use
    return edge & near_obj & band, edge & ~near_obj & band


EDGE_SHARE = 0.08   # every panorama gets the same edge density, so smooth and busy images compare fairly
TOL_DEG = 1.5


def image_edges(pano_bgr):
    g = cv2.cvtColor(pano_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 2.0)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    mag = np.hypot(gx, gy)
    return mag >= np.percentile(mag, 100 * (1 - EDGE_SHARE))


def score(sem_path, pano_path):
    sem = cv2.imread(sem_path)
    pano = cv2.imread(pano_path)
    h, w = sem.shape[:2]
    pano = cv2.resize(pano, (w, h), interpolation=cv2.INTER_AREA)
    obj_e, shell_e = blockout_edges(sem)
    edges = image_edges(pano)
    # Distance (px) to the nearest panorama edge, wrapping around the seam.
    pad = w // 4
    wrapped = np.concatenate([edges[:, -pad:], edges, edges[:, :pad]], axis=1)
    dist = cv2.distanceTransform((~wrapped).astype(np.uint8), cv2.DIST_L2, 5)[:, pad:pad + w]
    deg = 360.0 / w

    tol = TOL_DEG / deg

    def recall(mask):
        d = dist[mask]
        return float((d <= tol).mean()) if d.size else float('nan')

    out = {}
    for name, mask in (('objects', obj_e), ('shell', shell_e)):
        placed = recall(mask)
        chance = float(np.mean([recall(np.roll(mask, shift, axis=1)) for shift in (w // 4, w // 2, 3 * w // 4)]))
        # lift: how much more of the blockout's edges find an image edge than chance does (0 = none, 1 = all).
        lift = (placed - chance) / max(1e-6, 1 - chance)
        out[name] = {'recall': round(placed, 3), 'chance': round(chance, 3), 'lift': round(lift, 3)}
    out['edgeDensity'] = round(float(edges.mean()), 4)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('semantic')
    ap.add_argument('panos', nargs='+')
    a = ap.parse_args()
    res = {p: score(a.semantic, p) for p in a.panos}
    json.dump(res, sys.stdout, indent=1)
    print()


if __name__ == '__main__':
    main()
