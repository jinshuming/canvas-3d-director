/**
 * The rough fit of a SAM 3D object to its blockout box, done once when the object is generated.
 *
 * SAM 3D poses its splat in the frame of the crop it saw (x left, y up, z forward), at its own
 * scale. Here it is turned into the world through the crop camera, scaled by the median of the
 * box-size ratios and stood on the box's base centre. The placement at compose time (place.ts)
 * starts from this and decides up, level, heading, size and place again.
 *
 * Result in the scene FILE's frame: the capture point at the origin, metres, Y up.
 */
import { basis } from './frame.ts';
import type { CameraPose } from './frame.ts';
import type { Gaussians, Mat3 } from './gaussians.ts';
import { bounds, IDENTITY, rotY, transformGaussians, translateGaussians } from './gaussians.ts';
import type { LayoutObject } from './types.ts';

export interface FitResult { scale: number; ratios: [number, number, number]; dims: [number, number, number]; spread: number }

/** Rotation that takes SAM 3D's crop frame (x left, y up, z forward) into the world, for a crop camera. */
function cropToWorld(crop: CameraPose): Mat3 {
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
  // 1. Into world axes (no translation yet).
  transformGaussians(g, cropToWorld(crop), 1, [0, 0, 0]);
  // 2. Its extent along the blockout object's own axes (world → object-local: turn by -yaw), on a copy.
  const probe = { ...g, positions: new Float32Array(g.positions), scales: new Float32Array(g.scales), rotations: new Float32Array(g.rotations) };
  const b = bounds(transformGaussians(probe, rotY(-obj.yaw), 1, [0, 0, 0]));
  const dims: [number, number, number] = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  const ratios = [0, 1, 2].map((k) => obj.size[k]! / Math.max(1e-6, dims[k]!)) as [number, number, number];
  // Median ratio: one axis seen edge-on (thin, badly completed) cannot drag the whole object.
  const scale = [...ratios].sort((x, y) => x - y)[1]!;
  // 3. Scale about the origin, then move the box's base centre onto the blockout's footprint centre.
  transformGaussians(g, IDENTITY, scale, [0, 0, 0]);
  const wb = bounds(g);
  translateGaussians(g, [
    obj.position[0] - (wb.min[0] + wb.max[0]) / 2 - capture[0],
    obj.position[1] - wb.min[1] - capture[1],
    obj.position[2] - (wb.min[2] + wb.max[2]) / 2 - capture[2],
  ]);
  return { scale, ratios, dims, spread: Math.max(...ratios) / Math.min(...ratios) };
}
