import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cutAt, cutTo, editCamera, editSpan, moveCutEnd, normalizeCuts, removeCut, setSequence } from './cuts.js';
import { removeShot } from './edit.js';
import type { StageDoc, StageShot } from './types.js';

const shot = (id: string, x: number): StageShot => ({
  id, name: id, interpolation: 'linear', easing: 'linear',
  keys: [{ id: `${id}_k`, t: 0, position: [x, 1.6, 3], target: [0, 1.2, 0], fov: 40 }],
});
const doc = (): StageDoc => ({
  id: 's', version: 1, title: 't', duration: 8, fps: 24, aspect: '16:9', scene: null, characters: [], updatedAt: '',
  shots: [shot('wide', 0), shot('ots', 1), shot('rev', -1)],
});
const order = (d: StageDoc) => (d.cuts ?? []).map((c) => `${c.shotId}@${c.start}-${c.end}`);

test('a running order becomes cuts that follow each other to the end', () => {
  const d = setSequence(doc(), [{ shotId: 'ots', start: 1.8 }, { shotId: 'wide', start: 0 }, { shotId: 'rev', start: 4.5 }]);
  assert.deepEqual(order(d), ['wide@0-1.8', 'ots@1.8-4.5', 'rev@4.5-8']);
  assert.deepEqual(editSpan(d), [0, 8]);
  assert.equal(cutAt(d, 2)?.shotId, 'ots');
  assert.equal(cutAt(d, 4.5)?.shotId, 'rev', 'a cut takes over at its own start');
  assert.equal(editCamera(d, 5)?.position[0], -1, 'the film looks through the live shot');
});

test('cutting to a shot at the playhead splits the live cut', () => {
  let d = cutTo(doc(), 'wide', 3);
  assert.deepEqual(order(d), ['wide@0-8'], 'the first cut opens the film');
  d = cutTo(d, 'ots', 3);
  assert.deepEqual(order(d), ['wide@0-3', 'ots@3-8']);
  d = cutTo(d, 'rev', 5);
  assert.deepEqual(order(d), ['wide@0-3', 'ots@3-5', 'rev@5-8']);
  d = cutTo(d, 'wide', 4);
  assert.deepEqual(order(d), ['wide@0-3', 'ots@3-4', 'wide@4-5', 'rev@5-8'], 'up to the next cut, not past it');
});

test('the edit tidies itself: overlaps trimmed, neighbours on one shot joined, gone shots dropped', () => {
  const cuts = normalizeCuts([
    { id: 'a', shotId: 'wide', start: 0, end: 3 },
    { id: 'b', shotId: 'wide', start: 3, end: 5 },
    { id: 'c', shotId: 'ots', start: 4, end: 9 },
    { id: 'd', shotId: 'gone', start: 1, end: 2 },
  ], doc());
  assert.deepEqual(cuts.map((c) => `${c.shotId}@${c.start}-${c.end}`), ['wide@0-4', 'ots@4-8']);
  let d = setSequence(doc(), [{ shotId: 'wide', start: 0 }, { shotId: 'ots', start: 2 }]);
  d = removeShot(d, 'ots');
  assert.deepEqual(order(d), ['wide@0-2'], 'deleting a shot takes its cuts');
});

test('dragging a boundary moves both sides of it; removing a cut leaves a hold', () => {
  let d = setSequence(doc(), [{ shotId: 'wide', start: 0 }, { shotId: 'ots', start: 2 }, { shotId: 'rev', start: 5 }]);
  d = moveCutEnd(d, d.cuts![0]!.id, 3);
  assert.deepEqual(order(d), ['wide@0-3', 'ots@3-5', 'rev@5-8']);
  d = moveCutEnd(d, d.cuts![0]!.id, 9);
  assert.equal(d.cuts![0]!.end, 4.9, 'not past the next cut');
  d = removeCut(d, d.cuts![1]!.id);
  assert.equal(cutAt(d, 4.95)?.shotId, 'wide', 'in the gap the film holds the cut before');
});
