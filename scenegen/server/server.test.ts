import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runAgentTurn } from '../agent/loop.ts';
import type { ChatItem } from '../agent/loop.ts';
import { runTool } from '../agent/tools.ts';
import { paintedBox } from './objects.ts';
import type { AgentHost } from '../agent/tools.ts';
import { findCapturePoint } from '../core/capture.ts';
import { poseToC2W } from '../core/frame.ts';
import { readSpz } from '../core/spz.ts';
import { emptyLayout } from '../core/types.ts';
import { fillBudget, gapPose } from './fill.ts';
import { Jst2Client, Jst2Error } from './jst2.ts';
import { createMockJst2, MOCK_PREFIX } from './mockjst2.ts';
import { depthPrompt, openaiImageProvider } from './pano.ts';
import { encodePng } from './png.ts';

async function mockServer() {
  const dir = await mkdtemp(join(tmpdir(), 'sg-mock-'));
  let port = 0;
  const mock = createMockJst2(dir, () => `http://127.0.0.1:${port}`);
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (!path.startsWith(MOCK_PREFIX)) { res.writeHead(404); res.end(); return; }
    void mock.handle(req, res, path.slice(MOCK_PREFIX.length)).then((ok) => { if (!ok) { res.writeHead(404); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  return { dir, mock, base: `http://127.0.0.1:${port}${MOCK_PREFIX}`, close: () => server.close() };
}

function ply(points: number[][]): Uint8Array {
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${points.length}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n`;
  const body = new DataView(new ArrayBuffer(points.length * 15));
  points.forEach((p, i) => { body.setFloat32(i * 15, p[0]!, true); body.setFloat32(i * 15 + 4, p[1]!, true); body.setFloat32(i * 15 + 8, p[2]!, true); body.setUint8(i * 15 + 12, 100); body.setUint8(i * 15 + 13, 150); body.setUint8(i * 15 + 14, 200); });
  return new Uint8Array([...new TextEncoder().encode(head), ...new Uint8Array(body.buffer)]);
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);

test('posed-images (proposed endpoint) through the client against the mock: validates, answers like JST-2, returns a Y-up scene', async () => {
  const m = await mockServer();
  try {
    const client = new Jst2Client({ apiKey: 'test', base: 'http://unused', posedImagesBase: m.base });
    const plyPath = join(m.dir, 'points.ply');
    // Caller world is OpenCV (Y down): a floor at y = +1.5.
    await writeFile(plyPath, ply([[0, 1.5, 0], [1, 1.5, 1], [0.5, -1, 2]]));
    m.mock.registerPoints('sgv_test', plyPath);
    const view = { image: JPEG, mime: 'image/jpeg' as const, c2w: poseToC2W({ position: [0, 0, 0], yaw: 0 }), intrinsic: [0.5, 0.89, 0.5, 0.5] };
    let task = await client.posedImages({ sessionId: 'sgv_test', views: [view, { ...view, c2w: poseToC2W({ position: [0.3, 0, 0], yaw: 20 }) }] });
    assert.equal(task.status, 'processing');
    task = await client.wait(task, { base: m.base, intervalMs: 200 });
    assert.equal(task.result!.outputBatch!.kind, 'uploaded');
    assert.equal(task.result!.outputBatch!.views.length, 2);
    const spz = readSpz(await client.download(task.result!.spz.url));
    assert.equal(spz.count, 3);
    // Written Y-up: the floor point comes back at y = -1.5, z flipped.
    assert.ok(Math.abs(spz.positions[1]! + 1.5) < 1e-3);
    assert.ok(Math.abs(spz.positions[8]! + 2) < 1e-3);
    // Refusals match the spec.
    await assert.rejects(client.posedImages({ sessionId: 'sgv_test', views: [{ ...view, intrinsic: [0.5, 0.5, 0.5] }] }), Jst2Error);
    await assert.rejects(client.posedImages({ sessionId: 'sgv_test', views: Array.from({ length: 41 }, () => view) }), /1-40/);
    const bad = await fetch(`${m.base}/v1/scenes/posed-images`, { method: 'POST', headers: { Authorization: 'Bearer x' }, body: (() => { const f = new FormData(); f.append('sessionId', 'ok'); f.append('views', JSON.stringify([{ c2w: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], intrinsic: [0.5, 0.5, 0.5, 0.5] }])); return f; })() });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: { code: string } }).error.code, /files_mismatch/);
  } finally { m.close(); }
});

test('agent tools: build a room, place by relation, check, choose the capture point', async () => {
  const layout = emptyLayout();
  let changes = 0;
  const host: AgentHost = {
    layout,
    changed: () => { changes++; },
    look: async () => ({ image: 'data:image/jpeg;base64,', prompt: 'p' }),
    findCapture: async () => findCapturePoint(layout),
    generate: async () => ({ jobId: 'job_x' }),
  };
  assert.match((await runTool('set_room', { width: 5, depth: 4, height: 2.8 }, host)).text, /5×4×2.8/);
  const placed = await runTool('place_objects', { objects: [
    { type: 'couch', id: 'sofa', label: 'grey sofa', against: 'north' },
    { type: 'coffee table', id: 'table', label: 'oak table', in_front_of: 'sofa' },
    { type: 'lamp', id: 'lamp', label: 'brass lamp', right_of: 'sofa', gap: 0.1 },
    { type: 'tv', id: 'tv', label: 'tv', on: 'nothing_here' },
    { type: 'box', id: 'android', label: 'tall humanoid android seen from behind' },
  ] }, host);
  assert.match(placed.text, /sofa: sofa at/);
  assert.match(placed.text, /tv: FAILED - No object "nothing_here"/);
  assert.match(placed.text, /android: REFUSED - the scene is an empty place/);
  assert.equal(layout.objects.length, 3);
  assert.equal(layout.objects[0]!.type, 'sofa');
  assert.match((await runTool('check_layout', {}, host)).text, /No problems/);
  const cap = await runTool('choose_capture_point', {}, host);
  assert.match(cap.text, /Capture point/);
  assert.ok(layout.capture);
  assert.match((await runTool('generate_scene', {}, host)).text, /job_x/);
  assert.ok(changes >= 3);
  assert.equal((await runTool('nope', {}, host)).isError, true);
});

/** A fake Responses API: scripted turns streamed as SSE. */
function scripted(turns: Array<Array<{ type: string; [k: string]: unknown }>>) {
  const bodies: Array<{ input: unknown[]; previous_response_id?: string }> = [];
  let i = 0;
  const respond = async (body: unknown) => {
    bodies.push(body as never);
    const output = turns[i++] ?? [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }];
    const ev = `data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${i}`, output, usage: { input_tokens: 10, output_tokens: 5 } } })}\n\n`;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(ev)); c.close(); } }), { status: 200 });
  };
  return { respond, bodies };
}

test('agent loop: runs tool calls, feeds results (and pictures) back, chains responses, stops when the model stops', async () => {
  const layout = emptyLayout();
  const host: AgentHost = { layout, changed: () => {}, look: async () => ({ image: 'data:image/jpeg;base64,AAAA', prompt: 'p' }), findCapture: async () => findCapturePoint(layout), generate: async () => ({ jobId: 'j' }) };
  const { respond, bodies } = scripted([
    [{ type: 'function_call', name: 'set_room', arguments: '{"width":4,"depth":4}', call_id: 'c1' }, { type: 'function_call', name: 'place_objects', arguments: '{"objects":[{"type":"bed","label":"oak bed","against":"north"}]}', call_id: 'c2' }],
    [{ type: 'function_call', name: 'look', arguments: '{}', call_id: 'c3' }],
    [{ type: 'message', content: [{ type: 'output_text', text: '卧室已摆好。' }] }],
  ]);
  const items: ChatItem[] = [];
  const out = await runAgentTurn('一间卧室', host, { respond, emit: (it) => items.push(it), images: ['data:image/png;base64,QQ=='] });
  assert.equal(out.stats.steps, 3);
  assert.deepEqual(out.stats.tools, ['set_room', 'place_objects', 'look']);
  assert.equal(out.previousId, 'resp_3');
  assert.equal(layout.objects[0]!.type, 'bed');
  // The user's picture went in with the first message; the look's picture after the tool output.
  const first = bodies[0]!.input[0] as { content: Array<{ type: string }> };
  assert.ok(first.content.some((c) => c.type === 'input_image'));
  const third = bodies[2]!.input as Array<{ type?: string; role?: string }>;
  assert.equal(third[0]!.type, 'function_call_output');
  assert.equal(third[1]!.role, 'user');
  assert.equal(bodies[1]!.previous_response_id, 'resp_1');
  assert.equal(items.at(-1)!.role, 'assistant');
});

test('GPT-image provider: depth map squeezed to 3:2 in, panorama stretched back to 2:1 out', async () => {
  const depth = encodePng(new Uint8Array(64 * 32 * 3).fill(128), 64, 32);
  let sent: FormData | null = null;
  const fakeFetch = (async (_url: string, init?: RequestInit) => {
    sent = init!.body as FormData;
    const img = encodePng(new Uint8Array(48 * 32 * 3).fill(200), 48, 32);
    return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from(img).toString('base64') }] }), { status: 200 });
  }) as typeof fetch;
  const p = openaiImageProvider({ apiKey: 'k', size: '1536x1024' }, fakeFetch);
  const out = await p.generate({ prompt: 'a room', depth, semantic: depth, shaded: depth });
  assert.equal(out.mime, 'image/png');
  const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset);
  assert.equal(dv.getUint32(16), 2048);
  assert.equal(dv.getUint32(20), 1024);
  assert.equal(sent!.get('model'), 'gpt-image-2');
  const image = sent!.getAll('image[]')[0] as File;
  const head = new DataView(await image.arrayBuffer());
  assert.equal(head.getUint32(16), 1536);
  assert.match(depthPrompt('cap', false), /EQUIRECTANGULAR DEPTH MAP/);
  // An expired key surfaces as a clear error.
  const expired = openaiImageProvider({ apiKey: 'k' }, (async () => new Response(JSON.stringify({ error: { message: 'Your API key has expired.' } }), { status: 401 })) as typeof fetch);
  await assert.rejects(expired.generate({ prompt: 'x', depth, semantic: depth, shaded: depth }), /expired/);
});

test('gap view → camera pose in our convention', () => {
  const pose = gapPose({ id: 'g1', priority: 1, role: 'hole', position: [1, 2, 3], forward: [Math.sin(Math.PI / 3) * Math.cos(Math.PI / 6), -0.5, -Math.cos(Math.PI / 3) * Math.cos(Math.PI / 6)], yaw: 0, pitch: -30, hole: 0.1, blur: 0, magnification: 1 });
  assert.ok(Math.abs(pose.yaw - 60) < 1e-6);
  assert.ok(Math.abs(pose.pitch! + 30) < 1e-6);
});

test('fill budget grows with the space; the image prompt states sizes and forbids people', () => {
  assert.equal(fillBudget(20), 1);
  assert.equal(fillBudget(48), 2);
  assert.equal(fillBudget(80), 3);
  assert.equal(fillBudget(null), 3);
  const p = depthPrompt('cap', true, 'an interior 6 m wide');
  assert.match(p, /Measurements: an interior 6 m wide/);
  assert.match(p, /do not vault or raise the ceiling/);
  assert.match(p, /No people, characters/);
  assert.match(p, /not any people, characters or creatures in it/);
});

test('paintedBox: boxes what was painted, falls back to the blockout box when nothing was', () => {
  const S = 200;
  const before = new Uint8Array(S * S * 3).fill(120);
  const after = new Uint8Array(before);
  // The blockout box is 60..140 × 80..130; the painted object reaches higher and wider (within the area the edit may touch): 50..150 × 66..135.
  for (let y = 66; y < 135; y++) for (let x = 50; x < 150; x++) after.set([30, 20, 10], (y * S + x) * 3);
  const r = paintedBox(before, after, S, [60, 80, 140, 130]);
  assert.ok(r.fromPaint);
  assert.deepEqual(r.box, [50, 66, 150, 135]);
  const none = paintedBox(before, before, S, [60, 80, 140, 130]);
  assert.equal(none.fromPaint, false);
  assert.deepEqual(none.box, [60, 80, 140, 130]);
});
