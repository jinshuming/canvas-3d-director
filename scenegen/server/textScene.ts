/**
 * Text → blockout → 3DGS, the server half: from a finished layout to a JST-2
 * scene that sits in the layout's own world (metres, Y up, floor at 0).
 *
 *   conditions  capture point (searched if the layout has none) + equirect depth / semantic / clay renders
 *   pano        a provider paints the panorama from them
 *   scale       metres per JST-2 unit: from the provider's own reconstruction, else a calibration custom-pano
 *   scene       custom-pano at the capture pose with that scale → scene.spz in our world
 *   verify      floor height and depth agreement with the blockout
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { measureAlignment } from '../core/align.ts';
import type { Alignment } from '../core/align.ts';
import { compileCaption } from '../core/caption.ts';
import { findCapturePoint } from '../core/capture.ts';
import { toServiceC2W } from '../core/frame.ts';
import type { CameraPose } from '../core/frame.ts';
import { buildScene } from '../core/geometry.ts';
import { depthImage, depthRange, renderEquirect, semanticImage, shadedImage } from '../core/render.ts';
import { distanceToFloor, readSpz } from '../core/spz.ts';
import type { Layout } from '../core/types.ts';
import { EYE_HEIGHT } from '../core/types.ts';
import { autoFill } from './fill.ts';
import type { FillResult } from './fill.ts';
import { Jst2Client, newSessionId } from './jst2.ts';
import type { PanoProvider } from './pano.ts';
import { encodePng } from './png.ts';

export interface TextSceneResult {
  capture: CameraPose;
  prompt: string;
  provider: string;
  depthRange: { zMin: number; zMax: number };
  metersPerUnit: number;
  scaleSource: 'provider-reconstruction' | 'calibration';
  sessionId: string;
  batchIds: string[];
  credits: number;
  alignment: Alignment;
  /** The automatic gap fill (null when switched off). */
  fill: FillResult | null;
  files: { depth: string; semantic: string; shaded: string; panorama: string; scene: string; layout: string };
  legend: Array<{ cls: string; color: [number, number, number]; share: number }>;
  seconds: Record<string, number>;
}

export type Progress = (stage: 'conditions' | 'pano' | 'scale' | 'scene' | 'fill' | 'verify' | 'done', message: string) => void;

const W = 2048, H = 1024;

/** Step 1, also used on its own by the page to preview the conditions. */
export async function renderConditions(layout: Layout, dir: string) {
  await mkdir(dir, { recursive: true });
  const capture = layout.capture ?? (() => { const c = findCapturePoint(layout); return { position: c.best.position, yaw: c.best.yaw }; })();
  const r = renderEquirect(buildScene(layout), capture, W, H);
  const range = depthRange(r);
  const sem = semanticImage(r);
  const depth = encodePng(depthImage(r, range.zMin, range.zMax), W, H);
  const semantic = encodePng(sem.rgb, W, H);
  const shaded = encodePng(shadedImage(r), W, H);
  await Promise.all([
    writeFile(join(dir, 'depth.png'), depth),
    writeFile(join(dir, 'semantic.png'), semantic),
    writeFile(join(dir, 'shaded.png'), shaded),
  ]);
  return { capture, buffers: r, range, legend: sem.legend, depth, semantic, shaded };
}

export async function textToScene(layout: Layout, dir: string, deps: { jst2: Jst2Client; provider: PanoProvider; prompt?: string; styleImage?: { bytes: Uint8Array; mime: string }; maxFills?: number; signal?: AbortSignal; onProgress?: Progress }): Promise<TextSceneResult> {
  const p = deps.onProgress ?? (() => {});
  const seconds: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => { seconds[k] = Math.round((Date.now() - t) / 100) / 10; t = Date.now(); };
  let credits = 0;

  p('conditions', 'Finding the capture point and rendering the blockout');
  const c = await renderConditions(layout, dir);
  const prompt = deps.prompt ?? compileCaption(layout, c.capture);
  // THE SCENE FILE'S FRAME: the capture point at the origin, metres, +Y up (the floor at y = -1.5) -
  // what the director assumes of every generated scene (its placement, gap check and fill measure from
  // the file's origin). The blockout is the same frame shifted by the capture point; the layout file says so.
  const filePose: CameraPose = { position: [0, 0, 0], yaw: c.capture.yaw };
  const origin = c.capture.position;
  await writeFile(join(dir, 'layout.json'), JSON.stringify({ ...layout, capture: c.capture, sceneFrame: { origin, note: 'The .spz origin is the capture point `origin` of this layout (metres, +Y up). A layout point p is at p - origin in the file; in the director (which puts the capture point at x = z = 0, floor y = 0) it is at [p.x - origin.x, p.y, p.z - origin.z].' } }, null, 2));
  await writeFile(join(dir, 'prompt.txt'), prompt);
  lap('conditions');

  p('pano', `Painting the panorama (${deps.provider.label})`);
  const pano = await deps.provider.generate({ prompt, depth: c.depth, semantic: c.semantic, shaded: c.shaded, styleImage: deps.styleImage, signal: deps.signal, onProgress: (m) => p('pano', m) });
  credits += pano.credits ?? 0;
  const panoName = pano.mime === 'image/png' ? 'panorama.png' : 'panorama.jpg';
  await writeFile(join(dir, panoName), pano.bytes);
  lap('pano');

  p('scale', 'Measuring how big a JST-2 unit is');
  let unitsToFloor: number | null = null;
  let scaleSource: TextSceneResult['scaleSource'] = 'provider-reconstruction';
  if (pano.probeSpz) {
    // The provider's own scene: origin at the capture point, Y up (SPZ v4).
    unitsToFloor = distanceToFloor(readSpz(pano.probeSpz), [0, 0, 0], [0, -1, 0], { radius: 0.08, maxDistance: 10 });
  }
  if (unitsToFloor === null) {
    scaleSource = 'calibration';
    const cal = await deps.jst2.customPano({ sessionId: newSessionId('sgcal'), panorama: pano.bytes, mime: pano.mime, c2w: toServiceC2W(filePose), metersPerUnit: 1 });
    credits += cal.credits ?? 0;
    const done = await deps.jst2.wait(cal, { signal: deps.signal });
    const pts = readSpz(await deps.jst2.download(done.result!.spz.url));
    unitsToFloor = distanceToFloor(pts, [0, 0, 0], [0, -1, 0], { radius: 0.08, maxDistance: 10 });
  }
  if (unitsToFloor === null || !(unitsToFloor > 0)) throw new Error('Could not find the floor under the capture point in the reconstruction.');
  const metersPerUnit = Math.round((EYE_HEIGHT / unitsToFloor) * 1000) / 1000;
  lap('scale');

  p('scene', `Building the scene at the capture point (1 unit = ${metersPerUnit} m)`);
  const sessionId = newSessionId('sg');
  let task = await deps.jst2.customPano({ sessionId, panorama: pano.bytes, mime: pano.mime, c2w: toServiceC2W(filePose), metersPerUnit });
  credits += task.credits ?? 0;
  task = await deps.jst2.wait(task, { signal: deps.signal });
  const spz = await deps.jst2.download(task.result!.spz.url);
  await writeFile(join(dir, 'scene.spz'), spz);
  lap('scene');

  let finalSpz = spz;
  let batchIds = task.result!.outputBatch ? [task.result!.outputBatch.batchId] : [];
  let fill: FillResult | null = null;
  if ((deps.maxFills ?? 2) > 0) {
    p('fill', 'Looking for gaps in the scene');
    const f = await autoFill(spz, dir, { jst2: deps.jst2, sessionId, batchIds, capture: [0, 0, 0], maxFills: deps.maxFills ?? 2, signal: deps.signal, onProgress: (m) => p('fill', m) });
    fill = f.result;
    credits += f.result.credits;
    batchIds = f.result.batchIds;
    finalSpz = f.spz;
    if (f.result.rounds.length) await writeFile(join(dir, 'scene.spz'), finalSpz);
    lap('fill');
  }

  p('verify', 'Checking the scene against the blockout');
  const lowRes = renderEquirect(buildScene(layout), c.capture, 256, 128);
  // Blockout rendered at the capture point, splats seen from the file's origin: the same rays.
  const measured = measureAlignment(readSpz(finalSpz), lowRes, filePose);
  const alignment = { ...measured, floorY: measured.floorY === null ? null : Math.round((measured.floorY + origin[1]) * 100) / 100 };
  lap('verify');

  const result: TextSceneResult = {
    capture: c.capture,
    prompt,
    provider: deps.provider.id,
    depthRange: c.range,
    metersPerUnit,
    scaleSource,
    sessionId,
    batchIds,
    credits,
    alignment,
    fill,
    files: { depth: 'depth.png', semantic: 'semantic.png', shaded: 'shaded.png', panorama: panoName, scene: 'scene.spz', layout: 'layout.json' },
    legend: c.legend,
    seconds,
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  p('done', `Scene ready: floor at ${alignment.floorY ?? '?'} m, ${Math.round(alignment.within25 * 100)}% of directions within 25% of the blockout`);
  return result;
}
