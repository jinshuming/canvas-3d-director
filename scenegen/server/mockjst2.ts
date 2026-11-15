/**
 * A stand-in for the PROPOSED `POST /v1/scenes/posed-images` (and its task
 * poll), served by this dev server under `/scenegen/mock-jst2`, so the video
 * path runs end to end today. It validates exactly what the real endpoint
 * would (docs/SCENEGEN_DESIGN.md §3.2) and answers in the real task envelope.
 *
 * It cannot reconstruct: the scene it returns is a preview made from the
 * sparse point cloud the caller registers with it (`points`, the video
 * pipeline's points.ply), written Y-up the way JST-2 writes its files (the
 * caller's OpenCV world with Y and Z flipped, measured on custom-pano).
 * Point the client at the real API once it exists and nothing else changes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { readPointsPly, writeSpz } from '../core/spzwrite.ts';
import { checkC2W, MAX_VIEWS, SESSION_RE } from './jst2.ts';
import type { SceneTask } from './jst2.ts';

export const MOCK_PREFIX = '/scenegen/mock-jst2';

interface MockState { tasks: Map<string, SceneTask>; pointsBySession: Map<string, string> }

export function createMockJst2(dir: string, publicBase: () => string) {
  const state: MockState = { tasks: new Map(), pointsBySession: new Map() };

  /** The video pipeline tells the mock where its sparse points are, keyed by session. */
  function registerPoints(sessionId: string, plyPath: string) { state.pointsBySession.set(sessionId, plyPath); }

  async function handle(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); return true; };
    const fail = (status: number, code: string, message: string) => send(status, { error: { code, message } });
    if (path.startsWith('/files/') && req.method === 'GET') {
      const name = path.slice('/files/'.length);
      if (!/^[\w.-]+$/.test(name)) return fail(400, 'bad_name', 'Bad file name.');
      try { const b = await readFile(join(dir, name)); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end(b); return true; } catch { return fail(404, 'not_found', 'No such file.'); }
    }
    if (!(req.headers.authorization ?? '').startsWith('Bearer ')) return fail(401, 'unauthorized', 'Missing API key.');
    if (path === '/v1/scenes/posed-images' && req.method === 'POST') {
      const form = await new Response(Readable.toWeb(req) as ReadableStream, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData().catch(() => null);
      if (!form) return fail(400, 'invalid_body', 'Send multipart/form-data.');
      const sessionId = String(form.get('sessionId') ?? '');
      if (!SESSION_RE.test(sessionId)) return fail(400, 'invalid_session', 'sessionId must be 1-128 of [A-Za-z0-9_-].');
      let views: Array<{ c2w: number[][]; intrinsic: number[] }>;
      try { views = JSON.parse(String(form.get('views') ?? '[]')); } catch { return fail(400, 'invalid_views', 'views must be JSON.'); }
      const files = form.getAll('imageFiles').filter((f): f is File => typeof f !== 'string');
      if (views.length < 1 || views.length > MAX_VIEWS) return fail(400, 'too_many_views', `Send 1-${MAX_VIEWS} views.`);
      if (files.length !== views.length) return fail(400, 'files_mismatch', `${views.length} views but ${files.length} imageFiles.`);
      for (const [i, v] of views.entries()) {
        try { checkC2W(v.c2w); } catch (e) { return fail(400, 'invalid_c2w', `views[${i}]: ${(e as Error).message}`); }
        if (!Array.isArray(v.intrinsic) || v.intrinsic.length !== 4 || v.intrinsic.some((x) => !(x > 0) || x > 4)) return fail(400, 'invalid_intrinsic', `views[${i}].intrinsic must be [fx, fy, cx, cy] normalised.`);
        const f = files[i]!;
        if (!/^image\/(jpeg|png)$/.test(f.type)) return fail(400, 'invalid_image', `imageFiles[${i}] must be JPEG or PNG.`);
      }
      const mpu = Number(form.get('metersPerUnit') ?? 1) || 1;
      const id = `scn_${randomUUID()}.${sessionId}`;
      const batchId = randomUUID();
      await mkdir(dir, { recursive: true });
      // Keep the images, as the real batch would (views[].url).
      const urls = await Promise.all(files.map(async (f, i) => {
        const name = `${batchId}-${i}.${f.type === 'image/png' ? 'png' : 'jpg'}`;
        await writeFile(join(dir, name), new Uint8Array(await f.arrayBuffer()));
        return `${publicBase()}${MOCK_PREFIX}/files/${name}`;
      }));
      const task: SceneTask = { id, sessionId, operation: 'posed-images', status: 'processing', result: null, error: null, credits: views.length };
      state.tasks.set(id, task);
      // "Reconstruct" a moment later: a preview splat from the registered sparse points.
      setTimeout(() => { void finish(task, batchId, views, urls, mpu); }, 1500);
      return send(202, task);
    }
    const m = /^\/v1\/scenes\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const t = state.tasks.get(decodeURIComponent(m[1]!));
      return t ? send(200, t) : fail(404, 'not_found', 'No such task.');
    }
    return false;
  }

  async function finish(task: SceneTask, batchId: string, views: Array<{ c2w: number[][]; intrinsic: number[] }>, urls: string[], mpu: number) {
    try {
      const ply = state.pointsBySession.get(task.sessionId);
      if (!ply) throw new Error('The mock has no points for this session (it previews the video pipeline’s sparse cloud).');
      const { positions, colors } = readPointsPly(await readFile(ply));
      // Caller's world (OpenCV, Y down) → JST-2 file frame (Y up): flip Y and Z; scale by metersPerUnit.
      for (let i = 0; i < positions.length; i += 3) { positions[i]! *= mpu; positions[i + 1] = -positions[i + 1]! * mpu; positions[i + 2] = -positions[i + 2]! * mpu; }
      const spzName = `${batchId}.spz`;
      await writeFile(join(dir, spzName), writeSpz(positions, colors, { radius: 0.025 }));
      task.status = 'ready';
      task.result = {
        operation: 'posed-images',
        sessionId: task.sessionId,
        outputBatch: { batchId, createdAt: Date.now(), kind: 'uploaded', views: views.map((v, i) => ({ index: i, url: urls[i]!, c2w: v.c2w, intrinsic: v.intrinsic })) },
        spz: { url: `${publicBase()}${MOCK_PREFIX}/files/${spzName}` },
        preview: null,
        panorama: null,
        referenceViewCount: 0,
        newViewCount: views.length,
        seconds: { mock: 1.5 },
      };
    } catch (e) {
      task.status = 'failed';
      task.error = { code: 'mock_failed', message: (e as Error).message };
    }
  }

  return { handle, registerPoints };
}
