import type { StageClip } from './types.js';

/** What a character's body shows at one moment: a clip, and how far into it (seconds). */
export interface ClipSample {
  clip: StageClip;
  /** Seconds into the clip's own motion. */
  local: number;
}

/**
 * The clip a track shows at stage time `t`, given each clip's own length in
 * seconds (`lengthOf`, unknown until it has loaded). Between clips the last one
 * holds its final pose; before the first, the first holds its opening pose.
 * Where clips overlap, the one starting later wins.
 */
export function sampleTrack(
  clips: readonly StageClip[],
  t: number,
  lengthOf: (clip: StageClip) => number | null,
): ClipSample | null {
  if (!clips.length) return null;
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  let current: StageClip | null = null;
  for (const c of sorted) if (c.start <= t) current = c;
  if (!current) return { clip: sorted[0]!, local: 0 };
  const length = lengthOf(current);
  const into = Math.min(t, current.end) - current.start;
  if (!length || length <= 0) return { clip: current, local: Math.max(0, into) };
  if (current.loop) return { clip: current, local: ((into % length) + length) % length };
  return { clip: current, local: Math.min(Math.max(0, into), length) };
}

/**
 * How far a track has carried its character by stage time `t` - root motion,
 * summed: every clip that has played contributes the ground it covered, a
 * looping clip once per lap, and the clip playing now as far as it has got.
 * A clip is cut short where the next one starts (as in `sampleTrack`); a clip
 * with `rootMotion: false`, or not loaded yet, covers no ground.
 *
 * `travelOf(clip, local)` is the clip's own travel `local` seconds in, in the
 * body's frame (x right, z forward of the rig), from where it started; the
 * caller turns and scales the sum into the world.
 */
export function trackTravel(
  clips: readonly StageClip[],
  t: number,
  lengthOf: (clip: StageClip) => number | null,
  travelOf: (clip: StageClip, local: number) => [number, number] | null,
): [number, number] {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  let x = 0;
  let z = 0;
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (c.start > t) break;
    if (c.rootMotion === false) continue;
    const len = lengthOf(c);
    if (!len || len <= 0) continue;
    const stop = Math.min(t, c.end, sorted[i + 1]?.start ?? Infinity);
    const elapsed = Math.max(0, stop - c.start);
    const add = (local: number, times = 1) => {
      const d = travelOf(c, local);
      if (d) { x += d[0] * times; z += d[1] * times; }
    };
    if (c.loop) {
      const laps = Math.floor(elapsed / len);
      if (laps > 0) add(len, laps);
      add(elapsed - laps * len);
    } else {
      add(Math.min(elapsed, len));
    }
  }
  return [x, z];
}

/** Clips that overlap `[start, end)`, other than `except`. */
export function overlapping(clips: readonly StageClip[], start: number, end: number, except?: string): StageClip[] {
  return clips.filter((c) => c.id !== except && c.start < end && start < c.end);
}

/** Where a new clip of `length` seconds can go on a track: right after the last one. */
export function nextFreeStart(clips: readonly StageClip[]): number {
  return clips.reduce((at, c) => Math.max(at, c.end), 0);
}
