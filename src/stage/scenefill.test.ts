import assert from 'node:assert/strict';
import { test } from 'node:test';

import { captureOf, fillBlock, fillPoseToFile, poseOfCamera, sceneVersion } from './scenefill.js';
import type { StageDoc } from './types.js';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

const doc = (scene: Partial<NonNullable<StageDoc['scene']>> | null): StageDoc => ({
  id: 's', version: 1, title: 't', duration: 8, fps: 24, aspect: '16:9', characters: [], shots: [], updatedAt: '',
  scene: scene === null ? null : { name: 'n', url: 'x.spz', placement: { upright: true, scale: 2, floor: -0.75, start: [0, 0] }, viggle: { sessionId: 'dir_1', batchIds: ['b0'] }, ...scene },
});

test('the camera pose is read off where it stands and looks, with the stage\'s yaw convention', () => {
  // Looking along -Z is yaw 0, along -X is yaw 90, up is positive pitch.
  assert.deepEqual(poseOfCamera({ position: [1, 1.5, 0], target: [1, 1.5, -3] }), { position: [1, 1.5, 0], yaw: 0, pitch: 0 });
  assert.equal(poseOfCamera({ position: [0, 1, 0], target: [-3, 1, 0] }).yaw, 90);
  assert.equal(poseOfCamera({ position: [0, 1, 0], target: [0, 4, 0.0001] }).pitch, 90);
  assert.equal(poseOfCamera({ position: [0, 1, 0], target: [0, 0, -3] }).pitch, -18);
});

test('a pose is carried into the scene file\'s frame and units', () => {
  // Mount: scale 2, upright, floor 0.75 file units below the capture point: the capture point is 1.5 m up.
  const d = doc({});
  assert.deepEqual(captureOf(d)!.map((v) => Math.round(v * 1e6) / 1e6), [0, 1.5, 0]);
  const f = fillPoseToFile(d, { position: [2, 1.5, -4], yaw: 30, pitch: -10 });
  assert.ok(near(f.position[0], 1) && near(f.position[1], 0) && near(f.position[2], -2), JSON.stringify(f.position));
  assert.equal(f.yaw, 30);
  assert.equal(f.pitch, -10);
});

test('a scene that cannot be filled says why, and a fill retires the check by changing the version', () => {
  assert.match(fillBlock(doc(null))!, /No scene/);
  assert.match(fillBlock(doc({ viggle: null }))!, /only a scene generated here/);
  assert.match(fillBlock(doc({ placement: null }))!, /not measured/);
  assert.match(fillBlock(doc({ placement: { upright: false, scale: 1, floor: 1, start: [0, 0] } }))!, /frame/);
  assert.equal(fillBlock(doc({})), null);
  assert.throws(() => fillPoseToFile(doc({ viggle: null }), { position: [0, 1, 0], yaw: 0, pitch: 0 }));
  const d = doc({});
  assert.equal(sceneVersion(d), 1);
  d.scene!.viggle!.batchIds.push('b1');
  assert.equal(sceneVersion(d), 2);
});
