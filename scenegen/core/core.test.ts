import assert from 'node:assert/strict';
import { test } from 'node:test';

import { compileCaption } from './caption.ts';
import { findCapturePoint, frontYaw } from './capture.ts';
import { townSquare, livingRoom } from './fixtures.ts';
import { basis, c2wToPose, dirToEquirect, equirectDir, fromServiceC2W, poseToC2W, toServiceC2W } from './frame.ts';
import type { Mat4 } from './frame.ts';
import { buildScene, cast } from './geometry.ts';
import { checkLayout, placeObject, setRoom } from './layout.ts';
import { depthImage, depthRange, objectCoverage, renderEquirect } from './render.ts';
import { distanceToFloor, readSpz } from './spz.ts';
import { readPointsPly, writeSpz } from './spzwrite.ts';
import { emptyLayout } from './types.ts';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
function rigid(m: Mat4) {
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) close(m[0]![a]! * m[0]![b]! + m[1]![a]! * m[1]![b]! + m[2]![a]! * m[2]![b]!, a === b ? 1 : 0);
  const R = m.slice(0, 3).map((r) => r.slice(0, 3));
  const det = R[0]![0]! * (R[1]![1]! * R[2]![2]! - R[1]![2]! * R[2]![1]!) - R[0]![1]! * (R[1]![0]! * R[2]![2]! - R[1]![2]! * R[2]![0]!) + R[0]![2]! * (R[1]![0]! * R[2]![1]! - R[1]![1]! * R[2]![0]!);
  close(det, 1);
  assert.deepEqual(m[3], [0, 0, 0, 1]);
}

test('c2w: OpenCV axes, rigid, round-trips, and the service flip', () => {
  const pose = { position: [2, 1.5, -3] as [number, number, number], yaw: 30, pitch: -10 };
  const m = poseToC2W(pose);
  rigid(m);
  // Column 2 is forward; yaw 30 looks north-east: x > 0, z < 0.
  assert.ok(m[0]![2]! > 0 && m[2]![2]! < 0);
  // Column 1 (down) points to -Y for a level camera.
  close(poseToC2W({ position: [0, 0, 0], yaw: 0 })[1]![1]!, -1);
  const back = c2wToPose(m);
  close(back.yaw, 30, 1e-9); close(back.pitch!, -10, 1e-9);
  // The pose sent to JST-2 is in the Y/Z-flipped world (measured on custom-pano, 2026-11-15) and still rigid.
  const s = toServiceC2W(pose);
  rigid(s);
  assert.deepEqual(s[1]![3], -1.5);
  assert.deepEqual(s[2]![3], 3);
  assert.deepEqual(JSON.parse(JSON.stringify(fromServiceC2W(s))), JSON.parse(JSON.stringify(m)));
  // Matches what the API echoed back for the calibration call (views[0].c2w for yaw 30 at (2, 1.5, -3), sent unflipped).
  const echoed = [[0.8660254037844387, 0, 0.49999999999999994, 2], [0, -1, 0, 1.5], [0.49999999999999994, 0, -0.8660254037844387, -3], [0, 0, 0, 1]];
  poseToC2W({ position: [2, 1.5, -3], yaw: 30 }).forEach((row, i) => row.forEach((v, j) => close(v, echoed[i]![j]!, 1e-12)));
});

test('equirect: pixel ↔ direction round-trip, centre = forward', () => {
  const b = basis({ position: [0, 0, 0], yaw: 77, pitch: 0 });
  const d = equirectDir(1023.5 - 0.5, 511.5 - 0.5, 2048, 1024, b);
  for (let i = 0; i < 3; i++) close(d[i]!, b.forward[i]!, 1e-2);
  for (const [u, v] of [[10, 20], [700, 512], [2000, 900]] as const) {
    const [uu, vv] = dirToEquirect(equirectDir(u, v, 2048, 1024, b), 2048, 1024, b);
    close(uu, u, 1e-6); close(vv, v, 1e-6);
  }
});

test('layout: relations place things where a person would', () => {
  const l = livingRoom();
  const sofa = l.objects.find((o) => o.id === 'sofa')!;
  // Against the north wall, facing into the room (south).
  close(sofa.position[2], -2.5 + 0.45 + 0.02, 1e-6);
  assert.equal(sofa.yaw, 0);
  const table = l.objects.find((o) => o.id === 'coffee_table')!;
  assert.ok(table.position[2] > sofa.position[2] + 0.5, 'coffee table is in front of the sofa');
  const lamp = l.objects.find((o) => o.id === 'lamp')!;
  assert.ok(lamp.position[0] > sofa.position[0] + 1, "the lamp is on the sofa's own left = east, as it faces south");
  const tv = l.objects.find((o) => o.id === 'tv')!;
  close(tv.position[1], 0.9, 1e-9);
  assert.deepEqual(checkLayout(l), []);
});

test('layout checks: overlap, floating, outside, blocked', () => {
  const l = emptyLayout();
  setRoom(l, { width: 3, depth: 3, height: 2.5 });
  placeObject(l, { type: 'box', id: 'a', label: 'a', position: [0, 0] });
  placeObject(l, { type: 'box', id: 'b', label: 'b', position: [0.2, 0] });
  placeObject(l, { type: 'box', id: 'c', label: 'c', position: [1, 1, 1] });
  placeObject(l, { type: 'wardrobe', id: 'w', label: 'w', size: [3, 3, 0.5], position: [0, 0] });
  const kinds = new Set(checkLayout(l).map((i) => i.kind));
  assert.ok(kinds.has('overlap'));
  assert.ok(kinds.has('floating'));
  assert.ok(kinds.has('outside'));
});

test('ray caster: distances to the room shell and a box', () => {
  const l = emptyLayout();
  setRoom(l, { width: 6, depth: 4, height: 3 });
  const s = buildScene(l);
  close(cast(s, [0, 1.5, 0], [1, 0, 0]).t, 3);
  close(cast(s, [0, 1.5, 0], [0, -1, 0]).t, 1.5);
  assert.equal(cast(s, [0, 1.5, 0], [0, 0, -1]).cls, 'wall');
  placeObject(l, { type: 'box', id: 'b', label: 'b', position: [2, 0], size: [1, 3, 1] });
  const h = cast(buildScene(l), [0, 1.5, 0], [1, 0, 0]);
  close(h.t, 1.5); assert.equal(h.obj, 0); close(h.n[0], -1);
  // A window lets the ray out.
  l.room!.openings.push({ id: 'w', kind: 'window', wall: 'north', offset: 0, width: 2, height: 1, sill: 1 });
  assert.equal(cast(buildScene(l), [0, 1.5, 0], [0, 0, -1]).cls, 'window');
});

test('renders: depth encoding and per-object coverage', () => {
  const l = livingRoom();
  const pose = { position: [0, 1.5, 0.5] as [number, number, number], yaw: 0 };
  const r = renderEquirect(buildScene(l), pose, 128, 64);
  const range = depthRange(r);
  assert.ok(range.zMin > 0 && range.zMax > range.zMin);
  const d = depthImage(r, range.zMin, range.zMax);
  assert.equal(d.length, 128 * 64 * 3);
  // Straight down is the floor (near → bright), straight up the ceiling.
  assert.ok(d[(63 * 128 + 64) * 3]! > 120);
  const cov = objectCoverage(r, l.objects.length);
  assert.ok(cov[l.objects.findIndex((o) => o.id === 'sofa')]!.sr > 0.05);
});

test('capture point: sees every object of the sample room, faces them', () => {
  const l = livingRoom();
  const c = findCapturePoint(l);
  assert.ok(c.evaluated > 50);
  assert.ok(Object.values(c.best.visible).filter((v) => v > 0.5).length >= l.objects.length - 1);
  assert.equal(c.best.position[1], 1.5);
  // The front faces the sofa side (north), roughly.
  const yaw = frontYaw(l, c.best.position);
  assert.ok(yaw < 90 || yaw > 270, `front yaw ${yaw}`);
  const town = findCapturePoint(townSquare(), { maxCandidates: 120 });
  assert.ok(town.best.score > 0.5);
});

test('caption: fits JST-2 (≤ 1000 chars), most important objects first, all style kept', () => {
  const l = livingRoom();
  const c = findCapturePoint(l);
  const text = compileCaption(l, { position: c.best.position, yaw: c.best.yaw });
  assert.ok(text.length <= 1000);
  assert.match(text, /Lighting: soft afternoon sunlight/);
  assert.match(text, /sofa/);
  assert.match(text, /no people/);
});

test('SPZ: write v2 → read back, and find the floor', () => {
  const n = 4000;
  const pos = new Float32Array(n * 3), col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    // A floor at y = -1.5 and a ceiling at y = 1.2 around the origin.
    const floor = i % 2 === 0;
    pos[i * 3] = (Math.random() - 0.5) * 4; pos[i * 3 + 1] = floor ? -1.5 : 1.2; pos[i * 3 + 2] = (Math.random() - 0.5) * 4;
    col[i * 3] = 200; col[i * 3 + 1] = 100; col[i * 3 + 2] = 50;
  }
  const p = readSpz(writeSpz(pos, col));
  assert.equal(p.count, n);
  assert.equal(p.version, 2);
  close(p.positions[1]!, -1.5, 1e-3);
  assert.ok(Math.abs(p.colors[0]! - 200) <= 2);
  const d = distanceToFloor(p, [0, 0, 0], [0, -1, 0], { radius: 0.5, maxDistance: 5 })!;
  close(d, 1.5, 0.02);
});

test('PLY reader: binary xyz + rgb', () => {
  const head = 'ply\nformat binary_little_endian 1.0\nelement vertex 2\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n';
  const body = new ArrayBuffer(2 * 15);
  const dv = new DataView(body);
  [[1, 2, 3, 10, 20, 30], [4, 5, 6, 40, 50, 60]].forEach((v, i) => { dv.setFloat32(i * 15, v[0]!, true); dv.setFloat32(i * 15 + 4, v[1]!, true); dv.setFloat32(i * 15 + 8, v[2]!, true); dv.setUint8(i * 15 + 12, v[3]!); dv.setUint8(i * 15 + 13, v[4]!); dv.setUint8(i * 15 + 14, v[5]!); });
  const buf = new Uint8Array([...new TextEncoder().encode(head), ...new Uint8Array(body)]);
  const p = readPointsPly(buf);
  assert.deepEqual([...p.positions], [1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...p.colors], [10, 20, 30, 40, 50, 60]);
});
