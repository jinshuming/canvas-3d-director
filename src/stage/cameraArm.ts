import type { SceneCollider } from '@viggle/splat-engine';

/**
 * How far from a subject's head a camera may sit before a wall gets between them, and whether the camera is
 * inside one. The boom runs from the head to the eye; the eye only ever slides along it.
 *
 * Copied from PINOC (src/components/viewer3d/cameraArm.ts: `boomFor`, `pivotFor`, `armReach`, `clearReach`,
 * `insideReach`): the follow camera's spring and fade are left out, the wall tests are as they were.
 */

/** The boom's pivot, in walker heights above her feet: her head. */
const PIVOT_HEIGHTS = 0.85;

type Vec3 = { x: number; y: number; z: number };

/** The boom's sizes for one walker, world units. */
export interface Boom {
  /** An orbit this close to her head is left alone. */
  min: number;
  /** The eye is a ball this big: it stops this far off a wall, and keeps off one it only skims past. */
  radius: number;
  /** The ball is only checked past this, where her head may be near a wall. */
  skip: number;
}

/** The boom for a walker `height` tall. */
export function boomFor(height: number): Boom {
  return { min: height * 0.15, radius: height * 0.1, skip: height * 0.25 };
}

/** Where the boom pivots: her head. */
export function pivotFor(feet: Vec3, height: number): Vec3 {
  return { x: feet.x, y: feet.y + height * PIVOT_HEIGHTS, z: feet.z };
}

const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (a: Vec3): number => Math.hypot(a.x, a.y, a.z);
const along = (o: Vec3, d: Vec3, t: number): Vec3 => ({ x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t });

/** The boom length the walls allow from `pivot` toward `eye`: short of the
 *  first wall on the line, and of any the eye would skim. */
export function armReach(collider: SceneCollider, pivot: Vec3, eye: Vec3, boom: Boom): number {
  const full = len(sub(eye, pivot));
  if (!(full > boom.min)) return full;
  const dir = sub(eye, pivot);
  const unit = { x: dir.x / full, y: dir.y / full, z: dir.z / full };
  const hit = collider.raycast(pivot, unit, full + boom.radius);
  const reach = hit === null ? full : Math.min(full, hit - boom.radius);
  return clearReach(collider, pivot, unit, Math.max(0, reach), boom);
}

/** How far along unit `dir` the eye's ball stays clear, up to `end`. */
function clearReach(collider: SceneCollider, from: Vec3, dir: Vec3, end: number, boom: Boom): number {
  const start = Math.max(boom.skip, boom.min);
  if (!(end > start) || !(boom.radius > 0)) return end;
  const clear = (t: number) => collider.isClear(along(from, dir, t), boom.radius);
  if (!clear(start)) {
    // A wall right by her head: as far out as the ball clears it, from her head.
    let lo = 0, hi = start;
    for (let i = 0; i < 6; i++) {
      const mid = (lo + hi) / 2;
      if (clear(mid)) lo = mid; else hi = mid;
    }
    return lo;
  }
  // Steps of one radius leave no gap a wall could hide in between the balls.
  let free = start;
  for (let t = start + boom.radius; ; t += boom.radius) {
    const probe = Math.min(t, end);
    if (!clear(probe)) {
      let hi = probe;
      for (let i = 0; i < 5; i++) {
        const mid = (free + hi) / 2;
        if (clear(mid)) free = mid; else hi = mid;
      }
      return free;
    }
    free = probe;
    if (probe >= end) return end;
  }
}

/** The boom an eye inside a wall is pulled back to: that wall's near side.
 *  The whole boom when the eye is in the open. */
export function insideReach(collider: SceneCollider, pivot: Vec3, eye: Vec3, boom: Boom): number {
  const full = len(sub(eye, pivot));
  if (!(full > boom.min) || collider.isClear(eye, boom.radius)) return full;
  const d = sub(eye, pivot);
  const unit = { x: d.x / full, y: d.y / full, z: d.z / full };
  const clear = (t: number) => collider.isClear(along(pivot, unit, t), boom.radius);
  let hi = full;
  for (let t = full - boom.radius; t > 0; t -= boom.radius) {
    if (clear(t)) {
      let lo = t;
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2;
        if (clear(mid)) lo = mid; else hi = mid;
      }
      return lo;
    }
    hi = t;
  }
  return 0;
}
