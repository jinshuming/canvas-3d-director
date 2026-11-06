import type { CameraSample } from './camera.js';
import { sampleShot } from './camera.js';
import { uid } from './edit.js';
import type { StageCut, StageDoc } from './types.js';

/**
 * The edit: shots cut together into one film. A cut says which shot is live
 * from `start` to `end`; all shots share the stage clock, so the film at time
 * t is simply the live shot's camera at t.
 */

const EPS = 1e-3;
const r2 = (v: number) => Math.round(v * 100) / 100;

export function sortedCuts(doc: Pick<StageDoc, 'cuts'>): StageCut[] {
  return [...(doc.cuts ?? [])].sort((a, b) => a.start - b.start);
}

/** The first cut's start to the last cut's end; null with no edit. */
export function editSpan(doc: Pick<StageDoc, 'cuts'>): [number, number] | null {
  const cuts = sortedCuts(doc);
  return cuts.length ? [cuts[0]!.start, cuts[cuts.length - 1]!.end] : null;
}

/**
 * The cut live at `t`. Before the first cut the film holds on it; in a gap it
 * holds on the cut before; after the last, on the last. Null with no edit.
 */
export function cutAt(doc: Pick<StageDoc, 'cuts'>, t: number): StageCut | null {
  const cuts = sortedCuts(doc);
  if (!cuts.length) return null;
  let live = cuts[0]!;
  for (const c of cuts) {
    if (c.start <= t + EPS) live = c;
    else break;
  }
  return live;
}

/**
 * The cut the playhead is INSIDE, or null: unlike `cutAt` it does not hold on a cut before the first,
 * between two or after the last. A cut owns [start, end), and the last one also its end frame.
 */
export function cutWithin(doc: Pick<StageDoc, 'cuts'>, t: number): StageCut | null {
  const cuts = sortedCuts(doc);
  for (const c of cuts) if (c.start - EPS <= t && t < c.end - EPS) return c;
  const last = cuts[cuts.length - 1];
  return last && Math.abs(t - last.end) <= EPS ? last : null;
}

/** The film's camera at `t`: the live shot's camera then. */
export function editCamera(doc: Pick<StageDoc, 'cuts' | 'shots'>, t: number): CameraSample | null {
  const cut = cutAt(doc, t);
  const shot = cut ? doc.shots.find((s) => s.id === cut.shotId) : undefined;
  return shot ? sampleShot(shot, t) : null;
}

/**
 * Tidy an edit: cuts of shots that exist, inside [0, duration], sorted, at
 * least a frame long, a later cut trimming the one before it, neighbours on
 * the same shot joined.
 */
export function normalizeCuts(cuts: readonly StageCut[], doc: Pick<StageDoc, 'shots' | 'duration'>): StageCut[] {
  const shots = new Set(doc.shots.map((s) => s.id));
  const sorted = cuts
    .filter((c) => shots.has(c.shotId))
    .map((c) => ({ ...c, start: r2(Math.max(0, Math.min(doc.duration, c.start))), end: r2(Math.max(0, Math.min(doc.duration, c.end))) }))
    .sort((a, b) => a.start - b.start);
  const out: StageCut[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.end > c.start) prev.end = c.start;
    if (prev && prev.end - prev.start < 0.04) out.pop();
    const last = out[out.length - 1];
    if (last && last.shotId === c.shotId && Math.abs(last.end - c.start) < EPS) { last.end = Math.max(last.end, c.end); continue; }
    if (c.end - c.start >= 0.04) out.push({ ...c });
  }
  return out;
}

/**
 * The whole edit as a running order: each entry plays from its `start` until
 * the next one starts; the last until `end` (default the stage's duration).
 */
export function setSequence(doc: StageDoc, order: ReadonlyArray<{ shotId: string; start: number }>, end = doc.duration): StageDoc {
  const sorted = [...order].sort((a, b) => a.start - b.start);
  const cuts = sorted.map((o, i) => ({ id: uid('cut'), shotId: o.shotId, start: o.start, end: sorted[i + 1]?.start ?? end }));
  return { ...doc, cuts: normalizeCuts(cuts, doc) };
}

/**
 * "Cut to this shot here": from `t` the film shows `shotId`, until the next
 * cut after `t` (or, with none, the stage's end). The cut that was live at
 * `t` now ends there.
 */
export function cutTo(doc: StageDoc, shotId: string, t: number): StageDoc {
  const cuts = sortedCuts(doc);
  const next = cuts.find((c) => c.start > t + EPS);
  const live = cuts.find((c) => c.start <= t + EPS && c.end > t + EPS);
  const end = next?.start ?? (live ? live.end : doc.duration);
  const kept = cuts.flatMap((c) => {
    if (c === live) return c.start < t - EPS ? [{ ...c, end: t }] : [];
    return [c];
  });
  // With no edit yet, the film opens on this shot rather than starting mid-way.
  const start = cuts.length ? t : 0;
  return { ...doc, cuts: normalizeCuts([...kept, { id: uid('cut'), shotId, start, end: Math.max(end, start) }], doc) };
}

export function patchCut(doc: StageDoc, cutId: string, patch: Partial<Omit<StageCut, 'id'>>): StageDoc {
  return { ...doc, cuts: normalizeCuts(sortedCuts(doc).map((c) => (c.id === cutId ? { ...c, ...patch } : c)), doc) };
}

/** Move the boundary between a cut and the one after it, keeping them joined. */
export function moveCutEnd(doc: StageDoc, cutId: string, end: number): StageDoc {
  const cuts = sortedCuts(doc);
  const i = cuts.findIndex((c) => c.id === cutId);
  if (i < 0) return doc;
  const cut = cuts[i]!;
  const next = cuts[i + 1];
  const joined = next && Math.abs(next.start - cut.end) < EPS;
  const lo = cut.start + 0.1;
  const hi = joined ? next.end - 0.1 : doc.duration;
  const t = r2(Math.max(lo, Math.min(hi, end)));
  return { ...doc, cuts: cuts.map((c, k) => (k === i ? { ...c, end: t } : joined && k === i + 1 ? { ...c, start: t } : c)) };
}

export function removeCut(doc: StageDoc, cutId: string): StageDoc {
  return { ...doc, cuts: sortedCuts(doc).filter((c) => c.id !== cutId) };
}
