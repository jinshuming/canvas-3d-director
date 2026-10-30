import type { CameraKey, Easing, Interpolation, StageShot, Vec3Tuple } from './types.js';

/** Where a shot's camera is at one moment. */
export interface CameraSample {
  position: Vec3Tuple;
  target: Vec3Tuple;
  fov: number;
}

const EASE: Record<Easing, (u: number) => number> = {
  linear: (u) => u,
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - (1 - u) ** 3,
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - (-2 * u + 2) ** 3 / 2),
};

export function ease(easing: Easing, u: number): number {
  return EASE[easing](Math.min(1, Math.max(0, u)));
}

/** Keys in time order. */
export function sortedKeys(keys: readonly CameraKey[]): CameraKey[] {
  return [...keys].sort((a, b) => a.t - b.t);
}

/** The time a shot covers: its first key to its last; null with no keys. */
export function shotSpan(shot: StageShot): [number, number] | null {
  if (!shot.keys.length) return null;
  const keys = sortedKeys(shot.keys);
  return [keys[0]!.t, keys[keys.length - 1]!.t];
}

/**
 * The camera at stage time `t`. Before the first key it holds the first,
 * after the last the last. Easing remaps time across the whole move (path and
 * timing are separate, as in a DCC's time-warp curve); the path between keys
 * is linear, a Catmull-Rom curve through the keys, or a jump at each key.
 */
export function sampleShot(shot: StageShot, t: number): CameraSample | null {
  const keys = sortedKeys(shot.keys);
  if (!keys.length) return null;
  const first = keys[0]!;
  const last = keys[keys.length - 1]!;
  if (keys.length === 1 || t <= first.t) return copy(first);
  if (t >= last.t) return copy(last);
  const span = last.t - first.t;
  const warped = first.t + ease(shot.easing, (t - first.t) / span) * span;
  let i = 0;
  while (i < keys.length - 2 && warped >= keys[i + 1]!.t) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const dt = b.t - a.t;
  const u = dt > 0 ? Math.min(1, Math.max(0, (warped - a.t) / dt)) : 1;
  return interpolate(shot.interpolation, keys, i, u);
}

function interpolate(mode: Interpolation, keys: CameraKey[], i: number, u: number): CameraSample {
  const a = keys[i]!;
  const b = keys[i + 1]!;
  if (mode === 'step') return copy(u < 1 ? a : b);
  const fov = a.fov + (b.fov - a.fov) * u;
  if (mode === 'linear') return { position: lerp3(a.position, b.position, u), target: lerp3(a.target, b.target, u), fov };
  const p0 = keys[Math.max(0, i - 1)]!;
  const p3 = keys[Math.min(keys.length - 1, i + 2)]!;
  return {
    position: catmull(p0.position, a.position, b.position, p3.position, u),
    target: catmull(p0.target, a.target, b.target, p3.target, u),
    fov,
  };
}

function copy(k: CameraKey): CameraSample {
  return { position: [...k.position], target: [...k.target], fov: k.fov };
}

function lerp3(a: Vec3Tuple, b: Vec3Tuple, u: number): Vec3Tuple {
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

/** Uniform Catmull-Rom: passes through `b` at 0 and `c` at 1. */
function catmull(a: Vec3Tuple, b: Vec3Tuple, c: Vec3Tuple, d: Vec3Tuple, u: number): Vec3Tuple {
  const u2 = u * u;
  const u3 = u2 * u;
  const out: Vec3Tuple = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    out[k] = 0.5 * (2 * b[k]! + (-a[k]! + c[k]!) * u + (2 * a[k]! - 5 * b[k]! + 4 * c[k]! - d[k]!) * u2 + (-a[k]! + 3 * b[k]! - 3 * c[k]! + d[k]!) * u3);
  }
  return out;
}

/** Points along a shot's path, for drawing it. */
export function shotPath(shot: StageShot, samples = 64): Vec3Tuple[] {
  const span = shotSpan(shot);
  if (!span) return [];
  const [t0, t1] = span;
  if (t1 <= t0) return [sampleShot(shot, t0)!.position];
  const out: Vec3Tuple[] = [];
  for (let i = 0; i <= samples; i++) out.push(sampleShot(shot, t0 + ((t1 - t0) * i) / samples)!.position);
  return out;
}
