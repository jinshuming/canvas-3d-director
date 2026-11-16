/**
 * Expand a finished scene from a camera the user placed in the 3D viewer: where the scene has a
 * hole or a smear, JST-2 generates the view from that camera (from every batch so far), the scene is
 * rebuilt from all of them, and - for a generated scene - composed again with its SAM 3D objects.
 *
 * The camera is in the scene file's frame (the viewer shows the files as they are: capture point at
 * the origin, metres, Y up). The JST-2 session was built at 1 unit = 1 (textScene / videoGen), so
 * the pose goes out divided by the scale and the rebuild comes back multiplied.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toServiceC2W } from '../core/frame.ts';
import type { CameraPose } from '../core/frame.ts';
import { scaleSpz } from '../core/gaussians.ts';
import type { Layout } from '../core/types.ts';
import { sessionPose } from './fill.ts';
import type { Jst2Client } from './jst2.ts';
import type { ObjectAsset } from './objects.ts';
import { composeScene, shiftOf, withPastJob } from './textScene.ts';
import type { PastJob } from './textScene.ts';

export interface ExpandRecord { pose: CameraPose; fov: number; batchId: string; image: string | null; credits: number; at: string }

/** What a scene's result has that expanding needs (both routes write these). */
interface Expandable {
  sessionId: string; batchIds: string[]; metersPerUnit: number; credits: number;
  /** The JST-2 session was built at 1 unit = 1; missing on older scenes, whose session is in metres. */
  sessionInUnits?: boolean;
  files: Record<string, string | null>;
  objects?: ObjectAsset[];
  envScale?: number | null;
  expands?: ExpandRecord[];
  pastJobs?: PastJob[];
}

export async function expandScene(dir: string, kind: 'text' | 'video', pose: CameraPose, deps: {
  jst2: Jst2Client;
  fov?: number;
  /** The job this one replaces on the project, kept in the result so the log stays whole. */
  previousJob?: PastJob | null;
  signal?: AbortSignal;
  onProgress?: (stage: string, message: string) => void;
}): Promise<Expandable> {
  const p = deps.onProgress ?? (() => {});
  const result = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')) as Expandable;
  if (!result.sessionId || !result.batchIds?.length || !(result.metersPerUnit > 0)) throw new Error('This scene has no JST-2 session to expand.');
  // Older scenes' sessions were built at their scale (in metres): nothing to convert.
  const unit = result.sessionInUnits ? result.metersPerUnit : 1;
  const fov = Math.max(20, Math.min(140, deps.fov ?? 90));
  const at = pose.position.map((v) => v.toFixed(1)).join(', ');
  p('expand', `Generating the view at (${at}) m, facing ${Math.round(pose.yaw)}°, pitch ${Math.round(pose.pitch ?? 0)}°`);
  const g = await deps.jst2.wait(await deps.jst2.generate({ sessionId: result.sessionId, referenceBatchIds: result.batchIds, targetC2w: toServiceC2W(sessionPose(pose, unit)), projection: 'perspective', fov }), { signal: deps.signal });
  let credits = g.credits ?? 0;
  const batch = g.result!.outputBatch!;
  const n = (result.expands?.length ?? 0) + 1;
  let image: string | null = null;
  const url = batch.views?.[0]?.url;
  if (url) {
    await mkdir(join(dir, 'expand'), { recursive: true });
    image = `expand/view-${n}.jpg`;
    await writeFile(join(dir, image), await deps.jst2.download(url));
  }
  const batchIds = [...result.batchIds, batch.batchId];
  p('rebuild', `Rebuilding the scene from ${batchIds.length} batches`);
  const r = await deps.jst2.wait(await deps.jst2.reconstruct({ sessionId: result.sessionId, referenceBatchIds: batchIds }), { signal: deps.signal });
  credits += r.credits ?? 0;
  const env = new Uint8Array(scaleSpz(await deps.jst2.download(r.result!.spz.url), unit));

  if (kind === 'text') {
    // The environment changes; the SAM 3D objects stay where they were composed (already moved to
    // the environment's scale, if they were).
    await writeFile(join(dir, result.files.environment ?? 'environment.spz'), env);
    p('compose', 'Composing the scene with its objects again');
    const layout = JSON.parse(await readFile(join(dir, 'layout.json'), 'utf8')) as Layout;
    await composeScene(dir, layout, layout.capture!, env, result.objects ?? [], shiftOf(result.envScale ?? null));
  } else {
    await writeFile(join(dir, result.files.scene ?? 'scene.spz'), env);
  }
  const out: Expandable = {
    ...withPastJob(result, deps.previousJob),
    batchIds,
    credits: result.credits + credits,
    expands: [...(result.expands ?? []), { pose, fov, batchId: batch.batchId, image, credits, at: new Date().toISOString() }],
  };
  await writeFile(join(dir, 'result.json'), JSON.stringify(out, null, 2));
  p('done', `Expanded from (${at}) m: ${credits} credits`);
  return out;
}
