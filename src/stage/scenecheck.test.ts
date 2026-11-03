import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkScene } from './scenecheck.js';
import type { CloudSample } from './scenecheck.js';

const CAPTURE: [number, number, number] = [0, 1.5, 0];

/** A 8 x 3 x 8 m room sampled the way a panorama samples it: evenly in direction from the capture point. */
function room(drop?: (yaw: number, pitch: number) => number): CloudSample {
  let s = 12345;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pts: number[] = [];
  const N = 90_000;
  while (pts.length < N * 3) {
    // Uniform on the sphere.
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const d = [r * Math.cos(a), z, r * Math.sin(a)] as const;
    // Distance to the box walls: x, z in [-4, 4], y in [0, 3] (capture at y = 1.5).
    const tx = d[0] > 0 ? 4 / d[0] : d[0] < 0 ? -4 / d[0] : Infinity;
    const tz = d[2] > 0 ? 4 / d[2] : d[2] < 0 ? -4 / d[2] : Infinity;
    const ty = d[1] > 0 ? 1.5 / d[1] : d[1] < 0 ? -1.5 / d[1] : Infinity;
    const t = Math.min(tx, ty, tz);
    const yaw = (Math.atan2(-d[0], -d[2]) * 180) / Math.PI;
    const pitch = (Math.asin(d[1]) * 180) / Math.PI;
    if (drop && rnd() < drop(yaw, pitch)) continue;
    pts.push(CAPTURE[0] + d[0] * t, CAPTURE[1] + d[1] * t, CAPTURE[2] + d[2] * t);
  }
  return { positions: Float32Array.from(pts), alpha: null };
}

const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test('a room sampled evenly from the capture point has nothing worth filling', () => {
  const r = checkScene(room(), { capture: CAPTURE });
  assert.ok(r.domain > 20, `domain ${r.domain}`);
  assert.equal(r.views.length, 0, JSON.stringify(r.views));
});

test('a patch of wall the panorama never saw is found, and the view looks at it', () => {
  // Nothing from yaw 90 +-25, pitch -20..40: a hole in the -X wall.
  const r = checkScene(room((yaw, pitch) => (angDiff(yaw, 90) < 25 && pitch > -20 && pitch < 40 ? 1 : 0)), { capture: CAPTURE });
  assert.ok(r.views.length >= 1, 'found something');
  const best = r.views[0]!;
  assert.ok(best.hole > 0.05, `hole share ${best.hole}`);
  assert.ok(angDiff(best.yaw, 90) < 75, `looks toward the gap: yaw ${best.yaw}`);
  assert.ok(best.position[1] >= 0.5 && best.position[1] <= 2.2, 'a camera a person could hold');
});

test('a patch sampled far too thinly reads as blur, not as a hole', () => {
  const r = checkScene(room((yaw, pitch) => (angDiff(yaw, -90) < 30 && pitch > -25 && pitch < 40 ? 0.97 : 0)), { capture: CAPTURE });
  assert.ok(r.views.length >= 1, 'found something');
  const best = r.views[0]!;
  assert.ok(best.blur > best.hole, `blur ${best.blur} vs hole ${best.hole}`);
  assert.ok(angDiff(best.yaw, -90) < 80, `looks toward the thin patch: yaw ${best.yaw}`);
});

test('too few points is no answer rather than a crash', () => {
  const r = checkScene({ positions: new Float32Array(30), alpha: null }, { capture: CAPTURE });
  assert.equal(r.views.length, 0);
});

test('measureFrame: a frame aimed at the gap is mostly hole, one aimed away is clean', async () => {
  const { measureFrame } = await import('./scenecheck.js');
  const sample = room((yaw, pitch) => (angDiff(yaw, 90) < 25 && pitch > -20 && pitch < 40 ? 1 : 0));
  const at = measureFrame(sample, { capture: CAPTURE }, CAPTURE, [-1, 0.2, 0], 50)!; // yaw 90 looks -X
  const away = measureFrame(sample, { capture: CAPTURE }, CAPTURE, [1, 0, 0], 50)!;
  assert.ok(at.hole > 0.15, `hole ${at.hole}`);
  assert.ok(away.hole < 0.02 && away.blur < 0.05, `away ${JSON.stringify(away)}`);
});
