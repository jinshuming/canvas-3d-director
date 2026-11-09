import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SceneCollider } from '@viggle/splat-engine';

import { armReach, boomFor, insideReach, pivotFor } from './cameraArm.js';

type V = { x: number; y: number; z: number };
interface Box { min: V; max: V }

/** A collider stub that is a few solid boxes: a ray's first hit, and whether a ball touches one. */
function world(...boxes: Box[]): SceneCollider {
  const raycast = (o: V, d: V, maxT: number): number | null => {
    const l = Math.hypot(d.x, d.y, d.z) || 1;
    const u = { x: d.x / l, y: d.y / l, z: d.z / l };
    let best: number | null = null;
    for (const b of boxes) {
      let t0 = 0, t1 = maxT;
      for (const k of ['x', 'y', 'z'] as const) {
        if (Math.abs(u[k]) < 1e-9) { if (o[k] < b.min[k] || o[k] > b.max[k]) { t1 = -1; break; } continue; }
        const a = (b.min[k] - o[k]) / u[k], c = (b.max[k] - o[k]) / u[k];
        t0 = Math.max(t0, Math.min(a, c));
        t1 = Math.min(t1, Math.max(a, c));
      }
      if (t1 >= t0 && t1 >= 0 && (best === null || t0 < best)) best = t0;
    }
    return best;
  };
  const isClear = (p: V, radius: number) => boxes.every((b) => !(p.x + radius > b.min.x && p.x - radius < b.max.x && p.y + radius > b.min.y && p.y - radius < b.max.y && p.z + radius > b.min.z && p.z - radius < b.max.z));
  return { raycast, isClear } as unknown as SceneCollider;
}

const wall: Box = { min: { x: -5, y: 0, z: 2 }, max: { x: 5, y: 3, z: 2.2 } };
const feet = { x: 0, y: 0, z: 0 };
const height = 1.7;
const boom = boomFor(height);

test('with nothing in the way the eye reaches its full distance', () => {
  const pivot = pivotFor(feet, height);
  const eye = { x: 0, y: 1.5, z: 4 };
  const full = Math.hypot(eye.x - pivot.x, eye.y - pivot.y, eye.z - pivot.z);
  assert.ok(Math.abs(armReach(world(), pivot, eye, boom) - full) < 1e-9);
  assert.ok(Math.abs(insideReach(world(), pivot, eye, boom) - full) < 1e-9);
});

test('a wall between the head and the eye stops the boom short of it', () => {
  const pivot = pivotFor(feet, height);
  const eye = { x: 0, y: 1.5, z: 4 };
  const full = Math.hypot(eye.x - pivot.x, eye.y - pivot.y, eye.z - pivot.z);
  const reach = armReach(world(wall), pivot, eye, boom);
  assert.ok(reach < full - 1.5, `reach ${reach} of ${full}`);
  assert.ok(reach > 1.5, 'but not at her head');
});

test('an eye inside a wall is pulled back to its near side', () => {
  const pivot = pivotFor(feet, height);
  const inside = { x: 0, y: 1.5, z: 2.1 };
  const full = Math.hypot(inside.x - pivot.x, inside.y - pivot.y, inside.z - pivot.z);
  const reach = insideReach(world(wall), pivot, inside, boom);
  assert.ok(reach < full, `${reach} < ${full}`);
  assert.ok(reach > 1 && reach < 2, 'short of the wall face at 2 m');
});
