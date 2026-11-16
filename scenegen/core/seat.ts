/**
 * Seat SAM 3D objects in their scene: upright, on what they stand on, never stretched.
 *
 *  - UPRIGHT: SAM 3D poses an object in the frame of the crop it saw, and a little error in that
 *    frame tilts it. The object's support - the bottom of its splats (a cabinet's base, a chair's
 *    four feet) - should be level: fit a plane to it and, for a tilt between 0.5° and 20°, turn the
 *    object about its base so the plane is horizontal. A bigger "tilt" is not a tilt (a lying
 *    object, a bottom with no support) and is left alone.
 *  - ON THE GROUND: where the scene's floor actually is under the object - from the walk collider
 *    the Viggle Splat Engine builds from the environment's splats (PINOC's algorithm: the splats
 *    in a band around the floor, voxelized into an occupancy grid; the floor of a column is its
 *    topmost solid cell) - not where the blockout said it would be. A thing standing ON another
 *    (a lamp on a desk) sits on the top of that object's splats inside its own footprint.
 *  - NOT STRETCHED: only rotations and translations here; the size was set once, uniformly.
 *
 * Positions are in the scene file's frame: capture point at the origin, metres, Y up.
 */
import type { Gaussians, Mat3 } from './gaussians.ts';
import { transformGaussians } from './gaussians.ts';

export interface SeatResult { tiltDeg: number; straightened: boolean; dy: number; support: 'floor' | 'object' | 'none' }

/** The y below which `share` of the opaque splats lie. */
function quantileY(g: Gaussians, share: number, inside?: (x: number, z: number) => boolean): number | null {
  const ys: number[] = [];
  for (let i = 0; i < g.count; i++) {
    if (g.alphas[i]! < 0.3) continue;
    if (inside && !inside(g.positions[i * 3]!, g.positions[i * 3 + 2]!)) continue;
    ys.push(g.positions[i * 3 + 1]!);
  }
  if (ys.length < 50) return null;
  ys.sort((a, b) => a - b);
  return ys[Math.min(ys.length - 1, Math.floor(ys.length * share))]!;
}

export function footprint(g: Gaussians): { cx: number; cz: number; hx: number; hz: number } {
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < g.count; i += 3) if (g.alphas[i]! >= 0.3) { xs.push(g.positions[i * 3]!); zs.push(g.positions[i * 3 + 2]!); }
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const q = (v: number[], s: number) => v[Math.min(v.length - 1, Math.floor(v.length * s))]!;
  const x0 = q(xs, 0.02), x1 = q(xs, 0.98), z0 = q(zs, 0.02), z1 = q(zs, 0.98);
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
}

/**
 * The plane through the object's support: per cell of a 12 × 12 grid over its footprint, the
 * lowest opaque splat; then y = a·x + b·z + c by least squares over the cells near the bottom.
 */
export function supportTilt(g: Gaussians): { normal: [number, number, number]; tiltDeg: number } | null {
  const f = footprint(g);
  const N = 12, low = new Float64Array(N * N).fill(Infinity), lx = new Float64Array(N * N), lz = new Float64Array(N * N);
  for (let i = 0; i < g.count; i++) {
    if (g.alphas[i]! < 0.3) continue;
    const x = g.positions[i * 3]!, y = g.positions[i * 3 + 1]!, z = g.positions[i * 3 + 2]!;
    const u = Math.floor(((x - f.cx) / (2 * f.hx) + 0.5) * N), v = Math.floor(((z - f.cz) / (2 * f.hz) + 0.5) * N);
    if (u < 0 || v < 0 || u >= N || v >= N) continue;
    const k = v * N + u;
    if (y < low[k]!) { low[k] = y; lx[k] = x; lz[k] = z; }
  }
  const cells: Array<[number, number, number]> = [];
  for (let k = 0; k < N * N; k++) if (Number.isFinite(low[k]!)) cells.push([lx[k]!, low[k]!, lz[k]!]);
  if (cells.length < 8) return null;
  // Only the cells near the bottom are support (a table's top seen from below is not).
  const ys = cells.map((c) => c[1]).sort((a, b) => a - b);
  const cut = ys[Math.floor(ys.length * 0.1)]! + Math.max(0.03, (ys[ys.length - 1]! - ys[0]!) * 0.15);
  const sup = cells.filter((c) => c[1] <= cut);
  if (sup.length < 4) return null;
  // Least squares for y = a x + b z + c.
  let sxx = 0, sxz = 0, szz = 0, sx = 0, sz = 0, sy = 0, sxy = 0, szy = 0;
  for (const [x, y, z] of sup) { sxx += x * x; sxz += x * z; szz += z * z; sx += x; sz += z; sy += y; sxy += x * y; szy += z * y; }
  const n = sup.length;
  const M = [[sxx, sxz, sx], [sxz, szz, sz], [sx, sz, n]], r = [sxy, szy, sy];
  const det = (m: number[][]) => m[0]![0]! * (m[1]![1]! * m[2]![2]! - m[1]![2]! * m[2]![1]!) - m[0]![1]! * (m[1]![0]! * m[2]![2]! - m[1]![2]! * m[2]![0]!) + m[0]![2]! * (m[1]![0]! * m[2]![1]! - m[1]![1]! * m[2]![0]!);
  const D = det(M);
  if (Math.abs(D) < 1e-9) return null;
  const col = (j: number) => M.map((row, i) => row.map((v, k) => (k === j ? r[i]! : v)));
  const a = det(col(0)) / D, b = det(col(1)) / D;
  const l = Math.hypot(a, 1, b);
  const normal: [number, number, number] = [-a / l, 1 / l, -b / l];
  return { normal, tiltDeg: (Math.acos(Math.min(1, normal[1])) * 180) / Math.PI };
}

/** Rotation taking unit vector n onto +Y (Rodrigues). */
export function rotationToUp(n: [number, number, number]): Mat3 {
  const [x, y, z] = n;
  // axis = n × up = (-z, 0, x) normalised; angle = acos(y)
  const s = Math.hypot(x, z), c = y;
  if (s < 1e-9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const kx = -z / s, kz = x / s; // ky = 0
  const t = 1 - c;
  return [
    [c + kx * kx * t, -kz * s, kx * kz * t],
    [kz * s, c, -kx * s],
    [kx * kz * t, kx * s, c + kz * kz * t],
  ];
}

/** Level the object's support if it is tilted a little; about its base centre. */
export function straighten(g: Gaussians, maxDeg = 20): { tiltDeg: number; straightened: boolean } {
  const t = supportTilt(g);
  if (!t) return { tiltDeg: 0, straightened: false };
  if (t.tiltDeg < 0.5 || t.tiltDeg > maxDeg) return { tiltDeg: t.tiltDeg, straightened: false };
  const f = footprint(g);
  const base = quantileY(g, 0.02) ?? 0;
  const R = rotationToUp(t.normal);
  // About the base centre: move it to the origin, rotate, move back.
  transformGaussians(g, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1, [-f.cx, -base, -f.cz]);
  transformGaussians(g, R, 1, [f.cx, base, f.cz]);
  return { tiltDeg: t.tiltDeg, straightened: true };
}

/** The object's bottom (2nd percentile of its opaque splats' heights). */
export const bottomOf = (g: Gaussians) => quantileY(g, 0.02);

/** The top of `under` inside `on`'s footprint (98th percentile there): what a lamp on a desk stands on. */
export function topWithin(under: Gaussians, on: Gaussians): number | null {
  const f = footprint(on);
  return quantileY(under, 0.98, (x, z) => Math.abs(x - f.cx) <= f.hx && Math.abs(z - f.cz) <= f.hz);
}

/** Move an object vertically so its bottom is at `y`. */
export function dropTo(g: Gaussians, y: number): number {
  const b = bottomOf(g);
  if (b === null) return 0;
  const dy = y - b;
  transformGaussians(g, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1, [0, dy, 0]);
  return dy;
}

/** Move `on` horizontally, the least distance, so its footprint lies within `under`'s. */
export function centreOver(on: Gaussians, under: Gaussians): [number, number] {
  const a = footprint(on), b = footprint(under);
  const clamp = (v: number, lo: number, hi: number) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
  const x = clamp(a.cx, b.cx - b.hx + a.hx, b.cx + b.hx - a.hx), z = clamp(a.cz, b.cz - b.hz + a.hz, b.cz + b.hz - a.hz);
  const d: [number, number] = [x - a.cx, z - a.cz];
  if (d[0] || d[1]) transformGaussians(on, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1, [d[0], 0, d[1]]);
  return d;
}
