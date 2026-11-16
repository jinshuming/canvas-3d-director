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
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { horizontalScale, measureAlignment } from '../core/align.ts';
import type { Alignment } from '../core/align.ts';
import { compileCaption } from '../core/caption.ts';
import { findCapturePoint } from '../core/capture.ts';
import { toServiceC2W } from '../core/frame.ts';
import type { CameraPose } from '../core/frame.ts';
import { buildScene } from '../core/geometry.ts';
import { concatGaussians, readSpzGaussians, scaleSpz, writeSpzGaussians } from '../core/gaussians.ts';
import { placeScene } from './seatScene.ts';
import type { PlaceItem } from './seatScene.ts';
import { MASK_GRID } from '../core/place.ts';
import { depthImage, depthRange, renderEquirect, semanticImage, shadedImage } from '../core/render.ts';
import { distanceToFloor, readSpz } from '../core/spz.ts';
import type { Layout } from '../core/types.ts';
import { EYE_HEIGHT } from '../core/types.ts';
import { scorePanoramas } from './alignScore.ts';
import { autoFill, fillBudget } from './fill.ts';
import type { PastJob } from './expand.ts';
import { cropFor, decodeRgb, environmentLayout, generateObjects, paintedMask, planObjects } from './objects.ts';
import type { ObjectAsset } from './objects.ts';
import type { FillResult } from './fill.ts';
import { Jst2Client, newSessionId } from './jst2.ts';
import type { PanoProvider, PeopleCheck } from './pano.ts';
import { encodePng } from './png.ts';

export interface TextSceneResult {
  capture: CameraPose;
  prompt: string;
  provider: string;
  depthRange: { zMin: number; zMax: number };
  metersPerUnit: number;
  /** The JST-2 session is at 1 unit = 1 (poses go to it divided by metersPerUnit). */
  sessionInUnits?: boolean;
  /** Earlier jobs on this project (a generation before an expansion or a retry), for the log. */
  pastJobs?: PastJob[];
  scaleSource: 'provider-reconstruction' | 'calibration';
  sessionId: string;
  batchIds: string[];
  credits: number;
  alignment: Alignment;
  /** The automatic gap fill (null when switched off). */
  fill: FillResult | null;
  /** The people check on the final panorama (null when no vision model), and how many paintings it took. */
  panoCheck: { people: boolean; prominent: boolean; note: string } | null;
  panoAttempts: number;
  /** Every panorama painted, its alignment with the blockout and its figure check; `chosen` is the one kept. */
  candidates: PanoCandidate[];
  chosen: number;
  /** Key objects generated as their own assets (SAM 3D), fitted to the blockout; empty when objects are off. */
  objects: ObjectAsset[];
  /** The environment's horizontal size over the blockout's (walls), which the objects were moved by; null = not measured. */
  envScale: number | null;
  files: { depth: string; semantic: string; shaded: string; panorama: string; blockoutFull: string | null; environment: string; scene: string; layout: string };
  legend: Array<{ cls: string; color: [number, number, number]; share: number }>;
  seconds: Record<string, number>;
}

export interface PanoCandidate { file: string; objects: number | null; shell: number | null; people: { people: boolean; prominent: boolean; note: string } | null }

export type Progress = (stage: 'conditions' | 'pano' | 'scale' | 'scene' | 'fill' | 'objects' | 'compose' | 'verify' | 'done', message: string) => void;

const W = 2048, H = 1024;

/** The space in numbers, for the image model: room size, ceiling, camera height, nearest walls. */
export function geometryNote(layout: Layout, capture: CameraPose): string {
  const h = capture.position[1].toFixed(1);
  if (!layout.room) return `outdoors, the camera ${h} m above flat ground, the nearest large objects ${nearest(layout, capture)}`;
  const r = layout.room;
  const [x, , z] = capture.position;
  const walls = [`north wall ${(z + r.depth / 2).toFixed(1)} m`, `south wall ${(r.depth / 2 - z).toFixed(1)} m`, `east wall ${(r.width / 2 - x).toFixed(1)} m`, `west wall ${(x + r.width / 2).toFixed(1)} m`];
  return `an interior ${r.width} m wide and ${r.depth} m deep with a flat ${r.height} m ceiling; the camera stands ${h} m above the floor, so the ceiling is only ${(r.height - capture.position[1]).toFixed(1)} m above it; distances from the camera: ${walls.join(', ')}`;
}

function nearest(layout: Layout, capture: CameraPose): string {
  return layout.objects
    .map((o) => ({ o, d: Math.hypot(o.position[0] - capture.position[0], o.position[2] - capture.position[2]) }))
    .sort((a, b) => a.d - b.d).slice(0, 4)
    .map(({ o, d }) => `${o.label} ${d.toFixed(1)} m`).join(', ');
}

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

/** The environment's measured scale, if it is off by enough to move the objects (and plausible). */
export const shiftOf = (envScale: number | null) => (envScale !== null && envScale > 0.7 && envScale < 1.4 && Math.abs(envScale - 1) > 0.02 ? envScale : null);

/**
 * Environment + objects into scene.spz. Every object is placed from its source - SAM 3D's object as it
 * came, `objects/<id>-sam.spz` (an older scene's placed file becomes its source the first time) - by
 * seatScene.placeScene: cleaned, stood up, squared with its box, sized, seated, kept out of the walls
 * and the other objects. From the source every time, so composing again after an expansion or a retry
 * places the same way, and never compounds a move.
 */
export async function composeScene(dir: string, layout: Layout, capture: CameraPose, envSpz: Uint8Array, objects: ObjectAsset[], shift: number | null, onPlaced?: (suspect: string[]) => void): Promise<Uint8Array> {
  const env = readSpzGaussians(envSpz);
  const items: PlaceItem[] = [];
  for (const o of objects) {
    const obj = layout.objects.find((x) => x.id === o.id);
    if (!o.file || !obj) continue;
    const src = join(dir, `objects/${o.id}-sam.spz`);
    if (!existsSync(src)) await copyFile(join(dir, o.file), src);
    const g = readSpzGaussians(new Uint8Array(await readFile(src)));
    // The painted object's silhouette in the crop SAM 3D saw, when the crop was painted here.
    const view = cropFor(obj, capture);
    let mask: Uint8Array | null = null;
    const envCrop = join(dir, `objects/${o.id}-env.jpg`);
    if (o.crop.endsWith('.png') && existsSync(envCrop) && existsSync(join(dir, o.crop))) {
      const [before, after] = await Promise.all([decodeRgb(envCrop, view.size), decodeRgb(join(dir, o.crop), view.size)]).catch(() => [null, null]);
      if (before && after) mask = paintedMask(before, after, view.size, o.box, MASK_GRID);
    }
    items.push({ id: o.id, obj, g, crop: { pose: view.pose, fov: view.fov, mask } });
  }
  const placed = placeScene(env, items, layout, capture.position, shift);
  onPlaced?.([...placed].filter(([, p]) => p.place.suspect).map(([id]) => id));
  const parts = [env];
  for (const o of objects) {
    const p = placed.get(o.id);
    if (!p || !o.file) continue;
    o.place = p.place;
    o.seat = p.seat;
    delete o.shifted;
    await writeFile(join(dir, o.file), writeSpzGaussians(p.g));
    parts.push(p.g);
  }
  const finalSpz = parts.length > 1 ? writeSpzGaussians(concatGaussians(parts)) : envSpz;
  await writeFile(join(dir, 'scene.spz'), finalSpz);
  return finalSpz;
}

/**
 * SAM 3D again for the objects whose generation failed (a queue that never moved, a network error),
 * from the crops already painted; then the scene is composed again. The environment was painted
 * without them, so this is how they get back into the scene.
 */
export async function retryObjects(dir: string, deps: { sam3d: (image: Uint8Array, box: [number, number, number, number]) => Promise<{ ply: Uint8Array; seconds: number }>; onProgress?: Progress; /** The job this one replaces, kept in the result so the log stays whole. */ previousJob?: PastJob | null }): Promise<TextSceneResult> {
  const p = deps.onProgress ?? (() => {});
  const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as TextSceneResult;
  const layout = JSON.parse(await readFile(join(dir, 'layout.json'), 'utf8')) as Layout;
  const failed = result.objects.filter((o) => !o.file);
  if (!failed.length) { p('done', 'Every object is already there.'); return result; }
  const capture = result.capture;
  const assets = failed.map((o) => layout.objects.find((x) => x.id === o.id)).filter((x): x is Layout['objects'][number] => Boolean(x));
  p('objects', `SAM 3D again for ${assets.length} object(s): ${failed.map((o) => o.label).join(', ')}`);
  const redone = await generateObjects({ ...layout, capture }, assets, join(dir, result.files.panorama), dir, {
    sam3d: deps.sam3d, reuse: new Map(failed.map((o) => [o.id, { crop: o.crop, box: o.box }])), onProgress: (m) => p('objects', m),
  });
  const objects = result.objects.map((o) => redone.find((r) => r.id === o.id) ?? o);
  const envSpz = new Uint8Array(await readFile(join(dir, result.files.environment)));
  let envScale = result.envScale;
  if (envScale === null && objects.some((o) => o.file)) {
    const envLayout = { ...environmentLayout(layout, planObjects(layout).remove), capture };
    envScale = horizontalScale(readSpz(envSpz), renderEquirect(buildScene(envLayout), capture, 512, 256), { position: [0, 0, 0], yaw: capture.yaw });
  }
  p('compose', 'Composing the scene again');
  const finalSpz = await composeScene(dir, layout, capture, envSpz, objects, shiftOf(envScale));
  const measured = measureAlignment(readSpz(finalSpz), renderEquirect(buildScene(layout), capture, 256, 128), { position: [0, 0, 0], yaw: capture.yaw });
  const out: TextSceneResult = { ...result, pastJobs: [...(result.pastJobs ?? []), ...(deps.previousJob ? [deps.previousJob] : [])], objects, envScale, alignment: { ...measured, floorY: measured.floorY === null ? null : Math.round((measured.floorY + capture.position[1]) * 100) / 100 } };
  await writeFile(join(dir, 'result.json'), JSON.stringify(out, null, 2));
  const ok = redone.filter((o) => o.file).length;
  p('done', `${ok} of ${redone.length} object(s) now in the scene`);
  return out;
}

export async function textToScene(layout: Layout, dir: string, deps: { jst2: Jst2Client; provider: PanoProvider; prompt?: string; styleImage?: { bytes: Uint8Array; mime: string }; maxFills?: number | 'auto'; vision?: PeopleCheck; /** Keep the first panorama whose alignment with the blockout reaches this (0-1, default 0.8). */ goodEnough?: number;
  /** Generate key objects separately (SAM 3D) and the environment without them. Off: one 3DGS of everything. */
  objects?: { sam3d: (image: Uint8Array, box: [number, number, number, number]) => Promise<{ ply: Uint8Array; seconds: number }>; paint: (input: { image: Uint8Array; guide: Uint8Array; size: number; box: [number, number, number, number]; label: string; style?: string }) => Promise<Uint8Array> }; signal?: AbortSignal; onProgress?: Progress }): Promise<TextSceneResult> {
  const p = deps.onProgress ?? (() => {});
  const seconds: Record<string, number> = {};
  let t = Date.now();
  const lap = (k: string) => { seconds[k] = Math.round((Date.now() - t) / 100) / 10; t = Date.now(); };
  let credits = 0;

  p('conditions', 'Finding the capture point and rendering the blockout');
  // With SAM 3D objects, the environment is painted from the blockout WITHOUT them (the full blockout,
  // rendered from the same point, only guides where they are painted into the object panorama).
  const full = deps.objects ? await renderConditions(layout, join(dir, 'blockout-full')) : null;
  const plan = deps.objects ? planObjects(layout) : { assets: [], remove: new Set<number>() };
  // Its caption must not name them either - the user's words and the materials line do, and the image
  // model paints what the text names whatever the depth map says (measured: with the user's words the
  // counter, sofa and table came back; without them, the counter the style summary named still did). So: no user prompt, no style summary, no materials (palette and lighting stay), and the removed
  // things named as absent.
  const removed = [...plan.remove].map((i) => layout.objects[i]!.label);
  const envLayout = plan.remove.size ? { ...environmentLayout(layout, plan.remove), prompt: '', style: { ...layout.style, summary: '', materials: '' }, capture: full!.capture } : layout;
  const c = await renderConditions(envLayout, dir);
  const prompt = deps.prompt ?? compileCaption(envLayout, c.capture) + (removed.length ? `\nThese are NOT in the place (they will be added later): ${removed.join('; ')}. Where the blockout shows open floor, paint open floor - no furniture that the blockout does not show.` : '');
  // THE SCENE FILE'S FRAME: the capture point at the origin, metres, +Y up (the floor at y = -1.5) -
  // what the director assumes of every generated scene (its placement, gap check and fill measure from
  // the file's origin). The blockout is the same frame shifted by the capture point; the layout file says so.
  const filePose: CameraPose = { position: [0, 0, 0], yaw: c.capture.yaw };
  const origin = c.capture.position;
  await writeFile(join(dir, 'layout.json'), JSON.stringify({ ...layout, capture: c.capture, sceneFrame: { origin, note: 'The .spz origin is the capture point `origin` of this layout (metres, +Y up). A layout point p is at p - origin in the file; in the director (which puts the capture point at x = z = 0, floor y = 0) it is at [p.x - origin.x, p.y, p.z - origin.z].' } }, null, 2));
  await writeFile(join(dir, 'prompt.txt'), prompt);
  lap('conditions');

  // How the panorama is painted (A/B-tested 2026-11-15, docs/SCENEGEN_DESIGN.md): the depth map AND the
  // clay render, pixel-aligned, and NOT the user's picture - with it GPT-image-2 copies the picture's
  // composition and ignores the blockout (alignment 0.05-0.08 against 0.55-0.64 without). The picture's
  // look still arrives, as the agent's style text.
  //
  // Painted ON DEMAND: one first, scored against the blockout (edge alignment above chance, 0-1,
  // absolute per image) and checked for life-size figures; kept if it is good enough. Otherwise two
  // more at once, and the best clean one of the three is kept; three with a figure in each get one
  // last pair. The same images go on scoring against each other: picking the best of three took
  // alignment from 0.67 to 0.84 on one café, but most first paintings already clear the bar.
  const many = deps.provider.id === 'openai-image';
  const goodEnough = deps.goodEnough ?? 0.8;
  const batches = many ? [1, 2, 2] : [1];
  const geometry = geometryNote(envLayout, c.capture);
  const paint = () => deps.provider.generate({ prompt, depth: c.depth, semantic: c.semantic, shaded: c.shaded, geometry, withClay: many, styleImage: many ? undefined : deps.styleImage, signal: deps.signal, onProgress: () => {} });
  await mkdir(join(dir, 'candidates'), { recursive: true });
  const candidates: PanoCandidate[] = [];
  let panoAttempts = 0;
  let chosen: { pano: Awaited<ReturnType<typeof paint>>; index: number } | null = null;
  const kept: Array<{ pano: Awaited<ReturnType<typeof paint>>; index: number }> = [];
  for (const [round, n] of batches.entries()) {
    p('pano', round === 0 ? `Painting the panorama (${deps.provider.label})` : `Painting ${n} more panorama candidate${n > 1 ? 's' : ''}`);
    const painted = await Promise.all(Array.from({ length: n }, () => paint()));
    const start = candidates.length;
    panoAttempts += n;
    for (const [i, pano] of painted.entries()) {
      credits += pano.credits ?? 0;
      const file = join(dir, 'candidates', `cand-${start + i}.${pano.mime === 'image/png' ? 'png' : 'jpg'}`);
      await writeFile(file, pano.bytes);
      candidates.push({ file: `candidates/${file.split('/').pop()}`, objects: null, shell: null, people: null });
    }
    p('pano', 'Scoring against the blockout and checking for figures');
    const [scores, checks] = await Promise.all([
      many ? scorePanoramas(join(dir, 'semantic.png'), candidates.slice(start).map((x) => join(dir, x.file))) : Promise.resolve(null),
      Promise.all(painted.map((x) => (deps.vision ? deps.vision(x.bytes).catch(() => null) : Promise.resolve(null)))),
    ]);
    painted.forEach((pano, i) => {
      const cand = candidates[start + i]!;
      if (scores) { cand.objects = scores[i]!.objects; cand.shell = scores[i]!.shell; }
      cand.people = checks[i] ?? null;
      kept.push({ pano, index: start + i });
    });
    const clean = kept.filter(({ index }) => !candidates[index]!.people?.prominent);
    const best = clean.length ? clean.reduce((a, b) => ((candidates[b.index]!.objects ?? -1) > (candidates[a.index]!.objects ?? -1) ? b : a)) : null;
    const score = best ? candidates[best.index]!.objects : null;
    const last = round === batches.length - 1;
    // Good enough (or no scorer to tell: keep the first clean one); after the second round, the best
    // clean one whatever its score; a figure in every one painted so far: paint again.
    if (best && (score === null || score >= goodEnough || round >= 1)) { chosen = best; break; }
    if (best) p('pano', `Alignment ${score!.toFixed(2)} is under ${goodEnough}: painting more to choose from`);
    else if (!last) p('pano', `A figure in every candidate so far (${candidates[start]!.people?.note ?? ''}): painting again`);
  }
  // A figure in every candidate: keep the best-aligned one anyway, and say so.
  if (!chosen) {
    const index = candidates.map((_, i) => i).reduce((a, b) => ((candidates[b]!.objects ?? -1) > (candidates[a]!.objects ?? -1) ? b : a));
    chosen = kept.find((k) => k.index === index)!;
  }
  const pano = chosen.pano;
  const panoCheck = candidates[chosen.index]!.people;
  p('pano', `Kept candidate ${chosen.index + 1} of ${candidates.length} painted${candidates[chosen.index]!.objects !== null ? ` (alignment ${candidates[chosen.index]!.objects!.toFixed(2)})` : ''}`);
  const panoName = pano.mime === 'image/png' ? 'panorama.png' : 'panorama.jpg';
  await writeFile(join(dir, panoName), pano.bytes);
  lap('pano');

  // ── Objects and environment, side by side ─────────────────────────────────
  // The environment goes to JST-2 as painted. Each object is painted into its own crop of that
  // panorama (the view SAM 3D sees), one object per edit, then turned into a SAM 3D asset.
  const objectsStart = Date.now();
  const objectsJob = (async (): Promise<ObjectAsset[]> => {
    if (!deps.objects || !plan.assets.length) return [];
    p('objects', `Painting ${plan.assets.length} objects into their crops, then SAM 3D`);
    const out = await generateObjects({ ...layout, capture: c.capture }, plan.assets, join(dir, panoName), dir, {
      sam3d: deps.objects.sam3d,
      paint: { guidePano: join(dir, 'blockout-full', 'shaded.png'), style: layout.style.summary, run: deps.objects.paint },
      onProgress: (m) => p('objects', m),
    });
    seconds.objects = Math.round((Date.now() - objectsStart) / 100) / 10;
    return out;
  })();
  // Not awaited until the environment is done; a rejection is caught there, not left unhandled.
  objectsJob.catch(() => {});

  // ONE environment build: at 1 unit = 1, measured on itself (the capture point is EYE_HEIGHT above
  // the floor), then scaled into metres here. It used to be built twice - a calibration scene to
  // measure, then the real one at that scale: 20-35 s and 6 credits more for the same result, since
  // JST-2's scale is uniform. The session stays in units: fill sends its poses divided by the scale.
  p('scene', 'Building the environment at the capture point');
  const sessionId = newSessionId('sg');
  let task = await deps.jst2.customPano({ sessionId, panorama: pano.bytes, mime: pano.mime, c2w: toServiceC2W(filePose), metersPerUnit: 1 });
  credits += task.credits ?? 0;
  task = await deps.jst2.wait(task, { signal: deps.signal });
  const raw = await deps.jst2.download(task.result!.spz.url);
  lap('scene');
  p('scale', 'Measuring how big a JST-2 unit is (on the environment itself)');
  const scaleSource: TextSceneResult['scaleSource'] = 'provider-reconstruction';
  const unitsToFloor = distanceToFloor(readSpz(raw), [0, 0, 0], [0, -1, 0], { radius: 0.08, maxDistance: 10 });
  if (unitsToFloor === null || !(unitsToFloor > 0)) throw new Error('Could not find the floor under the capture point in the reconstruction.');
  const metersPerUnit = Math.round((EYE_HEIGHT / unitsToFloor) * 1000) / 1000;
  const spz = scaleSpz(raw, metersPerUnit);
  p('scale', `1 unit = ${metersPerUnit} m`);
  lap('scale');

  let envSpz = spz;
  let batchIds = task.result!.outputBatch ? [task.result!.outputBatch.batchId] : [];
  let fill: FillResult | null = null;
  const maxFills = deps.maxFills === undefined || deps.maxFills === 'auto' ? fillBudget(layout.room ? layout.room.width * layout.room.depth : null) : deps.maxFills;
  if (maxFills > 0) {
    p('fill', `Looking for gaps in the environment (up to ${maxFills} views)`);
    const f = await autoFill(spz, dir, { jst2: deps.jst2, sessionId, batchIds, capture: [0, 0, 0], maxFills, unit: metersPerUnit, signal: deps.signal, onProgress: (m) => p('fill', m) });
    fill = f.result;
    credits += f.result.credits;
    batchIds = f.result.batchIds;
    envSpz = f.spz;
    lap('fill');
  }
  await writeFile(join(dir, 'environment.spz'), envSpz);

  p('objects', 'Waiting for the objects');
  const objects = await objectsJob;
  lap('compose');
  // The composed scene: the environment and every object, one file (the director loads one), in the
  // scene's frame - capture point at the origin, metres, Y up. The viewer loads the parts separately.
  // The objects were placed by the blockout; the environment may have come out a little smaller or
  // larger (horizontally). Move each object to the same place IN the environment - its offset from
  // the capture point scaled by how the environment's walls compare with the blockout's - so a
  // counter against the wall stands at the scene's wall, not inside or behind it. Sizes stay.
  const envScale = objects.some((o) => o.file) ? horizontalScale(readSpz(envSpz), renderEquirect(buildScene(envLayout), c.capture, 512, 256), filePose) : null;
  const shift = shiftOf(envScale);
  if (shift !== null) p('objects', `The environment is ${Math.round(shift * 100)}% of the blockout's size: moving the objects to match`);
  p('compose', 'Placing the objects: cleaned, stood up, squared with the blockout, seated, kept out of the walls and each other');
  const finalSpz = await composeScene(dir, layout, c.capture, envSpz, objects, shift, (bad) => { if (bad.length) p('compose', `Does not fit its blockout box even placed (SAM 3D gave something else?): ${bad.join(', ')}`); });

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
    sessionInUnits: true,
    scaleSource,
    sessionId,
    batchIds,
    credits,
    alignment,
    fill,
    panoCheck,
    panoAttempts,
    candidates,
    chosen: chosen.index,
    objects,
    envScale,
    files: { depth: 'depth.png', semantic: 'semantic.png', shaded: 'shaded.png', panorama: panoName, blockoutFull: plan.assets.length ? 'blockout-full/shaded.png' : null, environment: 'environment.spz', scene: 'scene.spz', layout: 'layout.json' },
    legend: c.legend,
    seconds,
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2));
  p('done', `Scene ready: floor at ${alignment.floorY ?? '?'} m, ${Math.round(alignment.within25 * 100)}% of directions within 25% of the blockout`);
  return result;
}
