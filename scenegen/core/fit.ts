/**
 * Put a SAM 3D object where the blockout says it is.
 *
 * SAM 3D poses its splat in the frame of the crop it saw (x left, y up, z
 * forward - verified on the earlier object-swap work), at its own scale. So
 * its heading is trusted - turned into the world through the crop camera, it
 * faces the way the object faced in the panorama, which followed the blockout
 * - and its size and place come from the blockout box: the scale that best
 * matches the box's width, height and depth, and the box's base centre.
 *
 * Result in the scene FILE's frame: the capture point at the origin, metres, Y up.
 */
import { basis } from './frame.ts';
import type { CameraPose } from './frame.ts';
import type { Gaussians, Mat3 } from './gaussians.ts';
import { bounds, transformGaussians } from './gaussians.ts';
import type { LayoutObject } from './types.ts';

export interface FitResult { scale: number; ratios: [number, number, number]; dims: [number, number, number]; spread: number }

/** Rotation that takes SAM 3D's crop frame (x left, y up, z forward) into the world, for a crop camera. */
export function cropToWorld(crop: CameraPose): Mat3 {
  const { right, up, forward } = basis(crop);
  // Columns: where the crop's x (left), y (up) and z (forward) axes point in the world.
  return [
    [-right[0], up[0], forward[0]],
    [-right[1], up[1], forward[1]],
    [-right[2], up[2], forward[2]],
  ];
}

/**
 * Fit in place. `capture` is where the panorama was taken (world); the output frame has it at the origin.
 * `spread` is how much the three size ratios disagree (max / min): near 1 means SAM 3D's shape matches the box.
 */
export function fitToBlockout(g: Gaussians, obj: LayoutObject, crop: CameraPose, capture: [number, number, number]): FitResult {
  // 1. Into world axes (no translation yet), centred on the object's own middle.
  transformGaussians(g, cropToWorld(crop), 1, [0, 0, 0]);
  // 2. Its extent along the blockout object's own axes (front = +Z turned by yaw).
  const yaw = (obj.yaw * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
  const local: Mat3 = [[c, 0, -s], [0, 1, 0], [s, 0, c]]; // world → object-local (inverse of the yaw turn)
  const probe = { ...g, positions: new Float32Array(g.positions) };
  transformGaussians({ ...probe, scales: new Float32Array(g.scales), rotations: new Float32Array(g.rotations) }, local, 1, [0, 0, 0]);
  const b = bounds(probe);
  const dims: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const ratios = [0, 1, 2].map((k) => obj.size[k]! / Math.max(1e-6, dims[k]!)) as [number, number, number];
  // Median ratio: one axis seen edge-on (thin, badly completed) cannot drag the whole object.
  const scale = [...ratios].sort((x, y) => x - y)[1]!;
  // 3. Scale about the origin, then move the box's base centre onto the blockout's footprint centre.
  transformGaussians(g, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], scale, [0, 0, 0]);
  const wb = bounds(g);
  const t: [number, number, number] = [
    obj.position[0] - (wb.min[0] + wb.max[0]) / 2 - capture[0],
    obj.position[1] - wb.min[1] - capture[1],
    obj.position[2] - (wb.min[2] + wb.max[2]) / 2 - capture[2],
  ];
  transformGaussians(g, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], 1, t);
  return { scale, ratios, dims, spread: Math.max(...ratios) / Math.min(...ratios) };
}
