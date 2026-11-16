/**
 * Does the generated scene follow the blockout? Measured, not judged:
 * from the capture point, bin the splat centres by direction, take the near
 * surface in each bin, and compare it with the blockout's ray distance in the
 * same direction. Also where the floor ended up.
 */
import { basis, dirToEquirect, sub } from './frame.ts';
import type { CameraPose } from './frame.ts';
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

/**
 * The splat centres' distances from the capture point, binned by direction on a W × H equirect grid
 * (at most 64 per bin; only rows `keepRow` accepts).
 */
function distanceBins(points: SpzPoints, W: number, H: number, pose: CameraPose, keepRow: (iv: number) => boolean = () => true): Map<number, number[]> {
  const b = basis(pose);
  const o = pose.position;
  const bins = new Map<number, number[]>();
  for (let i = 0; i < points.count; i++) {
    if (points.alphas[i]! < 0.35) continue;
    const d = sub([points.positions[i * 3]!, points.positions[i * 3 + 1]!, points.positions[i * 3 + 2]!], o);
    const dist = Math.hypot(...d);
    if (dist < 0.05 || dist > 200) continue;
    const [u, v] = dirToEquirect([d[0] / dist, d[1] / dist, d[2] / dist], W, H, b);
    const iv = Math.max(0, Math.min(H - 1, Math.round(v)));
    if (!keepRow(iv)) continue;
    const k = iv * W + (((Math.round(u) % W) + W) % W);
    const bk = bins.get(k) ?? [];
    if (bk.length < 64) bk.push(dist);
    bins.set(k, bk);
  }
  return bins;
}

/** A bin's near surface: the 10th percentile of its distances (null under 4 samples). Sorts `bk`. */
function nearSurface(bk: number[]): number | null {
  if (bk.length < 4) return null;
  bk.sort((a, c) => a - c);
  return bk[Math.floor(bk.length * 0.1)]!;
}

export function measureAlignment(points: SpzPoints, blockout: EquirectBuffers, pose: CameraPose): Alignment {
  const { width: W, height: H } = blockout;
  const o = pose.position;
  const near = new Float32Array(W * H).fill(Infinity);
  for (const [k, bk] of distanceBins(points, W, H, pose)) near[k] = nearSurface(bk) ?? Infinity;
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

/**
 * How big the environment came out against the blockout, horizontally: the median, over the
 * directions near the horizon that hit a WALL in the blockout (not an object, an opening, the floor
 * or the ceiling), of the scene's near-surface distance over the blockout's. The image model and
 * JST-2 often build the room a little smaller or larger than drawn (measured: 0.88 on the café,
 * with the floor height right); an object placed by the blockout against a wall then ends up inside
 * or behind the scene's wall. null when too few directions see a wall (outdoors).
 */
export function horizontalScale(points: SpzPoints, blockout: EquirectBuffers, pose: CameraPose): number | null {
  const { width: W, height: H } = blockout;
  const v0 = Math.floor(H * 0.42), v1 = Math.ceil(H * 0.58);
  const wall = new Set(blockout.classes.map((c, k) => (c === 'wall' ? k : -1)).filter((k) => k >= 0));
  const ratios: number[] = [];
  for (const [k, bk] of distanceBins(points, W, H, pose, (iv) => iv >= v0 && iv <= v1)) {
    const bt = blockout.dist[k]!;
    if (!Number.isFinite(bt) || blockout.obj[k]! >= 0 || !wall.has(blockout.cls[k]!)) continue;
    const st = nearSurface(bk);
    if (st !== null) ratios.push(st / bt);
  }
  if (ratios.length < 20) return null;
  ratios.sort((a, c) => a - c);
  return ratios[Math.floor(ratios.length / 2)]!;
}
