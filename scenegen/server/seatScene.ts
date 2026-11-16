/**
 * Seat a scene's SAM 3D objects (core/seat.ts) on the floor the environment actually has: the
 * Viggle Splat Engine's walk collider (PINOC's), built here from the environment's splats.
 */
import { buildColliderData, SceneCollider } from '@viggle/splat-engine';

import type { Gaussians } from '../core/gaussians.ts';
import type { SeatResult } from '../core/seat.ts';
import { bottomOf, centreOver, dropTo, footprint, straighten, topWithin } from '../core/seat.ts';
import type { Layout, LayoutObject } from '../core/types.ts';
import { transformGaussians } from '../core/gaussians.ts';
import type { PlaceContext, PlaceResult } from '../core/place.ts';
import { placeObject } from '../core/place.ts';

export interface SeatItem { id: string; obj: LayoutObject; g: Gaussians }

/**
 * The exact height of the surface the collider found: among the environment's splats over the
 * object's footprint within `band` of the collider's answer, the densest 1 cm layer. The collider
 * says WHICH surface (floor or a table, and that there is one); its grid is too coarse to say
 * exactly where - measured: 11 cm voxels on a study, its floor read 15 cm high (the top of a
 * smeared, dilated cell), which would have left every object floating.
 */
export function surfaceHeight(env: Gaussians, f: { cx: number; cz: number; hx: number; hz: number }, y0: number, band: number): number {
  const hist = new Map<number, number>();
  const hx = f.hx + 0.2, hz = f.hz + 0.2;
  for (let i = 0; i < env.count; i++) {
    if (env.alphas[i]! < 0.3) continue;
    const y = env.positions[i * 3 + 1]!;
    if (Math.abs(y - y0) > band) continue;
    if (Math.abs(env.positions[i * 3]! - f.cx) > hx || Math.abs(env.positions[i * 3 + 2]! - f.cz) > hz) continue;
    const k = Math.round(y * 100);
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let best = y0, n = 0;
  // Smooth over three bins so a single dense centimetre of noise does not win.
  for (const k of hist.keys()) {
    const c = (hist.get(k - 1) ?? 0) + hist.get(k)! + (hist.get(k + 1) ?? 0);
    if (c > n) { n = c; best = k / 100; }
  }
  return n >= 30 ? best : y0;
}

/** The environment's walk collider, seeded at the capture point (eye height above the floor). */
export function environmentCollider(env: Gaussians, eyeHeight = 1.5): { ground: (x: number, z: number, fromY: number, r: number) => number | null; voxel: number } | null {
  const data = buildColliderData({ positions: env.positions, alpha: env.alphas }, { origin: { x: 0, y: 0, z: 0 }, scale: 1 }, { voxelMetres: 0.05 }, { x: 0, y: -eyeHeight, z: 0, radius: 0.3, height: 1.6 });
  if (!data) return null;
  const c = SceneCollider.fromData(data);
  const half = data.stats.voxelMetres / 2;
  // groundAt answers the TOP of the floor's cell: half a voxel above where the splats are.
  return { ground: (x, z, fromY, r) => { const y = c.groundAt(x, z, fromY, r); return y === null ? null : y - half; }, voxel: data.stats.voxelMetres };
}

/**
 * Straighten each object and put it on its support: floor objects on the collider's floor under
 * them, then things standing on another seated object on that object's top. `captureY` is the
 * capture point's height in the blockout (the file frame's origin), to read the blockout's base.
 * An object whose support is more than `maxDrop` away from where it is stays put (a collider hole,
 * a misread): moving it that far would be a guess.
 */
export function seatObjects(env: Gaussians, items: SeatItem[], captureY: number, maxDrop = 0.6, opts: { straighten?: boolean } = {}): Map<string, SeatResult> {
  const level = (g: Gaussians) => (opts.straighten === false ? { tiltDeg: 0, straightened: false } : straighten(g));
  const out = new Map<string, SeatResult>();
  const col = environmentCollider(env, captureY);
  const ids = new Set(items.map((i) => i.id));
  const floor = items.filter((i) => !i.obj.on || !ids.has(i.obj.on));
  // The room's floor, measured once where it is surely floor: under the capture point.
  const atCapture = col?.ground(0, 0, -captureY + 0.25, 0.3) ?? -captureY;
  const roomFloor = surfaceHeight(env, { cx: 0, cz: 0, hx: 0.8, hz: 0.8 }, atCapture, 0.3);
  const onTop = items.filter((i) => i.obj.on && ids.has(i.obj.on));
  for (const it of floor) {
    const s = level(it.g);
    const f = footprint(it.g);
    // From a little above where the blockout says its base is: the highest surface at or below that.
    // A small step above the blockout's base and a small disc: a big disc next to a wall reads the
    // wall's lowest cells as the floor.
    // On the floor in the blockout: the room's floor, give or take local unevenness (measured: the
    // panorama painted shelving on the wall behind a bookshelf, and the collider read a shelf as its
    // support, 44 cm up). Raised in the blockout (on something the environment has): the collider's
    // surface there.
    let y: number | null;
    if (it.obj.position[1] < 0.05) y = surfaceHeight(env, f, roomFloor, 0.08);
    else {
      const fromY = it.obj.position[1] - captureY + 0.25;
      const coarse = col?.ground(f.cx, f.cz, fromY, 0.15) ?? col?.ground(f.cx, f.cz, fromY, Math.max(0.15, Math.min(0.5, Math.min(f.hx, f.hz) * 0.5))) ?? null;
      y = coarse === null ? null : surfaceHeight(env, f, coarse, (col?.voxel ?? 0.1) * 2);
    }
    const b = bottomOf(it.g);
    if (y !== null && b !== null && Math.abs(y - b) <= maxDrop) out.set(it.id, { ...s, dy: dropTo(it.g, y), support: 'floor' });
    else out.set(it.id, { ...s, dy: 0, support: 'none' });
  }
  for (const it of onTop) {
    const s = level(it.g);
    const parent = items.find((p) => p.id === it.obj.on)!;
    // On a known object, that object is the authority - even far from where the blockout put it
    // (measured: a lamp `on` a desk laid out at floor height). If it is not over the object's top,
    // it is moved over it first (the nearest spot inside the top, keeping its own footprint on it).
    centreOver(it.g, parent.g);
    const y = topWithin(parent.g, it.g);
    const b = bottomOf(it.g);
    if (y !== null && b !== null && Math.abs(y - b) <= 2.5) out.set(it.id, { ...s, dy: dropTo(it.g, y), support: 'object' });
    else out.set(it.id, { ...s, dy: 0, support: 'none' });
  }
  return out;
}

// ── The whole placement ──────────────────────────────────────────────────────

export interface PlaceItem { id: string; obj: LayoutObject; g: Gaussians; crop?: PlaceContext['crop'] }
export interface PlacedObject { g: Gaussians; place: PlaceResult & { pushed: number }; seat: SeatResult }

const VOX = 0.05;

/** The 5 cm cells an object's opaque splats fill (a sample of them), offset by (dx, dz). */
function cells(p: Float32Array, dx = 0, dz = 0): Set<number> {
  const s = new Set<number>();
  for (let i = 0; i < p.length; i += 3) s.add(Math.floor((p[i]! + dx) / VOX) * 4_000_000 + Math.floor(p[i + 1]! / VOX + 1000) * 2_000 + Math.floor((p[i + 2]! + dz) / VOX + 1000));
  return s;
}
function sampleOf(g: Gaussians, max = 20_000): Float32Array {
  const out: number[] = [];
  const step = Math.max(1, Math.floor(g.count / max));
  for (let i = 0; i < g.count; i += step) if (g.alphas[i]! >= 0.3) out.push(g.positions[i * 3]!, g.positions[i * 3 + 1]!, g.positions[i * 3 + 2]!);
  return new Float32Array(out);
}
const shared = (a: Set<number>, b: Set<number>) => { let n = 0; const [s, l] = a.size < b.size ? [a, b] : [b, a]; for (const k of s) if (l.has(k)) n++; return n / Math.max(1, s.size); };
const move = (g: Gaussians, dx: number, dz: number) => transformGaussians(g, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1, [dx, 0, dz]);

/**
 * Every object of a scene, placed (core/place.ts: cleaned, stood up, squared, sized, on the box),
 * then held to the blockout's relations:
 *  - on the floor the environment has under it (seatObjects);
 *  - inside the room's walls (the blockout's, at the environment's scale): pushed in if it pokes out;
 *  - not inside another object: where two share more than 3% of the smaller one's 5 cm cells, the
 *    smaller is moved away - along the line between their blockout boxes - until they do not;
 *  - a thing standing on another (a lamp on a desk) seated on that object's top last, after the
 *    object under it has moved.
 */
export function placeScene(env: Gaussians, items: PlaceItem[], layout: Layout, capture: [number, number, number], shift: number | null): Map<string, PlacedObject> {
  const out = new Map<string, PlacedObject>();
  const placed = items.map((it) => {
    const r = placeObject(it.g, it.obj, { capture, shift, crop: it.crop ?? null });
    return { ...it, g: r.g, place: { ...r.result, pushed: 0 } };
  });
  const ids = new Set(placed.map((p) => p.id));
  const floor = placed.filter((p) => !p.obj.on || !ids.has(p.obj.on));
  const first = seatObjects(env, floor.map((p) => ({ id: p.id, obj: p.obj, g: p.g })), capture[1], 0.6, { straighten: false });

  // Inside the walls.
  const k = shift ?? 1;
  if (layout.room) {
    const { width: w, depth: d } = layout.room;
    const lim = { x0: (-w / 2 - capture[0]) * k + 0.02, x1: (w / 2 - capture[0]) * k - 0.02, z0: (-d / 2 - capture[2]) * k + 0.02, z1: (d / 2 - capture[2]) * k - 0.02 };
    for (const p of floor) {
      const f = footprint(p.g);
      const dx = f.cx - f.hx < lim.x0 ? lim.x0 - (f.cx - f.hx) : f.cx + f.hx > lim.x1 ? lim.x1 - (f.cx + f.hx) : 0;
      const dz = f.cz - f.hz < lim.z0 ? lim.z0 - (f.cz - f.hz) : f.cz + f.hz > lim.z1 ? lim.z1 - (f.cz + f.hz) : 0;
      // Never more than half a metre: further than that the room and the object disagree about more than an edge.
      const cx = Math.max(-0.5, Math.min(0.5, dx)), cz = Math.max(-0.5, Math.min(0.5, dz));
      if (cx || cz) { move(p.g, cx, cz); p.place.pushed += Math.hypot(cx, cz); }
    }
  }

  // Not inside each other.
  const samples = new Map(floor.map((p) => [p.id, sampleOf(p.g)]));
  const offset = new Map(floor.map((p) => [p.id, [0, 0] as [number, number]]));
  const occ = new Map(floor.map((p) => [p.id, cells(samples.get(p.id)!)]));
  for (let a = 0; a < floor.length; a++) for (let b = a + 1; b < floor.length; b++) {
    const A = floor[a]!, B = floor[b]!;
    if (shared(occ.get(A.id)!, occ.get(B.id)!) <= 0.03) continue;
    const [mover, other] = occ.get(A.id)!.size <= occ.get(B.id)!.size ? [A, B] : [B, A];
    let dx = mover.obj.position[0] - other.obj.position[0], dz = mover.obj.position[2] - other.obj.position[2];
    if (Math.hypot(dx, dz) < 1e-3) { const fm = footprint(mover.g), fo = footprint(other.g); dx = fm.cx - fo.cx; dz = fm.cz - fo.cz; }
    const l = Math.hypot(dx, dz) || 1;
    dx /= l; dz /= l;
    const o = offset.get(mover.id)!;
    for (let t = 0.02; t <= 0.4 + 1e-9; t += 0.02) {
      const c = cells(samples.get(mover.id)!, o[0] + dx * t, o[1] + dz * t);
      if (shared(c, occ.get(other.id)!) <= 0.01 || t >= 0.4 - 1e-9) {
        move(mover.g, dx * t, dz * t);
        o[0] += dx * t; o[1] += dz * t;
        occ.set(mover.id, c);
        mover.place.pushed += t;
        break;
      }
    }
  }

  // Seated again (a push may have moved it over a step), then the things on other things.
  const seats = seatObjects(env, placed.map((p) => ({ id: p.id, obj: p.obj, g: p.g })), capture[1], 0.6, { straighten: false });
  for (const p of placed) {
    const s = seats.get(p.id) ?? { dy: 0, support: 'none' as const };
    const dy = (first.get(p.id)?.dy ?? 0) + s.dy;
    out.set(p.id, { g: p.g, place: p.place, seat: { support: first.get(p.id)?.support ?? s.support, dy, tiltDeg: p.place.tiltDeg, straightened: p.place.tiltDeg > 0 } });
  }
  return out;
}
