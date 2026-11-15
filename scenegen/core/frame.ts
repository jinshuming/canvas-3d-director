/**
 * Frames.
 *
 * WORLD (the scene generator's, and the director stage's): metres, +Y up, the
 * floor at y = 0, +X east, -Z north. A camera's `yaw` is in degrees clockwise
 * seen from above: 0 looks north (-Z), 90 east (+X). `pitch` looks up when
 * positive.
 *
 * JST-2 c2w: a 4x4 camera-to-world matrix whose rotation columns are the
 * camera's x (RIGHT), y (DOWN) and z (FORWARD) axes - OpenCV - expressed in
 * whatever world the caller uses. `custom-pano` takes our world as is.
 *
 * EQUIRECT (our renders, and the panoramas we send): image centre = the
 * camera's forward, longitude grows to the right, the top row is straight up.
 */

export type Vec3 = [number, number, number];
export type Mat4 = number[][];

export const DEG = Math.PI / 180;

export interface CameraPose { position: Vec3; yaw: number; pitch?: number }

export function forwardOf(yaw: number, pitch = 0): Vec3 {
  const y = yaw * DEG, p = pitch * DEG;
  return [Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function norm(a: Vec3): Vec3 { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
export function sub(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
export function add(a: Vec3, b: Vec3): Vec3 { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
export function scale(a: Vec3, s: number): Vec3 { return [a[0] * s, a[1] * s, a[2] * s]; }

/** Camera basis in the world: right, up, forward (a level camera has no roll). */
export function basis(pose: CameraPose): { right: Vec3; up: Vec3; forward: Vec3 } {
  const forward = forwardOf(pose.yaw, pose.pitch ?? 0);
  const right = norm(cross(forward, [0, 1, 0]));
  const up = cross(right, forward);
  return { right, up, forward };
}

/** The JST-2 c2w of a camera pose in our world: columns right, DOWN, forward, then position. */
export function poseToC2W(pose: CameraPose): Mat4 {
  const { right, up, forward } = basis(pose);
  const down = scale(up, -1);
  const t = pose.position;
  return [
    [right[0], down[0], forward[0], t[0]],
    [right[1], down[1], forward[1], t[1]],
    [right[2], down[2], forward[2], t[2]],
    [0, 0, 0, 1],
  ];
}

/**
 * The c2w to SEND to JST-2 for a pose in our world.
 *
 * Measured 2026-11-15 (docs/SCENEGEN_DESIGN.md §2.6): `custom-pano` treats the
 * caller's world as OpenCV-like (Y down, Z forward) and writes the .spz with Y
 * and Z flipped (a 180° turn about X) so the file is Y-up. Sending our Y-up
 * pose as is therefore comes back upside down. So we send the pose in the
 * flipped world F·world, F = diag(1, -1, -1): the file then comes back in OUR
 * world, Y up. The same holds for `generate`'s targetC2w on that session.
 */
export function toServiceC2W(pose: CameraPose): Mat4 {
  const m = poseToC2W(pose);
  return [m[0]!.slice(), m[1]!.map((v) => -v), m[2]!.map((v) => -v), m[3]!.slice()].map((r) => r.map((v) => (Object.is(v, -0) ? 0 : v)));
}

/** A c2w the service returned (flipped world) back to our world. */
export function fromServiceC2W(m: Mat4): Mat4 {
  return [m[0]!.slice(), m[1]!.map((v) => -v), m[2]!.map((v) => -v), m[3]!.slice()].map((r) => r.map((v) => (Object.is(v, -0) ? 0 : v)));
}

/** Inverse of `poseToC2W` for a level (roll-free) camera. */
export function c2wToPose(m: Mat4): CameraPose {
  const forward: Vec3 = [m[0]![2]!, m[1]![2]!, m[2]![2]!];
  const yaw = Math.atan2(forward[0], -forward[2]) / DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward[1]))) / DEG;
  return { position: [m[0]![3]!, m[1]![3]!, m[2]![3]!], yaw, pitch };
}

/** Direction (world) of an equirect pixel centre for a camera pose. */
export function equirectDir(u: number, v: number, w: number, h: number, b: { right: Vec3; up: Vec3; forward: Vec3 }): Vec3 {
  const lon = ((u + 0.5) / w) * 2 * Math.PI - Math.PI;
  const lat = Math.PI / 2 - ((v + 0.5) / h) * Math.PI;
  const cl = Math.cos(lat);
  const f = cl * Math.cos(lon), r = cl * Math.sin(lon), s = Math.sin(lat);
  return [
    b.forward[0] * f + b.right[0] * r + b.up[0] * s,
    b.forward[1] * f + b.right[1] * r + b.up[1] * s,
    b.forward[2] * f + b.right[2] * r + b.up[2] * s,
  ];
}

/** Equirect pixel (fractional) of a world direction, for a camera pose. */
export function dirToEquirect(d: Vec3, w: number, h: number, b: { right: Vec3; up: Vec3; forward: Vec3 }): [number, number] {
  const f = dot(d, b.forward), r = dot(d, b.right), s = dot(d, b.up);
  const lon = Math.atan2(r, f);
  const lat = Math.atan2(s, Math.hypot(f, r));
  return [((lon + Math.PI) / (2 * Math.PI)) * w - 0.5, ((Math.PI / 2 - lat) / Math.PI) * h - 0.5];
}
