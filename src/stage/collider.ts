import type { ColliderFrame, Environment, SceneColliderData, WalkerCapsule } from '@viggle/splat-engine';
import {
  capsuleForWalker,
  COLLIDER_BAND_ABOVE_M,
  COLLIDER_BAND_BELOW_M,
  COLLIDER_SAMPLE_POINTS,
  environmentColliderFrame,
  minStepLimit,
  SceneCollider,
} from '@viggle/splat-engine';

/**
 * The scene's walls and floor for the stage: the engine's voxel collider, built in a worker around where the
 * people stand, and the floor and wall queries answered from it.
 *
 * Copied from PINOC (src/components/viewer3d/walkCollider.ts): its constants, the crop of the sample round the
 * walker, the build request, the floor read (a centre-weighted mean over a disc, lifted by the grid's bias, with
 * the floor index answering where the collider has no floor), the push-out. What is left out is what a walk
 * needs and a stage does not: rebuilding the grid as she walks away from where it was built, and the pipeline's
 * stored collider, which the published engine cannot read.
 */

/** Band kept above the walker's floor, in walker heights: room for her head on anything one jump and a step
 *  can put her on, so a ceiling too low to stand there is in the grid. Never under the engine's 3 m. */
const BAND_HEIGHTS = 2;

/** Horizontal radius of the scene kept around her, metres. Built whole, a big outdoor capture's grid coarsens
 *  until it has no floor detail left. */
const CROP_RADIUS = 15;

/** Points wanted inside the crop. The sample strides the whole file, so on a big scene few of its 200k land
 *  near her and it is taken again, denser. */
const CROP_POINTS = 200_000;

/** The densest sample taken, for the main-thread cost. */
const MAX_SAMPLE_POINTS = 2_000_000;

/** How far the collider's floor reads above the visible one, in voxels: the answer is a cell's TOP, and the
 *  build dilates by one cell. */
const FLOOR_BIAS_VOXELS = 1.5;

/** The floor is read from a disc this much narrower than her body, so she stands on an edge with her feet on
 *  it rather than hanging up to a full body radius off it. */
const FLOOR_READ_OF_RADIUS = 0.8;

/** Where the floor is read across that disc, as [fraction of its radius, points, weight of each]:
 *  centre-weighted, so a column entering at the rim moves the answer least. */
const FLOOR_RINGS: readonly [number, number, number][] = [[0, 1, 1], [0.5, 6, 0.75], [0.9, 6, 0.25]];

/** A column more than this many voxels under the disc's highest counts as this far under: an edge she stands
 *  on still holds her up. */
const FLOOR_SPREAD_VOXELS = 2;

/** Largest height change one step may take, as a fraction of the walker (PINOC's WALK_STEP_FRACTION): a 1.7 m
 *  body steps 0.42 m, about a stair and a half. */
export const STEP_FRACTION = 0.25;

/** The height a person on the stage is, until their own is known. */
export const DEFAULT_HEIGHT = 1.7;

/** What the stage knows about its ground before any collider exists. */
export interface StageGround {
  /** The floor index, which answers wherever the collider has no floor. */
  floorIndexAt: (x: number, z: number, aperture: number, fromY: number, maxDrop: number) => number | null;
}

type Sample = ReturnType<Environment['sampleWorldSample']>;

/**
 * The collider for one scene: builds it around the capture point, answers the floor and wall queries from it.
 * Dispose with its owner.
 */
export class StageColliders {
  private readonly ground: StageGround;
  private entry: { env: Environment; collider: SceneCollider | null; building: boolean } | null = null;
  /** Bumped whenever the collider answering changes. */
  private gen = 0;

  constructor(ground: StageGround) {
    this.ground = ground;
  }

  /** Bumped whenever the collider answering changes: a cache keyed on it stays right. */
  get generation(): number { return this.gen; }

  /** The collider answering now, or null before the first one has landed (or for a scene with nothing to collide with). */
  get collider(): SceneCollider | null {
    return this.entry?.collider ?? null;
  }

  /** Whether a collider for the scene is on its way: asked for, not landed yet. */
  get pending(): boolean {
    return !!this.entry && this.entry.building;
  }

  /** Forget the scene's collider (the scene went, or changed). */
  reset(): void {
    this.entry = null;
    this.gen++;
  }

  /**
   * Build the collider for `env` around `at` (where the floor under the capture point is, world metres), for a
   * walker `height` tall. Resolves when it has landed, or failed (a build that fails leaves the floor index
   * answering).
   */
  async build(env: Environment, at: { x: number; y: number; z: number }, height = DEFAULT_HEIGHT): Promise<void> {
    // The collider already built for this scene keeps answering until the new one lands.
    const entry = { env, collider: this.entry?.env === env ? this.entry.collider : null, building: true };
    this.entry = entry;
    this.gen++;
    try {
      const collider = await buildStageCollider(env, at, height);
      if (this.entry !== entry) return;
      entry.collider = collider;
    } catch (e) {
      // eslint-disable-next-line no-console -- non-fatal: the floor index keeps answering
      console.warn('[stage collider] build failed:', e);
    } finally {
      if (this.entry === entry) { entry.building = false; this.gen++; }
    }
  }

  /** The capsule for a walker `height` tall, against this grid. */
  capsule(c: SceneCollider, height = DEFAULT_HEIGHT): WalkerCapsule {
    return capsuleForWalker(height, Math.max(height * STEP_FRACTION, minStepLimit(c.voxelMetres)), c.voxelMetres);
  }

  /** The visible floor under (x, z). With `bodyTest`, null where a body `height` tall does not fit on the
   *  collider's floor (a wall). */
  floor(x: number, z: number, aperture: number, fromY: number, bodyTest: boolean, height = DEFAULT_HEIGHT): number | null {
    const c = this.collider;
    if (c) {
      const capsule = this.capsule(c, height);
      const radius = capsule.radius * FLOOR_READ_OF_RADIUS;
      const ground = c.groundAt(x, z, fromY, radius);
      if (ground !== null) {
        if (bodyTest && c.blocked(x, z, ground, capsule)) return null;
        return meanFloor(c, x, z, fromY, radius, ground) - bias(c);
      }
    }
    return this.ground.floorIndexAt(x, z, aperture, fromY, height * 3);
  }

  /** The visible floor under (x, z) looking down from `fromY`, from the collider alone: what a host stands
   *  other people on. */
  surfaceAt(x: number, z: number, fromY: number, height = DEFAULT_HEIGHT): number | null {
    const c = this.collider;
    if (!c) return null;
    const ground = c.groundAt(x, z, fromY + bias(c), this.capsule(c, height).radius * FLOOR_READ_OF_RADIUS);
    return ground === null ? null : ground - bias(c);
  }

  /** How deep a body `height` tall standing at (x, z) on `y` is inside solid, or 0. */
  overlap(x: number, z: number, y: number, height = DEFAULT_HEIGHT): number {
    const c = this.collider;
    if (!c) return 0;
    return c.overlap(x, z, y + bias(c), this.capsule(c, height));
  }

  /** Where a body `height` tall moved to (x, z) on `y` ends up, collided and slid along the walls; null with no collider. */
  resolve(x: number, z: number, y: number, height = DEFAULT_HEIGHT): { x: number; z: number } | null {
    const c = this.collider;
    return c ? c.resolve(x, z, y + bias(c), this.capsule(c, height)) : null;
  }

  /** A spawn inside a wall, or inside the capture's own shell, can never step out: nudged clear. Null when it
   *  is already clear (or there is no collider). */
  pushOut(x: number, z: number, y: number, height = DEFAULT_HEIGHT): { x: number; z: number } | null {
    const c = this.collider;
    if (!c) return null;
    const capsule = this.capsule(c, height);
    const feet = y + bias(c);
    if (c.overlap(x, z, feet, capsule) === 0) return null;
    const out = c.pushOut(x, z, feet, capsule);
    return out.x !== x || out.z !== z ? out : null;
  }
}

/** The disc's floor as the weighted mean of its columns' tops, not the highest
 *  one: the highest climbs a slope a whole voxel at a time. */
function meanFloor(c: SceneCollider, x: number, z: number, fromY: number, radius: number, highest: number): number {
  const v = c.voxelMetres;
  const lowest = highest - v * FLOOR_SPREAD_VOXELS;
  // Just wide enough to always hold the column under the point.
  const column = v * 0.71;
  let sum = 0;
  let weight = 0;
  for (const [ring, points, w] of FLOOR_RINGS) {
    for (let i = 0; i < points; i++) {
      const a = (i / points) * 2 * Math.PI;
      const top = c.groundAt(x + Math.cos(a) * ring * radius, z + Math.sin(a) * ring * radius, fromY, column);
      sum += w * Math.min(highest, Math.max(lowest, top ?? lowest));
      weight += w;
    }
  }
  return sum / weight;
}

/** How far the collider's floor reads above the visible one. */
export function bias(c: SceneCollider): number {
  return c.voxelMetres * FLOOR_BIAS_VOXELS;
}

/**
 * Build the collider for a walker whose feet are at `at.y`, standing at (`at.x`, `at.z`). Null when the capture
 * has nothing to collide with there.
 */
async function buildStageCollider(env: Environment, at: { x: number; y: number; z: number }, height: number): Promise<SceneCollider | null> {
  // At least her own height below her feet, so a walk that starts on a ledge has the ground below it in the grid.
  const lo = at.y - Math.max(COLLIDER_BAND_BELOW_M, height);
  const hi = at.y + Math.max(COLLIDER_BAND_ABOVE_M, height * BAND_HEIGHTS);
  const walker = { x: at.x, y: at.y, z: at.z, radius: capsuleForWalker(height, height * STEP_FRACTION, 0).radius, height };
  let sample = env.sampleWorldSample(COLLIDER_SAMPLE_POINTS);
  let crop = cropAround(sample, at, lo, hi);
  const taken = sample.positions.length / 3;
  if (crop.kept < CROP_POINTS * 0.75 && taken >= COLLIDER_SAMPLE_POINTS) {
    const count = Math.min(MAX_SAMPLE_POINTS, Math.ceil((taken * CROP_POINTS) / Math.max(1, crop.kept)));
    sample = env.sampleWorldSample(count);
    crop = cropAround(sample, at, lo, hi);
  }
  const { positions, alpha } = crop;
  if (positions.length === 0) return null;
  const frame = environmentColliderFrame(env);
  const data = await buildInWorker({
    positions,
    alpha,
    frame,
    // The engine hangs its band from a floor percentile inside this crop, so asking for the crop's full height
    // keeps all of it.
    tuning: { bandAboveM: hi - lo },
    walker,
  });
  return data ? SceneCollider.fromData(data, () => environmentColliderFrame(env)) : null;
}

/** The sample's points inside the band [lo, hi] and within CROP_RADIUS of her. */
function cropAround(
  sample: Sample,
  at: { x: number; z: number },
  lo: number,
  hi: number,
): { positions: Float32Array; alpha: Float32Array | null; kept: number } {
  const src = sample.positions;
  const n = src.length / 3;
  const r2 = CROP_RADIUS * CROP_RADIUS;
  const inside = (i: number) => {
    const y = src[i * 3 + 1]!;
    if (y < lo || y > hi) return false;
    const dx = src[i * 3]! - at.x, dz = src[i * 3 + 2]! - at.z;
    return dx * dx + dz * dz <= r2;
  };
  let kept = 0;
  for (let i = 0; i < n; i++) if (inside(i)) kept++;
  const positions = new Float32Array(kept * 3);
  const alpha = sample.alpha ? new Float32Array(kept) : null;
  for (let i = 0, k = 0; i < n; i++) {
    if (!inside(i)) continue;
    positions[k * 3] = src[i * 3]!;
    positions[k * 3 + 1] = src[i * 3 + 1]!;
    positions[k * 3 + 2] = src[i * 3 + 2]!;
    if (alpha) alpha[k] = sample.alpha![i]!;
    k++;
  }
  return { positions, alpha, kept };
}

/** What the engine's collider worker is asked: the cropped sample, where it is, how to build, and the walker the
 *  build is seeded from. */
interface BuildRequest {
  positions: Float32Array;
  alpha: Float32Array | null;
  frame: ColliderFrame;
  tuning: { bandAboveM: number };
  walker: { x: number; y: number; z: number; radius: number; height: number };
}
type BuildResponse = { ok: true; data: SceneColliderData | null } | { ok: false; error: string };

/** One worker shared by every build. It answers in order, so pending builds are a FIFO; a crash fails them all
 *  and the next build starts a fresh one. Kept for the next build, terminated once idle this long. */
const WORKER_IDLE_MS = 30_000;
let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const pending: { resolve: (d: SceneColliderData | null) => void; reject: (e: Error) => void }[] = [];

function releaseWorker(): void {
  if (pending.length > 0 || !worker) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.length > 0 || !worker) return;
    worker.terminate();
    worker = null;
  }, WORKER_IDLE_MS);
}

function failWorker(w: Worker, message: string): void {
  w.terminate();
  if (worker === w) worker = null;
  const error = new Error(`stage collider worker failed: ${message}`);
  for (const p of pending.splice(0)) p.reject(error);
}

function buildInWorker(request: BuildRequest): Promise<SceneColliderData | null> {
  if (!worker) {
    const w = new Worker(new URL('./collider.worker.ts', import.meta.url), { type: 'module', name: 'stage-collider' });
    w.onmessage = (e: MessageEvent<BuildResponse>) => {
      const next = pending.shift();
      if (next) {
        if (e.data.ok) next.resolve(e.data.data);
        else next.reject(new Error(e.data.error));
      }
      releaseWorker();
    };
    w.onerror = (e) => failWorker(w, e.message);
    w.onmessageerror = () => failWorker(w, 'reply could not be decoded');
    worker = w;
  }
  const w = worker;
  return new Promise((resolve, reject) => {
    pending.push({ resolve, reject });
    const transfer: ArrayBuffer[] = [request.positions.buffer as ArrayBuffer];
    if (request.alpha) transfer.push(request.alpha.buffer as ArrayBuffer);
    w.postMessage(request, transfer);
  });
}
