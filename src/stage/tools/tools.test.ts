import assert from 'node:assert/strict';
import { test } from 'node:test';

import { sampleShot } from '../camera.js';
import { framePair, frameSubject, SHOT_SIZES } from '../framing.js';
import { facingOf, sampleMoves, yawToward } from '../moves.js';
import type { StageDoc } from '../types.js';
import type { AssetRef, StageToolHost, ToolResult } from './host.js';
import { runStageTool, STAGE_TOOLS, stageToolDefinitions } from './index.js';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
/** Angles equal modulo 360. */
const sameAngle = (a: number, b: number) => near(((a - b + 540) % 360) - 180, 0, 1e-6);

test('yaw convention: 0 faces -Z, 90 faces -X, and yawToward agrees with facingOf', () => {
  assert.deepEqual(facingOf(0).map((v) => Math.round(v) + 0), [0, -1]);
  assert.deepEqual(facingOf(90).map((v) => Math.round(v) + 0), [-1, 0]);
  for (const yaw of [0, 45, 90, 135, -120]) {
    const [x, z] = facingOf(yaw);
    assert.ok(near(((yawToward([0, 0, 0], [x, 0, z]) - yaw + 540) % 360) - 180, 0, 1e-9));
  }
});

test('a move walks the path at even speed, faces along it, and holds where it ends', () => {
  const c = { position: [0, 0, 0] as [number, number, number], yaw: 180, moves: [{ id: 'm', start: 1, end: 3, points: [[0, 0, -2] as [number, number, number], [2, 0, -2] as [number, number, number]], easing: 'linear' as const }] };
  assert.deepEqual(sampleMoves(c, 0.5), { position: [0, 0, 0], yaw: 180, moving: false });
  const mid = sampleMoves(c, 2);
  assert.ok(near(mid.position[2], -2) && near(mid.position[0], 0), 'halfway along 4 m is the corner');
  assert.ok(near(sampleMoves(c, 1.5).yaw, 0), 'first leg heads -Z');
  const end = sampleMoves(c, 9);
  assert.deepEqual(end.position, [2, 0, -2]);
  assert.ok(near(end.yaw, -90), 'arrives facing +X, the last leg');
  assert.equal(end.moving, false);
});

test('framing: a front medium shot stands in front of the subject at eye level and fits the frame', () => {
  const cam = frameSubject({ subject: [0, 0, 0], height: 1.8, facing: 0, size: 'medium', fov: 40 });
  // Facing -Z, so "in front" is further -Z.
  assert.ok(cam.position[2] < -1, 'camera is in front');
  assert.ok(near(cam.position[1], cam.target[1], 1e-9), 'eye level');
  const d = Math.hypot(cam.position[0] - cam.target[0], cam.position[2] - cam.target[2]);
  const frameHeight = 2 * d * Math.tan((20 * Math.PI) / 180);
  assert.ok(near(frameHeight, SHOT_SIZES.medium.frame * 1.8, 1e-6), 'the frame holds the medium shot\'s share of the body');
  const left = frameSubject({ subject: [0, 0, 0], height: 1.8, facing: 0, size: 'medium', side: 'left' });
  assert.ok(left.position[0] < -1, 'their left is -X when they face -Z');
  const low = frameSubject({ subject: [0, 0, 0], height: 1.8, facing: 0, size: 'full', angle: 'low' });
  assert.ok(low.position[1] < low.target[1] && low.position[1] >= 0.15, 'low angle, above the floor');
});

// ── The tools, on a doc with no renderer ────────────────────────────────────

function fakeHost(): StageToolHost & { doc: StageDoc } {
  const assets: AssetRef[] = [
    { id: 'pre_frodo', kind: 'character', name: 'Frodo', url: 'frodo.vsplat', source: 'preset' },
    { id: 'pre_wave', kind: 'motion', name: 'Wave', url: 'wave.glb', source: 'preset', seconds: 2 },
    { id: 'pre_nod', kind: 'motion', name: 'Nod', url: 'nod.glb', source: 'preset', seconds: 1.5 },
    { id: 'room', kind: 'scene', name: 'Living room', url: 'room.spz', source: 'generated' },
  ];
  const host = {
    doc: { id: 's', version: 1, title: 't', duration: 8, fps: 24, aspect: '16:9', scene: null, characters: [], shots: [], updatedAt: '' } as StageDoc,
    getDoc: () => host.doc,
    update: (fn: (d: StageDoc) => StageDoc) => { host.doc = fn(host.doc); },
    renderer: null,
    assets: { list: async (kind: string) => assets.filter((a) => a.kind === kind) },
  };
  return host;
}

const json = (r: ToolResult) => {
  assert.ok(!r.is_error, r.content.map((c) => (c.type === 'text' ? c.text : '')).join());
  const t = r.content.find((c) => c.type === 'text');
  return JSON.parse(t && t.type === 'text' ? t.text : 'null');
};

test('every tool has a name, a description and an object schema', () => {
  const defs = stageToolDefinitions();
  assert.equal(new Set(defs.map((d) => d.name)).size, STAGE_TOOLS.length);
  for (const d of defs) {
    assert.match(d.name, /^[a-z_]+$/);
    assert.ok(d.description.length > 40, d.name);
    assert.equal(d.input_schema.type, 'object');
  }
});

test('cast, sequence motions, block a walk, frame and move the camera', async () => {
  const host = fakeHost();
  await runStageTool('set_scene', { scene: 'living room' }, host);
  const { character_id } = json(await runStageTool('add_character', { asset: 'Frodo', position: [0, -3], face: [0, 0] }, host));
  assert.ok(sameAngle(host.doc.characters[0]!.yaw, 180), 'faces the capture point');

  const seq = json(await runStageTool('set_motion_sequence', { character: 'frodo', sequence: [{ motion: 'Wave' }, { motion: 'nod', gap: 0.5, seconds: 3 }] }, host));
  assert.deepEqual(seq.clips.map((c: { start: number; end: number }) => [c.start, c.end]), [[0, 2], [2.5, 5.5]]);
  assert.equal(seq.clips[1].loop, true, 'longer than the motion: loops');

  const mv = json(await runStageTool('move_character', { character: character_id, start: 6, to: [2.6, -3] }, host));
  assert.ok(near(mv.end - mv.start, 2, 0.01), '2.6 m at walking pace is 2 s');
  const c = host.doc.characters[0]!;
  assert.equal(c.moves!.length, 1);
  assert.ok(c.clips.some((k) => k.id.startsWith('gait_') && k.rootMotion === false && k.loop), 'an in-place walk under the move');
  assert.ok(host.doc.duration >= 8);
  // Overlapping move is refused, with the reason.
  const clash = await runStageTool('move_character', { character: character_id, start: 7, to: [0, 0] }, host);
  assert.ok(clash.is_error);

  const { shot_id } = json(await runStageTool('add_shot', { name: 'Follow' }, host));
  json(await runStageTool('frame_shot', { shot_id, subject: 'Frodo', size: 'full', time: 0 }, host));
  const tr = json(await runStageTool('camera_move', { shot_id, kind: 'track', subject: 'Frodo', size: 'medium', side: 'three_quarter_left', start: 6, end: 8 }, host));
  assert.ok(tr.keys >= 3);
  const shot = host.doc.shots[0]!;
  assert.equal(shot.keys[0]!.t, 0, 'the key at 0 survives a move over 6-8');
  // Tracking: the camera's aim follows him across the room.
  const a = sampleShot(shot, 6)!.target[0];
  const b = sampleShot(shot, 8)!.target[0];
  assert.ok(b - a > 2, `aim moved ${b - a} m with him`);

  const stage = json(await runStageTool('get_stage', { time: 8 }, host));
  assert.deepEqual(stage.characters[0].at_time.position, [2.6, 0, -3]);
});

test('bad calls come back as readable errors, not exceptions', async () => {
  const host = fakeHost();
  const r = await runStageTool('update_character', { character: 'nobody', yaw: 10 }, host);
  assert.ok(r.is_error);
  assert.match((r.content[0] as { text: string }).text, /No character "nobody"/);
  assert.ok((await runStageTool('look', { view: 'top_down' }, host)).is_error, 'looking needs a renderer');
  assert.ok((await runStageTool('nope', {}, host)).is_error);
});

test('pair framing: over the shoulder, reverse on the same side of the line, and a two-shot that fits both', () => {
  // A stands 1.5 m in front of B; they face each other.
  const A = { position: [0, 0, -1.5] as [number, number, number], yaw: 180, height: 1.7 };
  const B = { position: [0, 0, 0] as [number, number, number], yaw: 0, height: 1.7 };
  const ots = framePair({ kind: 'over_shoulder', subject: A, other: B });
  assert.ok(ots.position[2] > 0.3, 'behind the foreground person');
  assert.ok(Math.abs(ots.position[0]) > 0.25 && Math.abs(ots.position[0]) < 0.6, 'out over one shoulder');
  assert.ok(ots.fov >= 12 && ots.fov < 40, `a longer lens (${ots.fov})`);
  // The line to A's face passes beside B's head, not through it.
  const face = [0, 1.7 * 0.92, -1.5];
  const u = (0 - ots.position[2]) / (face[2]! - ots.position[2]);
  const atB = [ots.position[0] + (face[0]! - ots.position[0]) * u, ots.position[1] + (face[1]! - ots.position[1]) * u];
  assert.ok(Math.hypot(atB[0]!, atB[1]! - 1.6) > 0.12, 'clears the head');
  // Reverse: same side of the line.
  const rev = framePair({ kind: 'over_shoulder', subject: B, other: A });
  assert.ok(rev.position[2] < -1.8, 'behind A');
  assert.equal(Math.sign(rev.position[0]), Math.sign(ots.position[0]), '180° rule');
  assert.notEqual(Math.sign(framePair({ kind: 'over_shoulder', subject: A, other: B, flip: true }).position[0]), Math.sign(ots.position[0]), 'flip crosses it');

  const two = framePair({ kind: 'two_shot', subject: A, other: B, size: 'medium' });
  assert.equal(Math.sign(two.position[0]), Math.sign(ots.position[0]), 'two-shot on the same side');
  assert.ok(near(two.target[2], -0.75, 1e-9), 'aims between them');
  const halfW = Math.atan(Math.tan((two.fov / 2) * Math.PI / 180) * 16 / 9);
  for (const p of [A, B]) {
    const ang = Math.abs(Math.atan2(p.position[2] - two.target[2], Math.abs(two.position[0] - two.target[0])));
    assert.ok(ang < halfW * 0.85, 'both well inside the frame');
  }
  // A looser two-shot widens the lens rather than backing out of the room.
  const loose = framePair({ kind: 'two_shot', subject: A, other: B, size: 'medium_full' });
  assert.ok(loose.fov > 40 && near(Math.hypot(loose.position[0] - loose.target[0], loose.position[2] - loose.target[2]), 2.2, 1e-6));
  // Favouring A swings the camera toward B, where A looks.
  const fav = framePair({ kind: 'two_shot', subject: A, other: B, side: 35 });
  assert.ok(fav.position[2] > two.position[2] + 0.5);
});

test('frame_shot and camera_move take a two-person framing', async () => {
  const host = fakeHost();
  const a = json(await runStageTool('add_character', { asset: 'Frodo', position: [0, -1.5], name: 'A' }, host)).character_id;
  json(await runStageTool('add_character', { asset: 'Frodo', position: [0, 0], name: 'B', face: a }, host));
  json(await runStageTool('update_character', { character: 'A', face: 'B' }, host));
  const { shot_id } = json(await runStageTool('add_shot', { name: 'OTS' }, host));
  const k = json(await runStageTool('frame_shot', { shot_id, subject: 'A', with: 'B', framing: 'over_shoulder' }, host)).key;
  assert.ok(k.position[2] > 0.3 && k.fov < 40);
  assert.ok((await runStageTool('frame_shot', { shot_id, subject: 'A', framing: 'two_shot' }, host)).is_error, 'needs `with`');
  assert.ok((await runStageTool('camera_move', { shot_id, kind: 'orbit', subject: 'A', with: 'B', framing: 'over_shoulder' }, host)).is_error);
  const orbit = json(await runStageTool('camera_move', { shot_id, kind: 'orbit', subject: 'A', with: 'B', framing: 'two_shot', degrees: 60, start: 0, end: 3 }, host));
  assert.ok(orbit.keys >= 3);
});
