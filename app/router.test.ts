import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parse, scenePath, worldPath } from './router.ts';

test('router: canvas, 导演台 (world) and the scene editor', () => {
  assert.deepEqual(parse('/canvas'), { page: 'canvas' });
  assert.deepEqual(parse('/canvas/world'), { page: 'worlds' });
  assert.deepEqual(parse('/canvas/world/w1', '', '?node=n_a'), { page: 'world', id: 'w1', node: 'n_a' });
  assert.deepEqual(parse('/canvas/scene/sg123', '', '?node=n_b'), { page: 'scene', id: 'sg123', node: 'n_b' });
  assert.deepEqual(parse('/canvas/scene/sg123/'), { page: 'scene', id: 'sg123', node: null });
  assert.deepEqual(parse('/canvas/scene/bad id'), { redirect: '/canvas' });
  assert.equal(scenePath('sg123', 'n_b'), '/canvas/scene/sg123?node=n_b');
  assert.equal(worldPath('w1'), '/canvas/world/w1');
});
