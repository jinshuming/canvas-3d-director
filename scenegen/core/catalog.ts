/**
 * Blockout assets: parametric shapes made of boxes and vertical cylinders, at
 * real sizes. Local frame: origin at the centre of the footprint on the
 * ground, +Y up, the FRONT faces +Z. Parts scale with the object's size, so
 * `size` can be anything within reason.
 */
import type { Vec3 } from './frame.ts';

export type Part =
  | { kind: 'box'; c: Vec3; s: Vec3 }
  | { kind: 'cyl'; c: Vec3; r: number; h: number }
  | { kind: 'cone'; c: Vec3; r: number; h: number };

export interface CatalogEntry {
  type: string;
  group: 'indoor' | 'outdoor' | 'any';
  /** Default width, height, depth (m). */
  size: Vec3;
  /** Words the agent may use for it. */
  aliases: string[];
  /** Semantic colour, for the condition map and the blockout view. */
  color: [number, number, number];
  /** Parts for a given size [w, h, d]. */
  parts(w: number, h: number, d: number): Part[];
  /** Stands against a wall by default. */
  wall?: boolean;
  /** Other things can stand on top of it at this height fraction (1 = its top). */
  surface?: number;
}

const box = (cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Part => ({ kind: 'box', c: [cx, cy, cz], s: [sx, sy, sz] });
const cyl = (cx: number, cy: number, cz: number, r: number, h: number): Part => ({ kind: 'cyl', c: [cx, cy, cz], r, h });
const cone = (cx: number, cy: number, cz: number, r: number, h: number): Part => ({ kind: 'cone', c: [cx, cy, cz], r, h });

/** A table: top slab and four legs. */
function table(w: number, h: number, d: number, top = 0.05): Part[] {
  const l = Math.min(0.06, w / 10);
  return [
    box(0, h - top / 2, 0, w, top, d),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz]) => box(sx! * (w / 2 - l), (h - top) / 2, sz! * (d / 2 - l), l, h - top, l)),
  ];
}

function seat(w: number, h: number, d: number, seatH: number, arms: boolean): Part[] {
  const back = Math.min(0.2, d * 0.25);
  const arm = arms ? Math.min(0.2, w * 0.1) : 0;
  const parts = [box(0, seatH / 2, back / 2, w, seatH, d - back), box(0, h / 2, -d / 2 + back / 2, w, h, back)];
  if (arms) parts.push(box(-w / 2 + arm / 2, (seatH + 0.2) / 2, back / 2, arm, seatH + 0.2, d - back), box(w / 2 - arm / 2, (seatH + 0.2) / 2, back / 2, arm, seatH + 0.2, d - back));
  return parts;
}

function shelf(w: number, h: number, d: number, n: number): Part[] {
  const t = 0.03;
  const parts = [box(-w / 2 + t / 2, h / 2, 0, t, h, d), box(w / 2 - t / 2, h / 2, 0, t, h, d), box(0, h / 2, -d / 2 + t / 2, w, h, t)];
  for (let i = 0; i <= n; i++) parts.push(box(0, Math.min(h - t / 2, t / 2 + (i * (h - t)) / n), 0, w, t, d));
  return parts;
}

const E: CatalogEntry[] = [
  // ── Indoor furniture
  { type: 'sofa', group: 'indoor', size: [2.1, 0.85, 0.9], aliases: ['couch', 'settee', '沙发'], color: [70, 90, 200], wall: true, parts: (w, h, d) => seat(w, h, d, 0.45, true) },
  { type: 'armchair', group: 'indoor', size: [0.85, 0.9, 0.85], aliases: ['lounge chair', '扶手椅'], color: [90, 110, 220], parts: (w, h, d) => seat(w, h, d, 0.45, true) },
  { type: 'chair', group: 'indoor', size: [0.45, 0.9, 0.5], aliases: ['dining chair', 'stool', '椅子'], color: [120, 140, 230], parts: (w, h, d) => [...table(w, 0.46, d - 0.05, 0.04).map((p) => p.kind === 'box' ? { ...p, c: [p.c[0], p.c[1], p.c[2] + 0.025] as Vec3 } : p), box(0, (h + 0.46) / 2, -d / 2 + 0.02, w, h - 0.46, 0.04)] },
  { type: 'bed', group: 'indoor', size: [1.6, 1.0, 2.1], aliases: ['double bed', '床'], color: [200, 80, 120], wall: true, parts: (w, h, d) => [box(0, 0.25, 0.04, w, 0.5, d - 0.08), box(0, h / 2, -d / 2 + 0.04, w, h, 0.08)] },
  { type: 'dining_table', group: 'indoor', size: [1.6, 0.75, 0.9], aliases: ['table', 'desk', '餐桌', '桌子'], color: [60, 160, 60], surface: 1, parts: (w, h, d) => table(w, h, d) },
  { type: 'coffee_table', group: 'indoor', size: [1.1, 0.42, 0.6], aliases: ['low table', 'side table', '茶几'], color: [80, 180, 80], surface: 1, parts: (w, h, d) => table(w, h, d, 0.06) },
  { type: 'desk', group: 'indoor', size: [1.4, 0.75, 0.7], aliases: ['work desk', 'writing desk', '书桌'], color: [50, 150, 90], wall: true, surface: 1, parts: (w, h, d) => [box(0, h - 0.025, 0, w, 0.05, d), box(-w / 2 + 0.2, (h - 0.05) / 2, 0, 0.4, h - 0.05, d), box(w / 2 - 0.03, (h - 0.05) / 2, 0, 0.06, h - 0.05, d)] },
  { type: 'bookshelf', group: 'indoor', size: [1.0, 2.0, 0.35], aliases: ['shelf', 'bookcase', '书架'], color: [200, 120, 40], wall: true, parts: (w, h, d) => shelf(w, h, d, 5) },
  { type: 'cabinet', group: 'indoor', size: [1.2, 0.9, 0.45], aliases: ['sideboard', 'dresser', 'tv stand', '柜子', '电视柜'], color: [180, 110, 50], wall: true, surface: 1, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'wardrobe', group: 'indoor', size: [1.2, 2.1, 0.6], aliases: ['closet', '衣柜'], color: [170, 100, 60], wall: true, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'counter', group: 'indoor', size: [2.4, 0.9, 0.62], aliases: ['kitchen counter', 'kitchen island', 'bar', '橱柜', '吧台'], color: [150, 150, 60], wall: true, surface: 1, parts: (w, h, d) => [box(0, h / 2 - 0.02, 0, w, h - 0.04, d - 0.04), box(0, h - 0.02, 0, w, 0.04, d)] },
  { type: 'fridge', group: 'indoor', size: [0.7, 1.8, 0.7], aliases: ['refrigerator', '冰箱'], color: [210, 210, 230], wall: true, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'stove', group: 'indoor', size: [0.6, 0.9, 0.6], aliases: ['oven', 'range', '灶台'], color: [120, 120, 120], wall: true, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'tv', group: 'indoor', size: [1.4, 0.8, 0.08], aliases: ['television', 'screen', 'monitor', '电视'], color: [20, 20, 20], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'rug', group: 'indoor', size: [2.4, 0.02, 1.7], aliases: ['carpet', 'mat', '地毯'], color: [190, 160, 130], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'floor_lamp', group: 'indoor', size: [0.4, 1.6, 0.4], aliases: ['lamp', 'standing lamp', '落地灯'], color: [250, 230, 120], parts: (w, h, _d) => [cyl(0, 0.015, 0, w / 2 * 0.7, 0.03), cyl(0, h / 2, 0, 0.02, h - 0.3), cone(0, h - 0.3, 0, w / 2, 0.3)] },
  { type: 'table_lamp', group: 'indoor', size: [0.3, 0.5, 0.3], aliases: ['desk lamp', '台灯'], color: [250, 220, 100], parts: (w, h, _d) => [cyl(0, h * 0.25, 0, w * 0.2, h * 0.5), cone(0, h * 0.5, 0, w / 2, h * 0.5)] },
  { type: 'plant', group: 'any', size: [0.6, 1.4, 0.6], aliases: ['potted plant', 'houseplant', 'fern', '绿植', '盆栽'], color: [40, 200, 90], parts: (w, h, _d) => [cyl(0, 0.18, 0, w * 0.3, 0.36), cone(0, 0.36, 0, w / 2, h - 0.36)] },
  { type: 'fireplace', group: 'indoor', size: [1.5, 1.2, 0.5], aliases: ['hearth', '壁炉'], color: [200, 60, 40], wall: true, parts: (w, h, d) => [box(-w / 2 + 0.2, h / 2, 0, 0.4, h, d), box(w / 2 - 0.2, h / 2, 0, 0.4, h, d), box(0, h - 0.15, 0, w, 0.3, d), box(0, 0.05, 0, w, 0.1, d)] },
  { type: 'piano', group: 'indoor', size: [1.5, 1.25, 0.6], aliases: ['upright piano', '钢琴'], color: [30, 30, 50], wall: true, parts: (w, h, d) => [box(0, h / 2, -d / 4, w, h, d / 2), box(0, 0.72, d / 4, w, 0.1, d / 2)] },
  { type: 'bathtub', group: 'indoor', size: [0.8, 0.6, 1.7], aliases: ['tub', '浴缸'], color: [230, 240, 250], wall: true, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'box', group: 'any', size: [0.5, 0.5, 0.5], aliases: ['crate', 'block', 'cube', '箱子'], color: [160, 160, 160], surface: 1, parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'cylinder', group: 'any', size: [0.5, 1.0, 0.5], aliases: ['barrel', 'column', 'pillar', 'drum', '柱子', '桶'], color: [150, 150, 170], parts: (w, h, d) => [cyl(0, h / 2, 0, Math.min(w, d) / 2, h)] },
  { type: 'counter_stool', group: 'indoor', size: [0.4, 0.75, 0.4], aliases: ['bar stool', '吧椅'], color: [130, 150, 230], parts: (w, h, _d) => [cyl(0, h - 0.03, 0, w / 2, 0.06), cyl(0, (h - 0.06) / 2, 0, 0.03, h - 0.06)] },
  // ── Outdoor
  { type: 'tree', group: 'outdoor', size: [3, 6, 3], aliases: ['oak', 'pine', 'maple', '树'], color: [30, 150, 50], parts: (w, h, _d) => [cyl(0, h * 0.2, 0, Math.max(0.12, w * 0.06), h * 0.4), cone(0, h * 0.3, 0, w / 2, h * 0.7)] },
  { type: 'bush', group: 'outdoor', size: [1.2, 0.9, 1.2], aliases: ['shrub', 'hedge', '灌木'], color: [50, 170, 60], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'rock', group: 'outdoor', size: [1.2, 0.7, 1.0], aliases: ['boulder', 'stone', '石头'], color: [130, 120, 110], parts: (w, h, d) => [box(0, h * 0.3, 0, w, h * 0.6, d), box(0, h * 0.8, 0, w * 0.6, h * 0.4, d * 0.6)] },
  { type: 'building', group: 'outdoor', size: [10, 8, 8], aliases: ['house', 'shop', 'tower', 'cabin', '房子', '建筑'], color: [180, 170, 200], parts: (w, h, d) => [box(0, h * 0.4, 0, w, h * 0.8, d), box(0, h * 0.9, 0, w * 0.8, h * 0.2, d * 0.8)] },
  { type: 'car', group: 'outdoor', size: [1.85, 1.45, 4.5], aliases: ['vehicle', 'sedan', '汽车'], color: [220, 50, 50], parts: (w, h, d) => [box(0, h * 0.3, 0, w, h * 0.45, d), box(0, h * 0.75, -d * 0.05, w * 0.9, h * 0.45, d * 0.5)] },
  { type: 'street_lamp', group: 'outdoor', size: [0.4, 4.5, 0.4], aliases: ['lamp post', 'streetlight', '路灯'], color: [240, 220, 90], parts: (_w, h, _d) => [cyl(0, h / 2, 0, 0.08, h), box(0, h - 0.15, 0.2, 0.3, 0.3, 0.5)] },
  { type: 'bench', group: 'outdoor', size: [1.6, 0.85, 0.6], aliases: ['park bench', '长椅'], color: [150, 100, 60], parts: (w, h, d) => seat(w, h, d, 0.45, false) },
  { type: 'fence', group: 'outdoor', size: [4, 1.1, 0.08], aliases: ['railing', 'wall segment', '围栏'], color: [160, 140, 120], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'road', group: 'outdoor', size: [6, 0.02, 30], aliases: ['street', 'path', 'pavement', '道路'], color: [90, 90, 90], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'water', group: 'outdoor', size: [10, 0.02, 10], aliases: ['pond', 'lake', 'pool', '水池', '湖'], color: [40, 120, 220], parts: (w, h, d) => [box(0, h / 2, 0, w, h, d)] },
  { type: 'tent', group: 'outdoor', size: [2.5, 1.8, 2.5], aliases: ['market stall', 'canopy', '帐篷'], color: [240, 140, 60], parts: (w, h, d) => [cone(0, 0, 0, Math.min(w, d) / 2, h)] },
  { type: 'well', group: 'outdoor', size: [1.4, 1.8, 1.4], aliases: ['fountain', '井', '喷泉'], color: [120, 140, 160], parts: (w, h, _d) => [cyl(0, 0.4, 0, w / 2, 0.8), cone(0, h * 0.7, 0, w * 0.6, h * 0.3)] },
];

export const CATALOG: ReadonlyMap<string, CatalogEntry> = new Map(E.map((e) => [e.type, e]));

/** Resolve a type or an alias (any case, English or Chinese) to a catalog type, or null. */
export function resolveType(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (CATALOG.has(n)) return n;
  for (const e of E) if (e.aliases.some((a) => a.toLowerCase().replace(/[\s-]+/g, '_') === n)) return e.type;
  for (const e of E) if (n.includes(e.type) || e.aliases.some((a) => a.length > 2 && n.includes(a.toLowerCase().replace(/[\s-]+/g, '_')))) return e.type;
  return null;
}

export function entryOf(type: string): CatalogEntry {
  return CATALOG.get(type) ?? CATALOG.get('box')!;
}

/** Colours for the room shell and the ground in the semantic map. */
export const SHELL_COLORS = { wall: [200, 200, 200], floor: [120, 100, 80], ceiling: [230, 230, 240], ground: [110, 130, 80], sky: [0, 0, 0], opening: [255, 255, 255] } as const;

export function catalogSummary(): string {
  return E.map((e) => `${e.type} (${e.size.join('×')} m; ${e.aliases.slice(0, 3).join(', ')})`).join('\n');
}
