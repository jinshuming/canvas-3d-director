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

export interface Sam3dResult { ply: Uint8Array; seconds: number; requestId: string }

const SAM3D_URL = 'https://queue.fal.run/fal-ai/sam-3/3d-objects';

/** SAM 3D Objects on fal: a crop and a box in, a Gaussian-splat PLY out (1-4 minutes; queued). */
export async function sam3d(image: Uint8Array, box: [number, number, number, number], key: string | undefined, opts: { seed?: number; signal?: AbortSignal; f?: typeof fetch } = {}): Promise<Sam3dResult> {
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
  for (let misses = 0; ;) {
    opts.signal?.throwIfAborted();
    await new Promise((r) => setTimeout(r, 3000));
    // A status poll that fails is retried; five in a row is a real failure.
    const st = await call(status).catch((e: Error) => { if (++misses >= 5) throw e; return null; });
    if (!st) continue;
    misses = 0;
    if (st.status === 'COMPLETED') break;
    if (st.status !== 'IN_QUEUE' && st.status !== 'IN_PROGRESS') throw new Error(`SAM 3D ended ${String(st.status)}`);
    if (Date.now() - t0 > 12 * 60_000) throw new Error('SAM 3D did not finish within 12 minutes.');
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
}

/** Every asset object: crop the object panorama at it, SAM 3D, thin, fit to the blockout, write objects/<id>.spz. */
export async function generateObjects(layout: Layout, assets: LayoutObject[], panoPath: string, dir: string, deps: {
  sam3d: (image: Uint8Array, box: [number, number, number, number]) => Promise<{ ply: Uint8Array; seconds: number }>;
  /** When the panorama does not show the objects (the environment's): paint each into its own crop, guided by `guidePano` (the full blockout's clay render). */
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
    const base = { id: o.id, label: o.label, crop, box: view.box };
    try {
      if (deps.paint) {
        const envCrop = join(dir, `objects/${o.id}-env.jpg`), guideCrop = join(dir, `objects/${o.id}-guide.jpg`);
        await Promise.all([cropPanorama(panoPath, view, capture.yaw, envCrop), cropPanorama(deps.paint.guidePano, view, capture.yaw, guideCrop)]);
        const painted = await deps.paint.run({ image: new Uint8Array(await readFile(envCrop)), guide: new Uint8Array(await readFile(guideCrop)), size: view.size, box: view.box, label: o.label, style: deps.paint.style });
        await wf(join(dir, crop), painted);
      } else await cropPanorama(panoPath, view, capture.yaw, join(dir, crop));
      // One retry: SAM 3D on fal fails now and then on the network, rarely twice.
      const image = new Uint8Array(await readFile(join(dir, crop)));
      const r = await deps.sam3d(image, view.box).catch((e: Error) => { deps.onProgress?.(`${o.label}: SAM 3D failed (${e.message}), retrying`); return deps.sam3d(image, view.box); });
      const g = thinGaussians(readPlyGaussians(r.ply), deps.maxGaussians ?? 150_000);
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
