import type { CameraSample } from '../camera.js';
import { sampleShot, shotSpan, sortedKeys } from '../camera.js';
import { nextFreeStart } from '../clips.js';
import { editSpan, setSequence, sortedCuts } from '../cuts.js';
import { addClip, addMove, addShot, clamp, patchCharacter, patchShot, removeCharacter, removeClip, removeShot, uid } from '../edit.js';
import type { CameraMoveKind, PairFraming, ShotAngle, ShotSide, ShotSize } from '../framing.js';
import { ANGLES, cameraMoveKeys, framePair, frameSubject, SHOT_SIZES, SIDES } from '../framing.js';
import { moveLength, sampleMoves, yawToward } from '../moves.js';
import type { GapView } from '../scenecheck.js';
import { checkScene, measureFrame } from '../scenecheck.js';
import { fileToWorldPoint, placeWalkScene, worldToFilePoint } from '../../walk/placement.js';
import type { CameraKey, Easing, Interpolation, StageAspect, StageCharacter, StageClip, StageDoc, StageMove, StageShot, Vec3Tuple } from '../types.js';
import { ASPECTS } from '../types.js';
import type { AssetKind, AssetRef, GenerationJob, StageToolHost, ToolResult } from './host.js';
import { contactSheet, povCamera, renderStill, settle, toBase64Jpeg, topDownCamera } from './look.js';

export type { AssetKind, AssetRef, AssetSource, GenerationJob, StageToolHost, ToolResult } from './host.js';
export { contactSheet, povCamera, renderStill, settle, topDownCamera } from './look.js';

/**
 * The 3D Studio as tools an agent can call: everything a director does by
 * hand - cast, place, block movement, sequence motions, set up shots and
 * camera moves - plus ways to look at the result and check it.
 *
 * Each tool is a Messages API tool definition (`name`, `description`,
 * `input_schema`) with an executor. `effect` says what calling it does:
 * `read` changes nothing, `edit` changes the stage (one undo step), `cost`
 * spends credits (the host decides whether to ask first; the agent loop caps them per request), `ui` acts on the editor.
 */
export interface StageTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  effect: 'read' | 'edit' | 'cost' | 'ui';
  /**
   * For a `cost` tool: what is wrong with this call, or null. Asked BEFORE the user is asked to spend
   * credits, so a stale id or a scene that cannot be filled never costs them a click.
   */
  precheck?(input: Record<string, any>, host: StageToolHost): Promise<string | null>; // eslint-disable-line @typescript-eslint/no-explicit-any
  run(input: Record<string, any>, host: StageToolHost): Promise<ToolResult>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Walking and running pace, metres per second, for moves given no duration. */
const PACE = { walk: 1.3, run: 3.4 } as const;
/** In-place locomotion on the Viggle rig, used under moves. */
const GAIT_CLIPS = {
  walk: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-walking-a0293881.glb',
  run: 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-running-1902fd18.glb',
} as const;

// ── Small helpers ────────────────────────────────────────────────────────────

const ok = (data: unknown): ToolResult => ({ content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] });
const fail = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], is_error: true });
const r2 = (v: number) => Math.round(v * 100) / 100;
const v3 = (p: readonly number[]): Vec3Tuple => [r2(p[0]!), r2(p[1]!), r2(p[2]!)];

class ToolError extends Error {}

function findCharacter(doc: StageDoc, ref: unknown): StageCharacter {
  const key = String(ref ?? '').trim().toLowerCase();
  const c = doc.characters.find((k) => k.id.toLowerCase() === key) ?? doc.characters.find((k) => k.name.toLowerCase() === key);
  if (!c) throw new ToolError(`No character "${ref}". On stage: ${doc.characters.map((k) => `${k.id} (${k.name})`).join(', ') || 'none'}.`);
  return c;
}

function findShot(doc: StageDoc, ref: unknown): StageShot {
  const key = String(ref ?? '').trim().toLowerCase();
  const s = doc.shots.find((k) => k.id.toLowerCase() === key) ?? doc.shots.find((k) => k.name.toLowerCase() === key);
  if (!s) throw new ToolError(`No shot "${ref}". Shots: ${doc.shots.map((k) => `${k.id} (${k.name})`).join(', ') || 'none - add_shot first'}.`);
  return s;
}

async function findAsset(host: StageToolHost, kind: AssetKind, ref: unknown): Promise<AssetRef> {
  const key = String(ref ?? '').trim().toLowerCase();
  const all = await host.assets.list(kind);
  const names = (k: AssetRef) => [k.name, ...(k.aliases ?? [])].map((n) => n.toLowerCase());
  const a = all.find((k) => k.id.toLowerCase() === key) ?? all.find((k) => names(k).includes(key)) ?? all.find((k) => key.length > 1 && names(k).some((n) => n.includes(key)));
  if (!a) throw new ToolError(`No ${kind} "${ref}". Call list_assets with kind "${kind}" to see what there is.`);
  return a;
}

/** Where a character is at `t`: the renderer's answer (root motion included) when there is one, else the moves alone. */
function placeAt(host: StageToolHost, c: StageCharacter, t: number): { position: Vec3Tuple; yaw: number } {
  return host.renderer?.characterAt(c.id, t) ?? sampleMoves(c, t);
}

/** A point given as [x, z] or [x, y, z], dropped onto the floor when the renderer can find it. */
function onFloor(_host: StageToolHost, p: readonly number[]): Vec3Tuple {
  // The scene is mounted with its floor at y = 0; the floor probe reads a rug or splat noise a few
  // centimetres up, so it only says whether there is floor (see the warnings), not how high.
  const [x, y, z] = p.length >= 3 ? [p[0]!, p[1]!, p[2]!] : [p[0]!, 0, p[1]!];
  return [r2(x), r2(y), r2(z)];
}

/** Resolve a subject (a character, or a point) to a framing target at `t`. */
function subjectAt(host: StageToolHost, doc: StageDoc, ref: unknown, t: number): { position: Vec3Tuple; yaw: number; height: number } {
  if (Array.isArray(ref)) return { position: onFloor(host, ref as number[]), yaw: 0, height: 1.7 };
  const c = findCharacter(doc, ref);
  return { ...placeAt(host, c, t), height: c.height };
}

/** `framing` / `with` from a camera tool's input: a two-person framing, or null for one subject. */
function pairOf(doc: StageDoc, i: Record<string, unknown>): { kind: PairFraming; a: StageCharacter; b: StageCharacter } | null {
  const kind = i.framing as string | undefined;
  // The model fills every optional field it sees (`with: ""`, `framing: "single"`): a second character
  // means nothing for one subject, so it is ignored rather than refused.
  if (!kind || kind === 'single') return null;
  if (kind !== 'over_shoulder' && kind !== 'two_shot') throw new ToolError(`Unknown framing "${kind}".`);
  if (Array.isArray(i.subject) || i.with === undefined) throw new ToolError(`"${kind}" needs two characters: \`subject\` and \`with\`.`);
  const a = findCharacter(doc, i.subject);
  const b = findCharacter(doc, i.with);
  if (a.id === b.id) throw new ToolError('`subject` and `with` must be two different characters.');
  return { kind, a, b };
}

/**
 * Which side of a pair's line to shoot from, unless `flip` says: the one whose
 * two-shot camera stands over floor with the clearer view. It is judged on the
 * pair, not the shot, so every framing of them lands on the same side.
 */
function pairFlip(host: StageToolHost, doc: StageDoc, p: NonNullable<ReturnType<typeof pairOf>>, i: Record<string, unknown>, t: number): boolean {
  const r = host.renderer;
  const other = i.line_side === 'other_side';
  if (!r) return other;
  const fig = (c: StageCharacter) => ({ ...placeAt(host, c, t), height: c.height });
  const score = (flip: boolean) => {
    const cam = framePair({ kind: 'two_shot', subject: fig(p.a), other: fig(p.b), aspect: ASPECTS[doc.aspect], flip });
    const lost = r.floorAt(cam.position[0], cam.position[2], cam.position[1]) === null ? 1000 : 0;
    return lost + (r.sightline(cam.position, cam.target)?.blocking ?? 0);
  };
  return (score(true) < score(false)) !== other;
}

/** The camera for a pair at `t`, both where they are then. */
function pairAt(host: StageToolHost, doc: StageDoc, p: NonNullable<ReturnType<typeof pairOf>>, i: Record<string, any>, t: number, flip: boolean, over: { size?: ShotSize; side?: number } = {}): CameraSample { // eslint-disable-line @typescript-eslint/no-explicit-any
  const fig = (c: StageCharacter) => ({ ...placeAt(host, c, t), height: c.height });
  // Square-on ± 75°: further round, one of them hides the other.
  const given = typeof i.side === 'number' ? i.side : typeof i.side === 'string' ? SIDES[i.side as ShotSide] ?? 0 : 0;
  return framePair({
    kind: p.kind, subject: fig(p.a), other: fig(p.b),
    size: over.size ?? (i.size as ShotSize | undefined), angle: i.angle as ShotAngle | undefined, side: over.side ?? Math.max(-75, Math.min(75, given)),
    aspect: ASPECTS[doc.aspect], flip,
  });
}

/** What to expect from a pair framing when checking it, so a correct one is not "fixed". */
function pairNote(kind: PairFraming): string {
  return kind === 'over_shoulder'
    ? 'Over the shoulder: `with` is meant to be cut by the frame edge (check_framing shows them mostly outside the frame, cut on several sides). Judge the shot by `subject` alone: head_in_frame and line_of_sight clear.'
    : 'Two-shot: both should be inside the frame with a clear line_of_sight. If one is blocked, swing `side` (e.g. 30 or -30) or change `size`; keep line_side as it is, the same for every shot of this pair, or the cut crosses the line.';
}

function extend(d: StageDoc, t: number): StageDoc {
  return t > d.duration ? { ...d, duration: Math.ceil(t) } : d;
}

/** Keys of a shot with those inside [start, end] replaced by `keys`. */
function replaceKeys(shot: StageShot, keys: CameraKey[], start: number, end: number): CameraKey[] {
  const eps = 1e-3;
  return [...shot.keys.filter((k) => k.t < start - eps || k.t > end + eps), ...keys].sort((a, b) => a.t - b.t);
}

/**
 * Reject a framing argument that is not one of the vocabulary, saying which word belongs where. The model
 * mixes them up ("front" is a side, not an angle); passing one on would put NaN in the camera.
 */
function checkFraming(i: Record<string, any>): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  const tables: Array<[string, Record<string, unknown>, boolean]> = [['size', SHOT_SIZES, false], ['to_size', SHOT_SIZES, false], ['angle', ANGLES, true], ['side', SIDES, true]];
  for (const [name, table, numeric] of tables) {
    const v = i[name];
    if (v === undefined || v === null || (numeric && typeof v === 'number' && Number.isFinite(v))) continue;
    if (typeof v === 'string' && v in table) continue;
    const elsewhere = [['size', SHOT_SIZES], ['angle', ANGLES], ['side', SIDES]].find(([n, t]) => n !== name.replace('to_', '') && typeof v === 'string' && v in (t as object));
    throw new ToolError(`\`${name}\` = ${JSON.stringify(v)} is not valid. Use one of: ${Object.keys(table).join(', ')}${numeric ? ' (or a number of degrees)' : ''}.${elsewhere ? ` "${v}" is a ${elsewhere[0]}, put it in \`${elsewhere[0]}\`.` : ''}`);
  }
}

function key(cam: CameraSample, t: number): CameraKey {
  if (![...cam.position, ...cam.target, cam.fov].every(Number.isFinite)) throw new ToolError('That framing gave an invalid camera (check size, angle, side, fov and offset).');
  return { id: uid('key'), t: r2(t), position: v3(cam.position), target: v3(cam.target), fov: r2(cam.fov) };
}

function describe(doc: StageDoc, host: StageToolHost, t?: number) {
  return {
    title: doc.title,
    duration: doc.duration, fps: doc.fps, aspect: doc.aspect,
    scene: doc.scene ? { name: doc.scene.name, metresPerUnit: doc.scene.placement?.scale ?? null } : null,
    characters: doc.characters.map((c) => ({
      id: c.id, name: c.name, height: c.height, position: v3(c.position), yaw: Math.round(c.yaw),
      ...(t !== undefined ? { at_time: { t, ...((p) => ({ position: v3(p.position), yaw: Math.round(p.yaw) }))(placeAt(host, c, t)) } } : {}),
      clips: [...c.clips].sort((a, b) => a.start - b.start).map((k) => ({ id: k.id, motion: k.name, start: k.start, end: k.end, loop: k.loop, root_motion: k.rootMotion !== false })),
      moves: (c.moves ?? []).map((m) => ({ id: m.id, start: m.start, end: m.end, to: v3(m.points[m.points.length - 1] ?? c.position), waypoints: m.points.length })),
    })),
    shots: doc.shots.map((s) => ({
      id: s.id, name: s.name, interpolation: s.interpolation, easing: s.easing, span: shotSpan(s),
      keys: sortedKeys(s.keys).map((k) => ({ id: k.id, t: k.t, position: v3(k.position), target: v3(k.target), fov: Math.round(k.fov) })),
    })),
    edit: sortedCuts(doc).map((c) => ({ shot: c.shotId, shot_name: doc.shots.find((s) => s.id === c.shotId)?.name, start: c.start, end: c.end })),
  };
}

const NUM = { type: 'number' };
const POINT = { type: 'array', items: NUM, minItems: 2, maxItems: 3, description: '[x, z] on the floor, or [x, y, z]. Metres; +Y up; the capture point is the origin, -Z is "forward" from it.' };
const SUBJECT = { description: 'A character id or name, or a point [x, z] / [x, y, z].', anyOf: [{ type: 'string' }, POINT] };
const SIZE = { type: 'string', enum: Object.keys(SHOT_SIZES), description: 'Shot size: how much of the subject fills the frame height.' };
const ANGLE = { type: 'string', enum: Object.keys(ANGLES), description: 'Camera height: eye_level, low (looking up), worm, high (looking down), overhead.' };
const SIDE = {
  description: 'Where the camera stands round the subject, relative to the way they face: front, three_quarter_left/right, left, right, back_left/right, back - or degrees (0 = in front, positive toward their left).',
  anyOf: [{ type: 'string', enum: Object.keys(SIDES) }, NUM],
};

const PAIR_PROPS = {
  framing: {
    type: 'string', enum: ['single', 'over_shoulder', 'two_shot'],
    description: 'single (default): one `subject`. over_shoulder: over the shoulder of `with` onto `subject` (who should face `with`); `size` is how big `subject` is (default medium_close); the shoulder of `with` is meant to be cut by the frame edge. two_shot: both in frame, square-on to the line between them (`size` default medium_full); a numeric `side` swings round, positive favouring `subject`\'s face. Both pick their own lens (`fov` is ignored). A shot and its reverse (swap subject and with) stay on the same side of the line automatically.',
  },
  with: { type: 'string', description: 'The second character (id or name) for over_shoulder / two_shot.' },
  line_side: { type: 'string', enum: ['auto', 'other_side'], description: 'Two-person framings: which side of the line between them to shoot from. auto (default, use it): the side with the clearer view of the pair, the same for every shot of that pair. other_side: the opposite one, for every shot of the pair (crosses the line against auto shots).' },
};

// ── The tools ───────────────────────────────────────────────────────────────


// ── Scene check and fill ────────────────────────────────────────────────────

/** The last scene check a host ran, so `fill_scene_view` can take one of its ids. */
const lastCheck = new WeakMap<StageToolHost, { url: string; version: number; views: GapView[] }>();

/** How many image batches the scene holds: it changes every time a fill lands, which is what retires an id. */
const sceneVersion = (doc: StageDoc) => doc.scene?.viggle?.batchIds.length ?? 0;

/** Why this scene cannot be filled, or null when it can. A check works on any scene; a fill needs the Viggle session. */
function fillBlock(doc: StageDoc): string | null {
  if (!doc.scene) return 'No scene yet: set_scene first.';
  if (!doc.scene.viggle?.sessionId) return 'This scene cannot be filled: only a scene generated here keeps its Viggle session (a preset or imported file has none). Keep people and cameras away from the gaps, or generate a new scene.';
  if (!doc.scene.placement) return 'The scene is not measured yet: call get_world_layout, then try again.';
  if (!doc.scene.placement.upright) return 'This scene file is stored in a frame fills cannot be aimed in (only .spz scenes can be filled).';
  return null;
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/** What is wrong with a generate_asset call, or null. */
function generateProblem(i: Record<string, any>, host: StageToolHost): string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!host.assets.generate) return 'Generation is not set up here (no API key on the server).';
  const kind = i.kind as AssetKind;
  if (kind === 'character' && !i.prompt && !i.image_url) return 'A character needs `prompt` (a description of them) or `image_url`.';
  if (kind === 'character' && String(i.prompt ?? '').length > 1000) return 'Describe the character in 1000 characters or fewer.';
  if ((kind === 'scene' || kind === 'motion') && !String(i.prompt ?? '').trim()) return `A ${kind} needs a \`prompt\`.`;
  return null;
}

/** Check a fill_scene_view call and turn it into the pose to shoot from; throws a ToolError saying what to change. */
async function planFill(i: Record<string, any>, host: StageToolHost): Promise<{ pose: { position: Vec3Tuple; yaw: number; pitch: number } }> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const doc = host.getDoc();
      const block = fillBlock(doc);
      if (block) throw new ToolError(block);
      if (!host.assets.fillView) throw new ToolError('Filling is not set up here (no API key on the server).');
      let pose: { position: Vec3Tuple; yaw: number; pitch: number };
      if (i.view_id !== undefined && i.view_id !== '') {
        if (i.position !== undefined || i.yaw !== undefined || i.pitch !== undefined) throw new ToolError('Give EITHER view_id OR position, yaw and pitch, not both.');
        const m = /^g(\d+)@(\d+)$/.exec(String(i.view_id).trim());
        if (!m) throw new ToolError(`"${i.view_id}" is not a view id: use one from find_scene_gaps, like g1@0.`);
        const version = sceneVersion(doc);
        if (Number(m[2]) !== version) throw new ToolError(`That id is from version ${m[2]} of the scene and it is now version ${version}: a fill rebuilds the scene, so call find_scene_gaps again.`);
        const last = lastCheck.get(host);
        const v = last && last.url === doc.scene!.url && last.version === version ? last.views.find((k) => k.id === `g${m[1]}`) : undefined;
        if (!v) throw new ToolError('No check on record for this scene: call find_scene_gaps first.');
        pose = { position: v.position, yaw: v.yaw, pitch: v.pitch };
      } else {
        const p = i.position as number[] | undefined;
        if (!Array.isArray(p) || p.length !== 3 || typeof i.yaw !== 'number' || typeof i.pitch !== 'number') throw new ToolError('Give a view_id, or position [x, y, z] with yaw and pitch.');
        if (p[1]! < 0.2 || p[1]! > 3) throw new ToolError('A camera at that height is outside the room: use y between 0.2 and 3 metres.');
        pose = { position: [p[0]!, p[1]!, p[2]!], yaw: i.yaw, pitch: clamp(i.pitch, -89, 89) };
      }
  const running = (await host.assets.jobs?.().catch(() => []))?.find((j) => j.kind === 'fill' && j.status === 'processing');
  if (running) throw new ToolError(`A fill is already running (job ${running.id}): a scene takes one edit at a time. Wait for check_jobs to say ready.`);
  return { pose };
}

export const STAGE_TOOLS: StageTool[] = [
  // ── Look ──
  {
    name: 'get_stage',
    effect: 'read',
    description: 'Everything on the stage as JSON: timeline, scene, characters (placement, motion clips, moves) and shots (camera keys). Pass `time` to also get where each character is at that moment. Call this first, and again after a batch of edits.',
    input_schema: { type: 'object', properties: { time: { ...NUM, description: 'Seconds; adds each character\'s position and facing at that time.' } } },
    async run(i, host) {
      return ok(describe(host.getDoc(), host, typeof i.time === 'number' ? i.time : undefined));
    },
  },
  {
    name: 'get_world_layout',
    effect: 'read',
    description: 'The floor of the scene as a top-down map, so you know where people can stand and walk: a grid where "." is floor and "#" is not (wall, furniture, hole, outside), the bounds of the floor connected to the capture point, and where each character stands on the grid (their initial letter). Coordinates: column = x, row = z, both from `origin` in steps of `step` metres.',
    input_schema: { type: 'object', properties: { radius: { ...NUM, description: 'Metres round the capture point to map. Default 6.' }, step: { ...NUM, description: 'Grid cell, metres. Default 0.5.' }, time: NUM } },
    async run(i, host) {
      const r = host.renderer;
      if (!r) return fail('No renderer: the world layout needs the scene loaded in the editor.');
      const doc = host.getDoc();
      if (!doc.scene) return fail('No scene yet: set_scene first.');
      r.setDoc(doc);
      await settle(r);
      const map = r.floorMap(i.radius ?? 6, i.step ?? 0.5);
      const rows = map.rows.map((row) => row.split(''));
      const t = i.time ?? 0;
      for (const c of doc.characters) {
        const p = placeAt(host, c, t).position;
        const col = Math.round((p[0] - map.origin[0]) / map.step);
        const row = Math.round((p[2] - map.origin[1]) / map.step);
        if (rows[row]?.[col] !== undefined) rows[row]![col] = c.name[0]!.toUpperCase();
      }
      return ok({
        legend: '"." floor, "#" no floor, letters = characters (initials). Row 0 is the most negative z (forward/away from the capture point\'s back); column 0 the most negative x (left).',
        origin_xz: map.origin, step: map.step, floor_bounds: map.bounds,
        capture_point: [0, 0, 0],
        map: rows.map((row) => row.join('')),
      });
    },
  },
  {
    name: 'look',
    effect: 'read',
    description: 'Render a picture of the stage and look at it. `view`: "shot" (through a shot\'s camera at `time`), "camera" (any camera you give), "top_down" (straight down from under the ceiling, for blocking - who stands where), "character" (through a character\'s eyes) or "editor" (the user\'s current viewport). Characters are labelled with their names. Use it after placing people or setting up a shot to check the result before telling the user it is done.',
    input_schema: {
      type: 'object',
      properties: {
        view: { type: 'string', enum: ['shot', 'camera', 'top_down', 'character', 'editor'] },
        shot_id: { type: 'string' },
        character: { type: 'string', description: 'For view "character".' },
        camera: { type: 'object', properties: { position: POINT, look_at: SUBJECT, fov: NUM }, description: 'For view "camera".' },
        time: { ...NUM, description: 'Seconds. Default the shot\'s first key, else 0.' },
        height: { ...NUM, description: 'For "top_down": camera height, metres (default 2.25 - keep it under the ceiling).' },
        width: { ...NUM, description: 'Pixels. Default 640.' },
      },
      required: ['view'],
    },
    async run(i, host) {
      const r = host.renderer;
      if (!r) return fail('No renderer: looking needs the editor open.');
      const doc = host.getDoc();
      if (!doc.scene) return fail('No scene yet: set_scene first.');
      let t = typeof i.time === 'number' ? i.time : 0;
      let cam: CameraSample;
      if (i.view === 'shot') {
        const shot = findShot(doc, i.shot_id ?? doc.shots[0]?.id);
        if (typeof i.time !== 'number') t = shotSpan(shot)?.[0] ?? 0;
        const s = sampleShot(shot, t);
        if (!s) return fail('That shot has no camera keys: frame_shot or camera_move first.');
        cam = s;
      } else if (i.view === 'top_down') {
        // Over the middle of the cast, else the capture point.
        const at = doc.characters.map((c) => placeAt(host, c, t).position);
        const centre: [number, number] = at.length ? [at.reduce((s, p) => s + p[0], 0) / at.length, at.reduce((s, p) => s + p[2], 0) / at.length] : [0, -1.5];
        cam = topDownCamera(centre, typeof i.height === 'number' ? i.height : 2.25);
      } else if (i.view === 'character') {
        const c = findCharacter(doc, i.character);
        const p = placeAt(host, c, t);
        cam = povCamera(p.position, p.yaw, c.height);
      } else if (i.view === 'camera') {
        const c = i.camera ?? {};
        if (!Array.isArray(c.position)) return fail('camera.position is required for view "camera".');
        const position = (c.position.length >= 3 ? c.position : [c.position[0], 1.6, c.position[1]]) as Vec3Tuple;
        const s = c.look_at !== undefined ? subjectAt(host, doc, c.look_at, t) : null;
        const target: Vec3Tuple = s ? [s.position[0], s.position[1] + s.height * 0.6, s.position[2]] : [position[0], position[1], position[2] - 3];
        cam = { position, target, fov: c.fov ?? 45 };
      } else {
        cam = r.getCamera();
        t = r.getTime();
      }
      const canvas = await renderStill(r, doc, cam, t, { width: clamp(i.width ?? 640, 256, 1280), labels: true });
      const framed = r.framing(cam, ASPECTS[doc.aspect], t).map((f) => ({ name: f.name, visible: f.visible, box: f.box, cut: f.cut, head_in_frame: f.head_in_frame, line_of_sight: f.line_of_sight, distance: f.distance }));
      return {
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toBase64Jpeg(canvas) } },
          { type: 'text', text: JSON.stringify({ view: i.view, time: t, camera: { position: v3(cam.position), target: v3(cam.target), fov: Math.round(cam.fov) }, characters: framed }) },
        ],
      };
    },
  },
  {
    name: 'check_framing',
    effect: 'read',
    description: 'Numbers instead of a picture: for a shot at given times, each character\'s whole-body box in the frame (0..1, x right, y down), the share of the body inside, which edges cut it, whether the head is in frame, `line_of_sight` from the lens to them (clear / partly_blocked / blocked - by furniture, a plant, a wall, or a smear the camera has backed into: change the side, height or distance), height in frame and distance; and `camera_over_floor` (false: the camera has left the scene\'s reconstructed area), and `scene_gap` - the share of the frame that is hole (nothing reconstructed) or blur (a smear) in the scene itself, whoever is in it (over 25% is a warning: aim elsewhere or fill the scene). Tighter sizes than "full" cut the body by design - judge them by `head_in_frame`. Cheap: use it across a whole move ("is she still in frame at the end of the dolly?").',
    input_schema: { type: 'object', properties: { shot_id: { type: 'string' }, times: { type: 'array', items: NUM, description: 'Default: the shot\'s start, middle and end.' } }, required: ['shot_id'] },
    async run(i, host) {
      const r = host.renderer;
      if (!r) return fail('No renderer.');
      const doc = host.getDoc();
      r.setDoc(doc);
      await settle(r);
      const shot = findShot(doc, i.shot_id);
      const span = shotSpan(shot);
      if (!span) return fail('That shot has no camera keys.');
      const times: number[] = Array.isArray(i.times) && i.times.length ? i.times : [span[0], (span[0] + span[1]) / 2, span[1]];
      // How much of the frame is scene gap (a hole or a smear), when the scene can be read.
      const sample = doc.scene?.placement ? r.cloudSample() : null;
      const capture = doc.scene?.placement ? fileToWorldPoint(placeWalkScene(doc.scene.placement), [0, 0, 0]) : null;
      return ok(times.map((t) => {
        const cam = sampleShot(shot, t)!;
        const dir: Vec3Tuple = [cam.target[0] - cam.position[0], cam.target[1] - cam.position[1], cam.target[2] - cam.position[2]];
        const gap = sample && capture ? measureFrame(sample, { capture: [capture.x, capture.y, capture.z] }, cam.position, dir, cam.fov, ASPECTS[doc.aspect]) : null;
        // A camera with no floor under it has left the reconstruction: expect smears.
        const overFloor = r.floorAt(cam.position[0], cam.position[2], cam.position[1]) !== null;
        return { t, camera_over_floor: overFloor, ...(gap ? { scene_gap: { hole: pct(gap.hole), blur: pct(gap.blur), ...(gap.hole + gap.blur > 0.25 ? { warning: 'much of this frame is hole or smear in the scene itself: aim away, or find_scene_gaps / fill it.' } : {}) } } : {}), characters: r.framing(cam, ASPECTS[doc.aspect], t).map(({ id: _id, inFront: _f, ...f }) => f) };
      }));
    },
  },
  {
    name: 'contact_sheet',
    effect: 'read',
    description: 'Several frames of a shot, evenly through its move, tiled into one labelled image - to judge a camera move or a blocking as a whole.',
    input_schema: { type: 'object', properties: { shot_id: { type: 'string' }, frames: { ...NUM, description: '2-12, default 6.' } }, required: ['shot_id'] },
    async run(i, host) {
      const r = host.renderer;
      if (!r) return fail('No renderer.');
      const doc = host.getDoc();
      const shot = findShot(doc, i.shot_id);
      const sheet = await contactSheet(r, doc, shot.id, i.frames ?? 6);
      return { content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: toBase64Jpeg(sheet, 0.78) } }, { type: 'text', text: `${shot.name}: ${i.frames ?? 6} frames over ${JSON.stringify(shotSpan(shot))} s.` }] };
    },
  },
  {
    name: 'probe_floor',
    effect: 'read',
    description: 'Is there floor at these points, and how high? Use before placing or moving someone somewhere the layout map is unsure about.',
    input_schema: { type: 'object', properties: { points: { type: 'array', items: POINT } }, required: ['points'] },
    async run(i, host) {
      const r = host.renderer;
      if (!r) return fail('No renderer.');
      r.setDoc(host.getDoc());
      await settle(r);
      return ok((i.points as number[][]).map((p) => {
        const [x, z] = p.length >= 3 ? [p[0]!, p[2]!] : [p[0]!, p[1]!];
        const y = r.floorAt(x, z);
        return { x, z, floor: y === null ? null : r2(y) };
      }));
    },
  },

  // ── Assets ──
  {
    name: 'list_assets',
    effect: 'read',
    description: 'Scenes, characters or motions you can use: Viggle\'s free presets and those generated for this project, each with its aliases (other names, Chinese included). The lists are short: call it once per kind with no query and pick from the result - don\'t search word by word.',
    input_schema: { type: 'object', properties: { kind: { type: 'string', enum: ['scene', 'character', 'motion'] }, query: { type: 'string' } }, required: ['kind'] },
    async run(i, host) {
      const q = String(i.query ?? '').toLowerCase();
      const all = await host.assets.list(i.kind as AssetKind);
      const hit = (a: AssetRef) => !q || [a.name, ...(a.aliases ?? [])].some((n) => n.toLowerCase().includes(q));
      const found = all.filter(hit);
      return ok((found.length ? found : all).map((a) => ({ id: a.id, name: a.name, ...(a.aliases?.length ? { aliases: a.aliases.join(', ') } : {}), source: a.source, ...(a.seconds ? { seconds: a.seconds } : {}) })));
    },
  },
  {
    name: 'generate_asset',
    effect: 'cost',
    description: 'Generate a new asset with Viggle when the library has nothing that matches the intent. SPENDS CREDITS (scene 6, character 30, motion 10), spent at once with no confirmation: be sure nothing in the library matches. Several in one turn run at once; at most 4 per request. scene: `prompt` (a place). character: `prompt` (who they are: a full-body description - age, build, clothes, colours, pose standing) and/or `image_url` (a full-body photo or drawing; the prompt then steers it) - one of the two, 1000 characters at most, a few minutes. motion: `prompt` (what the body does) and `seconds` (3-60). Returns a job; poll check_jobs, then use the asset id.',
    input_schema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['scene', 'character', 'motion'] }, prompt: { type: 'string' }, image_url: { type: 'string' }, seconds: NUM, name: { type: 'string' } },
      required: ['kind'],
    },
    // Asked before the user is, so a call that cannot work costs them no click.
    async precheck(i, host) { return generateProblem(i, host); },
    async run(i, host) {
      const problem = generateProblem(i, host);
      if (problem) return fail(problem);
      if (!host.assets.generate) return fail('Generation is not set up here (no API key on the server).');
      const kind = i.kind as AssetKind;
      const input = kind === 'scene' ? { prompt: i.prompt } : kind === 'character' ? { imageUrl: i.image_url, prompt: i.prompt, name: i.name } : { text: i.prompt, duration: i.seconds ?? 5, name: i.name };
      const job = await host.assets.generate(kind, input);
      return ok({ job_id: job.id, status: job.status, credits: job.credits });
    },
  },
  {
    name: 'wait_for_jobs',
    effect: 'read',
    description: 'Wait for generation jobs (assets, scene fills) to finish, then report them: up to `seconds` (default 45, at most 60) - call it again if some are still processing. Without `job_ids` it waits for every job in progress. A ready job carries the new asset id; use it with set_scene / add_character / the motion name. Prefer this to calling check_jobs over and over: it costs no extra step while you wait.',
    input_schema: { type: 'object', properties: { job_ids: { type: 'array', items: { type: 'string' } }, seconds: { ...NUM, description: 'Default 45, at most 60.' } } },
    async run(i, host) {
      if (!host.assets.jobs) return ok([]);
      const limit = Date.now() + clamp(typeof i.seconds === 'number' ? i.seconds : 45, 1, 60) * 1000;
      const want = (all: GenerationJob[]) => (Array.isArray(i.job_ids) && i.job_ids.length ? all.filter((j) => i.job_ids.includes(j.id)) : all.filter((j) => j.status === 'processing'));
      let all = await host.assets.jobs();
      const watched = new Set(want(all).map((j) => j.id));
      if (!watched.size) return ok({ waiting: 0, note: 'No jobs in progress.' });
      while (Date.now() < limit && all.some((j) => watched.has(j.id) && j.status === 'processing')) {
        await new Promise((r) => setTimeout(r, 3000));
        all = await host.assets.jobs();
      }
      const jobs = all.filter((j) => watched.has(j.id));
      const pending = jobs.filter((j) => j.status === 'processing').length;
      return ok({
        jobs: jobs.map((j) => ({
          id: j.id, kind: j.kind, status: j.status, asset_id: j.assetId, error: j.error, label: j.label,
          ...(j.kind === 'fill' && j.status === 'ready' ? { next: 'set_scene with this asset_id to see the filled scene.' } : {}),
        })),
        ...(pending ? { still_processing: pending, note: 'Not finished yet: call wait_for_jobs again.' } : {}),
      });
    },
  },
  {
    name: 'check_jobs',
    effect: 'read',
    description: 'Status of generation jobs; a ready job carries the new asset id.',
    input_schema: { type: 'object', properties: {} },
    async run(_i, host) {
      if (!host.assets.jobs) return ok([]);
      return ok((await host.assets.jobs()).map((j) => ({
        id: j.id, kind: j.kind, status: j.status, asset_id: j.assetId, error: j.error, label: j.label,
        ...(j.kind === 'fill' && j.status === 'ready' ? { next: 'set_scene with this asset_id to see the filled scene.' } : {}),
      })));
    },
  },

  {
    name: 'find_scene_gaps',
    effect: 'read',
    description: 'Check the scene itself for defects, as a detector: where a camera could stand and look to see HOLES (nothing reconstructed - the floor behind a pillar, the wall behind a sofa) or BLUR (reconstructed too coarsely: a smear). A scene is built from ONE viewpoint, so it only knows what that point saw. Returns up to 6 views, best first, with their share of hole and blur, a pose in stage metres and a `look_at` point for `look`. Free, no picture; a second or two. It can miss what a picture shows, and an empty list does not mean the scene is clean: `look` at a doubtful view. Ids carry the scene version (g1@0) and are void once a fill lands. Use it after a scene is set, before shots and people go near the gaps.',
    input_schema: { type: 'object', properties: {} },
    async run(_i, host) {
      const doc = host.getDoc();
      const r = host.renderer;
      if (!r) return fail('No renderer: checking the scene needs it loaded in the editor.');
      if (!doc.scene) return fail('No scene yet: set_scene first.');
      r.setDoc(doc);
      await settle(r);
      if (!doc.scene.placement) return fail('The scene is not measured yet: call get_world_layout first.');
      const sample = r.cloudSample();
      if (!sample || sample.positions.length < 3000) return fail('This scene has no splat data the editor can read (a streamed scene), so it cannot be checked. Use `look` instead.');
      const mount = placeWalkScene(doc.scene.placement);
      const c = fileToWorldPoint(mount, [0, 0, 0]);
      const result = checkScene(sample, { capture: [c.x, c.y, c.z] });
      const version = sceneVersion(doc);
      lastCheck.set(host, { url: doc.scene.url, version, views: result.views });
      const block = fillBlock(doc);
      const views = result.views.map((v) => {
        const at = v.position, f = v.forward;
        return {
          id: `${v.id}@${version}`, role: v.role, hole: pct(v.hole), blur: pct(v.blur),
          position: v3(at), yaw: v.yaw, pitch: v.pitch,
          look_at: v3([at[0] + f[0] * 3, at[1] + f[1] * 3, at[2] + f[2] * 3]),
          ...(v.role === 'candidate' ? { weaker: true } : {}),
        };
      });
      return ok({
        scene: doc.scene.name, version, views,
        can_fill: block === null, ...(block ? { fill_blocked: block } : {}),
        ...(result.undefinedShare > 0.05 ? { warning: `${pct(result.undefinedShare)} of the directions from the capture point show nothing: this scene has large gaps from the start.` } : {}),
        note: views.length
          ? 'HOLE = nothing reconstructed, BLUR = reconstructed too coarsely; both are shares of a 100 degree frame, the one a fill is generated at. The order weighs nearness and framing, not the size of the numbers. `look` at a view first (camera.position, camera.look_at) to see it, then fill_scene_view with its id. Each fill costs credits and rebuilds the scene: ids from before are void.'
          : 'Found nothing worth filling - which does not mean the scene is clean. Use `look` from a couple of angles you intend to shoot; fill only a view whose picture shows a defect, otherwise say the scene came out clean.',
        measured: { positions: result.domain, ms: result.ms },
      });
    },
  },
  {
    name: 'fill_scene_view',
    effect: 'cost',
    description: 'Repair the scene from one camera pose: Viggle generates a view there and rebuilds the scene from every view it holds (1-3 minutes). SPENDS CREDITS (about 8 for the first fill, one more each time), at once with no confirmation; at most 2 per request. Give `view_id` from find_scene_gaps (with its @version), or `position` [x, y, z] in stage metres with `yaw` and `pitch` for a defect you saw in a `look`. One pose per call, one fill at a time. The result is a NEW scene asset: when check_jobs says ready, call set_scene with it, then find_scene_gaps again. Only scenes generated here can be filled.',
    input_schema: {
      type: 'object',
      properties: {
        view_id: { type: 'string', description: 'From find_scene_gaps, e.g. g1@0. Preferred.' },
        position: { type: 'array', items: NUM, minItems: 3, maxItems: 3, description: '[x, y, z] stage metres, y up. Omit with view_id.' },
        yaw: { ...NUM, description: 'Degrees, as for characters: 0 looks -Z, 90 looks -X.' },
        pitch: { ...NUM, description: 'Degrees, positive looks up.' },
      },
    },
    async precheck(i, host) {
      try { await planFill(i, host); return null; } catch (e) { return e instanceof ToolError ? e.message : String(e); }
    },
    async run(i, host) {
      const doc = host.getDoc();
      const { pose } = await planFill(i, host);
      if (!host.assets.fillView) return fail('Filling is not set up here (no API key on the server).');
      // The editor's frame -> the scene file's: the camera is stood where the file's own units say.
      const mount = placeWalkScene(doc.scene!.placement!);
      const job = await host.assets.fillView({
        sceneUrl: doc.scene!.url,
        position: worldToFilePoint(mount, pose.position),
        yaw: pose.yaw - mount.rotation.y,
        pitch: pose.pitch,
      });
      return ok({
        job_id: job.id, status: job.status, credits: job.credits,
        note: 'Started: takes one to three minutes. Poll check_jobs; when it is ready call set_scene with its asset id (the scene changes under you, so people and shots stay as they are), then find_scene_gaps again. Say what you filled and what it cost.',
      });
    },
  },

  // ── Stage ──
  {
    name: 'set_scene',
    effect: 'edit',
    description: 'Put the stage in a scene (a scene asset id or name). The floor and scale are measured when it loads. Characters keep their positions.',
    input_schema: { type: 'object', properties: { scene: { type: 'string' } }, required: ['scene'] },
    async run(i, host) {
      const a = await findAsset(host, 'scene', i.scene);
      host.update((d) => ({ ...d, scene: { name: a.name, url: a.url, placement: null, viggle: a.viggle ?? null, panoramaUrl: a.panoramaUrl ?? null } }));
      const r = host.renderer;
      if (r) { r.setDoc(host.getDoc()); await settle(r); }
      return ok({ scene: a.name, note: 'Call get_world_layout to see where the floor is.' });
    },
  },
  {
    name: 'set_timeline',
    effect: 'edit',
    description: 'The world\'s `title`, and the timeline: length (seconds), frame rate and frame aspect.',
    input_schema: { type: 'object', properties: { title: { type: 'string', description: 'A short name for the world, in the user\'s language.' }, duration: NUM, fps: { type: 'number', enum: [24, 25, 30] }, aspect: { type: 'string', enum: Object.keys(ASPECTS) } } },
    async run(i, host) {
      host.update((d) => ({
        ...d,
        ...(typeof i.title === 'string' && i.title.trim() ? { title: i.title.trim().slice(0, 40) } : {}),
        ...(typeof i.duration === 'number' ? { duration: clamp(i.duration, 1, 600) } : {}),
        ...(i.fps ? { fps: i.fps } : {}),
        ...(i.aspect ? { aspect: i.aspect as StageAspect } : {}),
      }));
      const d = host.getDoc();
      return ok({ title: d.title, duration: d.duration, fps: d.fps, aspect: d.aspect });
    },
  },

  // ── Characters ──
  {
    name: 'add_character',
    effect: 'edit',
    description: 'Cast a character (a character asset id or name) onto the stage. Place them at `position`, or `near` someone/something (`distance` metres away, `bearing` degrees round from the way the reference faces, 0 = in front). Face a direction (`yaw`, 0 = -Z) or `face` a character, a point, or "camera". Returns the new character id.',
    input_schema: {
      type: 'object',
      properties: {
        asset: { type: 'string' }, name: { type: 'string' },
        position: POINT,
        near: SUBJECT, distance: NUM, bearing: NUM,
        yaw: NUM, face: { description: 'A character, a point [x, z], a shot id (face that shot\'s camera - use this for "look at the camera"), or "camera" (the user\'s editor view).', anyOf: [{ type: 'string' }, POINT] },
        height: { ...NUM, description: 'Metres, default 1.7.' },
      },
      required: ['asset'],
    },
    async run(i, host) {
      const a = await findAsset(host, 'character', i.asset);
      const doc = host.getDoc();
      let position: Vec3Tuple;
      if (Array.isArray(i.position)) position = onFloor(host, i.position);
      else if (i.near !== undefined) {
        const ref = i.near === 'camera' && host.renderer ? { position: host.renderer.getCamera().position, yaw: 0, height: 1.7 } : subjectAt(host, doc, i.near, 0);
        const yaw = i.near === 'camera' && host.renderer ? yawToward(host.renderer.getCamera().position, host.renderer.getCamera().target) : ref.yaw;
        const a2 = ((yaw + (i.bearing ?? 0)) * Math.PI) / 180;
        const dist = i.distance ?? 1.5;
        position = onFloor(host, [ref.position[0] - Math.sin(a2) * dist, ref.position[2] - Math.cos(a2) * dist]);
      } else position = onFloor(host, [0, -2.5]);
      const yaw = faceYaw(host, doc, position, i.face, i.yaw ?? 180);
      const id = uid('chr');
      const name = String(i.name || a.name);
      host.update((d) => ({ ...d, characters: [...d.characters, { id, name, url: a.url, position, yaw, height: clamp(i.height ?? 1.7, 0.3, 4), clips: [] }] }));
      const floorWarn = host.renderer && host.renderer.floorAt(position[0], position[2]) === null ? ' Warning: no floor found under that point - check with get_world_layout.' : '';
      return ok({ character_id: id, name, position, yaw: Math.round(yaw), note: `Loaded on stage.${floorWarn}` });
    },
  },
  {
    name: 'update_character',
    effect: 'edit',
    description: 'Change a character\'s starting position, facing (`yaw`, or `face` a character / point / "camera"), height or name. Their moves start from the new position.',
    input_schema: { type: 'object', properties: { character: { type: 'string' }, name: { type: 'string' }, position: POINT, yaw: NUM, face: { anyOf: [{ type: 'string' }, POINT] }, height: NUM }, required: ['character'] },
    async run(i, host) {
      const doc = host.getDoc();
      const c = findCharacter(doc, i.character);
      const position = Array.isArray(i.position) ? onFloor(host, i.position) : c.position;
      const patch: Partial<StageCharacter> = { position };
      if (i.name) patch.name = String(i.name);
      if (typeof i.height === 'number') patch.height = clamp(i.height, 0.3, 4);
      if (typeof i.yaw === 'number' || i.face !== undefined) patch.yaw = faceYaw(host, doc, position, i.face, i.yaw ?? c.yaw);
      host.update((d) => patchCharacter(d, c.id, patch));
      return ok({ character_id: c.id, position: patch.position, yaw: Math.round(patch.yaw ?? c.yaw) });
    },
  },
  {
    name: 'remove_character',
    effect: 'edit',
    description: 'Take a character off the stage, with their clips and moves.',
    input_schema: { type: 'object', properties: { character: { type: 'string' } }, required: ['character'] },
    async run(i, host) {
      const c = findCharacter(host.getDoc(), i.character);
      host.update((d) => removeCharacter(d, c.id));
      return ok({ removed: c.id });
    },
  },

  // ── Motion ──
  {
    name: 'set_motion_sequence',
    effect: 'edit',
    description: 'Choreograph what one character does, in order: replaces their motion clips with the given sequence, laid end to end from `start` (each item can wait `gap` seconds first). Each item: a motion asset id/name, optional `seconds` (default the motion\'s own length; longer with `loop` repeats it), `loop`, `root_motion` (default true: a walk motion carries them forward; false plays it on the spot). Returns the clip times.',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string' },
        start: NUM,
        sequence: {
          type: 'array',
          items: { type: 'object', properties: { motion: { type: 'string' }, seconds: NUM, loop: { type: 'boolean' }, gap: NUM, root_motion: { type: 'boolean' } }, required: ['motion'] },
        },
      },
      required: ['character', 'sequence'],
    },
    async run(i, host) {
      const c = findCharacter(host.getDoc(), i.character);
      const clips: StageClip[] = [];
      let at = Math.max(0, i.start ?? 0);
      for (const item of i.sequence as Array<Record<string, any>>) { // eslint-disable-line @typescript-eslint/no-explicit-any
        const m = await findAsset(host, 'motion', item.motion);
        const own = (await host.renderer?.measureClip(m.url)) ?? m.seconds ?? 3;
        at += Math.max(0, item.gap ?? 0);
        const len = item.seconds ?? own;
        clips.push({ id: uid('clip'), name: m.name, url: m.url, start: r2(at), end: r2(at + len), loop: item.loop ?? len > own + 0.05, ...(item.root_motion === false ? { rootMotion: false } : {}) });
        at += len;
      }
      // Keep clips that play under moves (gait), drop the rest.
      host.update((d) => extend({ ...d, characters: d.characters.map((k) => (k.id === c.id ? { ...k, clips: [...k.clips.filter((x) => x.id.startsWith('gait_')), ...clips] } : k)) }, at));
      return ok({ character_id: c.id, clips: clips.map((k) => ({ id: k.id, motion: k.name, start: k.start, end: k.end, loop: k.loop })), ends_at: r2(at) });
    },
  },
  {
    name: 'add_motion',
    effect: 'edit',
    description: 'Add one motion clip to a character at `start` (seconds, or "after_last"). `seconds` sets its length (default the motion\'s own); `loop` repeats it to fill.',
    input_schema: { type: 'object', properties: { character: { type: 'string' }, motion: { type: 'string' }, start: { anyOf: [NUM, { type: 'string', enum: ['after_last'] }] }, seconds: NUM, loop: { type: 'boolean' }, root_motion: { type: 'boolean' } }, required: ['character', 'motion'] },
    async run(i, host) {
      const c = findCharacter(host.getDoc(), i.character);
      const m = await findAsset(host, 'motion', i.motion);
      const own = (await host.renderer?.measureClip(m.url)) ?? m.seconds ?? 3;
      const start = typeof i.start === 'number' ? Math.max(0, i.start) : nextFreeStart(c.clips);
      const len = i.seconds ?? own;
      const clip: StageClip = { id: uid('clip'), name: m.name, url: m.url, start: r2(start), end: r2(start + len), loop: i.loop ?? len > own + 0.05, ...(i.root_motion === false ? { rootMotion: false } : {}) };
      host.update((d) => addClip(d, c.id, clip));
      return ok({ clip_id: clip.id, start: clip.start, end: clip.end, motion_seconds: r2(own) });
    },
  },
  {
    name: 'edit_motion_clip',
    effect: 'edit',
    description: 'Retime, loop, root-motion toggle or delete one clip (ids from get_stage).',
    input_schema: { type: 'object', properties: { character: { type: 'string' }, clip_id: { type: 'string' }, start: NUM, end: NUM, loop: { type: 'boolean' }, root_motion: { type: 'boolean' }, delete: { type: 'boolean' } }, required: ['character', 'clip_id'] },
    async run(i, host) {
      const c = findCharacter(host.getDoc(), i.character);
      const k = c.clips.find((x) => x.id === i.clip_id);
      if (!k) return fail(`No clip ${i.clip_id} on ${c.name}. Clips: ${c.clips.map((x) => x.id).join(', ')}`);
      if (i.delete) { host.update((d) => removeClip(d, c.id, k.id)); return ok({ deleted: k.id }); }
      const start = typeof i.start === 'number' ? Math.max(0, i.start) : k.start;
      const end = typeof i.end === 'number' ? i.end : start + (k.end - k.start);
      if (end <= start) return fail('end must be after start.');
      const next: StageClip = { ...k, start: r2(start), end: r2(end), loop: i.loop ?? k.loop, ...(typeof i.root_motion === 'boolean' ? { rootMotion: i.root_motion } : {}) };
      host.update((d) => extend({ ...d, characters: d.characters.map((x) => (x.id === c.id ? { ...x, clips: x.clips.map((y) => (y.id === k.id ? next : y)) } : x)) }, end));
      return ok({ clip_id: k.id, start: next.start, end: next.end, loop: next.loop });
    },
  },

  // ── Movement ──
  {
    name: 'move_character',
    effect: 'edit',
    description: 'Block movement: the character travels from wherever they are at `start` through `waypoints` (or `to` a point, or `toward` another character, stopping `stop_distance` short) - on the floor, at even speed, turning to face the way they go. Give `seconds`, or let `gait` set the pace (walk 1.3 m/s, run 3.4 m/s). A matching in-place walk/run clip is laid under the move automatically (`gait: "none"` to skip, e.g. when a motion clip already walks). `end_face`: a yaw, a character, a point, or a shot id (face that shot\'s camera on arrival - what "turns to the camera" means).',
    input_schema: {
      type: 'object',
      properties: {
        character: { type: 'string' },
        start: NUM, seconds: NUM,
        to: POINT, waypoints: { type: 'array', items: POINT }, toward: { type: 'string' }, stop_distance: NUM,
        gait: { type: 'string', enum: ['walk', 'run', 'none'] },
        easing: { type: 'string', enum: ['linear', 'easeIn', 'easeOut', 'easeInOut'] },
        end_face: { anyOf: [NUM, { type: 'string' }, POINT] },
      },
      required: ['character'],
    },
    async run(i, host) {
      const doc = host.getDoc();
      const c = findCharacter(doc, i.character);
      const start = Math.max(0, i.start ?? 0);
      const from = placeAt(host, c, start).position;
      let points: Vec3Tuple[];
      if (Array.isArray(i.waypoints) && i.waypoints.length) points = (i.waypoints as number[][]).map((p) => onFloor(host, p));
      else if (Array.isArray(i.to)) points = [onFloor(host, i.to)];
      else if (i.toward !== undefined) {
        const other = findCharacter(doc, i.toward);
        const p = placeAt(host, other, start).position;
        const dx = p[0] - from[0], dz = p[2] - from[2];
        const len = Math.hypot(dx, dz) || 1;
        const stop = Math.min(len, i.stop_distance ?? 1);
        points = [onFloor(host, [p[0] - (dx / len) * stop, p[2] - (dz / len) * stop])];
      } else return fail('Give `to`, `waypoints` or `toward`.');
      const gait = (i.gait ?? 'walk') as 'walk' | 'run' | 'none';
      const probe: StageMove = { id: '', start, end: start, points, easing: 'linear' };
      const distance = moveLength(from, probe);
      const seconds = i.seconds ?? Math.max(0.5, distance / PACE[gait === 'run' ? 'run' : 'walk']);
      const end = start + seconds;
      const blocked = host.renderer ? points.filter((p) => host.renderer!.floorAt(p[0], p[2]) === null) : [];
      const move: StageMove = { id: uid('move'), start: r2(start), end: r2(end), points, easing: (i.easing ?? 'easeInOut') as Easing };
      if (i.end_face !== undefined) move.endYaw = faceYaw(host, doc, points[points.length - 1]!, typeof i.end_face === 'number' ? undefined : i.end_face, typeof i.end_face === 'number' ? i.end_face : 0, end);
      const overlap = (c.moves ?? []).find((m) => m.start < end && start < m.end);
      if (overlap) return fail(`${c.name} already moves from ${overlap.start}s to ${overlap.end}s (move ${overlap.id}); start after it or remove it with clear_moves.`);
      host.update((d) => {
        let next = addMove(d, c.id, move);
        if (gait !== 'none') {
          next = addClip(next, c.id, { id: uid('gait'), name: gait === 'run' ? 'Run' : 'Walk', url: GAIT_CLIPS[gait], start: move.start, end: move.end, loop: true, rootMotion: false });
        }
        return extend(next, end);
      });
      return ok({
        move_id: move.id, from: v3(from), to: points[points.length - 1], start: move.start, end: move.end, metres: r2(distance),
        ...(blocked.length ? { warning: `No floor found at ${JSON.stringify(blocked)} - they may walk through a wall or off the set. Check get_world_layout.` } : {}),
      });
    },
  },
  {
    name: 'clear_moves',
    effect: 'edit',
    description: 'Remove a character\'s moves (all, or one `move_id`), with the walk/run clips laid under them. They stay at their starting position.',
    input_schema: { type: 'object', properties: { character: { type: 'string' }, move_id: { type: 'string' } }, required: ['character'] },
    async run(i, host) {
      const c = findCharacter(host.getDoc(), i.character);
      const gone = (c.moves ?? []).filter((m) => !i.move_id || m.id === i.move_id);
      host.update((d) => patchCharacter(d, c.id, {
        moves: (c.moves ?? []).filter((m) => !gone.includes(m)),
        clips: c.clips.filter((k) => !(k.id.startsWith('gait_') && gone.some((m) => Math.abs(m.start - k.start) < 0.02 && Math.abs(m.end - k.end) < 0.02))),
      }));
      return ok({ removed: gone.map((m) => m.id) });
    },
  },

  // ── Camera ──
  {
    name: 'add_shot',
    effect: 'edit',
    description: 'Create a shot (a camera with its own move). Returns the shot id; then frame_shot / camera_move / set_camera_keys to give it a camera.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, interpolation: { type: 'string', enum: ['smooth', 'linear', 'step'] }, easing: { type: 'string', enum: ['easeInOut', 'easeIn', 'easeOut', 'linear'] } } },
    async run(i, host) {
      let id = '';
      host.update((d) => {
        const made = addShot(d, i.name);
        id = made.shot.id;
        return patchShot(made.doc, id, { ...(i.interpolation ? { interpolation: i.interpolation as Interpolation } : {}), ...(i.easing ? { easing: i.easing as Easing } : {}) });
      });
      host.ui?.preview?.({ shotId: id });
      return ok({ shot_id: id });
    },
  },
  {
    name: 'frame_shot',
    effect: 'edit',
    description: 'Set a shot\'s camera at `time` by film grammar instead of coordinates: frame a `subject` (character or point) at a shot `size`, `angle` and `side`, with lens `fov` (degrees, default 40) and optional `offset` (-1..1, puts the subject off-centre; ±0.33 is rule of thirds). Adds (or replaces) the key at that time. Follows the subject to where they are at that time. For two people (over-the-shoulder, two-shot) pass `framing` and `with`.',
    input_schema: {
      type: 'object',
      properties: { shot_id: { type: 'string' }, time: NUM, subject: SUBJECT, size: SIZE, angle: ANGLE, side: SIDE, fov: NUM, offset: NUM, ...PAIR_PROPS },
      required: ['shot_id', 'subject'],
    },
    async run(i, host) {
      checkFraming(i);
      const doc = host.getDoc();
      const shot = findShot(doc, i.shot_id);
      const t = Math.max(0, i.time ?? 0);
      const pair = pairOf(doc, i);
      if (!pair && !i.size) throw new ToolError('`size` is required for a one-subject framing.');
      const s = subjectAt(host, doc, i.subject, t);
      const cam = pair ? pairAt(host, doc, pair, i, t, pairFlip(host, doc, pair, i, t)) : frameSubject({ subject: s.position, height: s.height, facing: s.yaw, size: i.size as ShotSize, angle: i.angle as ShotAngle, side: i.side as ShotSide, fov: i.fov, offset: i.offset });
      const k = key(cam, t);
      host.update((d) => extend(patchShot(d, shot.id, { keys: replaceKeys(shot, [k], t, t) }), t));
      host.ui?.preview?.({ shotId: shot.id, time: t });
      return ok({ shot_id: shot.id, key: k, ...(pair ? { note: pairNote(pair.kind) } : {}) });
    },
  },
  {
    name: 'camera_move',
    effect: 'edit',
    description: 'Design a camera move over [start, end] seconds on a shot, replacing its keys in that span. Kinds: static (hold a framing), push_in / pull_out (dolly to `to_size`), orbit (swing `degrees` round the subject), crane_up / crane_down (rise/sink `rise` metres), pan (turn `degrees` in place), track (follow a moving subject, keeping the framing). Start framing: subject + size/angle/side/fov/offset, as in frame_shot, or a two-person `framing` + `with` (orbit works with two_shot, not over_shoulder). Then check it with contact_sheet or check_framing.',
    input_schema: {
      type: 'object',
      properties: {
        shot_id: { type: 'string' }, kind: { type: 'string', enum: ['static', 'push_in', 'pull_out', 'orbit', 'crane_up', 'crane_down', 'pan', 'track'] },
        start: NUM, end: NUM, subject: SUBJECT, size: SIZE, angle: ANGLE, side: SIDE, fov: NUM, offset: NUM, ...PAIR_PROPS,
        to_size: SIZE, degrees: NUM, rise: NUM,
        interpolation: { type: 'string', enum: ['smooth', 'linear', 'step'] }, easing: { type: 'string', enum: ['easeInOut', 'easeIn', 'easeOut', 'linear'] },
      },
      required: ['shot_id', 'kind', 'subject'],
    },
    async run(i, host) {
      checkFraming(i);
      const doc = host.getDoc();
      const shot = findShot(doc, i.shot_id);
      const start = Math.max(0, i.start ?? 0);
      const end = Math.max(start + 0.1, i.end ?? start + 4);
      const pair = pairOf(doc, i);
      if (pair?.kind === 'over_shoulder' && i.kind === 'orbit') throw new ToolError('An over-the-shoulder shot cannot orbit: use framing "two_shot" for an orbit round the pair.');
      if (!pair && !i.size) throw new ToolError('`size` is required for a one-subject framing.');
      const height = Array.isArray(i.subject) ? 1.7 : findCharacter(doc, i.subject).height;
      const size = (i.size ?? (pair?.kind === 'over_shoulder' ? 'medium_close' : 'medium_full')) as ShotSize;
      const flip = pair ? pairFlip(host, doc, pair, i, start) : false;
      const pairSide = typeof i.side === 'number' ? i.side : typeof i.side === 'string' ? SIDES[i.side as ShotSide] ?? 0 : 0;
      const samples = cameraMoveKeys({
        kind: i.kind as CameraMoveKind, start, end,
        from: { size, angle: i.angle as ShotAngle, side: pair ? pairSide : i.side as ShotSide, fov: i.fov, offset: i.offset, height },
        subjectAt: (t) => subjectAt(host, doc, i.subject, t),
        toSize: i.to_size as ShotSize | undefined, degrees: i.degrees, rise: i.rise,
        ...(pair ? { frameAt: (t: number, over: { size?: ShotSize; side?: number }) => pairAt(host, doc, pair, { ...i, size }, t, flip, over) } : {}),
      });
      const keys = samples.map((s) => key(s, s.t));
      host.update((d) => extend(patchShot(d, shot.id, {
        keys: replaceKeys(shot, keys, start, end),
        // A tracking move is many keys: ease the whole, not each step.
        ...(i.interpolation ? { interpolation: i.interpolation as Interpolation } : {}),
        ...(i.easing ? { easing: i.easing as Easing } : i.kind === 'track' ? { easing: 'linear' as Easing } : {}),
      }), end));
      host.ui?.preview?.({ shotId: shot.id, time: start });
      return ok({ shot_id: shot.id, kind: i.kind, keys: keys.length, span: [start, end], ...(pair ? { note: pairNote(pair.kind) } : {}) });
    },
  },
  {
    name: 'set_camera_keys',
    effect: 'edit',
    description: 'Exact control: set a shot\'s camera keys yourself. Each key: `t`, `position` [x, y, z], and either `target` [x, y, z] or `look_at` a character (aims at their chest at that time), and `fov`. `replace` (default true) clears keys in the keys\' time span first.',
    input_schema: {
      type: 'object',
      properties: {
        shot_id: { type: 'string' }, replace: { type: 'boolean' },
        keys: { type: 'array', items: { type: 'object', properties: { t: NUM, position: POINT, target: POINT, look_at: { type: 'string' }, fov: NUM }, required: ['t', 'position'] } },
      },
      required: ['shot_id', 'keys'],
    },
    async run(i, host) {
      const doc = host.getDoc();
      const shot = findShot(doc, i.shot_id);
      const keys: CameraKey[] = (i.keys as Array<Record<string, any>>).map((k) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const position = (k.position.length >= 3 ? k.position : [k.position[0], 1.6, k.position[1]]) as Vec3Tuple;
        let target: Vec3Tuple;
        if (Array.isArray(k.target)) target = (k.target.length >= 3 ? k.target : [k.target[0], 1.2, k.target[1]]) as Vec3Tuple;
        else if (k.look_at) { const s = subjectAt(host, doc, k.look_at, k.t); target = [s.position[0], s.position[1] + s.height * 0.65, s.position[2]]; }
        else throw new ToolError(`Key at ${k.t}s needs target or look_at.`);
        return key({ position, target, fov: k.fov ?? 40 }, Math.max(0, k.t));
      });
      const ts = keys.map((k) => k.t);
      const merged = i.replace === false ? [...shot.keys, ...keys].sort((a, b) => a.t - b.t) : replaceKeys(shot, keys, Math.min(...ts), Math.max(...ts));
      host.update((d) => extend(patchShot(d, shot.id, { keys: merged }), Math.max(...ts)));
      return ok({ shot_id: shot.id, keys: merged.length });
    },
  },
  {
    name: 'edit_shot',
    effect: 'edit',
    description: 'Rename a shot, change how its keys join (`interpolation`: smooth curve / linear / step cut) and its time `easing`, delete one key (`delete_key`), or delete the shot.',
    input_schema: { type: 'object', properties: { shot_id: { type: 'string' }, name: { type: 'string' }, interpolation: { type: 'string', enum: ['smooth', 'linear', 'step'] }, easing: { type: 'string', enum: ['easeInOut', 'easeIn', 'easeOut', 'linear'] }, delete_key: { type: 'string' }, delete: { type: 'boolean' } }, required: ['shot_id'] },
    async run(i, host) {
      const shot = findShot(host.getDoc(), i.shot_id);
      if (i.delete) { host.update((d) => removeShot(d, shot.id)); return ok({ deleted: shot.id }); }
      host.update((d) => patchShot(d, shot.id, {
        ...(i.name ? { name: String(i.name) } : {}),
        ...(i.interpolation ? { interpolation: i.interpolation as Interpolation } : {}),
        ...(i.easing ? { easing: i.easing as Easing } : {}),
        ...(i.delete_key ? { keys: shot.keys.filter((k) => k.id !== i.delete_key) } : {}),
      }));
      return ok({ shot_id: shot.id });
    },
  },

  {
    name: 'set_edit',
    effect: 'edit',
    description: 'Cut the shots together into one film: a running order of `{shot_id, start}` - each shot plays from its start until the next one starts, the last until `end` (default the timeline\'s end). Every shot films the same performance on the same clock, so a cut only picks the camera. Cut on action or on a line of dialogue: e.g. two-shot to establish, then over-the-shoulder on whoever speaks, the reverse when the other answers. `clear: true` removes the edit. Then `preview` with `edit: true`.',
    input_schema: {
      type: 'object',
      properties: {
        cuts: { type: 'array', items: { type: 'object', properties: { shot_id: { type: 'string' }, start: NUM }, required: ['shot_id', 'start'] } },
        end: NUM,
        clear: { type: 'boolean' },
      },
    },
    async run(i, host) {
      if (i.clear) { host.update((d) => ({ ...d, cuts: [] })); return ok({ edit: [] }); }
      const doc = host.getDoc();
      const order = ((i.cuts ?? []) as Array<{ shot_id: string; start: number }>).map((c) => ({ shotId: findShot(doc, c.shot_id).id, start: Math.max(0, Number(c.start) || 0) }));
      if (!order.length) throw new ToolError('Give at least one cut, or clear: true.');
      const end = typeof i.end === 'number' ? i.end : doc.duration;
      host.update((d) => setSequence(extend(d, end), order, end));
      const next = host.getDoc();
      const cuts = sortedCuts(next);
      const unkeyed = cuts.filter((c) => !next.shots.find((s) => s.id === c.shotId)?.keys.length).map((c) => c.shotId);
      return ok({
        edit: cuts.map((c) => ({ shot: c.shotId, start: c.start, end: c.end })),
        span: editSpan(next),
        ...(unkeyed.length ? { warning: `These shots have no camera keys yet, so their stretch shows nothing: ${[...new Set(unkeyed)].join(', ')}.` } : {}),
      });
    },
  },

  // ── Editor ──
  {
    name: 'preview',
    effect: 'ui',
    description: 'Show the user: point the viewport through a shot, through the edit (`edit: true`, the film as cut), or the free camera (shot_id null); move the playhead to `time`, and optionally `play`.',
    input_schema: { type: 'object', properties: { shot_id: { type: ['string', 'null'] }, edit: { type: 'boolean' }, time: NUM, play: { type: 'boolean' } } },
    async run(i, host) {
      if (!host.ui?.preview) return fail('No editor to preview in.');
      if (i.edit) {
        if (!sortedCuts(host.getDoc()).length) return fail('There is no edit yet: set_edit first.');
        host.ui.preview({ edit: true, time: i.time, play: i.play });
        return ok('Showing the edit to the user.');
      }
      if (i.shot_id) findShot(host.getDoc(), i.shot_id);
      host.ui.preview({ shotId: i.shot_id ?? null, time: i.time, play: i.play });
      return ok('Showing it to the user.');
    },
  },
  {
    name: 'undo',
    effect: 'ui',
    description: 'Undo the last edit (yours or the user\'s). `steps` to go back several.',
    input_schema: { type: 'object', properties: { steps: NUM } },
    async run(i, host) {
      if (!host.ui?.undo) return fail('Undo is not available here.');
      for (let n = 0; n < Math.max(1, Math.min(20, i.steps ?? 1)); n++) host.ui.undo();
      return ok('Undone.');
    },
  },
  {
    name: 'export_shot',
    effect: 'ui',
    description: 'Render for the user: a shot as "mp4" (the whole move, frame by frame) or "png" (one frame at `time`), or with `edit: true` the whole edit as mp4. Downloads in the editor. Only when the user asks for a file.',
    input_schema: { type: 'object', properties: { shot_id: { type: 'string' }, edit: { type: 'boolean' }, format: { type: 'string', enum: ['mp4', 'png'] }, time: NUM }, required: ['format'] },
    async run(i, host) {
      if (i.edit) {
        if (!host.ui?.exportEdit) return fail('Export is not available here.');
        if (!sortedCuts(host.getDoc()).length) return fail('There is no edit yet: set_edit first.');
        return ok(await host.ui.exportEdit());
      }
      if (!host.ui?.exportShot) return fail('Export is not available here.');
      const shot = findShot(host.getDoc(), i.shot_id);
      return ok(await host.ui.exportShot(shot.id, i.format, i.time));
    },
  },
];

/** The yaw that faces `face` from `at` (a character, a point, "camera"), else `fallback`. */
function faceYaw(host: StageToolHost, doc: StageDoc, at: Vec3Tuple, face: unknown, fallback: number, t = 0): number {
  if (face === undefined || face === null) return fallback;
  if (face === 'camera') {
    const cam = host.renderer?.getCamera();
    return cam ? yawToward(at, cam.position) : fallback;
  }
  if (Array.isArray(face)) return yawToward(at, onFloor(host, face as number[]));
  // A shot: face where its camera is at that moment.
  const shot = doc.shots.find((s) => s.id === face || s.name === face);
  if (shot) {
    const cam = sampleShot(shot, t);
    if (cam) return yawToward(at, cam.position);
    throw new ToolError(`Shot "${shot.name}" has no camera yet, so there is nothing to face: frame_shot it first, then set the facing.`);
  }
  const c = findCharacter(doc, face);
  return yawToward(at, placeAt(host, c, t).position);
}

/** The definitions to send to the model (Messages API `tools`). */
export function stageToolDefinitions(tools: StageTool[] = STAGE_TOOLS): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return tools.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/** Run one tool call. Never throws: a bad call comes back as an `is_error` result the model can read and correct. */
export async function runStageTool(name: string, input: Record<string, unknown>, host: StageToolHost, tools: StageTool[] = STAGE_TOOLS): Promise<ToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return fail(`No tool "${name}".`);
  try {
    return await tool.run(input ?? {}, host);
  } catch (e) {
    return fail(e instanceof ToolError ? e.message : `${name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
