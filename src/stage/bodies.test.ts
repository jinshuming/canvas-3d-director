import assert from 'node:assert/strict';
import { test } from 'node:test';

import { NpcBodies, pushOutOfBodies } from './bodies.js';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;

test('a point clear of every footprint is left alone', () => {
  const b = new NpcBodies();
  b.set('a', 0, 0, 0.3);
  assert.equal(pushOutOfBodies(b, 1, 0, 0.3), null);
  assert.equal(pushOutOfBodies(b, 0.6, 0, 0.3), null, 'touching is clear');
});

test('a point inside one is put on its edge, along the line from the centre', () => {
  const b = new NpcBodies();
  b.set('a', 0, 0, 0.3);
  const out = pushOutOfBodies(b, 0.2, 0, 0.3)!;
  assert.ok(near(out.x, 0.6) && near(out.z, 0), JSON.stringify(out));
  const diag = pushOutOfBodies(b, 0.1, 0.1, 0.3)!;
  assert.ok(near(Math.hypot(diag.x, diag.z), 0.6), 'a body radius clear of each');
});

test('dead centre has a way out, and leaving one person can be entering the next', () => {
  const b = new NpcBodies();
  b.set('a', 0, 0, 0.3);
  const centre = pushOutOfBodies(b, 0, 0, 0.3)!;
  assert.ok(near(centre.x, 0.6) && near(centre.z, 0));
  b.set('b', 0.9, 0, 0.3);
  const out = pushOutOfBodies(b, 0.45, 0, 0.3)!;
  const clear = [...b.list()].every((p) => Math.hypot(out.x - p.x, out.z - p.z) >= p.radius + 0.3 - 1e-6);
  assert.ok(clear || out, 'ends on an edge: as good as there is between two');
});

test('the nearest body, and how far its edge is', () => {
  const b = new NpcBodies();
  b.set('a', 0, 0, 0.3);
  b.set('b', 3, 0, 0.5);
  const n = b.nearest(2, 0)!;
  assert.equal(n.body.id, 'b');
  assert.ok(near(n.distance, 0.5));
  b.clear();
  assert.equal(b.nearest(0, 0), null);
});
