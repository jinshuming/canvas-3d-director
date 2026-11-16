/**
 * Video → 3DGS with the scene endpoints that exist today (no image upload with poses yet):
 *
 *   anchor     the point on the walk where the video looked around the most; the frames taken
 *              near it (COLMAP poses) are stitched into a 360° panorama - real pixels where the
 *              video looked, nothing elsewhere
 *   complete   GPT-image-2 paints only what the video never saw from there (strict composite)
 *   scene      JST-2 custom-pano at the anchor at 1 unit = 1, scaled to metres from the anchor's height
 *   path       JST-2 generate at the video's own cameras further along the walk (position, yaw,
 *              pitch, field of view from COLMAP), each view from every batch so far
 *   rebuild    JST-2 reconstruct from all of them, then the usual gap check and fill
 *   verify     the scene against COLMAP's points: how far its surfaces are from where the video
 *              measured them
 *
 * Away from the anchor the views are GENERATED, guided by the scene so far, not the video's
 * frames: the video decides where they are, not what they show. A posed-images endpoint (see
 * videoScene.ts) would replace all of this with the real frames.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { basis, c2wToPose, DEG, dirToEquirect, equirectDir, toServiceC2W } from '../core/frame.ts';
import type { CameraPose, Mat4, Vec3 } from '../core/frame.ts';
import { scaleSpz } from '../core/gaussians.ts';
import { readSpz } from '../core/spz.ts';
import type { SpzPoints } from '../core/spz.ts';
import { readPointsPly } from '../core/spzwrite.ts';
import { autoFill, metersPerUnitFromFloor, sessionPose } from './fill.ts';
import type { FillResult } from './fill.ts';
import { newSessionId } from './jst2.ts';
import type { Jst2Client, SceneTask } from './jst2.ts';
import { openaiImageEdit, resizeImage } from './pano.ts';
import { encodePng } from './png.ts';
import type { VideoProgress, VideoSceneResult, VideoViews } from './videoScene.ts';
import { runPosePipeline } from './videoScene.ts';

/** A video camera in OUR world (metres, Y up, floor y = 0). */
export interface VideoCam {
  index: number;
  file: string;
  /** Columns right, down, forward, position (the poseToC2W layout), in our world. */
  c2w: Mat4;
  pose: CameraPose;
  /** Normalised intrinsics: fx / width, fy / height, cx / width, cy / height. */
  k: [number, number, number, number];
  hfov: number;
  vfov: number;
}

/**
 * The pose pipeline's frame is OpenCV-style (Y down, the floor at y = floorY). Ours is Y up with
 * the floor at 0: turn 180° about X (y, z negated - a rotation, so handedness is kept) and lift.
 */
const liftOf = (v: VideoViews) => v.frame.floorY ?? 1.5;

export function camerasFromViews(v: VideoViews): VideoCam[] {
  const lift = liftOf(v);
  return v.views.map((x) => {
    const m = x.c2w;
    const c2w: Mat4 = [
      [m[0]![0]!, m[0]![1]!, m[0]![2]!, m[0]![3]!],
      [-m[1]![0]!, -m[1]![1]!, -m[1]![2]!, -m[1]![3]! + lift],
      [-m[2]![0]!, -m[2]![1]!, -m[2]![2]!, -m[2]![3]!],
      [0, 0, 0, 1],
    ];
    const [fx, fy, cx, cy] = x.intrinsic as [number, number, number, number];
    return {
      index: x.index, file: x.file, c2w, pose: c2wToPose(c2w), k: [fx, fy, cx, cy],
      hfov: (2 * Math.atan(0.5 / fx)) / DEG, vfov: (2 * Math.atan(0.5 / fy)) / DEG,
    };
  });
}

const horiz = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** The camera with the most of the circle seen by the frames within `radius` of it (20° bins). */
export function chooseAnchor(cams: VideoCam[], radius = 0.6): { anchor: VideoCam; near: VideoCam[]; coverage: number } {
  let best: { anchor: VideoCam; near: VideoCam[]; coverage: number } | null = null;
  for (const a of cams) {
    const near = cams.filter((c) => horiz(c.pose.position, a.pose.position) <= radius);
    const bins = new Set<number>();
    for (const c of near) for (let d = -c.hfov / 2; d <= c.hfov / 2; d += 5) bins.add(Math.floor((((c.pose.yaw + d) % 360) + 360) % 360 / 20));
    const coverage = bins.size / 18;
    if (!best || coverage > best.coverage || (coverage === best.coverage && near.length > best.near.length)) best = { anchor: a, near, coverage };
  }
  return best!;
}

/** Decode any image to raw RGB at w × h (ffmpeg). */
function decodeRgbBytes(bytes: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (c: Buffer) => chunks.push(c));
    p.stderr.on('data', (c: Buffer) => { err += c.toString(); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(new Uint8Array(Buffer.concat(chunks))) : reject(new Error(`ffmpeg decode failed: ${err.slice(0, 200)}`))));
    p.stdin.on('error', () => {});
    p.stdin.end(Buffer.from(bytes));
  });
}

/**
 * Stitch the frames near the anchor into an equirect panorama at the anchor, level, facing the
 * anchor's heading. Translation between the frames is ignored (they are within ~0.6 m), each
 * pixel blends the frames that see it, favouring their centres. `weight` > 0 where seen.
 */
async function stitchPanorama(cams: VideoCam[], pose: CameraPose, bundle: string, W = 2048, H = 1024): Promise<{ rgb: Uint8Array; weight: Float32Array }> {
  const fw = 960, fh = 540;
  const frames = await Promise.all(cams.map(async (c) => decodeRgbBytes(new Uint8Array(await readFile(join(bundle, c.file))), fw, fh)));
  const b = basis(pose);
  const acc = new Float32Array(W * H * 3), weight = new Float32Array(W * H);
  const near = cams.map((c) => Math.exp(-(Math.hypot(c.pose.position[0] - pose.position[0], c.pose.position[2] - pose.position[2]) / 0.15)));
  const cols = cams.map((c) => ({ r: [c.c2w[0]![0]!, c.c2w[1]![0]!, c.c2w[2]![0]!], d: [c.c2w[0]![1]!, c.c2w[1]![1]!, c.c2w[2]![1]!], f: [c.c2w[0]![2]!, c.c2w[1]![2]!, c.c2w[2]![2]!] }));
  for (let v = 0; v < H; v++) for (let u = 0; u < W; u++) {
    const dir = equirectDir(u, v, W, H, b);
    const i = v * W + u;
    for (let k = 0; k < cams.length; k++) {
      const c = cols[k]!, z = dir[0] * c.f[0]! + dir[1] * c.f[1]! + dir[2] * c.f[2]!;
      if (z <= 0.05) continue;
      const [fx, fy, cx, cy] = cams[k]!.k;
      const nx = cx + (fx * (dir[0] * c.r[0]! + dir[1] * c.r[1]! + dir[2] * c.r[2]!)) / z;
      const ny = cy + (fy * (dir[0] * c.d[0]! + dir[1] * c.d[1]! + dir[2] * c.d[2]!)) / z;
      if (nx < 0.01 || nx > 0.99 || ny < 0.01 || ny > 0.99) continue;
      // Mostly ONE frame per pixel - the nearest to the anchor, seeing it nearest its centre - with a
      // short blend between frames: averaging all of them ghosts anything the walk moved past
      // (measured: a doubled sofa).
      const e = Math.max(Math.abs(nx * 2 - 1), Math.abs(ny * 2 - 1));
      const w = (1 - e) ** 8 * near[k]!;
      const px = nx * fw - 0.5, py = ny * fh - 0.5;
      const x0 = Math.max(0, Math.min(fw - 2, Math.floor(px))), y0 = Math.max(0, Math.min(fh - 2, Math.floor(py)));
      const ax = px - x0, ay = py - y0, img = frames[k]!;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = img[(y0 * fw + x0) * 3 + ch]!, p10 = img[(y0 * fw + x0 + 1) * 3 + ch]!;
        const p01 = img[((y0 + 1) * fw + x0) * 3 + ch]!, p11 = img[((y0 + 1) * fw + x0 + 1) * 3 + ch]!;
        acc[i * 3 + ch] += w * ((p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay);
      }
      weight[i] += w;
    }
  }
  const rgb = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) if (weight[i]! > 0) for (let ch = 0; ch < 3; ch++) rgb[i * 3 + ch] = Math.round(acc[i * 3 + ch]! / weight[i]!);
  return { rgb, weight };
}

/** Roll an RGB (or 1-channel) image `shift` columns to the left. */
function roll<T extends Uint8Array | Float32Array>(img: T, w: number, h: number, ch: number, shift: number): T {
  const out = new (img.constructor as new (n: number) => T)(img.length);
  const s = ((shift % w) + w) % w;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) out[(y * w + x) * ch + c] = img[(y * w + ((x + s) % w)) * ch + c]!;
  return out;
}

/**
 * Paint what the video never saw. The panorama is turned half way round first, so the unseen
 * part (behind the anchor) is one piece in the middle, not split by the seam; the model's pixels
 * are kept only where nothing was seen (feathered), the video's everywhere else.
 */
async function completePanorama(cfg: { apiKey?: string; base?: string; model?: string }, input: { rgb: Uint8Array; weight: Float32Array; W: number; H: number; signal?: AbortSignal }): Promise<Uint8Array> {
  if (!cfg.apiKey) throw new Error('OPENAI_API_KEY is not set.');
  const { W, H } = input;
  const half = W / 2;
  const rgb = roll(input.rgb, W, H, 3, half), weight = roll(input.weight, W, H, 1, half);
  // Seen = some real weight; the mask is transparent where nothing was, grown 6 px into the seen
  // edge so the model blends across it.
  const seen = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) seen[i] = weight[i]! > 0 ? 1 : 0;
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let edge = false;
    for (let d = -6; d <= 6 && !edge; d += 3) edge = !seen[y * W + ((x + d + W) % W)] || !seen[Math.max(0, Math.min(H - 1, y + d)) * W + x];
    const i = y * W + x;
    rgba[i * 4] = rgb[i * 3]!; rgba[i * 4 + 1] = rgb[i * 3 + 1]!; rgba[i * 4 + 2] = rgb[i * 3 + 2]!;
    rgba[i * 4 + 3] = seen[i] && !edge ? 255 : 0;
  }
  const [image, mask] = await Promise.all([resizeImage(encodePng(rgb, W, H), 1536, 1024, 'png'), resizeImage(encodePng(rgba, W, H, 4), 1536, 1024, 'png')]);
  const form = new FormData();
  form.append('model', cfg.model ?? 'gpt-image-2');
  form.append('size', '1536x1024');
  form.append('n', '1');
  form.append('prompt', [
    'This is a 360° equirectangular panorama (horizontally squeezed) of a real place, photographed from one point. The opaque part is real photographs.',
    'Fill the transparent area so the panorama is complete and seamless: the same place continuing - its walls, floor, ceiling or sky, doors and windows, furniture - in the same materials, light, colour and perspective, joining the photographed edges exactly. Equirectangular geometry: straight vertical lines stay vertical, the horizon is the middle row.',
    'Keep the opaque part exactly as it is. No people, no text, no watermark.',
  ].join('\n'));
  form.append('image', new Blob([image as BlobPart], { type: 'image/png' }), 'panorama.png');
  form.append('mask', new Blob([mask as BlobPart], { type: 'image/png' }), 'mask.png');
  const painted = await decodeRgbBytes(await openaiImageEdit(cfg, form, 'OpenAI image edit', input.signal), W, H);
  // Composite: the video's pixels where seen (feathered over ~12 px), the model's elsewhere; then turn back.
  const a = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) a[i] = seen[i]!;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0; for (let d = -6; d <= 6; d++) s += a[y * W + ((x + d + W) % W)]!; tmp[y * W + x] = s / 13; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let d = -6; d <= 6; d++) { const yy = y + d; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]!; n++; } } a[y * W + x] = s / n; }
  }
  const out = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const k = seen[i] ? a[i]! : 0;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(rgb[i * 3 + c]! * k + painted[i * 3 + c]! * (1 - k));
  }
  return encodePng(roll(out, W, H, 3, -half), W, H);
}

/** Cameras along the walk to generate from: at least `spacing` from the anchor and from each other. */
export function pathTargets(cams: VideoCam[], anchor: VideoCam, max = 6, spacing = 0.7): VideoCam[] {
  const picked: VideoCam[] = [];
  for (const c of cams) {
    if (picked.length >= max) break;
    if (horiz(c.pose.position, anchor.pose.position) < spacing) continue;
    if (picked.some((p) => horiz(p.pose.position, c.pose.position) < spacing)) continue;
    picked.push(c);
  }
  return picked;
}

/**
 * How well the scene follows what the video measured: for each COLMAP point (file frame), the
 * scene's near surface in that direction from the anchor, against the point's distance.
 */
function compareWithPoints(scene: SpzPoints, points: Float32Array, W = 256, H = 128): { points: number; within25: number; medianLogError: number } {
  const b = basis({ position: [0, 0, 0], yaw: 0 });
  const buckets: number[][] = Array.from({ length: W * H }, () => []);
  for (let i = 0; i < scene.count; i++) {
    if (scene.alphas[i]! < 0.35) continue;
    const d: Vec3 = [scene.positions[i * 3]!, scene.positions[i * 3 + 1]!, scene.positions[i * 3 + 2]!];
    const r = Math.hypot(...d);
    if (r < 0.1 || r > 100) continue;
    const [u, v] = dirToEquirect([d[0] / r, d[1] / r, d[2] / r], W, H, b);
    const k = Math.max(0, Math.min(H - 1, Math.round(v))) * W + (((Math.round(u) % W) + W) % W);
    if (buckets[k]!.length < 64) buckets[k]!.push(r);
  }
  const near = buckets.map((bk) => (bk.length >= 4 ? bk.sort((x, y) => x - y)[Math.floor(bk.length * 0.1)]! : NaN));
  const errs: number[] = [];
  for (let i = 0; i < points.length / 3; i++) {
    const d: Vec3 = [points[i * 3]!, points[i * 3 + 1]!, points[i * 3 + 2]!];
    const r = Math.hypot(...d);
    if (r < 0.3 || r > 30) continue;
    const [u, v] = dirToEquirect([d[0] / r, d[1] / r, d[2] / r], W, H, b);
    const s = near[Math.max(0, Math.min(H - 1, Math.round(v))) * W + (((Math.round(u) % W) + W) % W)]!;
    if (!Number.isFinite(s)) continue;
    errs.push(Math.abs(Math.log(s / r)));
  }
  errs.sort((x, y) => x - y);
  return { points: errs.length, within25: errs.length ? errs.filter((e) => e < Math.log(1.25)).length / errs.length : 0, medianLogError: errs.length ? errs[Math.floor(errs.length / 2)]! : NaN };
}

export interface VideoGenResult {
  sessionId: string;
  anchor: { index: number; file: string; frames: number; coverage: number; position: Vec3; yaw: number };
  metersPerUnit: number;
  /** The JST-2 session is at 1 unit = 1. Missing on older scenes. */
  sessionInUnits?: boolean;
  pathViews: Array<{ index: number; file: string; position: Vec3; yaw: number; pitch: number; fov: number; batchId: string; image: string | null }>;
  batchIds: string[];
  fill: FillResult | null;
  verify: { points: number; within25: number; medianLogError: number };
  credits: number;
  files: { stitched: string; panorama: string; initial: string; scene: string };
  seconds: Record<string, number>;
}

/** Gap-fill views after the rebuild. */
const MAX_FILLS = 2;

/** The whole route from a pose bundle (views.json + images + points.ply). */
async function videoGenerateScene(bundle: string, dir: string, deps: {
  jst2: Jst2Client;
  openai: { apiKey?: string; base?: string; model?: string };
  maxViews?: number;
  signal?: AbortSignal;
  onProgress?: (stage: string, message: string) => void;
}): Promise<VideoGenResult> {
  const p = deps.onProgress ?? (() => {});
  const seconds: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => { seconds[k] = Math.round((Date.now() - t) / 100) / 10; t = Date.now(); };
  let credits = 0;
  await mkdir(join(dir, 'views'), { recursive: true });
  // Submit and wait, once more on PROCESSING_FAILED (the service says it is retryable; seen on a
  // custom-pano that went through on the second try).
  const run = async (submit: () => Promise<SceneTask>) => {
    try { return await deps.jst2.wait(await submit(), { signal: deps.signal }); } catch (e) {
      if ((e as { code?: string }).code !== 'PROCESSING_FAILED') throw e;
      p('retry', `JST-2 failed (${(e as Error).message}), trying once more`);
      return deps.jst2.wait(await submit(), { signal: deps.signal });
    }
  };
  const v = JSON.parse(await readFile(join(bundle, 'views.json'), 'utf8')) as VideoViews;
  const cams = camerasFromViews(v);

  // 1. Anchor and the real panorama there.
  const { anchor, near, coverage } = chooseAnchor(cams);
  const apose: CameraPose = { position: anchor.pose.position, yaw: anchor.pose.yaw };
  p('stitch', `Anchor: frame ${anchor.index}, ${near.length} frames within 0.6 m seeing ${Math.round(coverage * 100)}% of the circle`);
  const W = 2048, H = 1024;
  const st = await stitchPanorama(near, apose, bundle, W, H);
  await writeFile(join(dir, 'anchor-stitched.png'), encodePng(st.rgb, W, H));
  lap('stitch');

  // 2. Paint the rest.
  p('complete', 'Painting what the video never saw from the anchor');
  const pano = await completePanorama(deps.openai, { rgb: st.rgb, weight: st.weight, W, H, signal: deps.signal });
  await writeFile(join(dir, 'panorama.png'), pano);
  lap('complete');

  // 3. The scene at the anchor. The file frame: anchor at the origin, metres, Y up. One build at
  // 1 unit = 1, measured on itself (the anchor camera's height above the floor), scaled into metres
  // here; the session stays in units (poses go out divided by the scale).
  const sessionId = newSessionId('sgvg');
  const filePose: CameraPose = { position: [0, 0, 0], yaw: apose.yaw };
  p('scene', 'Building the scene at the anchor');
  const first = await run(() => deps.jst2.customPano({ sessionId, panorama: pano, mime: 'image/png', c2w: toServiceC2W(filePose), metersPerUnit: 1 }));
  credits += first.credits ?? 0;
  const built = await deps.jst2.download(first.result!.spz.url);
  const metersPerUnit = metersPerUnitFromFloor(built, anchor.pose.position[1]);
  if (metersPerUnit === null) throw new Error('Could not find the floor under the anchor in the scene.');
  p('scale', `1 unit = ${metersPerUnit} m`);
  await writeFile(join(dir, 'initial.spz'), scaleSpz(built, metersPerUnit));
  const batchIds = [first.result!.outputBatch!.batchId];
  lap('scene');

  // 4. The video's own cameras further along the walk.
  const targets = pathTargets(cams, anchor, deps.maxViews ?? 6);
  const views: VideoGenResult['pathViews'] = [];
  const rel = (q: Vec3): Vec3 => [q[0] - anchor.pose.position[0], q[1] - anchor.pose.position[1], q[2] - anchor.pose.position[2]];
  for (const [i, c] of targets.entries()) {
    deps.signal?.throwIfAborted();
    const pose: CameraPose = { position: rel(c.pose.position), yaw: c.pose.yaw, pitch: c.pose.pitch ?? 0 };
    const fov = Math.round(Math.max(20, Math.min(140, c.hfov)));
    p('path', `View ${i + 1}/${targets.length}: frame ${c.index}, ${pose.position.map((x) => x.toFixed(1)).join(', ')} m, facing ${Math.round(c.pose.yaw)}°`);
    const g = await run(() => deps.jst2.generate({ sessionId, referenceBatchIds: batchIds, targetC2w: toServiceC2W(sessionPose(pose, metersPerUnit)), projection: 'perspective', fov }));
    credits += g.credits ?? 0;
    const batch = g.result!.outputBatch!;
    batchIds.push(batch.batchId);
    let image: string | null = null;
    const url = batch.views?.[0]?.url;
    if (url) { image = `views/gen-${c.index}.jpg`; await writeFile(join(dir, image), await deps.jst2.download(url)); }
    views.push({ index: c.index, file: c.file, position: pose.position, yaw: pose.yaw, pitch: pose.pitch ?? 0, fov, batchId: batch.batchId, image });
  }
  lap('path');

  // 5. Rebuild from everything, then the gap check.
  let spz: Uint8Array = new Uint8Array(await readFile(join(dir, 'initial.spz')));
  if (views.length) {
    p('rebuild', `Rebuilding from ${batchIds.length} batches`);
    const r = await run(() => deps.jst2.reconstruct({ sessionId, referenceBatchIds: batchIds }));
    credits += r.credits ?? 0;
    spz = new Uint8Array(scaleSpz(await deps.jst2.download(r.result!.spz.url), metersPerUnit));
  }
  lap('rebuild');
  p('fill', 'Looking for gaps');
  const f = await autoFill(spz, dir, { jst2: deps.jst2, sessionId, batchIds, capture: [0, 0, 0], maxFills: MAX_FILLS, unit: metersPerUnit, signal: deps.signal, onProgress: (m) => p('fill', m) });
  const fill: FillResult = f.result;
  credits += f.result.credits;
  spz = new Uint8Array(f.spz);
  await writeFile(join(dir, 'scene.spz'), spz);
  lap('fill');

  // 6. Against what the video measured: COLMAP's points, in the file frame.
  const raw = readPointsPly(new Uint8Array(await readFile(join(bundle, v.points))));
  const lift = liftOf(v);
  const pts = new Float32Array(raw.positions.length);
  for (let i = 0; i < raw.positions.length / 3; i++) {
    pts[i * 3] = raw.positions[i * 3]! - anchor.pose.position[0];
    pts[i * 3 + 1] = -raw.positions[i * 3 + 1]! + lift - anchor.pose.position[1];
    pts[i * 3 + 2] = -raw.positions[i * 3 + 2]! - anchor.pose.position[2];
  }
  const verify = compareWithPoints(readSpz(spz), pts);
  lap('verify');

  const result: VideoGenResult = {
    sessionId,
    anchor: { index: anchor.index, file: anchor.file, frames: near.length, coverage, position: anchor.pose.position, yaw: anchor.pose.yaw },
    metersPerUnit, sessionInUnits: true, pathViews: views, batchIds, fill, verify, credits,
    files: { stitched: 'anchor-stitched.png', panorama: 'panorama.png', initial: 'initial.spz', scene: 'scene.spz' },
    seconds,
  };
  p('done', `Scene ready: ${views.length} views along the walk, ${Math.round(verify.within25 * 100)}% of the video's points within 25%`);
  return result;
}

/** What the video page reads: the posed-images result's fields, plus this route's own. */
export type VideoGenSceneResult = VideoGenResult & Pick<VideoSceneResult, 'stats' | 'frame'> & { mode: 'generate'; endpoint: 'generate'; views: number; files: VideoGenResult['files'] & { views: string; points: string } };

/** Video file → poses (reused when the bundle is already there and `reusePoses`) → the generate route. */
export async function videoToSceneByGenerate(video: string, dir: string, deps: Parameters<typeof videoGenerateScene>[2] & { reusePoses?: boolean; square?: number; onPoseProgress?: VideoProgress }): Promise<VideoGenSceneResult> {
  const bundle = join(dir, 'bundle');
  const v: VideoViews = deps.reusePoses && existsSync(join(bundle, 'views.json'))
    ? JSON.parse(await readFile(join(bundle, 'views.json'), 'utf8')) as VideoViews
    : await runPosePipeline(video, bundle, { square: deps.square, signal: deps.signal, onProgress: deps.onPoseProgress });
  const r = await videoGenerateScene(bundle, dir, deps);
  const out: VideoGenSceneResult = {
    ...r, mode: 'generate', endpoint: 'generate', views: 6 + r.pathViews.length, stats: v.stats, frame: v.frame,
    files: { ...r.files, views: 'bundle/views.json', points: `bundle/${v.points}` },
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(out, null, 2));
  return out;
}
