/**
 * Video → images + poses → 3DGS, the server half.
 *
 *   poses   the Python pipeline (scenegen/py): frame sampling, COLMAP, gravity
 *           and metric normalisation, ≤ 40 views → views.json + images/
 *   upload  JST-2 `posed-images` (PROPOSED endpoint; the mock until it exists)
 *   scene   wait, download scene.spz
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Jst2Client, PosedView } from './jst2.ts';
import { newSessionId } from './jst2.ts';

export interface VideoViews {
  version: 1;
  source: { video: string; durationSec: number; fps: number; size: [number, number] };
  frame: { convention: 'opencv'; worldUp: number[]; units: string; scale: 'floor' | 'assumed'; metersPerUnit: number; floorY?: number };
  stats: Record<string, unknown> & { registered: number; keyframes: number; selected: number; reprojErrorPx: number };
  views: Array<{ index: number; file: string; frameTime: number; width: number; height: number; c2w: number[][]; intrinsic: number[] }>;
  points: string;
}

export interface VideoSceneResult {
  sessionId: string;
  batchIds: string[];
  views: number;
  stats: VideoViews['stats'];
  frame: VideoViews['frame'];
  endpoint: 'mock' | 'live';
  credits: number;
  files: { scene: string; views: string; points: string };
  seconds: Record<string, number>;
}

export type VideoProgress = (stage: string, progress: number, message: string) => void;

export const PY_DIR = new URL('../py/', import.meta.url).pathname;
export const PY_BIN = join(PY_DIR, '.venv/bin/python');

export function videoPipelineAvailable(): boolean {
  return existsSync(PY_BIN);
}

/** Run scenegen/py on a video; resolves with the parsed views.json. Progress lines are JSON. */
export function runPosePipeline(video: string, out: string, opts: { maxViews?: number; square?: number; sessionId?: string; signal?: AbortSignal; onProgress?: VideoProgress } = {}): Promise<VideoViews> {
  return new Promise((resolve, reject) => {
    const args = ['-m', 'videoscene.run', video, '--out', out, '--max-views', String(opts.maxViews ?? 40)];
    if (opts.square) args.push('--square', String(opts.square));
    if (opts.sessionId) args.push('--session-id', opts.sessionId);
    const child = spawn(PY_BIN, args, { cwd: PY_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    opts.signal?.addEventListener('abort', () => child.kill('SIGTERM'));
    let buf = '';
    let err = '';
    let failure: string | null = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const ev = JSON.parse(line) as { stage: string; progress?: number; message?: string };
          if (ev.stage === 'error') failure = ev.message ?? 'The video pipeline failed.';
          else opts.onProgress?.(ev.stage, ev.progress ?? 0, ev.message ?? '');
        } catch { /* not a progress line */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => { err = (err + c).slice(-4000); });
    child.on('error', reject);
    child.on('close', async (code) => {
      if (code !== 0) return reject(new Error(failure ?? `The video pipeline exited with ${code}: ${err.split('\n').filter(Boolean).slice(-3).join(' | ')}`));
      try { resolve(JSON.parse(await readFile(join(out, 'views.json'), 'utf8')) as VideoViews); } catch (e) { reject(e); }
    });
  });
}

export async function videoToScene(video: string, dir: string, deps: {
  jst2: Jst2Client;
  endpoint: 'mock' | 'live';
  /** The mock previews the sparse cloud: tell it where the points are. */
  registerMockPoints?: (sessionId: string, plyPath: string) => void;
  posedBase?: string;
  square?: number;
  signal?: AbortSignal;
  onProgress?: VideoProgress;
}): Promise<VideoSceneResult> {
  const p = deps.onProgress ?? (() => {});
  const seconds: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => { seconds[k] = Math.round((Date.now() - t) / 100) / 10; t = Date.now(); };
  const sessionId = newSessionId('sgv');
  const out = join(dir, 'bundle');
  const v = await runPosePipeline(video, out, { sessionId, square: deps.square, signal: deps.signal, onProgress: p });
  lap('poses');

  p('upload', 0, `Uploading ${v.views.length} images and their cameras to JST-2 (${deps.endpoint === 'mock' ? 'mock endpoint' : 'live'})`);
  const views: PosedView[] = await Promise.all(v.views.map(async (x) => ({
    image: new Uint8Array(await readFile(join(out, x.file))),
    mime: x.file.endsWith('.png') ? 'image/png' as const : 'image/jpeg' as const,
    c2w: x.c2w,
    intrinsic: x.intrinsic,
  })));
  if (deps.endpoint === 'mock') deps.registerMockPoints?.(sessionId, join(out, v.points));
  let task = await deps.jst2.posedImages({ sessionId, views, metersPerUnit: v.frame.metersPerUnit });
  lap('upload');
  p('scene', 0.5, 'JST-2 is reconstructing the scene');
  task = await deps.jst2.wait(task, { base: deps.posedBase, intervalMs: deps.endpoint === 'mock' ? 500 : 3000, signal: deps.signal });
  await writeFile(join(dir, 'scene.spz'), await deps.jst2.download(task.result!.spz.url));
  lap('scene');
  const result: VideoSceneResult = {
    sessionId,
    batchIds: task.result!.outputBatch ? [task.result!.outputBatch.batchId] : [],
    views: v.views.length,
    stats: v.stats,
    frame: v.frame,
    endpoint: deps.endpoint,
    credits: task.credits ?? 0,
    files: { scene: 'scene.spz', views: 'bundle/views.json', points: `bundle/${v.points}` },
    seconds,
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  p('done', 1, `Scene ready from ${v.views.length} views`);
  return result;
}
