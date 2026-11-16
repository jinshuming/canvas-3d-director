import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Gaussians } from './gaussians.ts';
import { bounds, mul, rotY, transformGaussians } from './gaussians.ts';
import { bodyIndices, placeObject } from './place.ts';
import { supportTilt } from './seat.ts';
import type { LayoutObject } from './types.ts';

/** Seeded random numbers (mulberry32), so every run tests the same points. */
let seed = 7;
function rand(): number {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A table, 1.4 wide (x) × 0.75 high × 0.8 deep (z): a top slab and four legs, plus floaters and a floor patch. */
function table(extra = true): Gaussians {
  const pts: number[] = [];
  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, n: number) => {
    for (let i = 0; i < n; i++) pts.push(x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0), z0 + rand() * (z1 - z0));
  };
  box(-0.7, 0.7, 0.7, 0.75, -0.4, 0.4, 20000);
  for (const [x, z] of [[-0.65, -0.35], [0.65, -0.35], [-0.65, 0.35], [0.65, 0.35]]) box(x! - 0.03, x! + 0.03, 0, 0.7, z! - 0.03, z! + 0.03, 2500);
  if (extra) {
    box(-1.3, 1.3, 0, 0.01, -1.0, 1.0, 1500); // floor patch, wider than the table
    box(2.5, 2.55, 1.5, 1.55, 2.5, 2.55, 300); // a floater
  }
  const n = pts.length / 3;
  return { count: n, positions: new Float32Array(pts), scales: new Float32Array(n * 3).fill(Math.log(0.01)), rotations: new Float32Array(n * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)), alphas: new Float32Array(n).fill(0.9), colors: new Float32Array(n * 3) };
}

const obj = (yaw: number): LayoutObject => ({ id: 't', type: 'table', label: 'table', size: [1.4, 0.75, 0.8], position: [1, 0, -2], yaw });
const tilt = (deg: number): [[number, number, number], [number, number, number], [number, number, number]] => {
  const r = (deg * Math.PI) / 180;
  return [[1, 0, 0], [0, Math.cos(r), -Math.sin(r)], [0, Math.sin(r), Math.cos(r)]];
};

function check(g: Gaussians, o: LayoutObject, capture: [number, number, number]) {
  const b = bounds(g);
  // Upright and level.
  const t = supportTilt(g)!;
  assert.ok(t.tiltDeg < 1.5, `tilt ${t.tiltDeg}`);
  // Base on the box's base, centred on its footprint (file frame: minus the capture point).
  assert.ok(Math.abs(b.min[1] - (o.position[1] - capture[1])) < 0.03, `base ${b.min[1]}`);
  assert.ok(Math.abs((b.min[0] + b.max[0]) / 2 - (o.position[0] - capture[0])) < 0.05);
  assert.ok(Math.abs((b.min[2] + b.max[2]) / 2 - (o.position[2] - capture[2])) < 0.05);
  // Its long side along the box's width, turned by the box's yaw.
  const local = { ...g, positions: new Float32Array(g.positions) };
  transformGaussians({ ...local, scales: new Float32Array(g.scales), rotations: new Float32Array(g.rotations) }, rotY(-o.yaw), 1, [0, 0, 0]);
  const lb = bounds(local);
  const w = lb.max[0] - lb.min[0], d = lb.max[2] - lb.min[2];
  assert.ok(Math.abs(w - 1.4) < 0.12 && Math.abs(d - 0.8) < 0.12, `w ${w} d ${d}`);
}

test('cleaning keeps the body and drops a floater', () => {
  const g = table();
  const { keep } = bodyIndices(g);
  const kept = new Set(keep);
  // The table itself (the first 30000 points) stays; the floater (the last 300) goes.
  for (let i = 0; i < 30000; i++) assert.ok(kept.has(i), `table point ${i} dropped`);
  for (let i = g.count - 300; i < g.count; i++) assert.ok(!kept.has(i), 'floater kept');
});

test('a SAM 3D object tilted 6°, turned 17° and at its own scale is placed upright, squared and on the box', () => {
  const capture: [number, number, number] = [0, 1.5, 0];
  const o = obj(30);
  const g = table();
  // What SAM 3D might give: tilted, turned a little off the box's yaw, 0.4× the size, somewhere else.
  transformGaussians(g, mul(tilt(6), rotY(30 + 17)), 0.4, [3, -1, 2]);
  const r = placeObject(g, o, { capture });
  assert.equal(r.result.up, 'kept');
  assert.ok(r.result.tiltDeg > 3, `levelled ${r.result.tiltDeg}`);
  assert.ok(r.result.removed > 0.02, 'floor patch and floater dropped');
  check(r.g, o, capture);
});

test('an object lying on its side is stood up; a quarter turn is taken when the box says so', () => {
  const capture: [number, number, number] = [0.5, 1.5, 0.5];
  const o = obj(-60);
  const g = table(false);
  // On its side (up = +x), then a quarter turn off (width and depth swapped).
  transformGaussians(g, mul([[0, -1, 0], [1, 0, 0], [0, 0, 1]], rotY(-60 + 90)), 2, [0, 0, 0]);
  const r = placeObject(g, o, { capture });
  assert.notEqual(r.result.up, 'kept');
  assert.ok(Math.abs(Math.abs(r.result.yawDeg) - 90) < 5, `yaw ${r.result.yawDeg}`);
  check(r.g, o, capture);
});

test('a table tilted 14° on two axes is levelled, not tilted further', () => {
  const capture: [number, number, number] = [0, 1.5, 0];
  const o = obj(0);
  const g = table(false);
  const r0 = (a: number): [[number, number, number], [number, number, number], [number, number, number]] => {
    const t = (a * Math.PI) / 180;
    return [[Math.cos(t), -Math.sin(t), 0], [Math.sin(t), Math.cos(t), 0], [0, 0, 1]];
  };
  transformGaussians(g, mul(r0(9), tilt(11)), 1, [0, 0, 0]);
  const r = placeObject(g, o, { capture });
  assert.ok(r.result.tiltDeg > 12 && r.result.tiltDeg < 16, `levelled ${r.result.tiltDeg}`);
  check(r.g, o, capture);
});
