/**
 * The layout as geometry: world-space solids (oriented boxes, vertical
 * cylinders and cones) plus the room shell, and a CPU ray caster over them.
 * Everything here runs in Node and in the page; it is what the condition maps,
 * the capture-point search and the layout checks are computed from.
 */
import { CATALOG, entryOf, SHELL_COLORS } from './catalog.ts';
import type { Part } from './catalog.ts';
import { DEG } from './frame.ts';
import type { Vec3 } from './frame.ts';
import type { Layout, LayoutObject, Room, Wall } from './types.ts';

export interface Solid {
  /** Object index in layout.objects, or -1 for the room shell / ground. */
  obj: number;
  /** Semantic class: a catalog type, or wall / floor / ceiling / ground. */
  cls: string;
  part: Part;
  /** World transform of the part's local frame: translation + yaw (radians). */
  t: Vec3;
  cos: number;
  sin: number;
}

export interface Hit { t: number; obj: number; cls: string; n: Vec3 }

const NO_HIT: Hit = { t: Infinity, obj: -2, cls: 'sky', n: [0, 0, 0] };

/** Solids of every object, in world space. */
export function objectSolids(layout: Layout): Solid[] {
  const out: Solid[] = [];
  layout.objects.forEach((o, i) => {
    const e = entryOf(o.type);
    const [w, h, d] = o.size;
    const yaw = o.yaw * DEG;
    for (const part of e.parts(w, h, d)) out.push({ obj: i, cls: CATALOG.has(o.type) ? o.type : 'box', part, t: o.position, cos: Math.cos(yaw), sin: Math.sin(yaw) });
  });
  return out;
}

/** World-space axis-aligned bounds of one object (all its parts). */
export function objectBounds(o: LayoutObject): { min: Vec3; max: Vec3 } {
  const [w, h, d] = o.size;
  const c = Math.cos(o.yaw * DEG), s = Math.sin(o.yaw * DEG);
  const ex = Math.abs(c) * w / 2 + Math.abs(s) * d / 2;
  const ez = Math.abs(s) * w / 2 + Math.abs(c) * d / 2;
  return { min: [o.position[0] - ex, o.position[1], o.position[2] - ez], max: [o.position[0] + ex, o.position[1] + h, o.position[2] + ez] };
}

/** World point → object local frame (yaw is clockwise from above: local +Z front → world (sin, 0, cos)). */
function toLocal(p: Vec3, s: Solid): Vec3 {
  const x = p[0] - s.t[0], y = p[1] - s.t[1], z = p[2] - s.t[2];
  return [s.cos * x - s.sin * z, y, s.sin * x + s.cos * z];
}
function dirToLocal(d: Vec3, s: Solid): Vec3 {
  return [s.cos * d[0] - s.sin * d[2], d[1], s.sin * d[0] + s.cos * d[2]];
}
function nToWorld(n: Vec3, s: Solid): Vec3 {
  return [s.cos * n[0] + s.sin * n[2], n[1], -s.sin * n[0] + s.cos * n[2]];
}

function hitBox(o: Vec3, d: Vec3, c: Vec3, sz: Vec3): { t: number; n: Vec3 } | null {
  let tmin = -Infinity, tmax = Infinity, axis = 0, sign = 1;
  for (let a = 0; a < 3; a++) {
    const lo = c[a]! - sz[a]! / 2, hi = c[a]! + sz[a]! / 2;
    if (Math.abs(d[a]!) < 1e-12) { if (o[a]! < lo || o[a]! > hi) return null; continue; }
    let t1 = (lo - o[a]!) / d[a]!, t2 = (hi - o[a]!) / d[a]!;
    let sg = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; sg = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = sg; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (tmax < 1e-6) return null;
  if (tmin < 1e-6) return null; // inside: solids are seen from outside only
  const n: Vec3 = [0, 0, 0];
  n[axis] = sign;
  return { t: tmin, n };
}

function hitCyl(o: Vec3, d: Vec3, c: Vec3, r: number, h: number, cone: boolean): { t: number; n: Vec3 } | null {
  // Base at c[1] - h/2 for a cylinder; a cone's base is at c[1] and its apex at c[1] + h.
  const y0 = cone ? c[1] : c[1] - h / 2, y1 = y0 + h;
  const ox = o[0] - c[0], oz = o[2] - c[2], oy = o[1];
  let best: { t: number; n: Vec3 } | null = null;
  const consider = (t: number, n: Vec3) => { if (t > 1e-6 && (!best || t < best.t)) best = { t, n }; };
  if (!cone) {
    const a = d[0] * d[0] + d[2] * d[2], b = 2 * (ox * d[0] + oz * d[2]), cc = ox * ox + oz * oz - r * r;
    const disc = b * b - 4 * a * cc;
    if (a > 1e-12 && disc >= 0) {
      for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
        const y = oy + t * d[1];
        if (y >= y0 && y <= y1) { const px = ox + t * d[0], pz = oz + t * d[2]; consider(t, [px / r, 0, pz / r]); }
      }
    }
    if (Math.abs(d[1]) > 1e-12) for (const [yy, ny] of [[y1, 1], [y0, -1]] as const) {
      const t = (yy - oy) / d[1];
      const px = ox + t * d[0], pz = oz + t * d[2];
      if (px * px + pz * pz <= r * r) consider(t, [0, ny, 0]);
    }
  } else {
    // radius(y) = r * (y1 - y) / h ; x² + z² = k² (y1 - y)², k = r / h
    const k = r / h, k2 = k * k;
    const dy = oy - y1;
    const a = d[0] * d[0] + d[2] * d[2] - k2 * d[1] * d[1];
    const b = 2 * (ox * d[0] + oz * d[2] - k2 * dy * d[1]);
    const cc = ox * ox + oz * oz - k2 * dy * dy;
    const disc = b * b - 4 * a * cc;
    if (Math.abs(a) > 1e-12 && disc >= 0) {
      for (const t of [(-b - Math.sqrt(disc)) / (2 * a), (-b + Math.sqrt(disc)) / (2 * a)]) {
        const y = oy + t * d[1];
        if (y >= y0 && y <= y1) { const px = ox + t * d[0], pz = oz + t * d[2]; const l = Math.hypot(px, pz) || 1; consider(t, [px / l, k, pz / l]); }
      }
    }
    if (Math.abs(d[1]) > 1e-12) {
      const t = (y0 - oy) / d[1];
      const px = ox + t * d[0], pz = oz + t * d[2];
      if (px * px + pz * pz <= r * r) consider(t, [0, -1, 0]);
    }
  }
  return best;
}

export function hitSolid(o: Vec3, d: Vec3, s: Solid): { t: number; n: Vec3 } | null {
  const lo = toLocal(o, s), ld = dirToLocal(d, s);
  const p = s.part;
  const h = p.kind === 'box' ? hitBox(lo, ld, p.c, p.s) : hitCyl(lo, ld, p.c, p.r, p.h, p.kind === 'cone');
  return h ? { t: h.t, n: nToWorld(h.n, s) } : null;
}

const WALL_N: Record<Wall, Vec3> = { north: [0, 0, 1], south: [0, 0, -1], east: [-1, 0, 0], west: [1, 0, 0] };

/** Ray from inside the room against its shell; openings let the ray out (to "outside"). */
function hitRoom(o: Vec3, d: Vec3, room: Room): Hit {
  const hx = room.width / 2, hz = room.depth / 2;
  const cands: Array<{ t: number; cls: string; n: Vec3; wall?: Wall }> = [];
  if (d[1] < -1e-12) cands.push({ t: (0 - o[1]) / d[1], cls: 'floor', n: [0, 1, 0] });
  if (d[1] > 1e-12) cands.push({ t: (room.height - o[1]) / d[1], cls: 'ceiling', n: [0, -1, 0] });
  if (d[0] > 1e-12) cands.push({ t: (hx - o[0]) / d[0], cls: 'wall', n: WALL_N.east, wall: 'east' });
  if (d[0] < -1e-12) cands.push({ t: (-hx - o[0]) / d[0], cls: 'wall', n: WALL_N.west, wall: 'west' });
  if (d[2] > 1e-12) cands.push({ t: (hz - o[2]) / d[2], cls: 'wall', n: WALL_N.south, wall: 'south' });
  if (d[2] < -1e-12) cands.push({ t: (-hz - o[2]) / d[2], cls: 'wall', n: WALL_N.north, wall: 'north' });
  let best = cands[0];
  for (const c of cands) if (c.t > 0 && (!best || c.t < best.t || best.t <= 0)) best = c;
  if (!best || best.t <= 0) return NO_HIT;
  if (best.wall) {
    const p: Vec3 = [o[0] + best.t * d[0], o[1] + best.t * d[1], o[2] + best.t * d[2]];
    const along = best.wall === 'north' || best.wall === 'south' ? p[0] : p[2];
    for (const op of room.openings) {
      if (op.wall !== best.wall) continue;
      if (Math.abs(along - op.offset) <= op.width / 2 && p[1] >= op.sill && p[1] <= op.sill + op.height) {
        // Seen through the opening: an outside surface far away (ground below the horizon, else sky).
        return { t: d[1] < -0.02 ? Math.min(60, -o[1] / d[1]) : 60, obj: -1, cls: op.kind === 'window' ? 'window' : 'door', n: best.n };
      }
    }
  }
  return { t: best.t, obj: -1, cls: best.cls, n: best.n };
}

export interface Scene { layout: Layout; solids: Solid[] }

export function buildScene(layout: Layout): Scene {
  return { layout, solids: objectSolids(layout) };
}

/** Nearest hit along a ray, or a sky hit (t = Infinity). */
export function cast(scene: Scene, o: Vec3, d: Vec3, skip = -1): Hit {
  let best: Hit = NO_HIT;
  for (const s of scene.solids) {
    if (s.obj === skip) continue;
    const h = hitSolid(o, d, s);
    if (h && h.t < best.t) best = { t: h.t, obj: s.obj, cls: s.cls, n: h.n };
  }
  const room = scene.layout.room;
  if (room) {
    const r = hitRoom(o, d, room);
    if (r.t < best.t) best = r;
  } else if (d[1] < -1e-9) {
    const t = -o[1] / d[1];
    const half = scene.layout.ground.size / 2;
    const px = o[0] + t * d[0], pz = o[2] + t * d[2];
    if (t < best.t && Math.abs(px) <= half && Math.abs(pz) <= half) best = { t, obj: -1, cls: 'ground', n: [0, 1, 0] };
  }
  return best;
}

export function classColor(cls: string): [number, number, number] {
  const shell = (SHELL_COLORS as Record<string, readonly number[]>)[cls === 'window' || cls === 'door' ? 'opening' : cls];
  if (shell) return shell as [number, number, number];
  return CATALOG.get(cls)?.color ?? [160, 160, 160];
}
