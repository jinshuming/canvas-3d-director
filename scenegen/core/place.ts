/**
 * Place a SAM 3D object where the blockout says, as a search instead of a guess.
 *
 * SAM 3D poses an object in a camera it estimates for itself (its own focal length, its own idea of
 * which way is down), and our crops - 30° to 110° wide, looking down from eye height - throw that
 * estimate off: every object came in tilted 2-8°, and now and then one lies on its side (an office
 * chair at 75°) or is turned a quarter so its width and depth swap. So nothing about its pose is
 * trusted outright:
 *
 *  1. CLEAN: only the object's body is kept - the largest connected lumps of its opaque splats - and,
 *     once it stands upright, the thin floor patch SAM 3D often paints under it. Floaters and the
 *     patch otherwise pull the bounds, so the size, the centre and the bottom.
 *  2. UPRIGHT: which of its own six axes is up - the one whose height and footprint match the
 *     blockout box (yaw-free: footprint as its minimum-area rectangle); SAM 3D's own up wins unless
 *     another fits half again better. Then the support plane (seat.ts) is levelled.
 *  3. FACING: the turn about the vertical that squares the object with the blockout box (the least
 *     footprint area in the box's axes), then which quarter: SAM 3D's heading unless the box's size
 *     or the painted crop's silhouette (seen from the crop camera) clearly says a quarter turn.
 *     Half turns are never taken from geometry: a chair's back and front have the same box.
 *  4. SIZE AND PLACE: one uniform scale, the median of the three size ratios; the base centre on the
 *     blockout's footprint centre (with the environment's horizontal scale, if it has one).
 *
 * Everything is worked out on a sample of points and applied to the splats once, as one rigid turn,
 * one scale and one move: nothing is stretched. Positions are in the scene file's frame: capture
 * point at the origin, metres, Y up.
 */
import type { CameraPose } from './frame.ts';
import { basis } from './frame.ts';
import type { Gaussians, Mat3 } from './gaussians.ts';
import { pick, transformGaussians } from './gaussians.ts';
import { supportTilt } from './seat.ts';
import type { LayoutObject } from './types.ts';

const I: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export const mul = (a: Mat3, b: Mat3): Mat3 => [0, 1, 2].map((r) => [0, 1, 2].map((c) => a[r]![0]! * b[0]![c]! + a[r]![1]! * b[1]![c]! + a[r]![2]! * b[2]![c]!)) as Mat3;

/** Turn about +Y by `deg` (x towards -z for positive angles, like the blockout's yaw turning the front from +Z to +X). */
export function rotY(deg: number): Mat3 {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]];
}

/** The six turns that put one of an object's axes up: +Y (none), -Y, +X, -X, +Z, -Z. */
const UPS: Array<{ name: string; R: Mat3 }> = [
  { name: 'kept', R: I },
  { name: '-y', R: [[1, 0, 0], [0, -1, 0], [0, 0, -1]] },
  { name: '+x', R: [[0, 1, 0], [-1, 0, 0], [0, 0, 1]] },
  { name: '-x', R: [[0, -1, 0], [1, 0, 0], [0, 0, 1]] },
  { name: '+z', R: [[1, 0, 0], [0, 0, 1], [0, -1, 0]] },
  { name: '-z', R: [[1, 0, 0], [0, 0, -1], [0, 1, 0]] },
];

/** Points of a sample, as a thin Gaussians (what seat.ts reads: positions and alphas). */
function asGaussians(p: Float32Array): Gaussians {
  const n = p.length / 3;
  return { count: n, positions: p, alphas: new Float32Array(n).fill(1), scales: new Float32Array(0), rotations: new Float32Array(0), colors: new Float32Array(0) };
}

function apply(R: Mat3, p: Float32Array): Float32Array {
  const o = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    o[i] = R[0][0] * x + R[0][1] * y + R[0][2] * z;
    o[i + 1] = R[1][0] * x + R[1][1] * y + R[1][2] * z;
    o[i + 2] = R[2][0] * x + R[2][1] * y + R[2][2] * z;
  }
  return o;
}

function quant(v: number[], q: number): number {
  return v[Math.min(v.length - 1, Math.max(0, Math.floor(v.length * q)))]!;
}

/** Trimmed extent (2-98%) of the points along an axis. */
function extent(p: Float32Array, axis: number): { lo: number; hi: number } {
  const v: number[] = [];
  for (let i = axis; i < p.length; i += 3) v.push(p[i]!);
  v.sort((a, b) => a - b);
  return { lo: quant(v, 0.02), hi: quant(v, 0.98) };
}

/** Extents of points turned by `deg` about Y: width (x) and depth (z). */
function footprintAt(p: Float32Array, deg: number): [number, number] {
  const c = Math.cos((deg * Math.PI) / 180), s = Math.sin((deg * Math.PI) / 180);
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < p.length; i += 3) { xs.push(c * p[i]! + s * p[i + 2]!); zs.push(-s * p[i]! + c * p[i + 2]!); }
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  return [quant(xs, 0.98) - quant(xs, 0.02), quant(zs, 0.98) - quant(zs, 0.02)];
}

/** max / min of the ratios between the blockout's size and the object's: 1 when the shape matches. */
export function spreadOf(size: [number, number, number], dims: [number, number, number]): number {
  const r = [0, 1, 2].map((k) => size[k]! / Math.max(1e-6, dims[k]!));
  return Math.max(...r) / Math.min(...r);
}

// ── 1. Clean ─────────────────────────────────────────────────────────────────

/**
 * The object's body: its opaque splats voxelised (48 cells across), the connected lumps (26
 * neighbours) at least 15% the size of the largest kept, everything else dropped - faint splats
 * too, unless they sit in or next to a kept cell. Returns the kept indices.
 *
 * With `size` (the blockout box: width, height, depth) and more than one big lump - SAM 3D sometimes
 * returns what stood next to the object too (a chair with the table it was tucked under) - only the
 * lump whose proportions match the box is kept, or all of them if together they match better.
 */
export function bodyIndices(g: Gaussians, size?: [number, number, number]): { keep: number[]; removed: number } {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < g.count; i++) {
    if (g.alphas[i]! < 0.3) continue;
    const x = g.positions[i * 3]!, y = g.positions[i * 3 + 1]!, z = g.positions[i * 3 + 2]!;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  if (!Number.isFinite(x0)) return { keep: Array.from({ length: g.count }, (_, i) => i), removed: 0 };
  const v = Math.max(x1 - x0, y1 - y0, z1 - z0) / 48 || 1;
  const key = (i: number) => {
    const a = Math.floor((g.positions[i * 3]! - x0) / v), b = Math.floor((g.positions[i * 3 + 1]! - y0) / v), c = Math.floor((g.positions[i * 3 + 2]! - z0) / v);
    return (a + 2) * 4_000_000 + (b + 2) * 2_000 + (c + 2);
  };
  const count = new Map<number, number>();
  for (let i = 0; i < g.count; i++) if (g.alphas[i]! >= 0.3) { const k = key(i); count.set(k, (count.get(k) ?? 0) + 1); }
  const occupied = new Set([...count].filter(([, n]) => n >= 2).map(([k]) => k));
  const comp = new Map<number, number>();
  const sizes: number[] = [];
  for (const k of occupied) {
    if (comp.has(k)) continue;
    const id = sizes.length;
    let n = 0;
    const stack = [k];
    comp.set(k, id);
    while (stack.length) {
      const c = stack.pop()!;
      n++;
      for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) {
        const nb = c + da * 4_000_000 + db * 2_000 + dc;
        if (occupied.has(nb) && !comp.has(nb)) { comp.set(nb, id); stack.push(nb); }
      }
    }
    sizes.push(n);
  }
  const biggest = Math.max(0, ...sizes);
  let big = sizes.map((n, id) => (n >= biggest * 0.15 ? id : -1)).filter((id) => id >= 0);
  if (size && big.length > 1) {
    // Proportions, turn-free: the three extents sorted against the box's sorted.
    const box = [...size].sort((a, b) => b - a);
    const ext = (ids: Set<number>) => {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const [k, id] of comp) {
        if (!ids.has(id)) continue;
        const c = [Math.floor(k / 4_000_000), Math.floor((k % 4_000_000) / 2_000), k % 2_000];
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, c[a]!); hi[a] = Math.max(hi[a]!, c[a]! + 1); }
      }
      const d = [0, 1, 2].map((a) => hi[a]! - lo[a]!).sort((a, b) => b - a) as [number, number, number];
      return spreadOf(box as [number, number, number], d);
    };
    const options = [new Set(big), ...big.map((id) => new Set([id]))];
    const best = options.reduce((a, b) => (ext(b) < ext(a) * 0.8 ? b : a));
    big = [...best];
  }
  const keepIds = new Set(big);
  const kept = new Set<number>();
  for (const [k, id] of comp) if (keepIds.has(id)) kept.add(k);
  const near = (k: number) => {
    if (kept.has(k)) return true;
    for (let da = -1; da <= 1; da++) for (let db = -1; db <= 1; db++) for (let dc = -1; dc <= 1; dc++) if (kept.has(k + da * 4_000_000 + db * 2_000 + dc)) return true;
    return false;
  };
  const keep: number[] = [];
  for (let i = 0; i < g.count; i++) {
    const k = key(i);
    if (g.alphas[i]! >= 0.3 ? kept.has(k) : near(k)) keep.push(i);
  }
  return { keep, removed: 1 - keep.length / Math.max(1, g.count) };
}

/**
 * The floor patch under an upright object (its points `up`, Y up): splats in the bottom 5% of its
 * height that lie outside the footprint of the body above (the part above 15% of the height),
 * widened by 8%. Returns the indices to drop - none if that would be more than 15% of the object.
 */
export function floorPatch(up: Float32Array, alphas: Float32Array): number[] {
  const n = up.length / 3;
  const ys: number[] = [];
  for (let i = 0; i < n; i++) if (alphas[i]! >= 0.3) ys.push(up[i * 3 + 1]!);
  if (ys.length < 100) return [];
  ys.sort((a, b) => a - b);
  const lo = quant(ys, 0.02), h = quant(ys, 0.98) - lo;
  const xs: number[] = [], zs: number[] = [];
  for (let i = 0; i < n; i++) if (alphas[i]! >= 0.3 && up[i * 3 + 1]! > lo + 0.15 * h) { xs.push(up[i * 3]!); zs.push(up[i * 3 + 2]!); }
  if (xs.length < 50) return [];
  xs.sort((a, b) => a - b); zs.sort((a, b) => a - b);
  const bx0 = quant(xs, 0.01), bx1 = quant(xs, 0.99), bz0 = quant(zs, 0.01), bz1 = quant(zs, 0.99);
  const mx = (bx1 - bx0) * 0.08, mz = (bz1 - bz0) * 0.08;
  const drop: number[] = [];
  for (let i = 0; i < n; i++) {
    if (up[i * 3 + 1]! > lo + 0.05 * h) continue;
    const x = up[i * 3]!, z = up[i * 3 + 2]!;
    if (x < bx0 - mx || x > bx1 + mx || z < bz0 - mz || z > bz1 + mz) drop.push(i);
  }
  return drop.length <= 0.15 * n ? drop : [];
}

// ── Silhouette ───────────────────────────────────────────────────────────────

export const MASK_GRID = 128;

/** Where the points fall in a crop camera at the capture point (the file frame's origin), on a MASK_GRID² grid. */
export function silhouette(p: Float32Array, crop: CameraPose, fov: number): Uint8Array {
  const N = MASK_GRID, out = new Uint8Array(N * N);
  const { right, up, forward } = basis(crop);
  const f = N / 2 / Math.tan(((fov / 2) * Math.PI) / 180);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    const d = x * forward[0] + y * forward[1] + z * forward[2];
    if (d <= 0.05) continue;
    const u = Math.floor(N / 2 + (f * (x * right[0] + y * right[1] + z * right[2])) / d);
    const v = Math.floor(N / 2 - (f * (x * up[0] + y * up[1] + z * up[2])) / d);
    if (u >= 0 && v >= 0 && u < N && v < N) out[v * N + u] = 1;
  }
  // Close the gaps between sampled points: one cell of dilation.
  const d = new Uint8Array(N * N);
  for (let v = 0; v < N; v++) for (let u = 0; u < N; u++) {
    if (!out[v * N + u]) continue;
    for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) { const a = u + du, b = v + dv; if (a >= 0 && b >= 0 && a < N && b < N) d[b * N + a] = 1; }
  }
  return d;
}

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0, uni = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] && b[i]) inter++; if (a[i] || b[i]) uni++; }
  return uni ? inter / uni : 0;
}

// ── Level ────────────────────────────────────────────────────────────────────

/** Turn about X by `a`, then about Z by `b`, degrees. */
function tiltR(a: number, b: number): Mat3 {
  const ra = (a * Math.PI) / 180, rb = (b * Math.PI) / 180;
  const X: Mat3 = [[1, 0, 0], [0, Math.cos(ra), -Math.sin(ra)], [0, Math.sin(ra), Math.cos(ra)]];
  const Z: Mat3 = [[Math.cos(rb), -Math.sin(rb), 0], [Math.sin(rb), Math.cos(rb), 0], [0, 0, 1]];
  return mul(Z, X);
}

/** How sharply the points' heights stack into thin layers: the sum of squared bin shares, every point counted. */
function layering(p: Float32Array, R: Mat3, bin: number): number {
  const h = new Map<number, number>();
  const n = p.length / 3;
  for (let i = 0; i < p.length; i += 3) {
    const k = Math.floor((R[1][0] * p[i]! + R[1][1] * p[i + 1]! + R[1][2] * p[i + 2]!) / bin);
    h.set(k, (h.get(k) ?? 0) + 1);
  }
  let s = 0;
  for (const c of h.values()) s += (c / Math.max(1, n)) ** 2;
  return s;
}

/**
 * The small tilt (within ±20°) that levels an object, found by search: the one under which its
 * horizontal surfaces - a table's top, a chair's seat, a cabinet's base and top - are thinnest in
 * height, so its height histogram is sharpest. (A plane fitted to its lowest points, tried first,
 * reads a badly tilted table by the legs on its low side only and can tilt it further.) Nothing
 * flat to go by (a plant, a lamp): no tilt that sharpens by 10% - left as it is.
 */
export function levelTilt(p: Float32Array): { R: Mat3; deg: number } | null {
  const sub: number[] = [];
  const stride = Math.max(1, Math.floor(p.length / 3 / 12_000));
  for (let i = 0; i < p.length; i += 3 * stride) sub.push(p[i]!, p[i + 1]!, p[i + 2]!);
  const q = new Float32Array(sub);
  const e = extent(q, 1);
  const bin = Math.max(0.05, e.hi - e.lo) / 150;
  const base = layering(q, I, bin);
  let best = { a: 0, b: 0, s: base };
  for (let a = -20; a <= 20; a += 2) for (let b = -20; b <= 20; b += 2) {
    const s = layering(q, tiltR(a, b), bin);
    if (s > best.s) best = { a, b, s };
  }
  const ca = best.a, cb = best.b;
  for (let a = ca - 2; a <= ca + 2; a += 0.5) for (let b = cb - 2; b <= cb + 2; b += 0.5) {
    const s = layering(q, tiltR(a, b), bin);
    if (s > best.s) best = { a, b, s };
  }
  if (best.s < base * 1.1 || (best.a === 0 && best.b === 0)) return null;
  const R = tiltR(best.a, best.b);
  // A levelled object fits a smaller box than a tilted one; leaves or a soft shape that happened to
  // stack into a layer when tipped (a plant tipped 30°) fit a bigger one: not a levelling.
  const volume = (M: Mat3) => {
    const t = apply(M, q), ey = extent(t, 1);
    let a = Infinity;
    for (let d = 0; d < 90; d += 6) { const [w, dd] = footprintAt(t, d); a = Math.min(a, w * dd); }
    return (ey.hi - ey.lo) * a;
  };
  if (volume(R) > volume(I) * 0.99) return null;
  return { R, deg: (Math.acos(Math.min(1, R[1][1])) * 180) / Math.PI };
}

// ── The placement ────────────────────────────────────────────────────────────

export interface PlaceContext {
  /** The blockout's capture point (world); the file frame has it at the origin. */
  capture: [number, number, number];
  /** The environment's horizontal scale against the blockout (textScene shiftOf), if it differs. */
  shift?: number | null;
  /** The camera of the crop SAM 3D saw, and the painted object's silhouette in it (MASK_GRID²), if known. */
  crop?: { pose: CameraPose; fov: number; mask: Uint8Array | null } | null;
}

export interface PlaceResult {
  /** Share of the splats dropped as floaters or floor patch. */
  removed: number;
  /** Which axis was turned up ('kept': SAM 3D's own). */
  up: string;
  /** The support plane's tilt that was levelled, degrees (0: none). */
  tiltDeg: number;
  /** Turn about the vertical from SAM 3D's heading, degrees. */
  yawDeg: number;
  /** Shape vs the blockout box after placing (1 = same proportions). */
  spread: number;
  scale: number;
  /** Silhouette overlap with the painted object in the crop camera (null: no mask). */
  iou: number | null;
  /**
   * Its shape does not fit the blockout box even placed as well as it can be (spread above 2.5): SAM 3D
   * most likely gave something else (a board, a sparse smear). For regenerating, not for placing.
   */
  suspect: boolean;
}

/**
 * Place `g` (in place - it is replaced by the cleaned splats; use the returned Gaussians) for the
 * blockout object `obj`. `g` may be in any frame that is a rigid turn and a scale away from right:
 * SAM 3D's turned into the world through the crop camera, or an object placed before.
 */
export function placeObject(g0: Gaussians, obj: LayoutObject, ctx: PlaceContext): { g: Gaussians; result: PlaceResult } {
  // 1. The body.
  const body = bodyIndices(g0, obj.size);
  let g = body.removed > 0 ? pick(g0, body.keep) : g0;
  const sampleIdx: number[] = [];
  const opaque: number[] = [];
  for (let i = 0; i < g.count; i++) if (g.alphas[i]! >= 0.3) opaque.push(i);
  const stride = Math.max(1, Math.floor(opaque.length / 30_000));
  for (let k = 0; k < opaque.length; k += stride) sampleIdx.push(opaque[k]!);
  let cx = 0, cy = 0, cz = 0;
  for (const i of sampleIdx) { cx += g.positions[i * 3]!; cy += g.positions[i * 3 + 1]!; cz += g.positions[i * 3 + 2]!; }
  const n = Math.max(1, sampleIdx.length);
  const c0: [number, number, number] = [cx / n, cy / n, cz / n];
  const P = new Float32Array(sampleIdx.length * 3);
  sampleIdx.forEach((i, k) => { P[k * 3] = g.positions[i * 3]! - c0[0]; P[k * 3 + 1] = g.positions[i * 3 + 1]! - c0[1]; P[k * 3 + 2] = g.positions[i * 3 + 2]! - c0[2]; });

  // 2. Upright: the axis whose height and (yaw-free) footprint match the box.
  const sortedSize = (a: number, b: number): [number, number] => (a >= b ? [a, b] : [b, a]);
  const [boxBig, boxSmall] = sortedSize(obj.size[0], obj.size[2]);
  const upScore = (R: Mat3) => {
    const q = apply(R, P);
    const e = extent(q, 1);
    let best = Infinity, fb: [number, number] = [1, 1];
    for (let d = 0; d < 90; d += 6) { const [w, dd] = footprintAt(q, d); if (w * dd < best) { best = w * dd; fb = sortedSize(w, dd); } }
    return spreadOf([obj.size[1], boxBig, boxSmall], [e.hi - e.lo, fb[0], fb[1]]);
  };
  // Size alone is not enough to turn an object over (a chair SAM 3D gave with its table fits a chair's
  // box better lying down): SAM 3D's own up stays unless it has no level base to stand on (a chair
  // at 75°), or another up - with a level base - fits the box more than twice as well.
  const level = (R: Mat3) => { const t = supportTilt(asGaussians(apply(R, P))); return Boolean(t && t.tiltDeg <= 20); };
  const scored = UPS.map((u) => ({ ...u, s: upScore(u.R), level: level(u.R) }));
  const kept = scored[0]!;
  const alts = scored.slice(1).filter((u) => u.level);
  // Upside down fits the same box and stands as level: among ups that fit about as well, the one
  // that touches the floor with less than its top has (legs down, the top up).
  const bottomHeavy = (R: Mat3) => {
    const q = apply(R, P), e = extent(q, 1), h = e.hi - e.lo, cell = Math.max(h, 0.05) / 25;
    const lowC = new Set<number>(), highC = new Set<number>();
    for (let i = 0; i < q.length; i += 3) {
      const y = q[i + 1]!, k = Math.floor(q[i]! / cell) * 100_000 + Math.floor(q[i + 2]! / cell);
      if (y <= e.lo + 0.06 * h) lowC.add(k); else if (y >= e.hi - 0.06 * h) highC.add(k);
    }
    return lowC.size / Math.max(1, highC.size);
  };
  const bestS = alts.length ? Math.min(...alts.map((u) => u.s)) : Infinity;
  const near = alts.filter((u) => u.s <= bestS * 1.1);
  const alt = near.length ? near.reduce((a, b) => (bottomHeavy(b.R) < bottomHeavy(a.R) ? b : a)) : null;
  const upChoice = alt && ((!kept.level && alt.s < kept.s) || alt.s * 2 < kept.s) ? alt : kept;
  let R = upChoice.R;

  // The floor patch, once upright (on every splat of the object, not just the sample).
  {
    const all = new Float32Array(g.count * 3);
    for (let i = 0; i < g.count; i++) { all[i * 3] = g.positions[i * 3]! - c0[0]; all[i * 3 + 1] = g.positions[i * 3 + 1]! - c0[1]; all[i * 3 + 2] = g.positions[i * 3 + 2]! - c0[2]; }
    const drop = floorPatch(apply(R, all), g.alphas);
    if (drop.length) {
      const gone = new Set(drop);
      const keep: number[] = [];
      for (let i = 0; i < g.count; i++) if (!gone.has(i)) keep.push(i);
      g = pick(g, keep);
    }
  }
  const removed = 1 - g.count / Math.max(1, g0.count);
  // The sample again, from what is left.
  const Q: number[] = [];
  const step = Math.max(1, Math.floor(g.count / 30_000));
  for (let i = 0; i < g.count; i += step) if (g.alphas[i]! >= 0.3) Q.push(g.positions[i * 3]! - c0[0], g.positions[i * 3 + 1]! - c0[1], g.positions[i * 3 + 2]! - c0[2]);
  const P2 = new Float32Array(Q);

  // Level it: the tilt that makes its horizontal surfaces sharpest.
  const lv = levelTilt(apply(R, P2));
  if (lv) R = mul(lv.R, R);
  const tiltDeg = lv?.deg ?? 0;
  const U = apply(R, P2);

  // 3. Facing. In the box's own axes (world → box: turn by -yaw), the turn that squares the footprint.
  const toBox = (deg: number) => -obj.yaw + deg;
  let bestD = 0, bestA = Infinity, worstA = 0;
  for (let d = -45; d < 45; d += 1.5) {
    // footprintAt turns the points by rotY: the object turned by d, then into the box's axes.
    const [w, dd] = footprintAt(U, toBox(d));
    const a = w * dd;
    if (a < bestA) { bestA = a; bestD = d; }
    worstA = Math.max(worstA, a);
  }
  // A round thing has no corners to square: leave its heading.
  const base = worstA < bestA * 1.05 ? 0 : bestD;
  const fitFor = (deg: number) => {
    const Rk = mul(rotY(deg), R);
    const q = apply(Rk, P2);
    const local = apply(rotY(-obj.yaw), q);
    const ex = [extent(local, 0), extent(local, 1), extent(local, 2)];
    const dims = ex.map((e) => e.hi - e.lo) as [number, number, number];
    const ratios = [0, 1, 2].map((k) => obj.size[k]! / Math.max(1e-6, dims[k]!));
    const s = [...ratios].sort((a, b) => a - b)[1]!;
    // Bounds of the turned, scaled object in the world, to put its base centre where the box's is.
    const wx = extent(q, 0), wy = extent(q, 1), wz = extent(q, 2);
    const shift = ctx.shift ?? 1;
    const target: [number, number, number] = [(obj.position[0] - ctx.capture[0]) * shift, obj.position[1] - ctx.capture[1], (obj.position[2] - ctx.capture[2]) * shift];
    const tr: [number, number, number] = [target[0] - (s * (wx.lo + wx.hi)) / 2, target[1] - s * wy.lo, target[2] - (s * (wz.lo + wz.hi)) / 2];
    let sil: number | null = null;
    if (ctx.crop?.mask) {
      const placed = new Float32Array(q.length);
      for (let i = 0; i < q.length; i += 3) { placed[i] = s * q[i]! + tr[0]; placed[i + 1] = s * q[i + 1]! + tr[1]; placed[i + 2] = s * q[i + 2]! + tr[2]; }
      sil = iou(silhouette(placed, ctx.crop.pose, ctx.crop.fov), ctx.crop.mask);
    }
    return { deg, Rk, s, tr, spread: spreadOf(obj.size, dims), sil };
  };
  // The four quarters of the squared heading; SAM 3D's own (the one nearest no turn) unless a quarter
  // turn fits the box's size, or the painted silhouette, clearly better. Never a half turn.
  const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
  const quarters = [0, 90, -90].map((k) => fitFor(wrap(base + k)));
  const own = quarters[0]!;
  const score = (q: (typeof quarters)[number]) => Math.log(q.spread) + (q.sil === null ? 0 : 0.8 * (1 - q.sil));
  let chosen = own;
  for (const q of quarters.slice(1)) if (score(q) + 0.35 < score(chosen)) chosen = q;

  // 4. Apply: centre, turn, scale, move - once.
  transformGaussians(g, I, 1, [-c0[0], -c0[1], -c0[2]]);
  transformGaussians(g, chosen.Rk, chosen.s, chosen.tr);
  return { g, result: { removed, up: upChoice.name, tiltDeg, yawDeg: chosen.deg, spread: chosen.spread, scale: chosen.s, iou: chosen.sil, suspect: chosen.spread > 2.5 } };
}
