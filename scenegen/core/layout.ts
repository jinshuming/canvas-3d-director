/**
 * Editing a layout the way the agent thinks about it ("a sofa against the
 * north wall, a coffee table in front of it, a lamp to its left"), and
 * checking the result (overlaps, floating, out of the room, blocked walkway).
 * Pure functions on a Layout; every op returns a short text the agent reads.
 */
import { entryOf, resolveType } from './catalog.ts';
import { DEG } from './frame.ts';
import type { Vec3 } from './frame.ts';
import { objectBounds } from './geometry.ts';
import type { Layout, LayoutObject, Opening, Room, Wall } from './types.ts';

export interface PlaceSpec {
  type: string;
  label?: string;
  id?: string;
  size?: Partial<{ width: number; height: number; depth: number }> | Vec3;
  /** Explicit position [x, z] (or [x, y, z]); otherwise the relation decides. */
  position?: number[];
  yaw?: number;
  /** Relations, resolved in this order: against | on | in_front_of | behind | left_of | right_of | near | center. */
  against?: Wall;
  on?: string;
  in_front_of?: string;
  behind?: string;
  left_of?: string;
  right_of?: string;
  near?: string;
  /** Face towards another object (by id) or a wall. */
  facing?: string;
  /** Gap to the reference object, metres. Default 0.4 (0 for against). */
  gap?: number;
  /** Slide along the wall / across the reference, metres. */
  offset?: number;
  importance?: number;
  material?: string;
}

const WALL_YAW: Record<Wall, number> = { north: 0, south: 180, east: 270, west: 90 };

export function uniqueId(layout: Layout, base: string): string {
  const b = base.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_|_$/g, '') || 'object';
  if (!layout.objects.some((o) => o.id === b)) return b;
  for (let i = 2; ; i++) if (!layout.objects.some((o) => o.id === `${b}_${i}`)) return `${b}_${i}`;
}

function sizeOf(spec: PlaceSpec, type: string): Vec3 {
  const def = entryOf(type).size;
  if (Array.isArray(spec.size)) return [spec.size[0] ?? def[0], spec.size[1] ?? def[1], spec.size[2] ?? def[2]];
  const s = spec.size ?? {};
  return [s.width ?? def[0], s.height ?? def[1], s.depth ?? def[2]];
}

/** Footprint half extents in world x/z for a size and yaw. */
function halfXZ(size: Vec3, yaw: number): [number, number] {
  const c = Math.abs(Math.cos(yaw * DEG)), s = Math.abs(Math.sin(yaw * DEG));
  return [c * size[0] / 2 + s * size[2] / 2, s * size[0] / 2 + c * size[2] / 2];
}

/** Unit vector of where an object's front faces. */
export function frontOf(yaw: number): [number, number] {
  return [Math.sin(yaw * DEG), Math.cos(yaw * DEG)];
}

function yawTowards(from: [number, number], to: [number, number]): number {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  return ((Math.atan2(dx, dz) / DEG) + 360) % 360;
}

function find(layout: Layout, ref: string): LayoutObject {
  const o = layout.objects.find((x) => x.id === ref) ?? layout.objects.find((x) => x.label.toLowerCase().includes(ref.toLowerCase()));
  if (!o) throw new Error(`No object "${ref}". Ids: ${layout.objects.map((x) => x.id).join(', ') || '(none)'}.`);
  return o;
}

/** Add an object; returns it. Throws with a message the agent can act on. */
export function placeObject(layout: Layout, spec: PlaceSpec): LayoutObject {
  const type = resolveType(spec.type) ?? 'box';
  const entry = entryOf(type);
  const size = sizeOf(spec, type);
  let yaw = spec.yaw ?? 0;
  let x = 0, y = 0, z = 0;
  const gap = spec.gap ?? 0.4;
  const room = layout.room;
  if (spec.position && spec.position.length >= 2) {
    if (spec.position.length === 2) [x, z] = spec.position as [number, number];
    else [x, y, z] = spec.position as [number, number, number];
  } else if (spec.against) {
    if (!room) throw new Error('"against" needs a room; outdoors give a position or a relation to another object.');
    yaw = spec.yaw ?? WALL_YAW[spec.against];
    const [hx, hz] = halfXZ(size, yaw);
    const off = spec.offset ?? 0;
    const g = spec.gap ?? 0.02;
    if (spec.against === 'north') { x = off; z = -room.depth / 2 + hz + g; }
    if (spec.against === 'south') { x = off; z = room.depth / 2 - hz - g; }
    if (spec.against === 'east') { z = off; x = room.width / 2 - hx - g; }
    if (spec.against === 'west') { z = off; x = -room.width / 2 + hx + g; }
  } else if (spec.on) {
    const base = find(layout, spec.on);
    const top = base.position[1] + base.size[1] * (entryOf(base.type).surface ?? 1);
    [x, z] = [base.position[0] + (spec.offset ?? 0) * Math.cos(base.yaw * DEG), base.position[2] - (spec.offset ?? 0) * Math.sin(base.yaw * DEG)];
    y = top;
    yaw = spec.yaw ?? base.yaw;
  } else {
    const relName = (['in_front_of', 'behind', 'left_of', 'right_of', 'near'] as const).find((k) => spec[k]);
    if (relName) {
      const ref = find(layout, spec[relName]!);
      const [fx, fz] = frontOf(ref.yaw);
      // The reference's own right, as it faces its front: front (fx, fz) turned 90° clockwise seen from above.
      const [rx, rz] = [-fz, fx];
      const refDepth = ref.size[2] / 2, refWidth = ref.size[0] / 2;
      const myHalfDepth = size[2] / 2, myHalfWidth = size[0] / 2;
      let dx = 0, dz = 0;
      if (relName === 'in_front_of' || relName === 'near') { const k = refDepth + gap + myHalfDepth; dx = fx * k; dz = fz * k; yaw = spec.yaw ?? (ref.yaw + 180) % 360; }
      if (relName === 'behind') { const k = refDepth + gap + myHalfDepth; dx = -fx * k; dz = -fz * k; yaw = spec.yaw ?? ref.yaw; }
      if (relName === 'right_of') { const k = refWidth + gap + myHalfWidth; dx = rx * k; dz = rz * k; yaw = spec.yaw ?? ref.yaw; }
      if (relName === 'left_of') { const k = refWidth + gap + myHalfWidth; dx = -rx * k; dz = -rz * k; yaw = spec.yaw ?? ref.yaw; }
      const off = spec.offset ?? 0;
      x = ref.position[0] + dx + rx * (relName === 'in_front_of' || relName === 'behind' || relName === 'near' ? off : 0);
      z = ref.position[2] + dz + rz * (relName === 'in_front_of' || relName === 'behind' || relName === 'near' ? off : 0);
      y = 0;
    }
  }
  if (spec.facing) {
    const target = spec.facing as string;
    const wall = (['north', 'south', 'east', 'west'] as const).find((w) => w === target);
    if (wall) yaw = { north: 180, south: 0, east: 90, west: 270 }[wall];
    else { const o = find(layout, target); yaw = yawTowards([x, z], [o.position[0], o.position[2]]); }
  }
  const obj: LayoutObject = {
    id: uniqueId(layout, spec.id ?? type),
    type,
    label: spec.label ?? type.replace(/_/g, ' '),
    size,
    position: [round(x), round(y), round(z)],
    yaw: round(((yaw % 360) + 360) % 360),
    ...(spec.importance !== undefined ? { importance: spec.importance } : {}),
    ...(spec.material ? { material: spec.material } : {}),
    ...(spec.on ? { on: find(layout, spec.on).id } : {}),
  };
  if (room) clampIntoRoom(obj, room);
  layout.objects.push(obj);
  void entry;
  return obj;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

function clampIntoRoom(o: LayoutObject, room: Room): void {
  const [hx, hz] = halfXZ(o.size, o.yaw);
  o.position[0] = round(Math.max(-room.width / 2 + hx, Math.min(room.width / 2 - hx, o.position[0])));
  o.position[2] = round(Math.max(-room.depth / 2 + hz, Math.min(room.depth / 2 - hz, o.position[2])));
}

export function setRoom(layout: Layout, room: { width: number; depth: number; height?: number }): Room {
  layout.room = { width: room.width, depth: room.depth, height: room.height ?? 2.8, openings: layout.room?.openings ?? [] };
  return layout.room;
}

export function addOpening(layout: Layout, o: Omit<Opening, 'id' | 'sill' | 'height' | 'width' | 'offset'> & Partial<Opening>): Opening {
  if (!layout.room) throw new Error('Create the room first.');
  const op: Opening = {
    id: `${o.kind}_${layout.room.openings.length + 1}`,
    kind: o.kind,
    wall: o.wall,
    offset: o.offset ?? 0,
    width: o.width ?? (o.kind === 'door' ? 0.9 : 1.6),
    height: o.height ?? (o.kind === 'door' ? 2.1 : 1.4),
    sill: o.sill ?? (o.kind === 'door' ? 0 : 0.9),
  };
  layout.room.openings.push(op);
  return op;
}

export function updateObject(layout: Layout, id: string, patch: Partial<Pick<LayoutObject, 'label' | 'size' | 'position' | 'yaw' | 'importance' | 'material'>>): LayoutObject {
  const o = find(layout, id);
  Object.assign(o, patch);
  if (layout.room) clampIntoRoom(o, layout.room);
  return o;
}

export function removeObjects(layout: Layout, ids: string[]): number {
  const before = layout.objects.length;
  layout.objects = layout.objects.filter((o) => !ids.includes(o.id));
  return before - layout.objects.length;
}

// ── Checks ─────────────────────────────────────────────────────────────────

export interface Issue { kind: 'overlap' | 'floating' | 'outside' | 'blocked' | 'buried' | 'tight'; ids: string[]; message: string }

function overlapXZ(a: { min: Vec3; max: Vec3 }, b: { min: Vec3; max: Vec3 }): number {
  const ox = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  const oz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  return ox > 0 && oz > 0 ? ox * oz : 0;
}

/** Problems a person would notice: things inside each other, hovering, outside the room, no way through. */
export function checkLayout(layout: Layout): Issue[] {
  const issues: Issue[] = [];
  const bounds = layout.objects.map(objectBounds);
  const flat = new Set(['rug', 'road', 'water']);
  layout.objects.forEach((a, i) => {
    const ba = bounds[i]!;
    if (a.position[1] > 0.01 && !a.on) issues.push({ kind: 'floating', ids: [a.id], message: `${a.id} floats ${a.position[1].toFixed(2)} m above the floor with nothing under it.` });
    if (a.on) {
      const base = layout.objects.find((o) => o.id === a.on);
      if (!base) issues.push({ kind: 'floating', ids: [a.id], message: `${a.id} stands on ${a.on}, which is gone.` });
      else {
        const bb = objectBounds(base);
        if (overlapXZ(ba, bb) < 0.5 * (ba.max[0] - ba.min[0]) * (ba.max[2] - ba.min[2])) issues.push({ kind: 'floating', ids: [a.id, base.id], message: `${a.id} hangs off the edge of ${base.id}.` });
      }
    }
    if (layout.room) {
      const r = layout.room;
      if (ba.min[0] < -r.width / 2 - 0.01 || ba.max[0] > r.width / 2 + 0.01 || ba.min[2] < -r.depth / 2 - 0.01 || ba.max[2] > r.depth / 2 + 0.01) issues.push({ kind: 'outside', ids: [a.id], message: `${a.id} sticks out of the room.` });
      if (ba.max[1] > r.height + 0.01) issues.push({ kind: 'outside', ids: [a.id], message: `${a.id} (${ba.max[1].toFixed(2)} m) is taller than the room (${r.height} m).` });
    }
    for (let j = i + 1; j < layout.objects.length; j++) {
      const b = layout.objects[j]!;
      if (a.on === b.id || b.on === a.id) continue;
      if (flat.has(a.type) || flat.has(b.type)) continue;
      const bb = bounds[j]!;
      const oy = Math.min(ba.max[1], bb.max[1]) - Math.max(ba.min[1], bb.min[1]);
      const area = overlapXZ(ba, bb);
      if (oy > 0.02 && area > 0.01) issues.push({ kind: 'overlap', ids: [a.id, b.id], message: `${a.id} and ${b.id} overlap by ${area.toFixed(2)} m² of floor.` });
    }
  });
  if (layout.room) issues.push(...walkway(layout, bounds));
  return issues;
}

/** Is the free floor connected, with a 0.6 m wide way from every door? Grid flood fill at 0.1 m. */
function walkway(layout: Layout, bounds: Array<{ min: Vec3; max: Vec3 }>): Issue[] {
  const r = layout.room!;
  const cell = 0.1, half = 0.3;
  const nx = Math.ceil(r.width / cell), nz = Math.ceil(r.depth / cell);
  const blocked = new Uint8Array(nx * nz);
  const low = new Set(['rug', 'road', 'water']);
  for (let i = 0; i < nx; i++) for (let k = 0; k < nz; k++) {
    const x = -r.width / 2 + (i + 0.5) * cell, z = -r.depth / 2 + (k + 0.5) * cell;
    if (x < -r.width / 2 + half || x > r.width / 2 - half || z < -r.depth / 2 + half || z > r.depth / 2 - half) { blocked[i * nz + k] = 1; continue; }
    for (let j = 0; j < bounds.length; j++) {
      const o = layout.objects[j]!;
      if (low.has(o.type) || o.position[1] > 0.5) continue;
      const b = bounds[j]!;
      if (x > b.min[0] - half && x < b.max[0] + half && z > b.min[2] - half && z < b.max[2] + half) { blocked[i * nz + k] = 1; break; }
    }
  }
  const free = blocked.reduce((n, b) => n + (b ? 0 : 1), 0);
  if (free === 0) return [{ kind: 'blocked', ids: [], message: 'There is no free floor to walk on.' }];
  const seen = new Uint8Array(nx * nz);
  const start = blocked.findIndex((b) => !b);
  const stack = [start];
  seen[start] = 1;
  let reached = 0;
  while (stack.length) {
    const c = stack.pop()!;
    reached++;
    const i = Math.floor(c / nz), k = c % nz;
    for (const [di, dk] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di!, kk = k + dk!;
      if (ii < 0 || kk < 0 || ii >= nx || kk >= nz) continue;
      const n = ii * nz + kk;
      if (!blocked[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
    }
  }
  if (reached < free * 0.9) return [{ kind: 'blocked', ids: [], message: `The free floor is cut into pieces: only ${Math.round((reached / free) * 100)}% of it connects. Leave a 0.6 m way through.` }];
  if (free * cell * cell < r.width * r.depth * 0.2) return [{ kind: 'tight', ids: [], message: `Only ${(free * cell * cell).toFixed(1)} m² of floor is free to walk on; the room feels crammed.` }];
  return [];
}

/** A compact, numbered description of the layout for the agent. */
export function describeLayout(layout: Layout): string {
  const lines: string[] = [];
  if (layout.room) {
    const r = layout.room;
    lines.push(`Room ${r.width}×${r.depth} m, ${r.height} m high (x -${r.width / 2}..${r.width / 2}, z -${r.depth / 2} north..${r.depth / 2} south). Openings: ${r.openings.map((o) => `${o.id} ${o.wall} wall at ${o.offset} (${o.width}×${o.height} m)`).join('; ') || 'none'}.`);
  } else lines.push(`Outdoors, ground ${layout.ground.size}×${layout.ground.size} m centred on the origin.`);
  for (const o of layout.objects) lines.push(`- ${o.id} [${o.type}] "${o.label}" at (${o.position.map((v) => v.toFixed(2)).join(', ')}), size ${o.size.map((v) => v.toFixed(2)).join('×')}, front faces ${o.yaw}°${o.on ? `, on ${o.on}` : ''}${o.importance !== undefined ? `, importance ${o.importance}` : ''}`);
  if (layout.capture) lines.push(`Capture point (${layout.capture.position.map((v) => v.toFixed(2)).join(', ')}), facing ${layout.capture.yaw.toFixed(0)}°.`);
  lines.push(`Style: ${layout.style.summary || '(not set)'}`);
  return lines.join('\n');
}
