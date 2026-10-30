/**
 * The Stage document: one scene, the characters standing in it, what each of
 * them does when, and the shots that film it. Plain JSON - the single source
 * of truth the editor, the server and (later) an agent all read and write.
 *
 * WORLD UNITS ARE METRES, +Y up. The scene is mounted so its capture point's
 * floor is the origin (see `placeWalkScene`); a character's `position` is
 * where its feet stand.
 */

export type Vec3Tuple = [number, number, number];

export interface StageScene {
  /** Display name. */
  name: string;
  /** The splat file: `.spz`, `.sog`, `.ply`. */
  url: string;
  /** How the file is mounted in metres; null until the floor has been measured. */
  placement: StagePlacement | null;
  /** The Viggle scene task it came from, to fill views later. */
  viggle?: { sessionId: string; batchIds: string[] } | null;
  /** The panorama it was built from, for a cover. */
  panoramaUrl?: string | null;
}

export interface StagePlacement {
  upright: boolean;
  /** Metres per file unit. */
  scale: number;
  /** File units from the capture point down to the floor. */
  floor: number;
  /** The walk start, file units on the floor plane. */
  start: [number, number];
}

/** One stretch of a motion on a character's track. */
export interface StageClip {
  id: string;
  name: string;
  /** A `.glb` on the Viggle splat rig (MetaHuman), e.g. a Viggle motion's `metahuman_url`. */
  url: string;
  /** Seconds on the stage timeline. */
  start: number;
  /** Seconds on the stage timeline; `end > start`. */
  end: number;
  /** Repeat until `end`; otherwise play once and hold the last pose. */
  loop: boolean;
  /**
   * Let the clip carry the body: a walk walks off along the character's
   * facing, and the next clip starts where this one left them. Default true;
   * false plays it on the spot.
   */
  rootMotion?: boolean;
}

export interface StageCharacter {
  id: string;
  name: string;
  /** A Viggle `.vsplat`. */
  url: string;
  /** Feet, metres: where they stand before their first move. */
  position: Vec3Tuple;
  /** Degrees about +Y; 0 faces -Z (away from a camera at the capture point looking forward). */
  yaw: number;
  /** Body height in metres. */
  height: number;
  clips: StageClip[];
  /** Directed movement along paths: where the body goes, independent of what its clips do. */
  moves?: StageMove[];
}

/**
 * One directed movement: from where the character stands at `start`, through
 * `points`, arriving at the last at `end`. Speed is even along the path
 * (eased at the ends). Moves do not overlap; between them the body holds
 * where the last one left it. Pair a move with an in-place walk or run clip
 * (`rootMotion: false`) so the feet match the travel.
 */
export interface StageMove {
  id: string;
  /** Seconds on the stage timeline. */
  start: number;
  end: number;
  /** Waypoints in metres, feet on the floor; the last is where the move ends. */
  points: Vec3Tuple[];
  easing: Easing;
  /** Turn to face the way they walk (default true); otherwise keep facing as before. */
  faceAlong?: boolean;
  /** Degrees to face on arrival; default the path's final direction. */
  endYaw?: number;
}

export type Interpolation = 'linear' | 'smooth' | 'step';
export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut';

/** A camera key: where the camera stands, the point it looks at, and its vertical field of view. */
export interface CameraKey {
  id: string;
  /** Seconds on the stage timeline. */
  t: number;
  position: Vec3Tuple;
  target: Vec3Tuple;
  /** Vertical field of view, degrees. */
  fov: number;
}

export interface StageShot {
  id: string;
  name: string;
  /** Sorted by `t`. */
  keys: CameraKey[];
  interpolation: Interpolation;
  /** Time easing across the whole move, first key to last. */
  easing: Easing;
}

/**
 * One stretch of the edit: from `start` to `end` (stage seconds) the film
 * looks through `shotId`. Every shot films the same performance on the same
 * clock, so a cut picks a camera; it does not retime anything.
 */
export interface StageCut {
  id: string;
  shotId: string;
  start: number;
  end: number;
}

export type StageAspect = '16:9' | '9:16' | '1:1' | '4:3' | '2.39:1';

export interface StageDoc {
  id: string;
  /** Bumped by the server on each write; a write must name the version it was made from. */
  version: number;
  title: string;
  /** Seconds. */
  duration: number;
  fps: number;
  aspect: StageAspect;
  scene: StageScene | null;
  characters: StageCharacter[];
  shots: StageShot[];
  /** The edit: which shot the film shows when, sorted, without overlaps. Absent or empty: no edit yet. */
  cuts?: StageCut[];
  updatedAt: string;
}

export const ASPECTS: Record<StageAspect, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
  '4:3': 4 / 3,
  '2.39:1': 2.39,
};
