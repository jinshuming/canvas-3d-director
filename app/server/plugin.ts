import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { extname, join, normalize, sep } from 'node:path';
import type { Plugin } from 'vite';

import type { StageDoc } from '../../src/stage/types.ts';
import { AGENT_INSTRUCTIONS } from '../shared/agentPrompt.ts';
import { relayResponses } from './openaiRelay.ts';
import type { TurnBody } from './openaiRelay.ts';
import type { GenJob, Library, LibraryCharacter, LibraryMotion, LibraryScene } from '../shared/library.ts';
import { H3_ASPECT, H3_MAX_SECONDS, H3_MIN_SECONDS, H3_RESOLUTIONS, h3Credits } from '../shared/library.ts';
import type { WorldChat, WorldFile } from '../shared/world.ts';
import { copyWorld, newWorld, readWorld, storableChat, summarize, WORLD_ID, worldFromStage } from '../shared/world.ts';

/**
 * The Director's server, as Vite middleware: World project files (one
 * folder each, see shared/world.ts), the asset library, Viggle generation
 * jobs, and the relay for the agent's model.
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
  const worldsDir = join(opts.dataDir, 'worlds');
  const trashDir = join(opts.dataDir, 'trash');
  const legacyStagesDir = join(opts.dataDir, 'stages');
  const filesDir = join(opts.dataDir, 'files');
  const libraryFile = join(opts.dataDir, 'library.json');
  let library: Library = { scenes: [], characters: [], motions: [], jobs: [] };
  let writing = Promise.resolve();

  const saveLibrary = () => {
    writing = writing.then(() => atomicWrite(libraryFile, JSON.stringify(library, null, 2)));
    return writing;
  };

  async function init() {
    await mkdir(worldsDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await migrateStages();
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

  /**
   * An H3 render: the previs video the browser made goes to Viggle's MiniMax H3 as the reference video, with
   * a prompt, and comes back as a finished video. `form` is the browser's multipart: `reference_video` (the
   * mp4) and the options. Credits are Viggle's per-second price for the mode (library.ts).
   */
  async function submitH3(form: FormData): Promise<GenJob> {
    const video = form.get('reference_video');
    if (!(video instanceof Blob) || video.size === 0) throw httpError(400, 'Send the previs video as reference_video.');
    if (video.size > 100 * 1024 * 1024) throw httpError(413, 'The previs video is over Viggle\'s 100 MiB limit for a reference video.');
    const prompt = String(form.get('prompt') ?? '').trim();
    if (!prompt) throw httpError(400, 'Describe the video H3 should make.');
    const resolution = String(form.get('resolution') ?? '768p');
    if (!(H3_RESOLUTIONS as readonly string[]).includes(resolution)) throw httpError(400, `resolution must be one of ${H3_RESOLUTIONS.join(', ')}.`);
    const quality = String(form.get('quality') ?? 'high');
    if (quality !== 'low' && quality !== 'high') throw httpError(400, 'quality must be low or high.');
    const duration = Math.ceil(Number(form.get('duration_s') ?? H3_MIN_SECONDS));
    if (!(duration >= H3_MIN_SECONDS && duration <= H3_MAX_SECONDS)) throw httpError(400, `duration_s must be ${H3_MIN_SECONDS}-${H3_MAX_SECONDS} seconds.`);
    const aspect = String(form.get('aspect_ratio') ?? '16:9');
    if (!Object.values(H3_ASPECT).includes(aspect)) throw httpError(400, 'Unsupported aspect_ratio.');
    const enhance = String(form.get('enhance') ?? 'false') === 'true';
    const out = new FormData();
    out.set('prompt', prompt.slice(0, 2000));
    out.set('quality', quality);
    out.set('resolution', resolution);
    out.set('aspect_ratio', aspect);
    out.set('duration_s', String(duration));
    out.set('enhance', String(enhance));
    out.set('reference_video', video, 'previs.mp4');
    const created = await viggle('/v1/videos', { method: 'POST', body: out });
    const job: GenJob = {
      id: `job_${randomUUID().slice(0, 12)}`, kind: 'h3', remoteId: String(created.id), label: String(form.get('title') ?? 'H3 成片').slice(0, 60),
      status: 'processing', credits: h3Credits(duration, resolution as typeof H3_RESOLUTIONS[number], enhance), error: null, assetId: null,
      worldId: String(form.get('world') ?? '') || undefined, createdAt: new Date().toISOString(),
    };
    library.jobs.unshift(job);
    await saveLibrary();
    return job;
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
    } else if (kind === 'fill') {
      const scene = library.scenes.find((s) => s.id === String(input.sceneId ?? '') || s.url === String(input.sceneUrl ?? ''));
      if (!scene) throw httpError(404, 'That scene is not in the library.');
      if (!scene.viggle?.sessionId || !scene.viggle.batchIds.length) throw httpError(400, 'Only scenes generated here can be filled: this one has no Viggle session.');
      const position = input.position as number[] | undefined;
      if (!Array.isArray(position) || position.length !== 3 || position.some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw httpError(400, "position must be [x, y, z] in the scene file's frame.");
      const task = await viggle('/v1/scenes/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: scene.viggle.sessionId,
          referenceBatchIds: scene.viggle.batchIds,
          targetPosition: { position, yaw: Number(input.yaw ?? 0), pitch: Math.max(-90, Math.min(90, Number(input.pitch ?? 0))) },
          projection: 'perspective',
          fov: 100,
        }),
      });
      const filling: GenJob = {
        id: `job_${randomUUID().slice(0, 12)}`, kind, remoteId: String(task.id), label: `补全视角 · ${scene.name}`.slice(0, 60), status: 'processing',
        credits: Number(task.credits ?? 1), error: null, assetId: null, createdAt: new Date().toISOString(),
        fill: { sceneId: scene.id, sessionId: scene.viggle.sessionId, batchIds: scene.viggle.batchIds, phase: 'generate' },
      };
      library.jobs.unshift(filling);
      await saveLibrary();
      return filling;
    } else if (kind === 'character') {
      const form = new FormData();
      form.set('type', 'vsplat');
      form.set('render_thumbnail', 'true');
      // A description alone makes the character (type=vsplat with enhance_prompt, no image); with an
      // image it steers how the image is enhanced. 1000 characters at most, and it needs enhance on.
      const describe = String(input.prompt ?? '').trim();
      if (describe.length > 1000) throw httpError(400, 'Describe the character in 1000 characters or fewer.');
      if (describe) form.set('enhance_prompt', describe);
      if (input.name) form.set('name', String(input.name));
      if (typeof input.imageUrl === 'string' && input.imageUrl) form.set('image_url', input.imageUrl);
      else if (typeof input.imageBase64 === 'string') {
        const mime = String(input.mimeType ?? 'image/png');
        form.set('image', new Blob([Buffer.from(input.imageBase64, 'base64')], { type: mime }), `character${mimeExt(mime)}`);
      } else if (!describe) throw httpError(400, 'Describe the character, or choose an image.');
      const created = await viggle('/v1/characters', { method: 'POST', body: form });
      remoteId = String(created.id);
      label = String(input.name || describe.slice(0, 40) || 'Character');
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
      } else if (job.kind === 'fill') {
        await pollFill(job);
      } else if (job.kind === 'h3') {
        const v = await viggle(`/v1/videos/${encodeURIComponent(job.remoteId)}`);
        if (v.status === 'failed' || v.status === 'cancelled') return fail(job, (v.error as { message?: string } | null)?.message ?? 'H3 render failed');
        if (v.status !== 'ready' || !v.video_url) return;
        job.videoUrl = await download(String(v.video_url), `h3_${job.id.slice(4)}.mp4`);
        job.status = 'ready';
        void saveLibrary();
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

  /**
   * A fill is two Viggle tasks in a row on one session: generate the new view, then rebuild the scene
   * from every view it holds. The session takes one task at a time, so the second is submitted only
   * when the first is ready.
   */
  async function pollFill(job: GenJob): Promise<void> {
    const f = job.fill;
    if (!f) return fail(job, 'A fill with no state.');
    const task = await viggle(`/v1/scenes/${encodeURIComponent(job.remoteId)}`);
    if (task.status === 'failed' || task.status === 'cancelled') return fail(job, (task.error as { message?: string })?.message ?? 'Fill failed');
    if (task.status !== 'ready') return;
    const result = task.result as { spz?: { url: string } | null; outputBatch?: { batchId: string } | null };
    if (f.phase === 'generate') {
      const batch = result.outputBatch?.batchId;
      if (!batch) return fail(job, 'Viggle returned no new view.');
      const batchIds = [...f.batchIds, batch];
      const next = await viggle('/v1/scenes/reconstruct', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: f.sessionId, referenceBatchIds: batchIds }),
      });
      job.remoteId = String(next.id);
      job.credits += Number(next.credits ?? 0);
      job.fill = { ...f, batchIds, phase: 'reconstruct' };
      await saveLibrary();
      return;
    }
    if (!result.spz?.url) return fail(job, 'Viggle returned no rebuilt scene.');
    const parent = library.scenes.find((s) => s.id === f.sceneId);
    const id = `scn_${job.id.slice(4)}`;
    const url = await download(result.spz.url, `${id}.spz`);
    const fills = f.batchIds.length - 1;
    const base = (parent?.name ?? 'Scene').replace(/ · 补全\d+$/, '');
    library.scenes.unshift({
      id, name: `${base} · 补全${fills}`.slice(0, 60), url, panoramaUrl: parent?.panoramaUrl ?? null, parentId: f.sceneId,
      viggle: { sessionId: f.sessionId, batchIds: f.batchIds }, createdAt: new Date().toISOString(),
    });
    done(job, id);
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

  // ── Worlds ────────────────────────────────────────────────────────────────

  const worldDir = (id: string) => {
    if (!WORLD_ID.test(id)) throw httpError(400, 'Bad world id.');
    return join(worldsDir, id);
  };
  const worldFile = (id: string) => join(worldDir(id), 'world.json');
  const coverUrl = (w: WorldFile) => (w.cover ? `/api/worlds/${w.id}/cover?v=${encodeURIComponent(w.cover.updatedAt)}` : null);
  const newWorldId = () => `wld_${randomUUID().replace(/-/g, '').slice(0, 16)}`;

  async function readWorldFile(id: string): Promise<WorldFile> {
    const path = worldFile(id);
    if (!existsSync(path)) throw httpError(404, 'World not found.');
    return readWorld(JSON.parse(await readFile(path, 'utf8')));
  }
  async function writeWorld(w: WorldFile): Promise<void> {
    await mkdir(worldDir(w.id), { recursive: true });
    await atomicWrite(worldFile(w.id), JSON.stringify(w, null, 2));
  }

  // One write at a time per world: the stage, the chat and the title land in the same file.
  const locks = new Map<string, Promise<unknown>>();
  function mutate<T>(id: string, fn: (w: WorldFile) => Promise<{ world: WorldFile | null; result: T }> | { world: WorldFile | null; result: T }): Promise<T> {
    const run = (locks.get(id) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const { world, result } = await fn(await readWorldFile(id));
      if (world) await writeWorld({ ...world, updatedAt: new Date().toISOString() });
      return result;
    });
    locks.set(id, run);
    return run;
  }

  /** Stage files from before worlds existed become worlds (same id); the old folder is kept, renamed. */
  async function migrateStages() {
    if (!existsSync(legacyStagesDir)) return;
    for (const f of (await readdir(legacyStagesDir)).filter((x) => x.endsWith('.json'))) {
      const stage = JSON.parse(await readFile(join(legacyStagesDir, f), 'utf8')) as StageDoc;
      if (!WORLD_ID.test(stage.id) || existsSync(worldFile(stage.id))) continue;
      await writeWorld(worldFromStage(stage));
    }
    await rename(legacyStagesDir, `${legacyStagesDir}-migrated-${Date.now()}`);
  }

  async function listWorlds() {
    const ids = existsSync(worldsDir) ? (await readdir(worldsDir)).filter((d) => WORLD_ID.test(d) && existsSync(worldFile(d))) : [];
    const worlds = await Promise.all(ids.map((id) => readWorldFile(id).catch(() => null)));
    return worlds.filter((w): w is WorldFile => !!w).map((w) => summarize(w, coverUrl)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
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
      return relayResponses(req, res, ai && { apiKey: ai.apiKey, base: ai.base, model: ai.model, instructions: AGENT_INSTRUCTIONS }, await readJson(req) as TurnBody);
    }

    if (p === '/api/worlds' && m === 'GET') return json(res, await listWorlds());
    if (p === '/api/worlds' && m === 'POST') {
      const body = await readJson(req) as { title?: string; copyOf?: string };
      const id = newWorldId();
      let w: WorldFile;
      if (body.copyOf) {
        const src = await readWorldFile(body.copyOf);
        w = copyWorld(src, id, body.title || undefined);
        if (src.cover && existsSync(join(worldDir(src.id), src.cover.file))) {
          await mkdir(worldDir(id), { recursive: true });
          await cp(join(worldDir(src.id), src.cover.file), join(worldDir(id), src.cover.file));
          w.cover = { ...src.cover };
        }
      } else {
        w = newWorld(id, body.title?.trim() || '未命名 World');
      }
      await writeWorld(w);
      return json(res, w);
    }

    const world = /^\/api\/worlds\/([^/]+)(?:\/(stage|chat|cover))?$/.exec(p);
    if (world) {
      const [, id, part] = world as unknown as [string, string, string | undefined];
      if (!part && m === 'GET') return json(res, await readWorldFile(id));
      if (!part && m === 'PATCH') {
        const { title } = await readJson(req) as { title?: string };
        const t = String(title ?? '').trim().slice(0, 80);
        if (!t) throw httpError(400, 'A world needs a title.');
        return json(res, await mutate(id, (w) => {
          const next = { ...w, title: t, stage: { ...w.stage, title: t } };
          return { world: next, result: summarize(next, coverUrl) };
        }));
      }
      if (!part && m === 'DELETE') {
        // Recoverable: the folder moves to the trash.
        await (locks.get(id) ?? Promise.resolve()).catch(() => {});
        if (!existsSync(worldFile(id))) throw httpError(404, 'World not found.');
        await mkdir(trashDir, { recursive: true });
        await rename(worldDir(id), join(trashDir, `${id}-${Date.now()}`));
        locks.delete(id);
        return json(res, { ok: true });
      }
      if (part === 'stage' && m === 'GET') return json(res, (await readWorldFile(id)).stage);
      if (part === 'stage' && m === 'PUT') {
        const { baseVersion, doc } = await readJson(req) as { baseVersion: number; doc: StageDoc };
        const out = await mutate<{ conflict: StageDoc } | { stage: StageDoc }>(id, (w) => {
          // Optimistic lock: a write made from an older version is refused, with the newer one to merge onto.
          if (w.stage.version !== baseVersion) return { world: null, result: { conflict: w.stage } };
          const stage: StageDoc = { ...doc, id, version: w.stage.version + 1, updatedAt: new Date().toISOString() };
          // The title is edited on the stage in the editor; the world follows it.
          return { world: { ...w, stage, title: stage.title.trim() || w.title }, result: { stage } };
        });
        if ('conflict' in out) return json(res, { error: { code: 'VERSION_CONFLICT', message: 'The world changed elsewhere.' }, doc: out.conflict }, 409);
        return json(res, out.stage);
      }
      if (part === 'chat' && m === 'PUT') {
        const { chat } = await readJson(req) as { chat: WorldChat };
        if (!chat || !Array.isArray(chat.items)) throw httpError(400, 'Bad chat.');
        return json(res, await mutate(id, (w) => {
          const next = storableChat({ previousResponseId: chat.previousResponseId ?? null, items: chat.items, updatedAt: new Date().toISOString() });
          return { world: { ...w, chat: next }, result: { updatedAt: next.updatedAt } };
        }));
      }
      if (part === 'cover' && m === 'PUT') {
        const { dataUrl } = await readJson(req) as { dataUrl?: string };
        const b64 = /^data:image\/jpeg;base64,(.+)$/.exec(dataUrl ?? '')?.[1];
        if (!b64) throw httpError(400, 'Send the cover as a JPEG data URL.');
        const bytes = Buffer.from(b64, 'base64');
        if (bytes.length > 2 * 1024 * 1024) throw httpError(413, 'Cover too large.');
        return json(res, await mutate(id, async (w) => {
          await atomicWrite(join(worldDir(id), 'cover.jpg'), bytes);
          const next = { ...w, cover: { file: 'cover.jpg', updatedAt: new Date().toISOString() } };
          return { world: next, result: { coverUrl: coverUrl(next) } };
        }));
      }
      if (part === 'cover' && m === 'GET') {
        const w = await readWorldFile(id);
        const file = w.cover ? join(worldDir(id), w.cover.file) : null;
        if (!file || !existsSync(file)) throw httpError(404, 'No cover yet.');
        const s = await stat(file);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': s.size, 'Cache-Control': 'public, max-age=31536000, immutable' });
        createReadStream(file).pipe(res);
        return true;
      }
      throw httpError(405, 'Not allowed.');
    }

    if (p === '/api/library' && m === 'GET') return json(res, library);
    // A scene from the scene generator (scenegen/): its files are copied in, and a generated
    // scene keeps its Viggle session so 扩展场景 can still fill it.
    if (p === '/api/library/import-scene' && m === 'POST') {
      const b = await readJson(req) as { name?: string; dir?: string; spz?: string; panorama?: string | null; layout?: string | null; viggle?: { sessionId: string; batchIds: string[] } | null; source?: unknown };
      const allowed = join(opts.dataDir, 'scenegen') + sep;
      const src = (f: string | null | undefined) => {
        if (!f || !b.dir) return null;
        const full = normalize(join(b.dir, f));
        if (!full.startsWith(allowed) || !existsSync(full)) throw httpError(400, `Not a scene generator file: ${f}`);
        return full;
      };
      const spz = src(b.spz);
      if (!spz) throw httpError(400, 'spz is required.');
      const id = `scene_${randomUUID().slice(0, 12)}`;
      await mkdir(filesDir, { recursive: true });
      await copyFile(spz, join(filesDir, `${id}.spz`));
      const pano = src(b.panorama);
      let panoramaUrl: string | null = null;
      if (pano) { const ext = pano.endsWith('.png') ? '.png' : '.jpg'; await copyFile(pano, join(filesDir, `${id}-pano${ext}`)); panoramaUrl = `/files/${id}-pano${ext}`; }
      const layout = src(b.layout);
      let layoutUrl: string | undefined;
      if (layout) { await copyFile(layout, join(filesDir, `${id}-layout.json`)); layoutUrl = `/files/${id}-layout.json`; }
      const scene: LibraryScene = {
        id, name: String(b.name ?? 'Generated scene').slice(0, 60), url: `/files/${id}.spz`, panoramaUrl,
        viggle: b.viggle && Array.isArray(b.viggle.batchIds) ? { sessionId: String(b.viggle.sessionId), batchIds: b.viggle.batchIds.map(String) } : null,
        ...(layoutUrl ? { layoutUrl } : {}),
        createdAt: new Date().toISOString(),
      };
      library.scenes.unshift(scene);
      await saveLibrary();
      return json(res, scene);
    }
    if (p === '/api/h3' && m === 'POST') {
      // Multipart, parsed by the platform: the previs video can be tens of megabytes.
      const form = await new Request('http://local/', { method: 'POST', headers: req.headers as Record<string, string>, body: Readable.toWeb(req) as ReadableStream, duplex: 'half' } as RequestInit).formData();
      return json(res, await submitH3(form));
    }
    const gen = /^\/api\/gen\/(scene|character|motion|fill)$/.exec(p);
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
          // Failed mid-response (a model stream cut off): the status has gone, so just end it.
          if (res.headersSent) { res.end(); return; }
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

async function atomicWrite(path: string, text: string | Buffer): Promise<void> {
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
