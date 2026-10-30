import { Pose } from '@viggle/splat-engine';
import type { Armature } from '@viggle/splat-engine';
import { Quat, Vec3 } from 'playcanvas';

/**
 * Two read-only questions the stage asks of a character's active clip, which
 * the published engine (`@viggle/splat-engine`, pinned) does not answer
 * directly. Both are pure functions of the clip time: they evaluate the clip
 * into a scratch pose and never move or redraw the character.
 */

/** The engine's internals the travel probe needs (present in the pinned version). */
interface ArmatureInternals {
  _player: { evaluateAt(frameTime: number, out: Pose): boolean } | null;
  _resolveRigIndices(): void;
  _pelvisBoneIndex: number;
  _pelvisOffsetToEntitySpace(pose: Pose, x: number, z: number): Vec3;
}

const scratch = new WeakMap<Armature, Pose>();
const poseFor = (arm: Armature) => {
  let p = scratch.get(arm);
  if (!p) scratch.set(arm, (p = new Pose(arm.skeleton.numBones)));
  return p;
};

/**
 * How far the active clip's pelvis has travelled on X/Z at `frameTime`, from
 * where it stood at frame 0, in entity space - root motion as a pure function
 * of time, so a timeline can ask for any frame in any order. Read before the
 * rig clamps (which pin the pelvis to bind), so it goes through the engine's
 * internals. Null with no clip or no pelvis.
 */
export function probeRootTravel(arm: Armature, frameTime: number): { x: number; z: number } | null {
  const a = arm as unknown as ArmatureInternals;
  if (!a._player) return null;
  a._resolveRigIndices();
  const p = a._pelvisBoneIndex;
  if (p < 0) return null;
  const pose = poseFor(arm);
  if (!a._player.evaluateAt(0, pose)) return null;
  const x0 = pose.positions[p]!.x;
  const z0 = pose.positions[p]!.z;
  if (!a._player.evaluateAt(frameTime, pose)) return null;
  const o = a._pelvisOffsetToEntitySpace(pose, pose.positions[p]!.x - x0, pose.positions[p]!.z - z0);
  return { x: o.x, z: o.z };
}

/**
 * Which way the active clip's body faces at `frameTime`, in entity space:
 * degrees about +Y from +Z (atan2(x, z)), read off the shoulder line, so it
 * does not depend on how a rig's bones are oriented. About 0 on clips captured
 * facing the rig's forward; a clip captured with the actor turned (the
 * conversation clips are recorded side-on) reads its turn. Null with no clip
 * or no clavicles.
 */
export function probeFacing(arm: Armature, frameTime: number): number | null {
  const names = arm.rigBoneNames;
  const find = (side: 'l' | 'r') => names.findIndex((n) => {
    const k = n.toLowerCase().replace(/^.*:/, '').replace(/^mixamorig/, '');
    return k === `clavicle_${side}` || k === (side === 'l' ? 'leftshoulder' : 'rightshoulder');
  });
  const l = find('l');
  const r = find('r');
  if (l < 0 || r < 0) return null;
  // The rig clamps only pin the pelvis and root translation: the shoulder line keeps its direction.
  const pose = poseFor(arm);
  if (!arm.probePose(frameTime, pose)) return null;
  const parents = arm.skeleton.parents;
  // Forward kinematics up each shoulder's chain, in entity space.
  const at = (bone: number) => {
    const chain: number[] = [];
    for (let i = bone; i >= 0; i = parents[i]!) chain.unshift(i);
    const q = new Quat();
    const p = new Vec3();
    const v = new Vec3();
    for (const i of chain) {
      q.transformVector(pose.positions[i]!, v);
      p.add(v);
      q.mul(pose.rotations[i]!);
    }
    return p;
  };
  const a = at(l);
  const b = at(r);
  // Forward = up × (right shoulder - left shoulder).
  const rx = b.x - a.x;
  const rz = b.z - a.z;
  if (Math.hypot(rx, rz) < 1e-6) return null;
  return (Math.atan2(rz, -rx) * 180) / Math.PI;
}
