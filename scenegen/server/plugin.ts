/**
 * The scene generator's dev-server middleware, under `/scenegen/`. Separate
 * from the director's (app/server/plugin.ts): its own projects in
 * `.data/scenegen/`, its own jobs, its own agent instructions. The only
 * meeting point is the export, which hands a finished scene to the
 * director's library through `POST /api/library/import-scene`.
 *
 *   GET  /scenegen/api/config
 *   GET  /scenegen/api/projects                  list
 *   POST /scenegen/api/projects                  {kind, title?, layout?}
 *   GET  /scenegen/api/projects/:id              project (+ result, job)
 *   PUT  /scenegen/api/projects/:id              {title?, layout?, chat?}
 *   POST /scenegen/api/projects/:id/conditions   render the blockout from its capture point
 *   POST /scenegen/api/projects/:id/capture      search the capture point (ranked)
 *   POST /scenegen/api/projects/:id/generate     text → scene job {provider?}
 *   PUT  /scenegen/api/projects/:id/video        raw upload (Content-Type video/*)
 *   POST /scenegen/api/projects/:id/video-run    video → poses → scene job
 *   POST /scenegen/api/projects/:id/export       into the director's library
 *   POST /scenegen/api/agent/respond             one streamed model turn (OpenAI Responses)
 *   GET  /scenegen/files/:id/:path               project files
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { Plugin } from 'vite';

import { findCapturePoint } from '../core/capture.ts';
import { compileCaption } from '../core/caption.ts';
import { checkLayout } from '../core/layout.ts';
import type { Layout } from '../core/types.ts';
import { emptyLayout } from '../core/types.ts';
import { SCENEGEN_INSTRUCTIONS } from '../agent/prompt.ts';
import { Jst2Client } from './jst2.ts';
import { createMockJst2, MOCK_PREFIX } from './mockjst2.ts';
import { falFluxDepthProvider, jst2ReferenceProvider, openaiImageProvider } from './pano.ts';
import type { PanoProvider } from './pano.ts';
import { renderConditions, textToScene } from './textScene.ts';
import { videoPipelineAvailable, videoToScene } from './videoScene.ts';

export interface ScenegenOptions {
  dataDir: string;
  viggleKey?: string;
  viggleBase?: string;
  /** Where `posed-images` lives. Unset: the built-in mock. */
  posedImagesBase?: string;
  falKey?: string;
  openai?: { apiKey?: string; model: string; base?: string };
  /** GPT image model for the panorama. Default gpt-image-2. */
  imageModel?: string;
  port: number;
}

export interface Job { id: string; kind: 'text' | 'video'; status: 'running' | 'done' | 'failed'; stage: string; message: string; progress: number; log: string[]; error?: string; startedAt: number; endedAt?: number }

export interface Project {
  id: string;
  kind: 'text' | 'video';
  title: string;
  createdAt: string;
  updatedAt: string;
  layout: Layout;
  chat: unknown[];
  video?: { file: string; bytes: number } | null;
  /** The picture the user started from (image → scene), kept as reference.<ext>. */
  reference?: { file: string; mime: string } | null;
  result?: unknown;
  job?: Job | null;
  exported?: { sceneId: string; at: string } | null;
}

class HttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }

const json = (res: ServerResponse, body: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new HttpError(400, 'Body is not JSON.'); }
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.json': 'application/json', '.spz': 'application/octet-stream', '.ply': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.mp4': 'video/mp4', '.mov': 'video/quicktime' };

export function scenegenServer(opts: ScenegenOptions): Plugin {
  const root = join(opts.dataDir, 'scenegen');
  const projectsDir = join(root, 'projects');
  // This server's own origin, for the export (director route) and the mock's file URLs. Read off the
  // listening socket: Vite may bind IPv6 localhost only, where 127.0.0.1 is refused.
  let origin = `http://localhost:${opts.port}`;
  const base = () => origin;
  const mock = createMockJst2(join(root, 'mock-jst2'), base);
  const endpoint: 'mock' | 'live' = opts.posedImagesBase ? 'live' : 'mock';
  const jst2 = new Jst2Client({ apiKey: opts.viggleKey, base: opts.viggleBase, posedImagesBase: () => opts.posedImagesBase ?? `${base()}${MOCK_PREFIX}` });
  // First available is the default: GPT-image-2 from the depth map (the planned route), then JST-2's own painter.
  const providers: PanoProvider[] = [
    openaiImageProvider({ apiKey: opts.openai?.apiKey, base: opts.openai?.base, model: opts.imageModel ?? 'gpt-image-2' }),
    jst2ReferenceProvider(jst2, Boolean(opts.viggleKey)),
    falFluxDepthProvider(opts.falKey),
  ];
  const defaultProvider = () => providers.find((x) => x.available)?.id ?? 'jst2-reference';
  const jobs = new Map<string, { job: Job; abort: AbortController }>();
  const cache = new Map<string, Project>();
  let writing = Promise.resolve();

  const pdir = (id: string) => {
    if (!/^[a-z0-9_-]{4,64}$/.test(id)) throw new HttpError(400, 'Bad project id.');
    return join(projectsDir, id);
  };
  async function load(id: string): Promise<Project> {
    const hit = cache.get(id);
    if (hit) return hit;
    const f = join(pdir(id), 'project.json');
    if (!existsSync(f)) throw new HttpError(404, 'No such project.');
    const p = JSON.parse(await readFile(f, 'utf8')) as Project;
    // A job that was running when the server stopped did not finish.
    if (p.job?.status === 'running' && !jobs.has(p.id)) p.job = { ...p.job, status: 'failed', error: 'The server restarted while this was running.' };
    cache.set(id, p);
    return p;
  }
  function save(p: Project): Promise<void> {
    p.updatedAt = new Date().toISOString();
    cache.set(p.id, p);
    const dir = pdir(p.id);
    writing = writing.then(async () => {
      await mkdir(dir, { recursive: true });
      const tmp = join(dir, `project.json.${process.pid}.tmp`);
      await writeFile(tmp, JSON.stringify(p, null, 2));
      await rename(tmp, join(dir, 'project.json'));
    }).catch(() => {});
    return writing;
  }
  function summary(p: Project) {
    return { id: p.id, kind: p.kind, title: p.title, updatedAt: p.updatedAt, objects: p.layout.objects.length, status: p.job?.status ?? (p.result ? 'done' : 'draft'), exported: p.exported ?? null, thumb: p.result ? (p.kind === 'text' ? `/scenegen/files/${p.id}/out/${(p.result as { files: { panorama: string } }).files.panorama}` : null) : null };
  }

  function startJob(p: Project, kind: Job['kind'], run: (job: Job, signal: AbortSignal) => Promise<unknown>) {
    if (jobs.has(p.id)) throw new HttpError(409, 'This project is already generating.');
    const job: Job = { id: `job_${randomUUID().slice(0, 8)}`, kind, status: 'running', stage: 'start', message: 'Starting', progress: 0, log: [], startedAt: Date.now() };
    const abort = new AbortController();
    jobs.set(p.id, { job, abort });
    p.job = job;
    void save(p);
    run(job, abort.signal).then(async (result) => {
      job.status = 'done'; job.stage = 'done'; job.progress = 1; job.endedAt = Date.now();
      p.result = result;
      p.exported = null;
    }).catch((e: unknown) => {
      job.status = 'failed'; job.error = e instanceof Error ? e.message : String(e); job.endedAt = Date.now();
      job.log.push(`failed: ${job.error}`);
    }).finally(() => { jobs.delete(p.id); p.job = job; void save(p); });
    return job;
  }
  const note = (job: Job, stage: string, message: string, progress?: number) => {
    job.stage = stage; job.message = message; if (progress !== undefined) job.progress = progress;
    job.log.push(`[${((Date.now() - job.startedAt) / 1000).toFixed(0)}s] ${stage}: ${message}`);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local');
    const path = url.pathname;
    const m = req.method ?? 'GET';
    if (path.startsWith(MOCK_PREFIX + '/')) return mock.handle(req, res, path.slice(MOCK_PREFIX.length));
    if (path.startsWith('/scenegen/files/') && m === 'GET') {
      const [id, ...rest] = path.slice('/scenegen/files/'.length).split('/').map(decodeURIComponent);
      const dir = pdir(id!);
      const file = normalize(join(dir, ...rest));
      if (!file.startsWith(dir + sep)) throw new HttpError(400, 'Bad path.');
      if (!existsSync(file)) throw new HttpError(404, 'No such file.');
      const s = await stat(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
      return true;
    }
    if (!path.startsWith('/scenegen/api/')) return false;
    const p = path.slice('/scenegen/api'.length);

    if (p === '/config' && m === 'GET') {
      return json(res, {
        providers: providers.map((x) => ({ id: x.id, label: x.label, available: x.available })),
        defaultProvider: defaultProvider(),
        agent: opts.openai?.apiKey ? { model: opts.openai.model } : null,
        video: { available: videoPipelineAvailable(), endpoint },
        viggle: Boolean(opts.viggleKey),
      });
    }
    if (p === '/agent/respond' && m === 'POST') return relayAgent(req, res);
    if (p === '/projects' && m === 'GET') {
      await mkdir(projectsDir, { recursive: true });
      const ids = (await readdir(projectsDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
      const list = (await Promise.all(ids.map((id) => load(id).catch(() => null)))).filter((x): x is Project => Boolean(x));
      return json(res, list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(summary));
    }
    if (p === '/projects' && m === 'POST') {
      const body = await readJson(req);
      const kind = body.kind === 'video' ? 'video' : 'text';
      const now = new Date().toISOString();
      const layout = (body.layout as Layout | undefined) ?? emptyLayout(String(body.prompt ?? ''));
      const proj: Project = { id: `sg${Date.now().toString(36)}${randomUUID().slice(0, 4)}`, kind, title: String(body.title ?? (kind === 'video' ? 'Video scene' : layout.title)), createdAt: now, updatedAt: now, layout, chat: [], video: null, result: null, job: null, exported: null };
      await save(proj);
      return json(res, proj, 201);
    }
    const pm = /^\/projects\/([^/]+)(\/[a-z-]+)?$/.exec(p);
    if (!pm) return false;
    const proj = await load(pm[1]!);
    const action = pm[2] ?? '';
    const live = jobs.get(proj.id)?.job;
    if (live) proj.job = live;

    if (action === '' && m === 'GET') return json(res, proj);
    if (action === '' && m === 'PUT') {
      const body = await readJson(req);
      if (typeof body.title === 'string') proj.title = body.title.slice(0, 80);
      if (body.layout) proj.layout = body.layout as Layout;
      if (Array.isArray(body.chat)) proj.chat = body.chat;
      await save(proj);
      return json(res, { ok: true, updatedAt: proj.updatedAt });
    }
    if (action === '/capture' && m === 'POST') {
      const c = findCapturePoint(proj.layout);
      return json(res, c);
    }
    if (action === '/conditions' && m === 'POST') {
      const dir = join(pdir(proj.id), 'preview');
      const c = await renderConditions(proj.layout, dir);
      const stamp = Date.now();
      return json(res, {
        capture: c.capture, range: c.range, legend: c.legend,
        prompt: compileCaption(proj.layout, c.capture),
        issues: checkLayout(proj.layout),
        files: { depth: `/scenegen/files/${proj.id}/preview/depth.png?t=${stamp}`, semantic: `/scenegen/files/${proj.id}/preview/semantic.png?t=${stamp}`, shaded: `/scenegen/files/${proj.id}/preview/shaded.png?t=${stamp}` },
      });
    }
    if (action === '/generate' && m === 'POST') {
      const body = await readJson(req);
      const provider = providers.find((x) => x.id === (body.provider ?? defaultProvider()));
      if (!provider) throw new HttpError(400, `Unknown provider. Choose: ${providers.map((x) => x.id).join(', ')}.`);
      if (!provider.available) throw new HttpError(503, `${provider.label} is not configured on this server.`);
      if (!proj.layout.objects.length) throw new HttpError(400, 'The layout is empty: place some objects first.');
      const layout = structuredClone(proj.layout);
      const styleImage = proj.reference && body.useReference !== false ? { bytes: new Uint8Array(await readFile(join(pdir(proj.id), proj.reference.file))), mime: proj.reference.mime } : undefined;
      const maxFills = body.maxFills === undefined ? 2 : Math.max(0, Math.min(4, Number(body.maxFills) || 0));
      const job = startJob(proj, 'text', (j, signal) => textToScene(layout, join(pdir(proj.id), 'out'), {
        jst2, provider, styleImage, maxFills, prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : undefined, signal,
        onProgress: (stage, message) => note(j, stage, message, { conditions: 0.05, pano: 0.1, scale: 0.4, scene: 0.45, fill: 0.6, verify: 0.97, done: 1 }[stage]),
      }));
      return json(res, job, 202);
    }
    if (action === '/reference' && m === 'PUT') {
      const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (!/^image\/(png|jpeg|webp)$/.test(type)) throw new HttpError(415, 'Send the picture as the raw body with an image/png, image/jpeg or image/webp Content-Type.');
      const file = `reference.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`;
      await mkdir(pdir(proj.id), { recursive: true });
      await pipeline(req, createWriteStream(join(pdir(proj.id), file)));
      proj.reference = { file, mime: type };
      await save(proj);
      return json(res, { ...proj.reference, url: `/scenegen/files/${proj.id}/${file}` });
    }
    if (action === '/video' && m === 'PUT') {
      const type = req.headers['content-type'] ?? '';
      if (!/^video\//.test(type)) throw new HttpError(415, 'Send the video as the raw body with a video/* Content-Type.');
      const ext = type.includes('quicktime') ? '.mov' : '.mp4';
      const dir = pdir(proj.id);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `input${ext}`);
      await pipeline(req, createWriteStream(file));
      const s = await stat(file);
      if (s.size < 1000) throw new HttpError(400, 'The upload is empty.');
      proj.video = { file: `input${ext}`, bytes: s.size };
      proj.result = null;
      await save(proj);
      return json(res, proj.video);
    }
    if (action === '/video-run' && m === 'POST') {
      if (!proj.video) throw new HttpError(400, 'Upload a video first.');
      if (!videoPipelineAvailable()) throw new HttpError(503, 'The video pipeline is not installed (scenegen/py/.venv).');
      const body = await readJson(req);
      const video = join(pdir(proj.id), proj.video.file);
      const job = startJob(proj, 'video', (j, signal) => videoToScene(video, join(pdir(proj.id), 'out'), {
        jst2, endpoint, registerMockPoints: mock.registerPoints, posedBase: opts.posedImagesBase ?? `${base()}${MOCK_PREFIX}`,
        square: body.square ? Number(body.square) : undefined, signal,
        onProgress: (stage, progress, message) => note(j, stage, message, stageProgress(stage, progress)),
      }));
      return json(res, job, 202);
    }
    if (action === '/cancel' && m === 'POST') {
      jobs.get(proj.id)?.abort.abort();
      return json(res, { ok: true });
    }
    if (action === '/export' && m === 'POST') {
      if (!proj.result) throw new HttpError(400, 'Generate the scene first.');
      const out = join(pdir(proj.id), 'out');
      const r = proj.result as { sessionId: string; batchIds: string[]; files: { scene: string; panorama?: string; layout?: string } };
      const body = {
        name: proj.title,
        dir: out,
        spz: r.files.scene,
        panorama: r.files.panorama ?? null,
        layout: r.files.layout ?? null,
        viggle: proj.kind === 'text' ? { sessionId: r.sessionId, batchIds: r.batchIds } : null,
        source: { kind: proj.kind, projectId: proj.id },
      };
      const resp = await fetch(`${base()}/api/library/import-scene`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const out2 = await resp.json().catch(() => null) as { id?: string; error?: { message?: string } } | null;
      if (!resp.ok || !out2?.id) throw new HttpError(502, out2?.error?.message ?? `The director refused the import (${resp.status}).`);
      proj.exported = { sceneId: out2.id, at: new Date().toISOString() };
      await save(proj);
      return json(res, proj.exported);
    }
    return false;
  }

  function stageProgress(stage: string, p: number): number {
    const span: Record<string, [number, number]> = { probe: [0, 0.02], sample: [0.02, 0.1], colmap: [0.1, 0.75], normalise: [0.75, 0.8], select: [0.8, 0.82], write: [0.82, 0.85], upload: [0.85, 0.9], scene: [0.9, 0.99], done: [1, 1] };
    const [a, b] = span[stage] ?? [0, 1];
    return a + (b - a) * Math.max(0, Math.min(1, p));
  }

  async function relayAgent(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const ai = opts.openai;
    if (!ai?.apiKey) throw new HttpError(503, 'OPENAI_API_KEY is not set on the server.');
    const body = await readJson(req) as { input: unknown; previous_response_id?: string; tools: unknown[]; tool_choice?: string };
    const upstream = await fetch(`${ai.base ?? 'https://api.openai.com/v1'}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ai.model, instructions: SCENEGEN_INSTRUCTIONS, input: body.input, tools: body.tools,
        ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
        ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}),
        store: true, stream: true,
      }),
    });
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      let msg = `OpenAI ${upstream.status}`;
      try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
      throw new HttpError(upstream.status === 401 ? 502 : upstream.status, msg);
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const reader = upstream.body.getReader();
    req.on('close', () => { void reader.cancel().catch(() => {}); });
    for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); }
    res.end();
    return true;
  }

  return {
    name: 'scenegen-server',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const a = server.httpServer?.address();
        if (a && typeof a === 'object') {
          // Loopback and wildcard binds go by name: NO_PROXY lists "localhost", not "[::1]", and the
          // dev server runs with HTTPS_PROXY set (see .claude/launch.json).
          const loop = ['::', '0.0.0.0', '::1', '127.0.0.1'].includes(a.address);
          const host = loop ? 'localhost' : a.family === 'IPv6' ? `[${a.address}]` : a.address;
          origin = `http://${host}:${a.port}`;
        }
      });
      server.middlewares.use((req, res, next) => {
        const u = req.url ?? '';
        if (u === '/scenegen' || u === '/scenegen/') { res.writeHead(302, { Location: '/scenegen/index.html' }); res.end(); return; }
        route(req, res).then((handled) => { if (!handled) next(); }).catch((e: unknown) => {
          const status = e instanceof HttpError ? e.status : (e as { status?: number }).status ?? 500;
          json(res, { error: { message: e instanceof Error ? e.message : String(e) } }, status >= 400 && status < 600 ? status : 500);
        });
      });
    },
  };
}
