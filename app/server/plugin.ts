import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import type { Plugin } from 'vite';

import type { StageDoc } from '../../src/stage/types.ts';
import { AGENT_INSTRUCTIONS } from '../shared/agentPrompt.ts';
import { blankStage } from '../shared/blank.ts';
import type { GenJob, Library, LibraryCharacter, LibraryMotion, LibraryScene } from '../shared/library.ts';

/**
 * The Director's server, as Vite middleware: stages (versioned JSON files),
 * the asset library, and Viggle generation jobs.
 *
 * THE KEY STAYS HERE. Jobs are submitted and polled server-side; the files
 * they produce are downloaded into `dataDir/files` straight away, because
 * Viggle's signed URLs expire in 1-3 hours and a stage must reopen next week.
 */
export interface DirectorServerOptions {
  dataDir: string;
  apiKey: string | undefined;
  apiBase?: string;
  /** The World agent's model. The key stays here, like Viggle's. */
  openai?: { apiKey: string | undefined; model: string; base?: string };
  /** Files copied into the library on first start, as generated scenes. */
  seedScenes?: Array<{ name: string; spz: string; panorama?: string }>;
}

const POLL_MS = 4000;
const MIME: Record<string, string> = {
  '.spz': 'application/octet-stream', '.vsplat': 'application/octet-stream', '.glb': 'model/gltf-binary',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};

export function directorServer(opts: DirectorServerOptions): Plugin {
  const base = opts.apiBase ?? 'https://apis.viggle.ai';
  const stagesDir = join(opts.dataDir, 'stages');
  const filesDir = join(opts.dataDir, 'files');
  const libraryFile = join(opts.dataDir, 'library.json');
  let library: Library = { scenes: [], characters: [], motions: [], jobs: [] };
  let writing = Promise.resolve();

  const saveLibrary = () => {
    writing = writing.then(() => atomicWrite(libraryFile, JSON.stringify(library, null, 2)));
    return writing;
  };

  async function init() {
    await mkdir(stagesDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    if (existsSync(libraryFile)) library = JSON.parse(await readFile(libraryFile, 'utf8')) as Library;
    for (const seed of opts.seedScenes ?? []) {
      if (!existsSync(seed.spz) || library.scenes.some((s) => s.name === seed.name)) continue;
      const id = `seed_${randomUUID().slice(0, 8)}`;
      await copyFile(seed.spz, join(filesDir, `${id}.spz`));
      let panoramaUrl: string | null = null;
      if (seed.panorama && existsSync(seed.panorama)) {
        await copyFile(seed.panorama, join(filesDir, `${id}-pano.png`));
        panoramaUrl = `/files/${id}-pano.png`;
      }
      library.scenes.push({ id, name: seed.name, url: `/files/${id}.spz`, panoramaUrl, viggle: null, createdAt: new Date().toISOString() });
    }
    await saveLibrary();
  }

  // ── Viggle ────────────────────────────────────────────────────────────────

  async function viggle(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    if (!opts.apiKey) throw httpError(503, 'VIGGLE_API_KEY is not set on the server.');
    const res = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${opts.apiKey}`, 'X-Viggle-Source': 'viggle-director', ...init.headers } });
    const text = await res.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : {};
    if (!res.ok) {
      const err = (body.error ?? {}) as { message?: string; code?: string };
      throw httpError(res.status, err.message ?? `Viggle ${res.status}`, err.code);
    }
    return body;
  }

  async function download(url: string, name: string): Promise<string> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    await writeFile(join(filesDir, name), Buffer.from(await res.arrayBuffer()));
    return `/files/${name}`;
  }

  async function submit(kind: GenJob['kind'], input: Record<string, unknown>): Promise<GenJob> {
    let remoteId: string;
    let label: string;
    let credits: number;
    if (kind === 'scene') {
      const prompt = String(input.prompt ?? '').trim();
      if (!prompt) throw httpError(400, 'Describe the scene.');
      const sessionId = `dir_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const task = await viggle('/v1/scenes/pano', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, prompt, quality: input.quality ?? 'low' }),
      });
      remoteId = String(task.id);
      label = prompt;
      credits = Number(task.credits ?? 6);
    } else if (kind === 'character') {
      const form = new FormData();
      form.set('type', 'vsplat');
      form.set('render_thumbnail', 'true');
      if (input.name) form.set('name', String(input.name));
      if (typeof input.imageUrl === 'string' && input.imageUrl) form.set('image_url', input.imageUrl);
      else if (typeof input.imageBase64 === 'string') {
        const mime = String(input.mimeType ?? 'image/png');
        form.set('image', new Blob([Buffer.from(input.imageBase64, 'base64')], { type: mime }), `character${mimeExt(mime)}`);
      } else throw httpError(400, 'Choose an image.');
      const created = await viggle('/v1/characters', { method: 'POST', body: form });
      remoteId = String(created.id);
      label = String(input.name || 'Character');
      credits = 30;
    } else {
      const text = String(input.text ?? '').trim();
      if (!text) throw httpError(400, 'Describe the motion.');
      const duration = Math.min(60, Math.max(3, Number(input.duration ?? 5)));
      const created = await viggle('/v1/motions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, duration_seconds: duration, name: String(input.name ?? '') }),
      });
      remoteId = String(created.id);
      label = text;
      credits = 10;
    }
    const job: GenJob = {
      id: `job_${randomUUID().slice(0, 12)}`, kind, remoteId, label, status: 'processing', credits,
      error: null, assetId: null, createdAt: new Date().toISOString(),
    };
    library.jobs.unshift(job);
    await saveLibrary();
    return job;
  }

  /** One look at a job; when Viggle says ready, its files land in the library. */
  async function poll(job: GenJob): Promise<void> {
    try {
      if (job.kind === 'scene') {
        const task = await viggle(`/v1/scenes/${encodeURIComponent(job.remoteId)}`);
        if (task.status === 'failed' || task.status === 'cancelled') return fail(job, (task.error as { message?: string })?.message ?? 'Scene failed');
        if (task.status !== 'ready') return;
        const r = task.result as { spz: { url: string }; panorama?: { url: string } | null; outputBatch?: { batchId: string } | null; sessionId: string };
        const id = `scn_${job.id.slice(4)}`;
        const url = await download(r.spz.url, `${id}.spz`);
        const panoramaUrl = r.panorama?.url ? await download(r.panorama.url, `${id}-pano.png`) : null;
        const scene: LibraryScene = {
          id, name: job.label.slice(0, 60), url, panoramaUrl, createdAt: new Date().toISOString(),
          viggle: { sessionId: String(task.sessionId ?? r.sessionId), batchIds: r.outputBatch ? [r.outputBatch.batchId] : [] },
        };
        library.scenes.unshift(scene);
        done(job, id);
      } else if (job.kind === 'character') {
        const c = await viggle(`/v1/characters/${encodeURIComponent(job.remoteId)}`);
        if (c.status === 'failed' || c.status === 'cancelled') return fail(job, (c.error as { message?: string })?.message ?? 'Character failed');
        if (c.status !== 'ready') return;
        const ex = await viggle(`/v1/characters/${encodeURIComponent(job.remoteId)}/export?download_type=vsplat`);
        if (ex.status !== 'ready' || !ex.vsplat_url) return;
        const id = `chr_${job.id.slice(4)}`;
        const url = await download(String(ex.vsplat_url), `${id}.vsplat`);
        const thumbnailUrl = ex.thumbnail_url ? await download(String(ex.thumbnail_url), `${id}-thumb.png`).catch(() => null) : null;
        const character: LibraryCharacter = { id, name: job.label, url, thumbnailUrl, viggleId: job.remoteId, createdAt: new Date().toISOString() };
        library.characters.unshift(character);
        done(job, id);
      } else {
        const m = await viggle(`/v1/motions/${encodeURIComponent(job.remoteId)}`);
        if (m.status === 'failed' || m.status === 'cancelled') return fail(job, (m.error as { message?: string })?.message ?? 'Motion failed');
        if (m.status !== 'ready') return;
        const ex = await viggle(`/v1/motions/${encodeURIComponent(job.remoteId)}/export?download_type=glb`);
        const src = (ex.metahuman_url ?? ex.metahuman_body_url) as string | null;
        if (ex.status !== 'ready' || !src) return;
        const id = `mot_${job.id.slice(4)}`;
        const url = await download(src, `${id}.glb`);
        const motion: LibraryMotion = { id, name: job.label.slice(0, 60), url, viggleId: job.remoteId, createdAt: new Date().toISOString() };
        library.motions.unshift(motion);
        done(job, id);
      }
    } catch (e) {
      // 4xx other than a rate limit will not get better by waiting.
      const status = (e as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) fail(job, message(e));
    }
  }

  function done(job: GenJob, assetId: string) {
    job.status = 'ready';
    job.assetId = assetId;
    void saveLibrary();
  }
  function fail(job: GenJob, error: string) {
    job.status = 'failed';
    job.error = error;
    void saveLibrary();
  }

  let polling = false;
  const timer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try { for (const job of library.jobs.filter((j) => j.status === 'processing')) await poll(job); } finally { polling = false; }
  }, POLL_MS);
  timer.unref?.();

  // ── Stages ────────────────────────────────────────────────────────────────

  const stagePath = (id: string) => {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw httpError(400, 'Bad stage id.');
    return join(stagesDir, `${id}.json`);
  };
  async function readStage(id: string): Promise<StageDoc> {
    const path = stagePath(id);
    if (!existsSync(path)) throw httpError(404, 'Stage not found.');
    return JSON.parse(await readFile(path, 'utf8')) as StageDoc;
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  async function route(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://local');
    const p = url.pathname;
    const m = req.method ?? 'GET';

    if (p.startsWith('/files/') && m === 'GET') {
      const name = normalize(decodeURIComponent(p.slice('/files/'.length)));
      if (name.includes('..') || name.includes('/')) throw httpError(400, 'Bad file.');
      const file = join(filesDir, name);
      if (!existsSync(file)) throw httpError(404, 'No such file.');
      const s = await stat(file);
      res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
      createReadStream(file).pipe(res);
      return true;
    }
    if (!p.startsWith('/api/')) return false;

    if (p === '/api/config' && m === 'GET') return json(res, { live: Boolean(opts.apiKey), agent: opts.openai?.apiKey ? { model: opts.openai.model } : null });

    // The agent: one model turn, streamed. The page runs the tools (they need the renderer) and
    // sends their results back as the next turn's input, chained by previous_response_id.
    if (p === '/api/agent/respond' && m === 'POST') {
      const ai = opts.openai;
      if (!ai?.apiKey) throw httpError(503, 'OPENAI_API_KEY is not set on the server.');
      const body = await readJson(req) as { input: unknown; previous_response_id?: string; tools: unknown[]; tool_choice?: string };
      const upstream = await fetch(`${ai.base ?? 'https://api.openai.com/v1'}/responses`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ai.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: ai.model,
          instructions: AGENT_INSTRUCTIONS,
          input: body.input,
          tools: body.tools,
          ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
          ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}),
          store: true,
          stream: true,
        }),
      });
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text();
        let msg = `OpenAI ${upstream.status}`;
        try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
        throw httpError(upstream.status === 401 ? 502 : upstream.status, msg);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const reader = upstream.body.getReader();
      req.on('close', () => { void reader.cancel().catch(() => {}); });
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
      return true;
    }

    if (p === '/api/stages' && m === 'GET') {
      const files = (await readdir(stagesDir)).filter((f) => f.endsWith('.json'));
      const list = await Promise.all(files.map(async (f) => {
        const d = JSON.parse(await readFile(join(stagesDir, f), 'utf8')) as StageDoc;
        return { id: d.id, title: d.title, updatedAt: d.updatedAt };
      }));
      return json(res, list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }
    if (p === '/api/stages' && m === 'POST') {
      const body = await readJson(req) as { title?: string };
      const doc = blankStage(`stg_${randomUUID().replace(/-/g, '').slice(0, 16)}`, body.title || 'Untitled stage');
      await atomicWrite(stagePath(doc.id), JSON.stringify(doc, null, 2));
      return json(res, doc);
    }
    const stage = /^\/api\/stages\/([^/]+)$/.exec(p);
    if (stage && m === 'GET') return json(res, await readStage(stage[1]!));
    if (stage && m === 'PUT') {
      const { baseVersion, doc } = await readJson(req) as { baseVersion: number; doc: StageDoc };
      const current = await readStage(stage[1]!);
      // Optimistic lock: a write made from an older version is refused, with the newer one to merge onto.
      if (current.version !== baseVersion) return json(res, { error: { code: 'VERSION_CONFLICT', message: 'The stage changed elsewhere.' }, doc: current }, 409);
      const next: StageDoc = { ...doc, id: current.id, version: current.version + 1, updatedAt: new Date().toISOString() };
      await atomicWrite(stagePath(next.id), JSON.stringify(next, null, 2));
      return json(res, next);
    }

    if (p === '/api/library' && m === 'GET') return json(res, library);
    const gen = /^\/api\/gen\/(scene|character|motion)$/.exec(p);
    if (gen && m === 'POST') return json(res, await submit(gen[1] as GenJob['kind'], await readJson(req) as Record<string, unknown>));
    const dismiss = /^\/api\/jobs\/([^/]+)$/.exec(p);
    if (dismiss && m === 'DELETE') {
      library.jobs = library.jobs.filter((j) => j.id !== dismiss[1] || j.status === 'processing');
      await saveLibrary();
      return json(res, { ok: true });
    }
    throw httpError(404, 'No such endpoint.');
  }

  return {
    name: 'viggle-director-server',
    async configureServer(server) {
      await init();
      server.middlewares.use((req, res, next) => {
        route(req, res).then((handled) => { if (!handled) next(); }).catch((e: unknown) => {
          const status = (e as { status?: number }).status ?? 500;
          json(res, { error: { code: (e as { code?: string }).code ?? 'ERROR', message: message(e) } }, status);
        });
      });
    },
  };
}

function json(res: ServerResponse, body: unknown, status = 200): true {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(text);
  return true;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 40 * 1024 * 1024) throw httpError(413, 'Request too large.');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, path);
}

function httpError(status: number, msg: string, code?: string): Error {
  return Object.assign(new Error(msg), { status, code });
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function mimeExt(mime: string): string {
  return mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
}
