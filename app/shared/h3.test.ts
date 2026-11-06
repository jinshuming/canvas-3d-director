import assert from 'node:assert/strict';
import { test } from 'node:test';

import { H3_ASPECT, h3Credits, h3Duration } from './library.ts';

test('H3 is asked for whole seconds between 5 and 15', () => {
  assert.equal(h3Duration(2), 5, 'at least 5');
  assert.equal(h3Duration(5), 5);
  assert.equal(h3Duration(5.2), 6, 'rounded up');
  assert.equal(h3Duration(12), 12);
  assert.equal(h3Duration(40), 15, 'at most 15');
  assert.equal(h3Duration(15.0000001), 15);
});

test('an H3 render costs per started second, at Viggle\'s reference-video rate', () => {
  // 45 credits per 5 s at 768p with the prompt rewrite on: 9 a second.
  assert.equal(h3Credits(5, '768p', true), 45);
  assert.equal(h3Credits(8, '768p', true), 72);
  assert.equal(h3Credits(7.2, '768p', true), 72, 'a started second is a second');
  // Off: 25 per 5 s at 768p.
  assert.equal(h3Credits(5, '768p', false), 25);
  assert.equal(h3Credits(15, '480p', false), 45);
  assert.equal(h3Credits(5, '4k', true), 75);
});

test('every stage aspect has an H3 aspect', () => {
  assert.equal(H3_ASPECT['2.39:1'], '21:9');
  for (const a of ['16:9', '9:16', '1:1', '4:3']) assert.equal(H3_ASPECT[a], a);
});
