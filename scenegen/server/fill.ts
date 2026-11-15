/**
 * Find a scene's gaps and fill them, automatically: PINOC's view search
 * (ported in src/stage/scenecheck.ts, the director's own "检测场景缺口") on the
 * scene's splat centres, then for each of the worst views JST-2 generates that
 * view and the scene is rebuilt from every view - the same two calls the
 * director's 补全 makes (generate, then reconstruct).
 *
 * The scene is in our world (metres, Y up, floor 0) because it was made with
 * custom-pano; poses go back to JST-2 through the same flip (toServiceC2W).
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkScene } from '../../src/stage/scenecheck.ts';
import type { GapView } from '../../src/stage/scenecheck.ts';
import { DEG, toServiceC2W } from '../core/frame.ts';
import type { CameraPose, Vec3 } from '../core/frame.ts';
import { readSpz } from '../core/spz.ts';
import type { Jst2Client } from './jst2.ts';

export interface FillRound { view: Pick<GapView, 'id' | 'position' | 'yaw' | 'pitch' | 'hole' | 'blur' | 'priority'>; pose: CameraPose; batchId: string; credits: number; holeBefore: number; holeAfter: number | null }
export interface FillResult { rounds: FillRound[]; batchIds: string[]; credits: number; before: { views: number; worstHole: number }; after: { views: number; worstHole: number } }

export function gapsOf(spz: Uint8Array, capture: Vec3) {
  const p = readSpz(spz);
  return checkScene({ positions: p.positions, alpha: p.alphas }, { capture });
}

/** A gap view as a camera pose in our convention (yaw 0 looks north / -Z, 90 east / +X). */
export function gapPose(v: GapView): CameraPose {
  const [fx, fy, fz] = v.forward;
  return { position: v.position, yaw: Math.atan2(fx, -fz) / DEG, pitch: Math.asin(Math.max(-1, Math.min(1, fy))) / DEG };
}

export async function autoFill(spz: Uint8Array, dir: string, deps: {
  jst2: Jst2Client; sessionId: string; batchIds: string[]; capture: Vec3;
  /** At most this many generations. Default 2. */
  maxFills?: number;
  /** Only views whose frame is at least this share hole. Default 0.04. */
  minHole?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ spz: Uint8Array; result: FillResult }> {
  const p = deps.onProgress ?? (() => {});
  const max = deps.maxFills ?? 2;
  const minHole = deps.minHole ?? 0.04;
  let current = spz;
  let batchIds = [...deps.batchIds];
  const rounds: FillRound[] = [];
  let credits = 0;
  const first = gapsOf(current, deps.capture);
  const worst = (c: ReturnType<typeof gapsOf>) => c.views.reduce((m, v) => Math.max(m, v.hole), 0);
  const before = { views: first.views.length, worstHole: worst(first) };
  let check = first;
  for (let i = 0; i < max; i++) {
    const v = check.views.find((x) => x.role === 'hole' && x.hole >= minHole) ?? check.views.find((x) => x.hole >= minHole);
    if (!v) { p(i ? 'No gaps left worth a generation.' : 'The scene has no gaps worth filling.'); break; }
    const pose = gapPose(v);
    p(`Gap ${i + 1}/${max}: ${(v.hole * 100).toFixed(0)}% hole, ${(v.blur * 100).toFixed(0)}% blur at (${v.position.map((x) => x.toFixed(1)).join(', ')}) looking ${pose.yaw.toFixed(0)}° - generating that view`);
    let gen = await deps.jst2.generate({ sessionId: deps.sessionId, referenceBatchIds: batchIds, targetC2w: toServiceC2W(pose), projection: 'perspective', fov: 100 });
    let spent = gen.credits ?? 0;
    gen = await deps.jst2.wait(gen, { signal: deps.signal });
    const batch = gen.result!.outputBatch?.batchId;
    if (!batch) throw new Error('JST-2 returned no new view.');
    batchIds = [...batchIds, batch];
    p(`Gap ${i + 1}/${max}: rebuilding the scene from ${batchIds.length} batches`);
    let rec = await deps.jst2.reconstruct({ sessionId: deps.sessionId, referenceBatchIds: batchIds });
    spent += rec.credits ?? 0;
    rec = await deps.jst2.wait(rec, { signal: deps.signal });
    current = await deps.jst2.download(rec.result!.spz.url);
    credits += spent;
    await writeFile(join(dir, `scene-fill${i + 1}.spz`), current);
    check = gapsOf(current, deps.capture);
    // How much of THAT view is still a hole: re-measure the same pose.
    const again = check.views.find((x) => Math.hypot(x.position[0] - v.position[0], x.position[1] - v.position[1], x.position[2] - v.position[2]) < 0.3 && Math.abs(x.yaw - v.yaw) < 30);
    rounds.push({ view: { id: v.id, position: v.position, yaw: v.yaw, pitch: v.pitch, hole: v.hole, blur: v.blur, priority: v.priority }, pose, batchId: batch, credits: spent, holeBefore: v.hole, holeAfter: again ? again.hole : 0 });
  }
  return { spz: current, result: { rounds, batchIds, credits, before, after: { views: check.views.length, worstHole: worst(check) } } };
}
