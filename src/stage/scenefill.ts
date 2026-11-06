import { fileToWorldPoint, placeWalkScene, worldToFilePoint } from '../walk/placement.js';
import type { CameraSample } from './camera.js';
import type { StageDoc, Vec3Tuple } from './types.js';

/**
 * What filling a view of the scene needs from the stage, shared by the agent's `fill_scene_view` and
 * the editor's "expand the scene" panel: whether this scene can be filled at all, which version of it
 * a check belongs to, and a camera pose given in the editor's world turned into the scene file's own
 * frame (the one Viggle's scene API takes).
 */

/** A camera pose: where it stands (stage metres, +Y up) and which way it looks (degrees). */
export interface FillPose {
  position: Vec3Tuple;
  /** As for characters: 0 looks -Z, 90 looks -X. */
  yaw: number;
  /** Positive looks up. */
  pitch: number;
}

/** How many image batches the scene holds: it changes every time a fill lands, which is what retires a check's ids. */
export const sceneVersion = (doc: StageDoc): number => doc.scene?.viggle?.batchIds.length ?? 0;

/** Why this scene cannot be filled, or null when it can. A check works on any scene; a fill needs the Viggle session. */
export function fillBlock(doc: StageDoc): string | null {
  if (!doc.scene) return 'No scene yet: set_scene first.';
  if (!doc.scene.viggle?.sessionId) return 'This scene cannot be filled: only a scene generated here keeps its Viggle session (a preset or imported file has none). Keep people and cameras away from the gaps, or generate a new scene.';
  if (!doc.scene.placement) return 'The scene is not measured yet: call get_world_layout, then try again.';
  if (!doc.scene.placement.upright) return 'This scene file is stored in a frame fills cannot be aimed in (only .spz scenes can be filled).';
  return null;
}

/** A camera's pose: its position, and the yaw and pitch of the way it looks. */
export function poseOfCamera(cam: Pick<CameraSample, 'position' | 'target'>): FillPose {
  const f = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
  const len = Math.hypot(f[0]!, f[1]!, f[2]!) || 1;
  // `+ 0` turns a -0 (looking straight down -Z) into 0.
  return {
    position: [cam.position[0], cam.position[1], cam.position[2]],
    yaw: Math.round((Math.atan2(-f[0]! / len, -f[2]! / len) * 180) / Math.PI) + 0,
    pitch: Math.round((Math.asin(Math.max(-1, Math.min(1, f[1]! / len))) * 180) / Math.PI) + 0,
  };
}

/** The pose in the scene file's frame and units, for the fill request. Throws when the scene cannot be filled. */
export function fillPoseToFile(doc: StageDoc, pose: FillPose): FillPose {
  const block = fillBlock(doc);
  if (block) throw new Error(block);
  const mount = placeWalkScene(doc.scene!.placement!);
  return { position: worldToFilePoint(mount, pose.position), yaw: pose.yaw - mount.rotation.y, pitch: pose.pitch };
}

/** Where the panorama was taken, in stage metres: the file's origin, mounted. Null before the scene is measured. */
export function captureOf(doc: StageDoc): Vec3Tuple | null {
  if (!doc.scene?.placement) return null;
  const p = fileToWorldPoint(placeWalkScene(doc.scene.placement), [0, 0, 0]);
  return [p.x, p.y, p.z];
}
