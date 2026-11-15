/**
 * Does the generated scene follow the blockout? Measured, not judged:
 * from the capture point, bin the splat centres by direction, take the near
 * surface in each bin, and compare it with the blockout's ray distance in the
 * same direction. Also where the floor ended up.
 */
import { basis, dirToEquirect, sub } from './frame.ts';
import type { CameraPose, Vec3 } from './frame.ts';
import type { EquirectBuffers } from './render.ts';
import { OPEN_CLASSES } from './render.ts';
import type { SpzPoints } from './spz.ts';
import { distanceToFloor } from './spz.ts';

export interface Alignment {
  /** Floor height under the capture point in the scene, metres (0 = on the blockout floor). */
  floorY: number | null;
  /** Directions compared (bins with both a blockout surface and splats). */
  bins: number;
  /** Median |log(scene / blockout)| of the near-surface distance: 0 = identical, 0.22 ≈ 25 % off. */
  medianLogError: number;
  /** Share of directions within 25 % of the blockout distance. */
  within25: number;
  /** The same but only for directions that hit a layout object (not walls / floor / ground). */
  objectsWithin25: number;
}

export function measureAlignment(points: SpzPoints, blockout: EquirectBuffers, pose: CameraPose): Alignment {
  const { width: W, height: H } = blockout;
  const b = basis(pose);
  const o = pose.position;
  // Per bin: a small sample of distances, from which the 10th percentile is the near surface.
  const near = new Float32Array(W * H).fill(Infinity);
  const buckets: number[][] = Array.from({ length: W * H }, () => []);
  for (let i = 0; i < points.count; i++) {
    if (points.alphas[i]! < 0.35) continue;
    const p: Vec3 = [points.positions[i * 3]!, points.positions[i * 3 + 1]!, points.positions[i * 3 + 2]!];
    const d = sub(p, o);
    const dist = Math.hypot(...d);
    if (dist < 0.05 || dist > 200) continue;
    const [u, v] = dirToEquirect([d[0] / dist, d[1] / dist, d[2] / dist], W, H, b);
    const iu = ((Math.round(u) % W) + W) % W, iv = Math.max(0, Math.min(H - 1, Math.round(v)));
    const bk = buckets[iv * W + iu]!;
    if (bk.length < 64) bk.push(dist);
  }
  for (let i = 0; i < W * H; i++) {
    const bk = buckets[i]!;
    if (bk.length < 4) continue;
    bk.sort((a, c) => a - c);
    near[i] = bk[Math.floor(bk.length * 0.1)]!;
  }
  const errs: number[] = [];
  let ok = 0, objN = 0, objOk = 0;
  // What a window, a door or the sky shows has no blockout distance (it is a placeholder): leave it out.
  const open = new Set(blockout.classes.map((c, k) => (OPEN_CLASSES.has(c) ? k : -1)).filter((k) => k >= 0));
  for (let v = 0; v < H; v++) {
    // Skip the poles: equirect bins there are tiny and noisy.
    if (v < H * 0.1 || v > H * 0.9) continue;
    for (let u = 0; u < W; u++) {
      const i = v * W + u;
      const bt = blockout.dist[i]!, st = near[i]!;
      if (!Number.isFinite(bt) || !Number.isFinite(st) || bt > 40 || open.has(blockout.cls[i]!)) continue;
      const e = Math.abs(Math.log(st / bt));
      errs.push(e);
      const good = e < Math.log(1.25);
      if (good) ok++;
      if (blockout.obj[i]! >= 0) { objN++; if (good) objOk++; }
    }
  }
  errs.sort((a, c) => a - c);
  const fd = distanceToFloor(points, o, [0, -1, 0], { radius: 0.3 });
  return {
    floorY: fd === null ? null : Math.round((o[1] - fd) * 100) / 100,
    bins: errs.length,
    medianLogError: errs.length ? Math.round(errs[Math.floor(errs.length / 2)]! * 1000) / 1000 : NaN,
    within25: errs.length ? Math.round((ok / errs.length) * 1000) / 1000 : 0,
    objectsWithin25: objN ? Math.round((objOk / objN) * 1000) / 1000 : 0,
  };
}
