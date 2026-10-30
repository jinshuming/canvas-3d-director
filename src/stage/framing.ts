import type { CameraSample } from './camera.js';
import type { Vec3Tuple } from './types.js';

/**
 * Film grammar as numbers: a shot size, an angle and a side become a camera,
 * so an agent can say "medium shot, low angle, three-quarter left" instead of
 * guessing coordinates.
 */

/** How much of the subject the frame's height holds, in body heights, and where the lens aims (fraction of height). */
export const SHOT_SIZES = {
  // Each frames [aim - frame/2, aim + frame/2] of the body, with a little room above the head.
  extreme_wide: { frame: 7, aim: 0.5 },
  wide: { frame: 3.2, aim: 0.5 },
  full: { frame: 1.35, aim: 0.5 },
  medium_full: { frame: 1.1, aim: 0.56 },
  medium: { frame: 0.72, aim: 0.7 },
  medium_close: { frame: 0.46, aim: 0.8 },
  close_up: { frame: 0.3, aim: 0.86 },
  extreme_close_up: { frame: 0.14, aim: 0.9 },
} as const;
export type ShotSize = keyof typeof SHOT_SIZES;

/** Camera elevation, degrees above the aim point (negative looks up at the subject). */
export const ANGLES = { eye_level: 0, low: -22, worm: -50, high: 28, overhead: 70 } as const;
export type ShotAngle = keyof typeof ANGLES;

/** Where the camera stands round the subject, degrees from the way they face (0 = in front of them). */
export const SIDES = {
  front: 0, three_quarter_left: 40, left: 90, back_left: 140, back: 180, back_right: -140, right: -90, three_quarter_right: -40,
} as const;
export type ShotSide = keyof typeof SIDES;

export interface FramingInput {
  /** Feet of the subject. */
  subject: Vec3Tuple;
  /** Subject height, metres. */
  height: number;
  /** The way the subject faces, degrees (StageCharacter.yaw). */
  facing: number;
  size: ShotSize;
  angle?: ShotAngle | number;
  side?: ShotSide | number;
  /** Vertical field of view, degrees. Default 40 (about a 33 mm lens). */
  fov?: number;
  /** Move the aim point sideways in frame, -1..1 of half the frame width (rule of thirds is about ±0.33). */
  offset?: number;
}

/** The camera that frames a subject as asked. */
export function frameSubject(f: FramingInput): CameraSample {
  const size = SHOT_SIZES[f.size];
  const fov = f.fov ?? 40;
  const elevation = typeof f.angle === 'number' ? f.angle : ANGLES[f.angle ?? 'eye_level'];
  const around = typeof f.side === 'number' ? f.side : SIDES[f.side ?? 'front'];
  const aim: Vec3Tuple = [f.subject[0], f.subject[1] + f.height * size.aim, f.subject[2]];
  // Distance at which `frame` body heights fill the vertical field of view.
  const distance = (size.frame * f.height) / 2 / Math.tan(((fov / 2) * Math.PI) / 180);
  // The subject faces `facing`; the camera stands `around` degrees round from in front of them.
  const heading = ((f.facing + 180 + around) * Math.PI) / 180;
  const el = (elevation * Math.PI) / 180;
  const dirX = -Math.sin(heading) * Math.cos(el);
  const dirZ = -Math.cos(heading) * Math.cos(el);
  const position: Vec3Tuple = [aim[0] - dirX * distance, aim[1] + Math.sin(el) * distance, aim[2] - dirZ * distance];
  // A low camera must not go through the floor.
  position[1] = Math.max(f.subject[1] + 0.15, position[1]);
  let target = aim;
  if (f.offset) {
    // Shift the aim sideways so the subject sits off-centre.
    const halfW = Math.tan(((fov / 2) * Math.PI) / 180) * distance * (16 / 9);
    const rx = Math.cos(heading);
    const rz = -Math.sin(heading);
    target = [aim[0] - rx * f.offset * halfW, aim[1], aim[2] - rz * f.offset * halfW];
  }
  return { position, target, fov };
}

/** A person to frame: feet, facing, height. */
export interface Figure {
  position: Vec3Tuple;
  yaw: number;
  height: number;
}

export type PairFraming = 'over_shoulder' | 'two_shot';

export interface PairFramingInput {
  kind: PairFraming;
  /** `over_shoulder`: the one we see, facing us. `two_shot`: the one `side` favours. */
  subject: Figure;
  /** `over_shoulder`: the one whose shoulder is in the foreground. `two_shot`: the other one. */
  other: Figure;
  /** `over_shoulder`: how big `subject` is (default medium_close). `two_shot`: how much of the taller body shows (default medium_full). */
  size?: ShotSize;
  angle?: ShotAngle | number;
  /** `two_shot`: degrees round from square-on to the pair; positive swings toward `subject`'s face. Default 0. */
  side?: number;
  /** Vertical field of view, degrees (`two_shot`, default 40). `over_shoulder` always picks the lens that gives `size` from behind the shoulder. */
  fov?: number;
  /** Frame width / height. Default 16:9. */
  aspect?: number;
  /** Shoot from the other side of the pair's line (breaks the 180° rule against shots made without it). */
  flip?: boolean;
}

/**
 * The side of the line between two people the camera stays on. It does not
 * depend on which of them is featured, so a shot and its reverse land on the
 * same side (the 180° rule). A pair facing the same way is shot from in front.
 */
export function lineSide(a: Figure, b: Figure, flip = false): [number, number] {
  const [p, q] = a.position[0] < b.position[0] || (a.position[0] === b.position[0] && a.position[2] <= b.position[2]) ? [a, b] : [b, a];
  const dx = q.position[0] - p.position[0];
  const dz = q.position[2] - p.position[2];
  const len = Math.hypot(dx, dz);
  let n: [number, number] = len < 0.05 ? [1, 0] : [-dz / len, dx / len];
  // Facing vectors (yaw 0 faces -Z): side by side, both looking one way, the camera goes where they look.
  const rad = (y: number) => (y * Math.PI) / 180;
  const fx = -Math.sin(rad(a.yaw)) - Math.sin(rad(b.yaw));
  const fz = -Math.cos(rad(a.yaw)) - Math.cos(rad(b.yaw));
  const dot = fx * n[0] + fz * n[1];
  if (dot < -0.8) n = [-n[0], -n[1]];
  return flip ? [-n[0], -n[1]] : n;
}

/** Over-the-shoulder camera position: this far behind the foreground person, and this far out to the side. */
const OTS_BACK = 0.8;
const OTS_OUT = 0.32;
/** A two-shot stands no further back than this unless its lens is set: rooms are small, so it widens instead. */
const TWO_SHOT_MAX_DIST = 2.2;

/** The camera for a two-person framing: over the shoulder of one onto the other, or both in one frame. */
export function framePair(f: PairFramingInput): CameraSample {
  const A = f.subject;
  const B = f.other;
  const aspect = f.aspect ?? 16 / 9;
  const elevation = typeof f.angle === 'number' ? f.angle : ANGLES[f.angle ?? 'eye_level'];
  const el = (elevation * Math.PI) / 180;
  const n = lineSide(A, B, f.flip);
  let ux = A.position[0] - B.position[0];
  let uz = A.position[2] - B.position[2];
  const L = Math.hypot(ux, uz) || 1;
  ux /= L; uz /= L; // from the other one toward the subject

  if (f.kind === 'over_shoulder') {
    const size = SHOT_SIZES[f.size ?? 'medium_close'];
    // Behind the foreground person, out over the shoulder on the camera's side of the line, at their eye.
    const cx = B.position[0] - ux * OTS_BACK + n[0] * OTS_OUT;
    const cz = B.position[2] - uz * OTS_BACK + n[1] * OTS_OUT;
    const aim: Vec3Tuple = [A.position[0], A.position[1] + A.height * size.aim, A.position[2]];
    const horiz = Math.hypot(aim[0] - cx, aim[2] - cz);
    const eye = B.position[1] + B.height * 0.92;
    const cy = Math.max(B.position[1] + 0.3, eye + Math.max(-0.9, Math.min(1, Math.tan(el) * horiz * 0.5)));
    const dist = Math.hypot(horiz, aim[1] - cy);
    // The camera's place is fixed by the shoulder; the lens sets the size (a longer lens, as on set).
    const fov = Math.max(12, Math.min(60, (2 * Math.atan((size.frame * A.height) / 2 / dist) * 180) / Math.PI));
    // Put the subject on the third away from the shoulder, which then fills the near edge.
    const halfW = Math.tan(((fov / 2) * Math.PI) / 180) * aspect * dist;
    const shift = 0.35 * halfW;
    return { position: [cx, cy, cz], target: [aim[0] - n[0] * shift, aim[1], aim[2] - n[1] * shift], fov };
  }

  const size = SHOT_SIZES[f.size ?? 'medium_full'];
  const s = ((f.side ?? 0) * Math.PI) / 180;
  // Square-on is along the line's normal; swinging toward the other one turns the subject's face to us.
  const dx = n[0] * Math.cos(s) - ux * Math.sin(s);
  const dz = n[1] * Math.cos(s) - uz * Math.sin(s);
  const tall = Math.max(A.height, B.height);
  const aim: Vec3Tuple = [(A.position[0] + B.position[0]) / 2, Math.min(A.position[1], B.position[1]) + tall * size.aim, (A.position[2] + B.position[2]) / 2];
  // Far enough that both fit across (with shoulder room) and the size fits up and down.
  const across = L * Math.abs(Math.cos(s)) + 1.3;
  // The distance at which both fit with a lens whose half-angle tangent is `tanV`.
  const fit = (tanV: number) => Math.max((size.frame * tall) / 2 / tanV, across / 2 / (tanV * aspect)) / Math.max(0.3, Math.cos(el));
  let fov = f.fov ?? 40;
  let dist = fit(Math.tan(((fov / 2) * Math.PI) / 180));
  if (f.fov === undefined && dist > TWO_SHOT_MAX_DIST) {
    // Widen (up to 65°) rather than back out of the room.
    const tanV = Math.min(Math.tan((32.5 * Math.PI) / 180), (fit(1) / TWO_SHOT_MAX_DIST));
    fov = (2 * Math.atan(tanV) * 180) / Math.PI;
    dist = fit(tanV);
  }
  const position: Vec3Tuple = [aim[0] + dx * dist * Math.cos(el), aim[1] + Math.sin(el) * dist, aim[2] + dz * dist * Math.cos(el)];
  position[1] = Math.max(Math.min(A.position[1], B.position[1]) + 0.15, position[1]);
  return { position, target: aim, fov };
}

export type CameraMoveKind ='static' | 'push_in' | 'pull_out' | 'orbit' | 'crane_up' | 'crane_down' | 'pan' | 'track';

export interface CameraMoveInput {
  kind: CameraMoveKind;
  start: number;
  end: number;
  /** The framing the move starts from (and, for `track`, keeps). */
  from: Omit<FramingInput, 'subject' | 'facing'>;
  /** Where the subject is (feet) and faces at a stage time - follows their moves for `track`. */
  subjectAt: (t: number) => { position: Vec3Tuple; yaw: number };
  /** `push_in` / `pull_out`: the size to end on. Default two steps tighter / wider. */
  toSize?: ShotSize;
  /** `orbit`: degrees to swing round (positive goes to the subject's left). Default 90. `pan`: degrees to turn. Default 40. */
  degrees?: number;
  /** `crane_*`: metres to rise or sink. Default 1.5. */
  rise?: number;
  /** Keys per second for moves that need many (`orbit`, `track`). Default 2. */
  density?: number;
  /** Frame something other than one subject (a pair): the camera at `t` with `size` / `side` changed by the move. */
  frameAt?: (t: number, over: { size?: ShotSize; side?: number }) => CameraSample;
}

const ORDER: ShotSize[] = ['extreme_wide', 'wide', 'full', 'medium_full', 'medium', 'medium_close', 'close_up', 'extreme_close_up'];

/** Camera keys (time + camera) for a named move. */
export function cameraMoveKeys(m: CameraMoveInput): Array<CameraSample & { t: number }> {
  const at = (t: number, over: { size?: ShotSize; side?: number } = {}): CameraSample => {
    if (m.frameAt) return m.frameAt(t, over);
    const s = m.subjectAt(t);
    return frameSubject({ ...m.from, subject: s.position, facing: s.yaw, ...over });
  };
  const span = Math.max(0.1, m.end - m.start);
  const steps = (density = m.density ?? 2) => Math.max(2, Math.round(span * density) + 1);
  const sideOf = (f: Omit<FramingInput, 'subject' | 'facing'>) => (typeof f.side === 'number' ? f.side : SIDES[f.side ?? 'front']);
  const step = (size: ShotSize, by: number) => ORDER[Math.min(ORDER.length - 1, Math.max(0, ORDER.indexOf(size) + by))]!;

  switch (m.kind) {
    case 'static':
      return [{ t: m.start, ...at(m.start) }];
    case 'push_in':
    case 'pull_out': {
      const to = m.toSize ?? step(m.from.size, m.kind === 'push_in' ? 2 : -2);
      return [{ t: m.start, ...at(m.start) }, { t: m.end, ...at(m.start, { size: to }) }];
    }
    case 'orbit': {
      const n = steps(m.density ?? 3);
      const base = sideOf(m.from);
      const deg = m.degrees ?? 90;
      // Orbit round where they stood at the start: a still subject.
      return Array.from({ length: n }, (_, i) => {
        const u = i / (n - 1);
        return { t: m.start + span * u, ...at(m.start, { side: base + deg * u }) };
      });
    }
    case 'crane_up':
    case 'crane_down': {
      const rise = (m.rise ?? 1.5) * (m.kind === 'crane_up' ? 1 : -1);
      const a = at(m.start);
      const b = { ...a, position: [a.position[0], Math.max(0.2, a.position[1] + rise), a.position[2]] as Vec3Tuple };
      return [{ t: m.start, ...a }, { t: m.end, ...b }];
    }
    case 'pan': {
      const a = at(m.start);
      const deg = ((m.degrees ?? 40) * Math.PI) / 180;
      const dx = a.target[0] - a.position[0];
      const dz = a.target[2] - a.position[2];
      const target: Vec3Tuple = [a.position[0] + dx * Math.cos(deg) + dz * Math.sin(deg), a.target[1], a.position[2] - dx * Math.sin(deg) + dz * Math.cos(deg)];
      return [{ t: m.start, ...a }, { t: m.end, ...a, target }];
    }
    case 'track': {
      // Keep the same framing on a moving subject: sample along their path.
      const n = steps();
      return Array.from({ length: n }, (_, i) => {
        const t = m.start + (span * i) / (n - 1);
        return { t, ...at(t) };
      });
    }
  }
}
