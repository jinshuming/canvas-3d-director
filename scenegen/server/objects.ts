/**
 * Key objects as their own 3D assets: for each key object of the blockout, a
 * perspective crop of the panorama looking at it (the blockout says exactly
 * where it is), the blockout's box projected into that crop as the prompt, and
 * SAM 3D (fal) turning the crop into a Gaussian-splat object. Its shape and
 * heading are trusted; size and position come from the blockout (fit.ts).
 */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

import { basis, dot, sub } from '../core/frame.ts';
import type { CameraPose, Vec3 } from '../core/frame.ts';
import { objectBounds } from '../core/geometry.ts';
import { importanceOf } from '../core/capture.ts';
import type { Layout, LayoutObject } from '../core/types.ts';

export interface CropView {
  /** Camera of the crop, from the capture point: yaw (0 north, 90 east), pitch up positive, square FOV. */
  pose: CameraPose;
  fov: number;
  size: number;
  /** The object's projected box in the crop, pixels [x0, y0, x1, y1]. */
  box: [number, number, number, number];
}

/**
 * Which objects become separate 3D assets: the ones the layout marks key, else the most important
 * free-standing ones. Never flat things (rugs, water) or things standing on others; at most `max`.
 */
export function keyObjects(layout: Layout, max = 5): LayoutObject[] {
  const flat = new Set(['rug', 'road', 'water', 'fence']);
  const ok = (o: LayoutObject) => !flat.has(o.type) && !o.on && o.size[1] > 0.25;
  const marked = layout.objects.filter((o) => o.key && ok(o));
  const pool = marked.length ? marked : layout.objects.filter(ok).sort((a, b) => importanceOf(layout, layout.objects.indexOf(b)) - importanceOf(layout, layout.objects.indexOf(a)));
  return pool.slice(0, max);
}

/** Corners of an object's oriented box (world). */
function corners(o: LayoutObject): Vec3[] {
  const [w, h, d] = o.size;
  const c = Math.cos((o.yaw * Math.PI) / 180), s = Math.sin((o.yaw * Math.PI) / 180);
  const out: Vec3[] = [];
  for (const lx of [-w / 2, w / 2]) for (const ly of [0, h]) for (const lz of [-d / 2, d / 2]) {
    out.push([o.position[0] + c * lx + s * lz, o.position[1] + ly, o.position[2] - s * lx + c * lz]);
  }
  return out;
}

/** The crop that frames an object from the capture point, with its box projected in. */
export function cropFor(o: LayoutObject, capture: CameraPose, size = 1024): CropView {
  const b = objectBounds(o);
  const centre: Vec3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const d = sub(centre, capture.position);
  const yaw = (Math.atan2(d[0], -d[2]) * 180) / Math.PI;
  const pitch = (Math.atan2(d[1], Math.hypot(d[0], d[2])) * 180) / Math.PI;
  const pose: CameraPose = { position: capture.position, yaw, pitch };
  const cam = basis(pose);
  // FOV: the box's angular extent from the camera axis, with room around it for context.
  let half = 0;
  for (const p of corners(o)) {
    const v = sub(p, capture.position);
    const z = dot(v, cam.forward);
    if (z <= 0.05) { half = 60; break; }
    half = Math.max(half, Math.atan(Math.abs(dot(v, cam.right)) / z), Math.atan(Math.abs(dot(v, cam.up)) / z));
  }
  const fov = Math.max(30, Math.min(110, ((half * 180) / Math.PI) * 2 * 1.6));
  const f = size / 2 / Math.tan(((fov / 2) * Math.PI) / 180);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of corners(o)) {
    const v = sub(p, capture.position);
    const z = Math.max(0.05, dot(v, cam.forward));
    const x = size / 2 + (f * dot(v, cam.right)) / z, y = size / 2 - (f * dot(v, cam.up)) / z;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  const clampPx = (v: number) => Math.max(0, Math.min(size, Math.round(v)));
  return { pose, fov, size, box: [clampPx(x0), clampPx(y0), clampPx(x1), clampPx(y1)] };
}

/**
 * Cut a perspective view out of the equirect panorama with ffmpeg's v360 filter. The panorama's
 * centre is the capture yaw; v360 turns right for a positive yaw and up for a positive pitch.
 */
export function cropPanorama(pano: string, view: CropView, captureYaw: number, out: string): Promise<void> {
  const rel = ((((view.pose.yaw - captureYaw) % 360) + 540) % 360) - 180;
  const vf = `v360=input=e:output=flat:yaw=${rel.toFixed(3)}:pitch=${(view.pose.pitch ?? 0).toFixed(3)}:h_fov=${view.fov.toFixed(3)}:v_fov=${view.fov.toFixed(3)}:w=${view.size}:h=${view.size}:interp=lanczos`;
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-i', pano, '-vf', vf, '-q:v', '2', out]);
    let err = '';
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg crop failed: ${err.slice(0, 200)}`))));
  });
}

/**
 * Reject after `ms` whatever the promise does. An abort signal is not enough: a request stuck in
 * the proxy's CONNECT ignored one (measured: 16 minutes, then "fetch failed").
 */
export function deadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms); })]).finally(() => clearTimeout(timer));
}

/** Decode an image to raw RGB at `size` × `size` (ffmpeg). */
export function decodeRgb(file: string, size: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${size}:${size}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`ffmpeg decode failed: ${err.slice(0, 200)}`))));
  });
}

/**
 * The box of what was actually painted: where the painted crop differs from the empty one, inside
 * the area the edit could touch. SAM 3D segments only what its box covers, and the painted object
 * does not keep to the blockout's box (measured: a sofa's back and arms rose above it, and SAM 3D
 * returned just the seat cushions). Shadows - a uniform darkening - do not count: with them the
 * box reached the floor under a table and SAM 3D made a slab of it. Falls back to the blockout box
 * when little changed.
 */
export function paintedBox(before: Uint8Array, after: Uint8Array, size: number, box: [number, number, number, number]): { box: [number, number, number, number]; fromPaint: boolean } {
  const [x0, y0, x1, y1] = box;
  const mx = (x1 - x0) * 0.15 + 8, my = (y1 - y0) * 0.15 + 8;
  const ax0 = Math.max(0, Math.floor(x0 - mx)), ax1 = Math.min(size - 1, Math.ceil(x1 + mx));
  const ay0 = Math.max(0, Math.floor(y0 - my)), ay1 = Math.min(size - 1, Math.ceil(y1 + my * 2));
  // Changed pixels: a strong colour difference (contact shadows are mostly weaker).
  const rows = new Uint32Array(size), cols = new Uint32Array(size);
  let n = 0;
  for (let y = ay0; y <= ay1; y++) for (let x = ax0; x <= ax1; x++) {
    const i = (y * size + x) * 3;
    const d = Math.max(Math.abs(after[i]! - before[i]!), Math.abs(after[i + 1]! - before[i + 1]!), Math.abs(after[i + 2]! - before[i + 2]!));
    if (d <= 48) continue;
    // A shadow only darkens what was there, by about the same factor in every channel: not the object.
    const r = [0, 1, 2].map((c) => (after[i + c]! + 4) / (before[i + c]! + 4));
    if (Math.max(...r) < 0.92 && Math.max(...r) - Math.min(...r) < 0.12) continue;
    rows[y]!++; cols[x]!++; n++;
  }
  if (n < 0.2 * (x1 - x0) * (y1 - y0)) return { box, fromPaint: false };
  // Ignore stray rows / columns: keep those with at least 3% of the area's span changed.
  const span = (from: number, to: number, count: Uint32Array, need: number) => {
    let a = -1, b = -1;
    for (let k = from; k <= to; k++) if (count[k]! >= need) { if (a < 0) a = k; b = k; }
    return [a, b] as const;
  };
  const [bx0, bx1] = span(ax0, ax1, cols, Math.max(2, (ay1 - ay0) * 0.03));
  const [by0, by1] = span(ay0, ay1, rows, Math.max(2, (ax1 - ax0) * 0.03));
  if (bx0 < 0 || by0 < 0) return { box, fromPaint: false };
  return { box: [bx0, by0, bx1 + 1, by1 + 1], fromPaint: true };
}

export interface Sam3dResult { ply: Uint8Array; seconds: number; requestId: string }

const SAM3D_URL = 'https://queue.fal.run/fal-ai/sam-3/3d-objects';

/** SAM 3D Objects on fal: a crop and a box in, a Gaussian-splat PLY out (1-4 minutes; queued). */
/**
 * `maxQueueSeconds`: how long a request may wait in fal's queue before it is cancelled (default
 * 150); once it runs it gets `maxSeconds` in all (default 300) - cancelling a running request throws
 * its work away (seen: one cancelled at 150 s while running).
 */
export async function sam3d(image: Uint8Array, box: [number, number, number, number], key: string | undefined, opts: { seed?: number; signal?: AbortSignal; f?: typeof fetch; maxQueueSeconds?: number; maxSeconds?: number } = {}): Promise<Sam3dResult> {
  if (!key) throw new Error('FAL_KEY is not set: SAM 3D cannot run.');
  const f = opts.f ?? ((...a) => globalThis.fetch(...a));
  const t0 = Date.now();
  const H = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };
  // Every request has its own deadline: a connection that stalls (seen once: 33 minutes, then
  // "fetch failed") must fail fast so the retry can run.
  const within = (ms: number) => (opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms));
  const call = async (url: string, body?: unknown) => {
    const t = await deadline((async () => {
      const r = await f(url, { method: body ? 'POST' : 'GET', headers: H, body: body ? JSON.stringify(body) : undefined, signal: within(60_000) });
      const text = await r.text();
      if (!r.ok) throw new Error(`fal ${r.status}: ${text.slice(0, 300)}`);
      return text;
    })(), 60_000, 'fal request');
    return JSON.parse(t) as Record<string, unknown>;
  };
  const sub = await call(SAM3D_URL, {
    image_url: `data:${image[0] === 0x89 && image[1] === 0x50 ? 'image/png' : 'image/jpeg'};base64,${Buffer.from(image).toString('base64')}`,
    box_prompts: [{ x_min: box[0], y_min: box[1], x_max: box[2], y_max: box[3], object_id: 1 }],
    seed: opts.seed ?? 42,
    export_textured_glb: false,
  });
  const status = String(sub.status_url), resultUrl = String(sub.response_url);
  const cancelUrl = typeof sub.cancel_url === 'string' ? sub.cancel_url : null;
  const queueCap = (opts.maxQueueSeconds ?? 150) * 1000, cap = (opts.maxSeconds ?? 300) * 1000;
  for (let misses = 0; ;) {
    opts.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 3000));
    // A status poll that fails is retried; five in a row is a real failure.
    const st = await call(status).catch((e: Error) => { if (++misses >= 5) throw e; return null; });
    if (!st) continue;
    misses = 0;
    if (st.status === 'COMPLETED') break;
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new Error(`SAM 3D ended ${String(st.status)}`);
    const waited = Date.now() - t0;
    if ((st.status === 'IN_QUEUE' && waited > queueCap) || waited > cap) {
      // fal's queue time varies from seconds to minutes (seen: 374 s for one object): give up on this
      // request - cancelled, so it does not run on unseen - and let the caller try again.
      if (cancelUrl) void f(cancelUrl, { method: 'PUT', headers: H, signal: AbortSignal.timeout(10_000) }).catch(() => {});
      throw new Error(st.status === 'IN_QUEUE' ? `SAM 3D still queued after ${Math.round(queueCap / 1000)} s` : `SAM 3D did not finish within ${Math.round(cap / 1000)} s`);
    }
  }
  const res = await call(resultUrl) as { gaussian_splat?: { url: string }; metadata?: unknown[] };
  if (!res.gaussian_splat?.url) throw new Error('SAM 3D found no object in the box.');
  const ply = await deadline((async () => {
    const dl = await f(res.gaussian_splat!.url, { signal: within(180_000) });
    if (!dl.ok) throw new Error(`Downloading the SAM 3D object failed (${dl.status}).`);
    return new Uint8Array(await dl.arrayBuffer());
  })(), 180_000, 'SAM 3D download');
  return { ply, seconds: (Date.now() - t0) / 1000, requestId: String(sub.request_id) };
}

export async function saveJson(path: string, v: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(v, null, 2));
}


/**
 * Which objects become SAM 3D assets - the key objects and what stands on them - and so are left
 * out of the environment's blockout altogether: the environment's panorama is painted without
 * them, so they are never in the room twice and nothing has to be erased. Things on a key object
 * beyond `max` are left out too (they would float where the key object was).
 */
export function planObjects(layout: Layout, max = 8): { assets: LayoutObject[]; remove: Set<number> } {
  const keys = keyObjects(layout, max);
  const assets = [...keys];
  const remove = new Set(keys.map((o) => layout.objects.indexOf(o)));
  // Repeat: something on something on a key object goes too.
  for (let grew = true; grew;) {
    grew = false;
    layout.objects.forEach((o, i) => {
      if (remove.has(i) || !o.on || !assets.some((k) => k.id === o.on)) return;
      remove.add(i);
      if (assets.length < max) assets.push(o);
      grew = true;
    });
  }
  return { assets, remove };
}

/** The layout the environment is painted from: everything but the removed objects. */
export function environmentLayout(layout: Layout, remove: Set<number>): Layout {
  return { ...layout, objects: layout.objects.filter((_, i) => !remove.has(i)) };
}

export interface ObjectAsset {
  id: string;
  label: string;
  /** Files, relative to the output folder. */
  file: string | null;
  crop: string;
  box: [number, number, number, number];
  scale: number | null;
  /** How far SAM 3D's proportions are from the blockout box's (max / min of the per-axis ratios). */
  spread: number | null;
  gaussians: number | null;
  seconds: number | null;
  error: string | null;
  /** Already moved to the environment's scale (composeScene), so a later compose leaves it be. */
  shifted?: boolean;
}

/** Every asset object: crop the object panorama at it, SAM 3D, thin, fit to the blockout, write objects/<id>.spz. */
export async function generateObjects(layout: Layout, assets: LayoutObject[], panoPath: string, dir: string, deps: {
  sam3d: (image: Uint8Array, box: [number, number, number, number]) => Promise<{ ply: Uint8Array; seconds: number }>;
  /** When the panorama does not show the objects (the environment's): paint each into its own crop, guided by `guidePano` (the full blockout's clay render). */
  /** Objects whose crop was painted before (retrying a failed SAM 3D): their crop and box, no painting. */
  reuse?: Map<string, { crop: string; box: [number, number, number, number] }>;
  paint?: { guidePano: string; style?: string; run: (input: { image: Uint8Array; guide: Uint8Array; size: number; box: [number, number, number, number]; label: string; style?: string }) => Promise<Uint8Array> };
  maxGaussians?: number;
  onProgress?: (message: string) => void;
}): Promise<ObjectAsset[]> {
  const { mkdir, readFile, writeFile: wf } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { readPlyGaussians, thinGaussians, writeSpzGaussians } = await import('../core/gaussians.ts');
  const { fitToBlockout } = await import('../core/fit.ts');
  const capture = layout.capture!;
  await mkdir(join(dir, 'objects'), { recursive: true });
  let done = 0;
  return Promise.all(assets.map(async (o): Promise<ObjectAsset> => {
    const view = cropFor(o, capture);
    const crop = `objects/${o.id}-crop.${deps.paint ? 'png' : 'jpg'}`;
    let base = { id: o.id, label: o.label, crop, box: view.box };
    try {
      const prev = deps.reuse?.get(o.id);
      if (prev) {
        base = { ...base, crop: prev.crop, box: prev.box };
      } else if (deps.paint) {
        const envCrop = join(dir, `objects/${o.id}-env.jpg`), guideCrop = join(dir, `objects/${o.id}-guide.jpg`);
        await Promise.all([cropPanorama(panoPath, view, capture.yaw, envCrop), cropPanorama(deps.paint.guidePano, view, capture.yaw, guideCrop)]);
        const painted = await deps.paint.run({ image: new Uint8Array(await readFile(envCrop)), guide: new Uint8Array(await readFile(guideCrop)), size: view.size, box: view.box, label: o.label, style: deps.paint.style });
        await wf(join(dir, crop), painted);
        // Prompt SAM 3D with the box of what was painted, not the blockout's (see paintedBox).
        const [before, after] = await Promise.all([decodeRgb(envCrop, view.size), decodeRgb(join(dir, crop), view.size)]);
        base = { ...base, box: paintedBox(before, after, view.size, view.box).box };
      } else await cropPanorama(panoPath, view, capture.yaw, join(dir, crop));
      // One retry: SAM 3D on fal fails now and then on the network, rarely twice.
      const image = new Uint8Array(await readFile(join(dir, base.crop)));
      const r = await deps.sam3d(image, base.box).catch((e: Error) => { deps.onProgress?.(`${o.label}: SAM 3D failed (${e.message}), retrying`); return deps.sam3d(image, base.box); });
      // Every Gaussian SAM 3D gives (~0.5M, a few MB as .spz); the cap only guards against a runaway.
      const g = thinGaussians(readPlyGaussians(r.ply), deps.maxGaussians ?? 1_000_000);
      const fit = fitToBlockout(g, o, view.pose, capture.position);
      const file = `objects/${o.id}.spz`;
      await wf(join(dir, file), writeSpzGaussians(g));
      deps.onProgress?.(`${++done}/${assets.length} objects: ${o.label} (${r.seconds.toFixed(0)} s)`);
      return { ...base, file, scale: fit.scale, spread: fit.spread, gaussians: g.count, seconds: r.seconds, error: null };
    } catch (e) {
      deps.onProgress?.(`${++done}/${assets.length} objects: ${o.label} failed - ${(e as Error).message}`);
      return { ...base, file: null, scale: null, spread: null, gaussians: null, seconds: null, error: (e as Error).message };
    }
  }));
}
