import { ease } from './camera.js';
import type { StageCharacter, StageMove, Vec3Tuple } from './types.js';

/** Where a character's moves put them at one moment, before any clip's own root motion. */
export interface MovePlacement {
  position: Vec3Tuple;
  /** Degrees; 0 faces -Z. */
  yaw: number;
  /** True while a move is under way. */
  moving: boolean;
}

/** The yaw that faces from `a` toward `b` on the floor (0 faces -Z, 90 faces -X, matching `StageCharacter.yaw`). */
export function yawToward(a: Vec3Tuple | [number, number, number], b: Vec3Tuple | [number, number, number]): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  if (Math.hypot(dx, dz) < 1e-6) return 0;
  return (Math.atan2(-dx, -dz) * 180) / Math.PI;
}

/** The unit floor direction a yaw faces. */
export function facingOf(yaw: number): [number, number] {
  const a = (yaw * Math.PI) / 180;
  return [-Math.sin(a), -Math.cos(a)];
}

export function sortedMoves(moves: readonly StageMove[] | undefined): StageMove[] {
  return [...(moves ?? [])].sort((a, b) => a.start - b.start);
}

/**
 * Place a character at stage time `t` from their moves: before the first,
 * where they were put; during one, along its path at even speed (eased);
 * after, where it left them, facing its last direction (or `endYaw`).
 */
export function sampleMoves(c: Pick<StageCharacter, 'position' | 'yaw' | 'moves'>, t: number): MovePlacement {
  let position: Vec3Tuple = [...c.position];
  let yaw = c.yaw;
  for (const m of sortedMoves(c.moves)) {
    if (m.start > t || !m.points.length) break;
    const path: Vec3Tuple[] = [position, ...m.points];
    const span = Math.max(1e-6, m.end - m.start);
    const u = t >= m.end ? 1 : ease(m.easing, (t - m.start) / span);
    const at = alongPath(path, u);
    if (t < m.end) {
      return { position: at.position, yaw: m.faceAlong === false ? yaw : at.heading ?? yaw, moving: true };
    }
    position = at.position;
    yaw = m.endYaw ?? (m.faceAlong === false ? yaw : at.heading ?? yaw);
  }
  return { position, yaw, moving: false };
}

/** A point `u` (0..1) of the way along a polyline by length, and the yaw of the segment it is on. */
export function alongPath(path: readonly Vec3Tuple[], u: number): { position: Vec3Tuple; heading: number | null } {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const l = Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1], path[i]![2] - path[i - 1]![2]);
    lengths.push(l);
    total += l;
  }
  if (total < 1e-9) return { position: [...path[path.length - 1]!], heading: null };
  let left = Math.min(1, Math.max(0, u)) * total;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!;
    if (l < 1e-9) continue;
    if (left <= l || i === lengths.length - 1) {
      const a = path[i]!;
      const b = path[i + 1]!;
      const k = Math.min(1, left / l);
      return {
        position: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
        heading: yawToward(a, b),
      };
    }
    left -= l;
  }
  return { position: [...path[path.length - 1]!], heading: null };
}

/** Length of a move's path in metres, starting from `from`. */
export function moveLength(from: Vec3Tuple, m: StageMove): number {
  let p = from;
  let total = 0;
  for (const q of m.points) {
    total += Math.hypot(q[0] - p[0], q[2] - p[2]);
    p = q;
  }
  return total;
}
