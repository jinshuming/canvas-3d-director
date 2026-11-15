/**
 * Where to stand to take the one panorama JST-2 rebuilds the scene from.
 *
 * JST-2 reconstructs from a single viewpoint, so whatever that point cannot
 * see becomes a hole. Score candidate points at eye height on free floor by
 * how well they show the objects that matter: visible (not occluded) and at a
 * comfortable distance, plus how much floor they see, minus being cramped
 * against something. Then face the panorama's front at the most important
 * group, so the back seam lands where it matters least.
 */
import { DEG } from './frame.ts';
import type { Vec3 } from './frame.ts';
import { buildScene, objectBounds } from './geometry.ts';
import type { Scene } from './geometry.ts';
import { objectCoverage, renderEquirect, rowWeights } from './render.ts';
import type { Layout } from './types.ts';
import { EYE_HEIGHT } from './types.ts';

export interface CaptureCandidate {
  position: Vec3;
  score: number;
  /** Per object: share of its unoccluded view that is visible from here (0-1). */
  visible: Record<string, number>;
  floorShare: number;
  clearance: number;
}

export interface CaptureResult {
  best: CaptureCandidate & { yaw: number };
  ranked: CaptureCandidate[];
  evaluated: number;
}

/** Default importance: bigger things matter more, flat things and small props less. */
export function importanceOf(layout: Layout, i: number): number {
  const o = layout.objects[i]!;
  if (o.importance !== undefined) return o.importance;
  if (o.type === 'rug' || o.type === 'road' || o.type === 'water') return 0.3;
  const vol = o.size[0] * o.size[1] * o.size[2];
  return Math.max(0.2, Math.min(1, 0.35 + Math.log10(1 + vol * 3)));
}

/** Distance factor: 1 between 1.2 and 6 m, falling off nearer (magnified, blurry) and farther (too small). */
function distanceFactor(d: number): number {
  if (d < 0.6) return 0.2;
  if (d < 1.2) return 0.2 + 0.8 * (d - 0.6) / 0.6;
  if (d <= 6) return 1;
  return Math.max(0.3, 1 - (d - 6) / 20);
}

function clearanceAt(layout: Layout, x: number, z: number): number {
  let c = Infinity;
  for (const o of layout.objects) {
    if (o.type === 'rug' || o.type === 'road' || o.type === 'water' || o.position[1] > EYE_HEIGHT + 0.3) continue;
    const b = objectBounds(o);
    if (b.max[1] < 0.15) continue;
    const dx = Math.max(b.min[0] - x, 0, x - b.max[0]);
    const dz = Math.max(b.min[2] - z, 0, z - b.max[2]);
    c = Math.min(c, Math.hypot(dx, dz));
  }
  const r = layout.room;
  if (r) c = Math.min(c, x + r.width / 2, r.width / 2 - x, z + r.depth / 2, r.depth / 2 - z);
  return c;
}

/** Each object's coverage with nothing else in the way: render it alone, cheaply. */
function soloCoverage(layout: Layout, pos: Vec3, w: number, h: number): number[] {
  return layout.objects.map((_, i) => {
    const solo: Layout = { ...layout, room: null, ground: { size: 0 }, objects: [layout.objects[i]!] };
    const r = renderEquirect(buildScene(solo), { position: pos, yaw: 0 }, w, h);
    return objectCoverage(r, 1)[0]!.sr;
  });
}

export function findCapturePoint(layout: Layout, opts: { step?: number; minClearance?: number; width?: number; maxCandidates?: number } = {}): CaptureResult {
  const scene: Scene = buildScene(layout);
  const W = opts.width ?? 96, H = W / 2;
  const step = opts.step ?? (layout.room ? 0.25 : 1);
  const minClear = opts.minClearance ?? 0.6;
  const extentX = layout.room ? layout.room.width / 2 : layout.ground.size / 4;
  const extentZ = layout.room ? layout.room.depth / 2 : layout.ground.size / 4;
  let cands: Array<{ x: number; z: number; clear: number }> = [];
  for (let x = -extentX + step / 2; x < extentX; x += step) for (let z = -extentZ + step / 2; z < extentZ; z += step) {
    const clear = clearanceAt(layout, x, z);
    if (clear >= minClear) cands.push({ x, z, clear });
  }
  if (!cands.length) for (let x = -extentX + step / 2; x < extentX; x += step) for (let z = -extentZ + step / 2; z < extentZ; z += step) cands.push({ x, z, clear: clearanceAt(layout, x, z) });
  // Thin evenly to a budget.
  const max = opts.maxCandidates ?? 400;
  if (cands.length > max) { const k = cands.length / max; cands = Array.from({ length: max }, (_, i) => cands[Math.floor(i * k)]!); }
  const weights = layout.objects.map((_, i) => importanceOf(layout, i));
  const rw = rowWeights(H);
  const ranked: CaptureCandidate[] = [];
  for (const c of cands) {
    const pos: Vec3 = [c.x, EYE_HEIGHT, c.z];
    const r = renderEquirect(scene, { position: pos, yaw: 0 }, W, H);
    const cov = objectCoverage(r, layout.objects.length);
    const solo = soloCoverage(layout, pos, W / 2, H / 2);
    let s = 0, wsum = 0;
    const visible: Record<string, number> = {};
    layout.objects.forEach((o, i) => {
      const vis = solo[i]! > 1e-6 ? Math.min(1, cov[i]!.sr / solo[i]!) : 0;
      visible[o.id] = Math.round(vis * 100) / 100;
      const df = cov[i]!.sr > 0 ? distanceFactor(cov[i]!.meanDist) : 0;
      // Hogging: an object filling more than a quarter of the sphere hides the room behind it.
      const hog = cov[i]!.sr > Math.PI ? 0.5 : 1;
      s += weights[i]! * vis * df * hog;
      wsum += weights[i]!;
    });
    let floor = 0, tot = 0;
    const floorIdx = new Set(r.classes.map((n, k) => (n === 'floor' || n === 'ground' || n === 'rug' ? k : -1)).filter((k) => k >= 0));
    for (let v = H / 2; v < H; v++) for (let u = 0; u < W; u++) { const a = rw[v]!; tot += a; if (floorIdx.has(r.cls[v * W + u]!)) floor += a; }
    const floorShare = tot ? floor / tot : 0;
    const objScore = wsum ? s / wsum : 0;
    const cramped = Math.min(1, c.clear / 1.0);
    // Centrality (indoors): the middle of a room sees every wall at a similar distance.
    const centre = layout.room ? 1 - 0.15 * Math.hypot(c.x / (layout.room.width / 2), c.z / (layout.room.depth / 2)) : 1;
    const score = (0.75 * objScore + 0.25 * floorShare) * (0.7 + 0.3 * cramped) * centre;
    ranked.push({ position: [round(c.x), EYE_HEIGHT, round(c.z)], score: Math.round(score * 1000) / 1000, visible, floorShare: Math.round(floorShare * 100) / 100, clearance: Math.round(c.clear * 100) / 100 });
  }
  ranked.sort((a, b) => b.score - a.score);
  const top = ranked[0];
  if (!top) throw new Error('No place to stand: the floor is full.');
  return { best: { ...top, yaw: frontYaw(layout, top.position) }, ranked: ranked.slice(0, 8), evaluated: ranked.length };
}

const round = (v: number) => Math.round(v * 100) / 100;

/**
 * The panorama's front: the importance-weighted mean direction of the objects
 * (circular mean), so the seam at the back falls on what matters least.
 */
export function frontYaw(layout: Layout, pos: Vec3): number {
  let sx = 0, sz = 0;
  layout.objects.forEach((o, i) => {
    const dx = o.position[0] - pos[0], dz = o.position[2] - pos[2];
    const d = Math.hypot(dx, dz) || 1;
    const w = importanceOf(layout, i) / Math.max(1, d);
    sx += (dx / d) * w; sz += (dz / d) * w;
  });
  if (Math.hypot(sx, sz) < 1e-6) return 0;
  // Camera yaw: 0 looks north (-Z), 90 east (+X).
  return Math.round(((Math.atan2(sx, -sz) / DEG) + 360) % 360);
}
