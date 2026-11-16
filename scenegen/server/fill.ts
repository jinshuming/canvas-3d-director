/**
 * Find a scene's gaps and fill them, automatically: PINOC's view search
 * (ported in src/stage/scenecheck.ts, the director's own "检测场景缺口") on the
 * scene's splat centres, then for each of the worst views JST-2 generates that
 * view and the scene is rebuilt from every view - the same two calls the
 * director's 补全 makes (generate, then reconstruct).
 *
 * The scene is in our world (metres, Y up, floor 0) because it was made with
 * custom-pano; poses go back to JST-2 through the same flip (toServiceC2W).
 *
 * Also the two helpers every route shares for a JST-2 session built at
 * 1 unit = 1 (textScene, videoGen, expand): measuring the unit, and sending
 * poses in it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { checkScene } from '../../src/stage/scenecheck.ts';
import type { GapView } from '../../src/stage/scenecheck.ts';
import { DEG, toServiceC2W } from '../core/frame.ts';
import type { CameraPose, Vec3 } from '../core/frame.ts';
import { scaleSpz } from '../core/gaussians.ts';
import { distanceToFloor, readSpz } from '../core/spz.ts';
import type { Jst2Client } from './jst2.ts';

export interface FillRound { view: Pick<GapView, 'id' | 'position' | 'yaw' | 'pitch' | 'hole' | 'blur' | 'priority'>; pose: CameraPose; batchId: string; credits: number; holeBefore: number; holeAfter: number | null; /** The rebuild was kept (it shrank the gap); false = discarded. */ kept?: boolean }
export interface FillResult { rounds: FillRound[]; batchIds: string[]; credits: number; before: { views: number; worstHole: number }; after: { views: number; worstHole: number } }

/**
 * Metres per JST-2 unit of a scene built at 1 unit = 1, measured on itself: the capture point is
 * `height` metres above the floor. Null when no floor is found under the origin.
 */
export function metersPerUnitFromFloor(raw: Uint8Array, height: number): number | null {
  const units = distanceToFloor(readSpz(raw), [0, 0, 0], [0, -1, 0], { radius: 0.08, maxDistance: 10 });
  return units ? Math.round((height / units) * 1000) / 1000 : null;
}

/** A pose in the scene file's frame (metres) as the JST-2 session sees it (`unit` metres per unit). */
export function sessionPose(pose: CameraPose, unit: number): CameraPose {
  return { ...pose, position: [pose.position[0] / unit, pose.position[1] / unit, pose.position[2] / unit] };
}

function gapsOf(spz: Uint8Array, capture: Vec3) {
  const p = readSpz(spz);
  return checkScene({ positions: p.positions, alpha: p.alphas }, { capture });
}

/** A gap view as a camera pose in our convention (yaw 0 looks north / -Z, 90 east / +X). */
export function gapPose(v: GapView): CameraPose {
  const [fx, fy, fz] = v.forward;
  return { position: v.position, yaw: Math.atan2(fx, -fz) / DEG, pitch: Math.asin(Math.max(-1, Math.min(1, fy))) / DEG };
}

/**
 * How many views a scene may need: one per ~25 m² of room (at most 3), 3 outdoors. The loop
 * stops sooner once the worst gap is under TARGET_HOLE. Measured on the first end-to-end run:
 * one view left larger spaces as holed as before (a fill shows what was behind one thing, and the
 * rebuild exposes the next gap).
 */
export function fillBudget(area: number | null): number {
  if (area === null) return 3;
  return area <= 25 ? 1 : area <= 60 ? 2 : 3;
}

/** Only views whose frame is at least this share hole are worth a generation. */
const MIN_HOLE = 0.04;
/** Stop once the worst view is under this share hole. */
const TARGET_HOLE = 0.05;

export async function autoFill(spz: Uint8Array, dir: string, deps: {
  jst2: Jst2Client; sessionId: string; batchIds: string[]; capture: Vec3;
  /** At most this many generations. Default 2. */
  maxFills?: number;
  /**
   * Metres per unit of the JST-2 session, when the scene was built at 1 unit = 1 and converted to
   * metres here: poses go to JST-2 divided by it, its rebuilds come back multiplied. Default 1.
   */
  unit?: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<{ spz: Uint8Array; result: FillResult }> {
  const p = deps.onProgress ?? (() => {});
  const max = deps.maxFills ?? 2;
  let current = spz;
  let batchIds = [...deps.batchIds];
  const rounds: FillRound[] = [];
  let credits = 0;
  const unit = deps.unit ?? 1;
  const first = gapsOf(current, deps.capture);
  /** Views already tried that did not help: not asked for again. */
  const tried: GapView[] = [];
  const near = (a: GapView, b: GapView) => Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]) < 0.5 && Math.abs(((a.yaw - b.yaw + 540) % 360) - 180) < 40;
  const worst = (c: ReturnType<typeof gapsOf>) => c.views.reduce((m, v) => Math.max(m, v.hole), 0);
  const before = { views: first.views.length, worstHole: worst(first) };
  let check = first;
  for (let i = 0; i < max; i++) {
    if (worst(check) < TARGET_HOLE) { p(i ? `Worst gap now ${(worst(check) * 100).toFixed(0)}%: done.` : 'The scene has no gaps worth filling.'); break; }
    const v = check.views.filter((x) => x.hole >= MIN_HOLE && !tried.some((t) => near(t, x))).sort((a, b) => b.hole - a.hole)[0];
    if (!v) { p(i ? 'No gaps left worth a generation.' : 'The scene has no gaps worth filling.'); break; }
    const pose = gapPose(v);
    p(`Gap ${i + 1}/${max}: ${(v.hole * 100).toFixed(0)}% hole, ${(v.blur * 100).toFixed(0)}% blur at (${v.position.map((x) => x.toFixed(1)).join(', ')}) looking ${pose.yaw.toFixed(0)}° - generating that view`);
    let gen = await deps.jst2.generate({ sessionId: deps.sessionId, referenceBatchIds: batchIds, targetC2w: toServiceC2W(sessionPose(pose, unit)), projection: 'perspective', fov: 100 });
    let spent = gen.credits ?? 0;
    gen = await deps.jst2.wait(gen, { signal: deps.signal });
    const batch = gen.result!.outputBatch?.batchId;
    if (!batch) throw new Error('JST-2 returned no new view.');
    const withNew = [...batchIds, batch];
    p(`Gap ${i + 1}/${max}: rebuilding the scene from ${withNew.length} batches`);
    let rec = await deps.jst2.reconstruct({ sessionId: deps.sessionId, referenceBatchIds: withNew });
    spent += rec.credits ?? 0;
    rec = await deps.jst2.wait(rec, { signal: deps.signal });
    const rebuilt = scaleSpz(await deps.jst2.download(rec.result!.spz.url), unit);
    credits += spent;
    await writeFile(join(dir, `scene-fill${i + 1}.spz`), rebuilt);
    const after = gapsOf(rebuilt, deps.capture);
    // How much of THAT view is still a hole: re-measure the same pose.
    const again = after.views.find((x) => near(x, v));
    const holeAfter = again ? again.hole : 0;
    // Keep the round only if it helped: the view it aimed at lost at least a third of its hole and
    // the worst view did not get worse (measured: a round that took the worst gap from 16% to 17%).
    const kept = holeAfter <= v.hole * 0.67 && worst(after) <= worst(check) + 0.005;
    rounds.push({ view: { id: v.id, position: v.position, yaw: v.yaw, pitch: v.pitch, hole: v.hole, blur: v.blur, priority: v.priority }, pose, batchId: batch, credits: spent, holeBefore: v.hole, holeAfter, kept });
    if (kept) { current = rebuilt; batchIds = withNew; check = after; }
    else {
      tried.push(v);
      p(`Gap ${i + 1}/${max}: that view did not close the gap (${(v.hole * 100).toFixed(0)}% → ${(holeAfter * 100).toFixed(0)}%) - keeping the scene without it`);
    }
  }
  return { spz: current, result: { rounds, batchIds, credits, before, after: { views: check.views.length, worstHole: worst(check) } } };
}
