import type { Vec3Tuple } from './types.js';

/**
 * Where a generated scene is thin, and where to stand to fix it.
 *
 * A scene is a reconstruction of a place from ONE viewpoint (the capture
 * point), so it only knows the surfaces that point could see. Step off it and
 * what was in something's shadow is a hole; step toward a surface and the few
 * splats that covered it are magnified into a smear. Filling a view costs a
 * generation, so the job is choosing where to shoot from.
 *
 * This is a port of the view search PINOC's scene worker runs (scene_build
 * `core/viewsearch.ts` + `density.ts`), working on the splat centres the
 * engine hands the renderer instead of the full cloud:
 *
 *   - A direction is judged by how many splat centres it holds, not by how
 *     much alpha they accumulate. No centres is a HOLE; centres too far apart
 *     for the eye to forgive is BLUR - a smear that is fully covered, scores 0%
 *     on an alpha measure, and looks like fog.
 *   - The camera may only stand where no observed surface is magnified past
 *     `magnificationMax` (distance now vs. distance at capture). Any hole can
 *     be made to appear by walking far enough, and blur grows toward a surface,
 *     so an unbounded search would walk into a wall and call it a discovery.
 *   - Every (position, look) is scored by the share of its frame that wants
 *     filling, shaped by five composition factors: enough context to infer
 *     from, centred, new, near the capture point, and not already magnified.
 *     Picks are greedy, each one hiding what it showed.
 *
 * Blur is judged against THE SCENE'S OWN best sampling (the capture point's
 * mean spacing), not an absolute angle: the engine's sample is a stride of the
 * cloud, so a fixed number of degrees would mean a different thing for every
 * scene size.
 *
 * World frame: metres, +Y up, floor at y = 0; yaw 0 looks along -Z, 90 along -X
 * (the stage's own).
 */

export interface CloudSample {
  /** `[x, y, z] * n`, world metres. */
  positions: Float32Array;
  /** Per point, 0..1; null counts every point. */
  alpha: Float32Array | null;
}

export interface SceneCheckOptions {
  /** Where the panorama was taken, world metres. */
  capture: Vec3Tuple;
  /** Cells per cube face for a position's field. */
  faceEdge: number;
  /** Capture point's own field, finer. */
  originFaceEdge: number;
  /** Camera positions are at most this many capture heights from the capture point. */
  radiusCap: number;
  /** Grid step between positions, in capture heights. */
  gridStep: number;
  /** No observed surface may be magnified past this from where the camera stands. */
  magnificationMax: number;
  /** Positions the domain may hold; the grid coarsens until it fits. */
  maxPositions: number;
  /** Camera heights above the floor that a person (or a crane) could use, metres. */
  minHeight: number;
  maxHeight: number;
  /** A direction is blurred when its spacing is this many times the capture point's own. */
  coarseRatio: number;
  /** Points under this alpha are not samples of anything. */
  alphaFloor: number;
  /** At most this many points are binned per position. */
  maxPoints: number;
  /** Horizontal field of view of the frame a fill is judged (and generated) at, degrees. */
  fovDeg: number;
  /** Frame height / width. */
  aspect: number;
  yaws: number;
  pitches: number[];
  /** The central part of the frame, as a share of the field of view. */
  inner: number;
  /** Views kept: the confident ones, then weaker candidates. */
  holes: number;
  candidates: number;
  /** A frame under this share of want is not worth a generation. */
  minWant: number;
  /** Blur counts for this much of a hole: missing content is worth more than soft content. */
  coarseWeight: number;
  nearFull: number;
  nearZero: number;
  frameFull: number;
  frameZero: number;
  contextZero: number;
  contextFull: number;
  noveltyFull: number;
  prioRef: number;
  prioPower: number;
  camRef: number;
  /** Two picks closer than this many grid steps AND within 35 degrees are the same view. */
  blockSteps: number;
}

export const DEFAULT_CHECK: Omit<SceneCheckOptions, 'capture'> = {
  faceEdge: 16,
  originFaceEdge: 24,
  radiusCap: 3.0,
  gridStep: 0.4,
  magnificationMax: 2.5,
  maxPositions: 260,
  minHeight: 0.5,
  maxHeight: 2.2,
  coarseRatio: 2.2,
  alphaFloor: 0.1,
  maxPoints: 120_000,
  fovDeg: 100,
  aspect: 9 / 16,
  yaws: 12,
  pitches: [-30, -15, 0, 15, 30],
  inner: 0.7,
  holes: 4,
  candidates: 2,
  minWant: 0.02,
  coarseWeight: 0.35,
  nearFull: 1.25,
  nearZero: 2.0,
  frameFull: 0.10,
  frameZero: 0.40,
  contextZero: 0.55,
  contextFull: 0.75,
  noveltyFull: 0.5,
  prioRef: 2.0,
  prioPower: 3.0,
  camRef: 3.0,
  blockSteps: 1.5,
};

export interface GapView {
  /** `g1`, `g2`, ... best first. Meaningless between two checks. */
  id: string;
  priority: number;
  /** `hole`: the search is confident; `candidate`: found after, a thinner claim. */
  role: 'hole' | 'candidate';
  /** Where the camera stands, world metres. */
  position: Vec3Tuple;
  /** Unit vector it looks along. */
  forward: Vec3Tuple;
  yaw: number;
  /** Positive looks up. */
  pitch: number;
  /** Share of the frame with nothing reconstructed. */
  hole: number;
  /** Share of the frame reconstructed too coarsely: a smear. */
  blur: number;
  /** Mean magnification of what it looks at, 1 = as the panorama saw it. */
  magnification: number;
}

export interface SceneCheck {
  views: GapView[];
  /** Positions the domain admitted. */
  domain: number;
  /** Mean spacing of the capture point's own field, degrees: the best this scene can do. */
  originSpacingDeg: number;
  /** Share of directions at the capture point with no samples; the premise fails over a few percent. */
  undefinedShare: number;
  points: number;
  ms: number;
}

// ───────────────────────────────────────────────────────────── direction grid

interface Grid {
  edge: number;
  count: number;
  dirs: Float64Array;
  solid: Float64Array;
}

const grids = new Map<number, Grid>();

/** Directions binned on a cube: cheap to index, with exact solid angles per cell. */
function cellGrid(edge: number): Grid {
  const hit = grids.get(edge);
  if (hit) return hit;
  const n = edge;
  const count = 6 * n * n;
  const dirs = new Float64Array(3 * count);
  const solid = new Float64Array(count);
  const step = 2 / n;
  for (let face = 0; face < 6; face++) {
    for (let v = 0; v < n; v++) {
      const t = ((v + 0.5) / n) * 2 - 1;
      for (let u = 0; u < n; u++) {
        const s = ((u + 0.5) / n) * 2 - 1;
        let x: number, y: number, z: number;
        if (face === 0) { x = 1; y = t; z = s; }
        else if (face === 1) { x = -1; y = t; z = s; }
        else if (face === 2) { x = s; y = 1; z = t; }
        else if (face === 3) { x = s; y = -1; z = t; }
        else if (face === 4) { x = s; y = t; z = 1; }
        else { x = s; y = t; z = -1; }
        const len = Math.sqrt(x * x + y * y + z * z);
        const i = (face * n + v) * n + u;
        dirs[3 * i] = x / len; dirs[3 * i + 1] = y / len; dirs[3 * i + 2] = z / len;
        solid[i] = (step * step) / Math.pow(1 + s * s + t * t, 1.5);
      }
    }
  }
  const g = { edge, count, dirs, solid };
  grids.set(edge, g);
  return g;
}

/** The cell a unit direction falls in. */
function cellOf(g: Grid, x: number, y: number, z: number): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  const n = g.edge;
  let face: number, s: number, t: number;
  if (ax >= ay && ax >= az) { face = x > 0 ? 0 : 1; s = z / ax; t = y / ax; }
  else if (ay >= az) { face = y > 0 ? 2 : 3; s = x / ay; t = z / ay; }
  else { face = z > 0 ? 4 : 5; s = x / az; t = y / az; }
  const u = Math.min(n - 1, Math.max(0, Math.floor(((s + 1) / 2) * n)));
  const v = Math.min(n - 1, Math.max(0, Math.floor(((t + 1) / 2) * n)));
  return (face * n + v) * n + u;
}

// ──────────────────────────────────────────────────────────────── the field

const Z_MIN = 0.02;
const Z_STEP = 1.1;
const Z_BUCKETS = 80;
const LOG_STEP = Math.log(Z_STEP);
const FRONT_SHARE = 0.05;
const WINDOW_BUCKETS = Math.max(1, Math.round(Math.log(1.3) / LOG_STEP));

interface Cloud {
  n: number;
  x: Float32Array; y: Float32Array; z: Float32Array;
  /** Distance from the capture point: how far away the panorama saw this splat. */
  radius: Float32Array;
}

interface Field {
  count: Int32Array;
  /** Front surface's distance from the camera, metres; 0 where nothing. */
  depth: Float32Array;
  /** Mean radius / distance of the front surface. */
  mag: Float32Array;
  /** Mean spacing of the front surface's centres, degrees; Infinity where empty. */
  spacing: Float32Array;
}

class Scratch {
  hist: Int32Array;
  magSum: Float32Array;
  constructor(cells: number) {
    this.hist = new Int32Array(cells * Z_BUCKETS);
    this.magSum = new Float32Array(cells * Z_BUCKETS);
  }
}

/** What each direction from `pos` holds: how many samples, how far, how magnified, how coarse. */
function densityField(cloud: Cloud, pos: Vec3Tuple, g: Grid, scratch: Scratch, out: Field): void {
  const { hist, magSum } = scratch;
  hist.fill(0);
  magSum.fill(0);
  const [ox, oy, oz] = pos;
  const { x: X, y: Y, z: Z, radius: RAD, n } = cloud;
  for (let i = 0; i < n; i++) {
    const dx = X[i]! - ox, dy = Y[i]! - oy, dz = Z[i]! - oz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist < Z_MIN) continue;
    const b = cellOf(g, dx / dist, dy / dist, dz / dist);
    let k = Math.floor(Math.log(dist / Z_MIN) / LOG_STEP);
    k = k < 0 ? 0 : k >= Z_BUCKETS ? Z_BUCKETS - 1 : k;
    const q = b * Z_BUCKETS + k;
    hist[q]!++;
    magSum[q]! += RAD[i]! / dist;
  }
  for (let b = 0; b < g.count; b++) {
    const base = b * Z_BUCKETS;
    let total = 0;
    for (let k = 0; k < Z_BUCKETS; k++) total += hist[base + k]!;
    if (total === 0) { out.count[b] = 0; out.depth[b] = 0; out.mag[b] = 0; out.spacing[b] = Infinity; continue; }
    // The front surface is where FRONT_SHARE of the cell's mass has accumulated, so strays in front cannot define it.
    const need = Math.max(1, Math.ceil(FRONT_SHARE * total));
    let cum = 0, front = 0;
    for (let k = 0; k < Z_BUCKETS; k++) { cum += hist[base + k]!; if (cum >= need) { front = k; break; } }
    const last = Math.min(Z_BUCKETS - 1, front + WINDOW_BUCKETS);
    let c = 0, ms = 0;
    for (let k = front; k <= last; k++) { c += hist[base + k]!; ms += magSum[base + k]!; }
    out.count[b] = c;
    out.depth[b] = Z_MIN * Math.pow(Z_STEP, front + 0.5);
    out.mag[b] = c > 0 ? ms / c : 0;
    out.spacing[b] = c > 0 ? (Math.sqrt(g.solid[b]! / c) * 180) / Math.PI : Infinity;
  }
}

const newField = (cells: number): Field => ({ count: new Int32Array(cells), depth: new Float32Array(cells), mag: new Float32Array(cells), spacing: new Float32Array(cells) });

const ramp = (v: number, lo: number, hi: number) => {
  if (hi === lo) return v >= hi ? 1 : 0;
  const t = (v - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
};

/** A camera basis for a unit forward vector, y up: right, up, forward as rows. */
function basis(f: Vec3Tuple): number[] {
  let rx = f[2], rz = -f[0];
  const rl = Math.hypot(rx, rz);
  if (rl < 1e-6) { rx = 1; rz = 0; } else { rx /= rl; rz /= rl; }
  // up = forward x right... built so that right x up = -forward would flip; keep right-handed: up = right x forward.
  const ux = -rz * f[1], uy = rz * f[0] - rx * f[2], uz = rx * f[1];
  return [rx, 0, rz, ux, uy, uz, f[0], f[1], f[2]];
}

interface Prepared {
  cloud: Cloud;
  n: number;
  og: Grid;
  origin: Field;
  originSpacing: number;
  undefinedShare: number;
  /** Spacing past which a direction is blurred, degrees. */
  spacingMax: number;
}

const prepared = new WeakMap<Float32Array, { key: string; prep: Prepared }>();

/**
 * The cloud the passes read - solid enough to be a sample, strided down to a size a pass can afford -
 * and the capture point's own field: the best this scene can do, and the surfaces a camera must not
 * close in on. Measured once per sample, then reused by every frame asked about.
 */
function prepare(sample: CloudSample, p: SceneCheckOptions): Prepared {
  const key = [p.capture.join(','), p.alphaFloor, p.maxPoints, p.originFaceEdge, p.coarseRatio].join('|');
  const hit = prepared.get(sample.positions);
  if (hit && hit.key === key) return hit.prep;
  const [cx, cy, cz] = p.capture;
  const total = sample.positions.length / 3;
  const keep: number[] = [];
  for (let i = 0; i < total; i++) if (!sample.alpha || sample.alpha[i]! >= p.alphaFloor) keep.push(i);
  const stride = Math.max(1, Math.ceil(keep.length / p.maxPoints));
  const n = Math.floor(keep.length / stride);
  const cloud: Cloud = { n, x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), radius: new Float32Array(n) };
  for (let j = 0; j < n; j++) {
    const i = keep[j * stride]!;
    const x = sample.positions[3 * i]!, y = sample.positions[3 * i + 1]!, z = sample.positions[3 * i + 2]!;
    cloud.x[j] = x; cloud.y[j] = y; cloud.z[j] = z;
    cloud.radius[j] = Math.hypot(x - cx, y - cy, z - cz);
  }
  const og = cellGrid(p.originFaceEdge);
  const origin = newField(og.count);
  let spSum = 0, spSolid = 0, undef = 0, allSolid = 0;
  if (n >= 1000) {
    densityField(cloud, p.capture, og, new Scratch(og.count), origin);
    for (let b = 0; b < og.count; b++) {
      allSolid += og.solid[b]!;
      if (origin.count[b] === 0) { undef += og.solid[b]!; continue; }
      spSum += origin.spacing[b]! * og.solid[b]!;
      spSolid += og.solid[b]!;
    }
  }
  const originSpacing = spSolid > 0 ? spSum / spSolid : 0;
  const prep: Prepared = { cloud, n, og, origin, originSpacing, undefinedShare: allSolid > 0 ? undef / allSolid : 1, spacingMax: originSpacing * p.coarseRatio };
  prepared.set(sample.positions, { key, prep });
  return prep;
}

/**
 * How much of a frame is gap: the share of the view from `position` along `forward` that shows
 * nothing reconstructed (hole) or surfaces sampled too coarsely (blur). For judging a shot that
 * exists, where `checkScene` finds the views worth making. `fovDeg` is vertical, as a shot's is.
 */
export function measureFrame(
  sample: CloudSample,
  options: Partial<SceneCheckOptions> & { capture: Vec3Tuple },
  position: Vec3Tuple,
  forward: Vec3Tuple,
  fovDeg: number,
  aspect = 16 / 9,
): { hole: number; blur: number } | null {
  const p: SceneCheckOptions = { ...DEFAULT_CHECK, ...options };
  const { cloud, n, originSpacing, spacingMax } = prepare(sample, p);
  if (n < 1000 || !(originSpacing > 0)) return null;
  const g = cellGrid(p.faceEdge);
  const field = newField(g.count);
  densityField(cloud, position, g, new Scratch(g.count), field);
  const len = Math.hypot(forward[0], forward[1], forward[2]) || 1;
  const R = basis([forward[0] / len, forward[1] / len, forward[2] / len]);
  const tanV = Math.tan(((fovDeg / 2) * Math.PI) / 180);
  const tanH = tanV * aspect;
  let frame = 0, hole = 0, blur = 0;
  for (let b = 0; b < g.count; b++) {
    const dx = g.dirs[3 * b]!, dy = g.dirs[3 * b + 1]!, dz = g.dirs[3 * b + 2]!;
    const fz = dx * R[6]! + dy * R[7]! + dz * R[8]!;
    if (fz <= 0) continue;
    const fx = dx * R[0]! + dy * R[1]! + dz * R[2]!;
    const fy = dx * R[3]! + dy * R[4]! + dz * R[5]!;
    if (Math.abs(fx) / fz > tanH || Math.abs(fy) / fz > tanV) continue;
    const s = g.solid[b]!;
    frame += s;
    if (field.count[b] === 0) hole += s;
    else if (field.spacing[b]! / Math.max(field.mag[b]!, 1) > spacingMax) blur += s;
  }
  return frame > 0 ? { hole: hole / frame, blur: blur / frame } : null;
}

// ──────────────────────────────────────────────────────────────── the search

/**
 * Where to stand and which way to look to fill what a scene lacks, best first.
 * An empty list is an ordinary answer: the place came out clean, or no
 * position the camera may stand in sees a gap.
 */
export function checkScene(sample: CloudSample, options: Partial<SceneCheckOptions> & { capture: Vec3Tuple }): SceneCheck {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const p: SceneCheckOptions = { ...DEFAULT_CHECK, ...options };
  const [cx, cy, cz] = p.capture;
  const prep = prepare(sample, p);
  const { cloud, n, og, origin, originSpacing, undefinedShare, spacingMax } = prep;
  const empty = (undef: number, spacingDeg: number, domain: number): SceneCheck => ({ views: [], domain, originSpacingDeg: spacingDeg, undefinedShare: undef, points: n, ms: Math.round(now() - t0) });
  if (n < 1000) return empty(1, 0, 0);
  if (!(originSpacing > 0)) return empty(undefinedShare, 0, 0);

  // 1. (The capture point's own field is measured once per scene: see `prepare`.)

  // 2. The domain: every position a camera may stand in without magnifying anything observed past the cap.
  const height = Math.max(0.5, cy);
  const cap = p.radiusCap * height;
  const shrink = 1 - 1 / p.magnificationMax;
  let spacing = p.gridStep * height;
  let positions: number[] = [];
  for (;;) {
    positions = [];
    const m = Math.ceil(cap / spacing);
    for (let ia = -m; ia <= m; ia++) for (let ib = -m; ib <= m; ib++) for (let ic = -m; ic <= m; ic++) {
      const dx = ia * spacing, dy = ib * spacing, dz = ic * spacing;
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const y = cy + dy;
      if (!(r <= cap) || y < p.minHeight || y > p.maxHeight) continue;
      // The radial pre-test, along this direction only: how close may the camera get to the first surface ahead.
      if (r > 1e-9) {
        const d = origin.depth[cellOf(og, dx / r, dy / r, dz / r)]!;
        if (!(d > 0 && r <= shrink * d)) continue;
      }
      positions.push(cx + dx, y, cz + dz);
    }
    if (positions.length / 3 <= p.maxPositions) break;
    spacing *= 1.15;
  }
  // The exact test: no observed surface magnified past the cap from where the camera stands.
  const domain: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const px = positions[i]!, py = positions[i + 1]!, pz = positions[i + 2]!;
    let ok = true;
    for (let b = 0; b < og.count && ok; b++) {
      const d = origin.depth[b]!;
      if (!(d > 0)) continue;
      const sx = cx + og.dirs[3 * b]! * d - px, sy = cy + og.dirs[3 * b + 1]! * d - py, sz = cz + og.dirs[3 * b + 2]! * d - pz;
      const dist = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (dist > 1e-6 && d / dist > p.magnificationMax) ok = false;
    }
    if (ok) domain.push(px, py, pz);
  }
  const domainCount = domain.length / 3;
  if (domainCount === 0) return empty(undefinedShare, originSpacing, 0);

  // 3. The look table, and for each look the cells its frame holds: independent of position, so built once.
  const g = cellGrid(p.faceEdge);
  const tanH = Math.tan(((p.fovDeg / 2) * Math.PI) / 180);
  const tanV = tanH * p.aspect;
  const tanHIn = Math.tan(((p.fovDeg * p.inner) / 2) * Math.PI / 180);
  interface Look { forward: Vec3Tuple; yaw: number; pitch: number; cells: Int32Array; inner: Uint8Array; frame: number }
  const looks: Look[] = [];
  for (const pitch of p.pitches) {
    for (let k = 0; k < p.yaws; k++) {
      const yaw = (k * 360) / p.yaws - 180;
      const yr = (yaw * Math.PI) / 180, pr = (pitch * Math.PI) / 180;
      const forward: Vec3Tuple = [-Math.sin(yr) * Math.cos(pr), Math.sin(pr), -Math.cos(yr) * Math.cos(pr)];
      const R = basis(forward);
      const cells: number[] = [];
      const inner: number[] = [];
      let frame = 0;
      for (let b = 0; b < g.count; b++) {
        const dx = g.dirs[3 * b]!, dy = g.dirs[3 * b + 1]!, dz = g.dirs[3 * b + 2]!;
        const fz = dx * R[6]! + dy * R[7]! + dz * R[8]!;
        if (fz <= 0) continue;
        const fx = dx * R[0]! + dy * R[1]! + dz * R[2]!;
        const fy = dx * R[3]! + dy * R[4]! + dz * R[5]!;
        if (Math.abs(fx) / fz > tanH || Math.abs(fy) / fz > tanV) continue;
        cells.push(b);
        inner.push(Math.abs(fx) / fz <= tanHIn ? 1 : 0);
        frame += g.solid[b]!;
      }
      looks.push({ forward, yaw, pitch, cells: Int32Array.from(cells), inner: Uint8Array.from(inner), frame });
    }
  }

  // 4. Every position, every look, scored off one pass each.
  interface Cand { pos: Vec3Tuple; look: number; want: number; empty: number; coarse: number; inner: number; mag: number; dist: number; cells: number[] }
  const cands: Cand[] = [];
  const scratch = new Scratch(g.count);
  const field = newField(g.count);
  const wants = new Uint8Array(g.count);
  for (let i = 0; i < domainCount; i++) {
    const pos: Vec3Tuple = [domain[3 * i]!, domain[3 * i + 1]!, domain[3 * i + 2]!];
    densityField(cloud, pos, g, scratch, field);
    let any = false;
    for (let b = 0; b < g.count; b++) {
      // Two ways a direction can want filling: nothing there, or samples too far apart for the eye - and a
      // surface seen from nearer than the panorama saw it is spread apart in proportion.
      const w = field.count[b] === 0 || field.spacing[b]! / Math.max(field.mag[b]!, 1) > spacingMax;
      wants[b] = w ? (field.count[b] === 0 ? 1 : 2) : 0;
      if (w) any = true;
    }
    if (!any) continue;
    for (let li = 0; li < looks.length; li++) {
      const L = looks[li]!;
      let want = 0, emptyS = 0, coarseS = 0, innerWant = 0, magSum = 0, magN = 0, distSum = 0, distW = 0;
      const cells: number[] = [];
      for (let c = 0; c < L.cells.length; c++) {
        const b = L.cells[c]!;
        const w = wants[b]!;
        const s = g.solid[b]!;
        if (w) {
          cells.push(b);
          if (w === 1) { emptyS += s; want += s; } else { coarseS += s; want += s * p.coarseWeight; }
          if (L.inner[c]) innerWant += s;
        }
        if (field.count[b]! > 0) { magSum += field.mag[b]!; magN++; distSum += field.depth[b]! * s; distW += s; }
      }
      if (want <= 0) continue;
      cands.push({ pos, look: li, want, empty: emptyS, coarse: coarseS, inner: innerWant, mag: magN ? magSum / magN : 0, dist: distW ? distSum / distW : 0, cells });
    }
  }

  // 5. Greedy: best first, each pick hiding what it has shown.
  const shown = new Set<number>();
  const picks: GapView[] = [];
  const wanted = p.holes + p.candidates;
  const cos35 = Math.cos((35 * Math.PI) / 180);
  const minStep = p.blockSteps * spacing;
  for (let k = 0; k < wanted; k++) {
    let best: { c: Cand; total: number } | null = null;
    for (const c of cands) {
      const L = looks[c.look]!;
      const share = c.want / L.frame;
      if (share < p.minWant) continue;
      if (picks.some((q) => {
        const dp = Math.hypot(q.position[0] - c.pos[0], q.position[1] - c.pos[1], q.position[2] - c.pos[2]);
        return dp < minStep && q.forward[0] * L.forward[0] + q.forward[1] * L.forward[1] + q.forward[2] * L.forward[2] > cos35;
      })) continue;
      let fresh = 0;
      for (const b of c.cells) if (!shown.has(b)) fresh += g.solid[b]!;
      const novelty = ramp(fresh / c.want, 0, p.noveltyFull);
      // A frame that is mostly gap has nothing to infer the gap from; a sliver is not worth a generation.
      const size = share <= p.frameFull ? share / p.frameFull : ramp(share, p.frameZero, p.frameFull);
      const context = ramp(1 - share, p.contextZero, p.contextFull);
      const centred = c.want > 0 ? c.inner / c.want : 0;
      const near = ramp(c.mag, p.nearZero, p.nearFull);
      const camDist = Math.hypot(c.pos[0] - cx, c.pos[1] - cy, c.pos[2] - cz);
      const priority = (1 / (1 + Math.pow(c.dist / (p.prioRef * height), p.prioPower))) * (1 / (1 + Math.pow(camDist / (p.camRef * height), p.prioPower)));
      const score = share * size * context * centred * novelty * priority * near;
      if (score > 0 && (!best || score > best.total)) best = { c, total: score };
    }
    if (!best) break;
    const { c } = best;
    const L = looks[c.look]!;
    c.cells.forEach((b) => shown.add(b));
    picks.push({
      id: `g${picks.length + 1}`,
      priority: picks.length + 1,
      role: picks.length < p.holes ? 'hole' : 'candidate',
      position: [Math.round(c.pos[0] * 100) / 100, Math.round(c.pos[1] * 100) / 100, Math.round(c.pos[2] * 100) / 100],
      forward: L.forward,
      yaw: Math.round(L.yaw),
      pitch: Math.round(L.pitch),
      hole: c.empty / L.frame,
      blur: c.coarse / L.frame,
      magnification: c.mag,
    });
  }
  return { views: picks, domain: domainCount, originSpacingDeg: originSpacing, undefinedShare, points: n, ms: Math.round(now() - t0) };
}
