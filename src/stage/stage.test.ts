import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ease, sampleShot, shotSpan } from './camera.js';
import { nextFreeStart, sampleTrack, trackTravel } from './clips.js';
import type { StageClip, StageShot } from './types.js';

const shot = (keys: Array<[number, number]>, interpolation: StageShot['interpolation'] = 'linear', easing: StageShot['easing'] = 'linear'): StageShot => ({
  id: 's', name: 's', interpolation, easing,
  keys: keys.map(([t, x], i) => ({ id: `k${i}`, t, position: [x, 1, 0], target: [x, 1, -1], fov: 40 + t })),
});

test('a shot holds its first key before it and its last after it', () => {
  const s = shot([[1, 0], [3, 10]]);
  assert.deepEqual(sampleShot(s, 0)!.position, [0, 1, 0]);
  assert.deepEqual(sampleShot(s, 9)!.position, [10, 1, 0]);
  assert.deepEqual(shotSpan(s), [1, 3]);
});

test('linear interpolation is halfway at the midpoint, fov too', () => {
  const s = shot([[0, 0], [2, 10]]);
  const m = sampleShot(s, 1)!;
  assert.equal(m.position[0], 5);
  assert.equal(m.fov, 41);
});

test('keys are sorted by time whatever order they are stored in', () => {
  const s = shot([[2, 10], [0, 0]]);
  assert.equal(sampleShot(s, 1)!.position[0], 5);
});

test('a smooth path passes through every key', () => {
  const s = shot([[0, 0], [1, 4], [2, 5], [3, 9]], 'smooth');
  for (const [t, x] of [[0, 0], [1, 4], [2, 5], [3, 9]] as const) assert.ok(Math.abs(sampleShot(s, t)!.position[0] - x) < 1e-9);
});

test('step holds a key until the next', () => {
  const s = shot([[0, 0], [2, 10]], 'step');
  assert.equal(sampleShot(s, 1.99)!.position[0], 0);
});

test('easing keeps the ends and slows the start', () => {
  assert.equal(ease('easeInOut', 0), 0);
  assert.equal(ease('easeInOut', 1), 1);
  assert.ok(ease('easeIn', 0.25) < 0.25);
  const s = shot([[0, 0], [2, 10]], 'linear', 'easeIn');
  assert.ok(sampleShot(s, 0.5)!.position[0] < 2.5);
});

const clip = (id: string, start: number, end: number, loop = false): StageClip => ({ id, name: id, url: `${id}.glb`, start, end, loop });

test('a looping clip wraps, a one-shot holds its last pose', () => {
  const len = () => 2;
  assert.equal(sampleTrack([clip('a', 0, 10, true)], 5, len)!.local, 1);
  assert.equal(sampleTrack([clip('a', 0, 10)], 5, len)!.local, 2);
});

test('root motion: a one-shot walk carries the body as far as it has got, then holds', () => {
  // A 2 s clip that walks 1 m forward per second.
  const travel = (_: StageClip, local: number): [number, number] => [0, local];
  const walk = [clip('w', 1, 10)];
  assert.deepEqual(trackTravel(walk, 0.5, () => 2, travel), [0, 0]);
  assert.deepEqual(trackTravel(walk, 2, () => 2, travel), [0, 1]);
  assert.deepEqual(trackTravel(walk, 9, () => 2, travel), [0, 2]);
});

test('root motion: a loop adds a lap each time round, and the next clip starts where it left off', () => {
  const travel = (c: StageClip, local: number): [number, number] => (c.id === 'w' ? [0, local] : [local, 0]);
  const track = [clip('w', 0, 5, true), clip('s', 5, 6)];
  // 2.5 laps of a 2 s clip: 2 + 2 + 1.
  assert.deepEqual(trackTravel(track, 5, () => 2, travel), [0, 5]);
  assert.deepEqual(trackTravel(track, 5.5, () => 2, travel), [0.5, 5]);
});

test('root motion: a clip is cut where the next starts, and rootMotion false stays on the spot', () => {
  const travel = (_: StageClip, local: number): [number, number] => [0, local];
  const track = [clip('a', 0, 4), { ...clip('b', 2, 4), rootMotion: false }];
  assert.deepEqual(trackTravel(track, 3.5, () => 4, travel), [0, 2]);
});

test('before the first clip the body holds its opening pose; between clips the last one holds', () => {
  const len = () => 1;
  const track = [clip('a', 2, 3), clip('b', 5, 6)];
  assert.deepEqual([sampleTrack(track, 0, len)!.clip.id, sampleTrack(track, 0, len)!.local], ['a', 0]);
  assert.deepEqual([sampleTrack(track, 4, len)!.clip.id, sampleTrack(track, 4, len)!.local], ['a', 1]);
  assert.equal(sampleTrack(track, 5.5, len)!.clip.id, 'b');
  assert.equal(nextFreeStart(track), 6);
});
