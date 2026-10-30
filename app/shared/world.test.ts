import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { StageDoc } from '../../src/stage/types.ts';
import { blankStage } from './blank.ts';
import type { WorldFile } from './world.ts';
import { copyWorld, isEmptyWorld, newWorld, readWorld, storableChat, summarize, WORLD_FORMAT, WORLD_SCHEMA, worldFromStage } from './world.ts';

const cover = (w: WorldFile) => (w.cover ? `/c/${w.id}` : null);

test('a new world is tagged, empty, and its stage carries its id and title', () => {
  const w = newWorld('wld_a', 'Night scene');
  assert.equal(w.format, WORLD_FORMAT);
  assert.equal(w.schema, WORLD_SCHEMA);
  assert.equal(w.stage.id, 'wld_a');
  assert.equal(w.stage.title, 'Night scene');
  assert.deepEqual(w.origin, { kind: 'blank' });
  assert.ok(isEmptyWorld(w));
  // A file survives a round trip through JSON and the reader unchanged.
  assert.deepEqual(readWorld(JSON.parse(JSON.stringify(w))), w);
});

test('an old stage file becomes a world with the same id, so canvas nodes still open it', () => {
  const stage: StageDoc = { ...blankStage('stg_1', 'Old'), version: 7, scene: { name: 'Room', url: '/files/r.spz', placement: null } };
  const w = worldFromStage(stage);
  assert.equal(w.id, 'stg_1');
  assert.equal(w.stage.version, 7, 'keeps its version, so an editor open on it can still save');
  assert.deepEqual(w.origin, { kind: 'stage', from: 'stg_1' });
  assert.ok(!isEmptyWorld(w));
});

test('a copy has the stage, a fresh conversation, a new id, and says where it came from', () => {
  const src = newWorld('wld_src', 'Dialogue');
  src.stage.characters.push({ id: 'chr_1', name: 'Viking', url: 'v.vsplat', position: [0, 0, 0], yaw: 0, height: 1.7, clips: [] });
  src.stage.version = 12;
  src.chat = { previousResponseId: 'resp_1', items: [{ kind: 'user', id: 'u', text: 'hi' }], updatedAt: 'x' };
  const c = copyWorld(src, 'wld_copy');
  assert.equal(c.stage.id, 'wld_copy');
  assert.equal(c.stage.version, 1);
  assert.equal(c.stage.characters.length, 1);
  assert.notEqual(c.stage.characters, src.stage.characters, 'deep copy: editing one leaves the other');
  assert.deepEqual(c.chat.items, []);
  assert.equal(c.chat.previousResponseId, null);
  assert.deepEqual(c.origin, { kind: 'copy', from: 'wld_src', fromTitle: 'Dialogue' });
  assert.equal(c.title, 'Dialogue 副本');
});

test('the reader refuses what it cannot read and fills what older writers left out', () => {
  assert.throws(() => readWorld({ format: 'other' }), /Not a World file/);
  assert.throws(() => readWorld({ format: WORLD_FORMAT, schema: WORLD_SCHEMA + 1, id: 'x', stage: blankStage('x', 't') }), /newer/);
  const sparse = readWorld({ format: WORLD_FORMAT, schema: 1, id: 'wld_s', stage: blankStage('other', 'From stage') });
  assert.equal(sparse.title, 'From stage');
  assert.equal(sparse.stage.id, 'wld_s', 'the stage always carries the world id');
  assert.deepEqual(sparse.chat, { previousResponseId: null, items: [], updatedAt: null });
  assert.equal(sparse.cover, null);
});

test('a stored chat keeps the words, not the pictures or half-finished lines', () => {
  const chat = storableChat({
    previousResponseId: 'r',
    updatedAt: null,
    items: [
      { kind: 'user', id: '1', text: 'go' },
      { kind: 'tool', id: '2', name: 'look', args: '{}', status: 'done', result: 'ok', image: 'data:image/jpeg;base64,AAAA' },
      { kind: 'tool', id: '3', name: 'look', args: '{}', status: 'running' },
      { kind: 'assistant', id: '4', text: 'Done', streaming: true },
      { kind: 'confirm', id: '5', text: 'Spend?' },
      { kind: 'confirm', id: '6', text: 'Spend?', answer: false },
    ],
  });
  const json = JSON.stringify(chat);
  assert.ok(!json.includes('base64'));
  assert.equal((chat.items.find((x) => x.id === '3') as { status?: string }).status, 'error', 'a tool cut off mid-run reads as failed');
  assert.ok(!json.includes('"streaming"'));
  assert.deepEqual(chat.items.map((x) => x.id), ['1', '2', '3', '4', '6'], 'an unanswered confirm cannot be answered after a reload');
});

test('a summary says what is in a world and what was last asked', () => {
  const w = newWorld('wld_x', 'Coverage');
  assert.equal(summarize(w, cover).coverUrl, null);
  w.stage.scene = { name: 'Living room', url: '/files/r.spz', placement: null, panoramaUrl: '/files/p.png' };
  w.chat.items = [{ kind: 'user', id: 'a', text: 'first' }, { kind: 'assistant', id: 'b', text: 'ok' }, { kind: 'user', id: 'c', text: 'make it low angle' }];
  let s = summarize(w, cover);
  assert.equal(s.coverUrl, '/files/p.png', 'no cover yet: the panorama stands in');
  assert.equal(s.sceneName, 'Living room');
  assert.equal(s.prompts, 2);
  assert.equal(s.lastPrompt, 'make it low angle');
  w.cover = { file: 'cover.jpg', updatedAt: 't' };
  s = summarize(w, cover);
  assert.equal(s.coverUrl, '/c/wld_x');
});
