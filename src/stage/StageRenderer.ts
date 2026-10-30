import { Animation, Character, Environment, FlyControls, Scene } from '@viggle/splat-engine';

import { probeFacing, probeRootTravel } from '../engine/probes.js';
import type { FloorIndex } from '../walk/floorIndex.js';
import { buildFloorIndex } from '../walk/floorIndex.js';
import { isUprightFile, placementFromGround, placeWalkScene } from '../walk/placement.js';
import type { CameraSample } from './camera.js';
import { sampleShot, shotPath, sortedKeys } from './camera.js';
import { sampleTrack, trackTravel } from './clips.js';
import { sampleMoves } from './moves.js';
import type { StageCharacter, StageDoc, StagePlacement, StageShot, Vec3Tuple } from './types.js';

/** What the viewport shows: the free editing camera, a shot's camera, or a fixed camera (an agent looking somewhere). */
export type StageView = { kind: 'free' } | { kind: 'shot'; shotId: string } | { kind: 'camera'; camera: CameraSample };

export interface StageRendererEvents {
  /** The scene finished loading; `placement` is what it was mounted with (measured when the doc had none). */
  onSceneLoaded?: (placement: StagePlacement, measured: boolean) => void;
  onSceneError?: (error: unknown) => void;
  /** A character, or one of its clips, finished loading or failed. */
  onAssetState?: (state: StageAssetState) => void;
}

export interface StageAssetState {
  /** Character ids still loading. */
  loadingCharacters: string[];
  /** Clip URLs still loading. */
  loadingClips: string[];
  sceneLoading: boolean;
  errors: string[];
}

/** The clip a character holds when its track is empty: Viggle's public idle, retargeted to every splat character. */
export const DEFAULT_IDLE_CLIP = 'https://assets.viggle.ai/pub/www/jst2-gallery/pinoc-standing-idle-3e1a1f20.glb';

/** The rig's clips are authored at 30 fps; `animationTime` counts frames. */
const CLIP_FPS = 30;
/** `.vsplat` bodies face +Z at rest; a yaw of 0 faces -Z. */
const FACING_OFFSET = 180;
/** A clip whose body starts turned further than this (degrees) is turned back to face the character's yaw. */
const TURN_THRESHOLD = 30;

interface LiveCharacter {
  url: string;
  character: Character | null;
  /** The clip key playing, to switch only when it changes. */
  playing: string | null;
  ticket: number;
}

interface LoadedClip {
  key: string;
  frames: number;
}

/**
 * The 3D Studio's stage: a Gaussian-splat scene, any number of Viggle splat
 * characters on it playing their tracks, and the shots that film them - all
 * driven by one clock (`setTime`), so scrubbing, playback and export see the
 * same frame.
 *
 * Framework-free. Feed it the whole doc on every change (`setDoc`); it loads
 * what is new and drops what went.
 */
export class StageRenderer {
  private doc: StageDoc | null = null;
  private time = 0;
  private view: StageView = { kind: 'free' };
  private destroyed = false;

  private env: Environment | null = null;
  private envUrl: string | null = null;
  private envTicket = 0;
  private sceneLoading = false;
  private readonly characters = new Map<string, LiveCharacter>();
  private readonly clips = new Map<string, LoadedClip | Promise<LoadedClip | null>>();
  /** Root travel per `${bodyUrl}|${clipUrl}`: x, z per clip frame, in the body's frame, unscaled. */
  private readonly travel = new Map<string, Float32Array>();
  /** Per body and clip: degrees the clip's body is turned at its first frame, taken off the yaw (see `ensureTravel`). */
  private readonly turns = new Map<string, number>();
  /** Where each character stands this frame, root motion included. */
  private readonly livePositions = new Map<string, Vec3Tuple>();
  private readonly loadingClips = new Set<string>();
  private readonly errors: string[] = [];

  /** Overlay drawing: which character to ring, which shot's path to draw. */
  private selectedCharacter: string | null = null;
  private pathShot: string | null = null;
  private selectedKey: string | null = null;
  private overlays = true;

  private constructor(
    readonly scene: Scene,
    private readonly fly: FlyControls,
    private readonly canvas: HTMLCanvasElement,
    private readonly events: StageRendererEvents,
  ) {
    scene.app.on('update', this.tick);
  }

  static async create(canvas: HTMLCanvasElement, events: StageRendererEvents = {}): Promise<StageRenderer> {
    const scene = await Scene.create(canvas, {
      bgColor: { r: 0.05, g: 0.05, b: 0.07, a: 1 },
      // Frames are read back for export.
      preserveDrawingBuffer: true,
      fov: 50,
      near: 0.03,
      far: 1000,
      // A panorama scene is only whole near where it was captured: start there, at eye height.
      cameraPosition: { x: 0, y: 1.5, z: 0 },
      cameraTarget: { x: 0, y: 1.2, z: -3 },
    });
    const fly = new FlyControls({ flySpeed: 2, yaw: 0, pitch: -6 });
    fly.attach({ canvas, cameraEntity: scene.cameraEntity });
    scene.start();
    const cam = scene.cameraEntity.camera;
    if (cam) cam.horizontalFov = false;
    return new StageRenderer(scene, fly, canvas, events);
  }

  // ── The doc ────────────────────────────────────────────────────────────────

  setDoc(doc: StageDoc): void {
    if (this.destroyed) return;
    this.doc = doc;
    this.syncScene(doc);
    this.syncCharacters(doc);
    for (const c of doc.characters) for (const clip of c.clips) void this.ensureClip(clip.url);
    void this.ensureClip(DEFAULT_IDLE_CLIP);
  }

  setTime(t: number): void {
    this.time = t;
  }

  getTime(): number {
    return this.time;
  }

  setView(view: StageView): void {
    const wasFixed = this.view.kind !== 'free';
    this.view = view;
    this.fly.enabled = view.kind === 'free';
    // Leaving a shot: the free camera picks up where the shot's camera stood.
    if (wasFixed && view.kind === 'free') this.fly.syncFromCamera();
  }

  getView(): StageView {
    return this.view;
  }

  /** Overlays: the ring under the selected character, the shot's path and keys. */
  setHighlights(h: { character?: string | null; shot?: string | null; key?: string | null; visible?: boolean }): void {
    if (h.character !== undefined) this.selectedCharacter = h.character;
    if (h.shot !== undefined) this.pathShot = h.shot;
    if (h.key !== undefined) this.selectedKey = h.key;
    if (h.visible !== undefined) this.overlays = h.visible;
  }

  /** Seconds each loaded clip lasts, by URL; null while it loads. */
  clipLength(url: string): number | null {
    const c = this.clips.get(url);
    return c && !(c instanceof Promise) ? c.frames / CLIP_FPS : null;
  }

  /** Load a clip (if it is not already) and say how many seconds it lasts; null if it fails to load. */
  async measureClip(url: string): Promise<number | null> {
    const c = await this.ensureClip(url);
    return c ? c.frames / CLIP_FPS : null;
  }

  // ── The camera ─────────────────────────────────────────────────────────────

  /** The camera as it stands, as a key: `target` a point `focus` metres ahead. */
  getCamera(focus = 3): CameraSample {
    const cam = this.scene.cameraEntity;
    const p = cam.getPosition();
    const f = cam.forward;
    return {
      position: [p.x, p.y, p.z],
      target: [p.x + f.x * focus, p.y + f.y * focus, p.z + f.z * focus],
      fov: cam.camera?.fov ?? 50,
    };
  }

  /** Put the free camera somewhere (and look at `target`). */
  setCamera(sample: CameraSample): void {
    this.applyCamera(sample);
    if (this.view.kind === 'free') this.fly.syncFromCamera();
  }

  /** Frame a point from a few metres back, at eye height. */
  focusOn(point: Vec3Tuple, distance = 3.5): void {
    const cam = this.scene.cameraEntity.getPosition();
    let dx = cam.x - point[0];
    let dz = cam.z - point[2];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    this.setCamera({
      position: [point[0] + dx * distance, point[1] + 1.5, point[2] + dz * distance],
      target: [point[0], point[1] + 1, point[2]],
      fov: this.scene.cameraEntity.camera?.fov ?? 50,
    });
  }

  // ── Picking ────────────────────────────────────────────────────────────────

  /** The character nearest a canvas point (CSS pixels), within `radius` pixels of its body's axis. */
  pickCharacter(x: number, y: number, radius = 48): string | null {
    const cam = this.scene.cameraEntity.camera;
    if (!cam || !this.doc) return null;
    const tmp = this.scene.cameraEntity.getPosition().clone();
    const out = tmp.clone();
    let best: string | null = null;
    let bestD = radius;
    for (const c of this.doc.characters) {
      // Feet, waist and head: the body is a segment on screen.
      const p = this.characterPosition(c.id) ?? c.position;
      for (const k of [0.1, 0.5, 0.9]) {
        tmp.set(p[0], p[1] + c.height * k, p[2]);
        if (!this.inFront(tmp)) continue;
        cam.worldToScreen(tmp, out);
        const d = Math.hypot(out.x - x, out.y - y);
        if (d < bestD) { bestD = d; best = c.id; }
      }
    }
    return best;
  }

  /** Where a canvas point's ray meets the horizontal plane at height `planeY`; null when it never does. */
  floorPoint(x: number, y: number, planeY = 0): Vec3Tuple | null {
    const cam = this.scene.cameraEntity.camera;
    if (!cam) return null;
    const near = cam.screenToWorld(x, y, cam.nearClip);
    const far = cam.screenToWorld(x, y, cam.farClip);
    const dy = far.y - near.y;
    if (Math.abs(dy) < 1e-9) return null;
    const s = (planeY - near.y) / dy;
    if (s < 0) return null;
    return [near.x + (far.x - near.x) * s, planeY, near.z + (far.z - near.z) * s];
  }

  // ── Capture ────────────────────────────────────────────────────────────────

  /**
   * The canvas as it was last drawn, cropped to `aspect` (width / height) and
   * scaled to `width` pixels wide. Overlays are hidden while capturing.
   */
  async capture(aspect: number, width: number): Promise<HTMLCanvasElement> {
    const was = this.overlays;
    this.overlays = false;
    await this.frames(2);
    const out = this.cropTo(aspect, width);
    this.overlays = was;
    return out;
  }

  /** Draw the current back buffer, cropped to `aspect`, into a canvas `width` wide. Call after a frame has rendered. */
  cropTo(aspect: number, width: number, into?: HTMLCanvasElement): HTMLCanvasElement {
    const src = this.canvas;
    const sw = src.width;
    const sh = src.height;
    let cw = sw;
    let ch = Math.round(sw / aspect);
    if (ch > sh) { ch = sh; cw = Math.round(sh * aspect); }
    const w = Math.max(2, Math.round(width / 2) * 2);
    const h = Math.max(2, Math.round(w / aspect / 2) * 2);
    const out = into ?? document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2D canvas is unavailable.');
    ctx.drawImage(src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, w, h);
    return out;
  }

  /**
   * Let `n` frames render. A page in the background (or in a hidden pane, which
   * can still say it is visible) gets no animation frames, so a frame that does
   * not come in time is drawn by hand - otherwise a capture or an export would wait forever.
   */
  async frames(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const drawn = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 120);
        requestAnimationFrame(() => { clearTimeout(timer); resolve(true); });
      });
      if (!drawn) {
        this.scene.app.update(1 / 60);
        this.scene.app.render();
        // The splat sort runs in a worker: give it a moment to answer.
        await new Promise((res) => setTimeout(res, 40));
      }
    }
  }

  /** Hide or show the overlays (rings, paths) - export hides them. */
  setOverlaysVisible(visible: boolean): void {
    this.overlays = visible;
  }

  getAssetState(): StageAssetState {
    return {
      loadingCharacters: [...this.characters.entries()].filter(([, l]) => !l.character).map(([id]) => id),
      loadingClips: [...this.loadingClips],
      sceneLoading: this.sceneLoading,
      errors: [...this.errors],
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.scene.app.off('update', this.tick);
    this.fly.detach();
    for (const l of this.characters.values()) l.character?.destroy();
    this.characters.clear();
    this.env?.destroy();
    this.scene.destroy();
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  private syncScene(doc: StageDoc): void {
    const url = doc.scene?.url ?? null;
    if (url === this.envUrl) {
      // Same file, placement edited by hand: re-mount it.
      if (this.env && doc.scene?.placement) this.mount(this.env, doc.scene.placement);
      return;
    }
    this.envUrl = url;
    const ticket = ++this.envTicket;
    this.env?.destroy();
    this.env = null;
    if (!url || !doc.scene) { this.sceneLoading = false; this.emitState(); return; }
    const scene = doc.scene;
    const filename = filenameOf(url);
    const given = scene.placement;
    const upright = given?.upright ?? isUprightFile(filename);
    const first: StagePlacement = given ?? { upright, scale: 1, floor: 0, start: [0, 0] };
    const t = placeWalkScene(first);
    this.sceneLoading = true;
    this.emitState();
    Environment.load(this.scene, url, { rotation: t.rotation, position: t.position, scale: t.scale, filename })
      .then((env) => {
        if (ticket !== this.envTicket || this.destroyed) { env.destroy(); return; }
        this.env = env;
        let placement = first;
        let measured = false;
        if (!given) {
          const ground = env.probeGroundDepth(upright ? -1 : 1);
          const p = placementFromGround(ground?.depth ?? null, { upright });
          placement = { upright, scale: p.scale, floor: p.floor, start: [p.start[0], p.start[1]] };
          measured = Boolean(ground?.depth);
          this.mount(env, placement);
        }
        this.sceneLoading = false;
        this.emitState();
        this.events.onSceneLoaded?.(placement, measured);
      })
      .catch((e: unknown) => {
        if (ticket !== this.envTicket) return;
        this.sceneLoading = false;
        this.errors.push(`Scene: ${message(e)}`);
        this.emitState();
        this.events.onSceneError?.(e);
      });
  }

  private mount(env: Environment, placement: StagePlacement): void {
    const { position: p, rotation: r, scale: k } = placeWalkScene(placement);
    env.entity.setPosition(p.x, p.y, p.z);
    env.entity.setEulerAngles(r.x, r.y, r.z);
    env.entity.setLocalScale(k, k, k);
  }

  private syncCharacters(doc: StageDoc): void {
    const wanted = new Map(doc.characters.map((c) => [c.id, c]));
    for (const [id, live] of this.characters) {
      const c = wanted.get(id);
      if (!c || c.url !== live.url) {
        live.ticket++;
        live.character?.destroy();
        this.characters.delete(id);
      }
    }
    for (const c of doc.characters) {
      if (this.characters.has(c.id)) continue;
      const live: LiveCharacter = { url: c.url, character: null, playing: null, ticket: 0 };
      this.characters.set(c.id, live);
      const ticket = live.ticket;
      Character.load(this.scene, c.url)
        .then((character) => {
          if (this.destroyed || this.characters.get(c.id) !== live || live.ticket !== ticket) { character.destroy(); return; }
          // On the scene's layer, so its splats sort with the scene's.
          character.setLayers([this.scene.envLayerId]);
          live.character = character;
          this.emitState();
        })
        .catch((e: unknown) => {
          this.errors.push(`${c.name}: ${message(e)}`);
          if (this.characters.get(c.id) === live) this.characters.delete(c.id);
          this.emitState();
        });
    }
    this.emitState();
  }

  private ensureClip(url: string): Promise<LoadedClip | null> {
    const have = this.clips.get(url);
    if (have) return have instanceof Promise ? have : Promise.resolve(have);
    const key = `stage_clip_${this.clips.size}_${Math.random().toString(36).slice(2)}`;
    this.loadingClips.add(url);
    const loading = Animation.loadGlb(this.scene, url, key)
      .then((anim) => {
        const loaded = { key, frames: Math.max(1, anim.numFrames) };
        this.clips.set(url, loaded);
        return loaded;
      })
      .catch((e: unknown) => {
        this.clips.delete(url);
        this.errors.push(`Motion: ${message(e)}`);
        return null;
      })
      .finally(() => {
        this.loadingClips.delete(url);
        this.emitState();
      });
    this.clips.set(url, loading);
    this.emitState();
    return loading;
  }

  private emitState(): void {
    this.events.onAssetState?.(this.getAssetState());
  }

  // ── Per frame ──────────────────────────────────────────────────────────────

  private readonly tick = (): void => {
    const doc = this.doc;
    if (!doc) return;
    for (const c of doc.characters) this.pose(c);
    const view = this.view;
    if (view.kind === 'shot') {
      const shot = doc.shots.find((s) => s.id === view.shotId);
      const sample = shot ? sampleShot(shot, this.time) : null;
      if (sample) this.applyCamera(sample);
    } else if (view.kind === 'camera') {
      this.applyCamera(view.camera);
    }
    if (this.overlays) this.drawOverlays(doc);
  };

  private pose(c: StageCharacter): void {
    const live = this.characters.get(c.id);
    const body = live?.character;
    if (!live || !body) return;
    for (const clip of c.clips) this.ensureTravel(live, body, clip.url);
    const placed = this.placementAt(c, this.time);
    const sample = sampleTrack(c.clips, this.time, (clip) => this.clipLength(clip.url));
    body.setScale(placed.scale, placed.scale, placed.scale);
    // A clip captured with the actor turned starts facing the character's yaw all the same.
    body.setRotation(0, placed.yaw + FACING_OFFSET - (sample ? this.turnOf(live.url, sample.clip.url) : 0), 0);
    const at = placed.position;
    this.livePositions.set(c.id, at);
    // Feet at the position: the armature, not Character.setPosition, which lowers v1 feet that already sit on the origin.
    const arm = body.armature;
    arm.move(arm.entity.getLocalPosition().clone().set(at[0], at[1], at[2]));

    const idle = this.clips.get(DEFAULT_IDLE_CLIP);
    let clip: LoadedClip | null = null;
    let local = 0;
    if (sample) {
      const loaded = this.clips.get(sample.clip.url);
      if (loaded && !(loaded instanceof Promise)) { clip = loaded; local = sample.local; }
    } else if (idle && !(idle instanceof Promise)) {
      clip = idle;
      local = this.time % (idle.frames / CLIP_FPS);
    }
    if (!clip) return;
    if (live.playing !== clip.key) {
      body.playAnimation(clip.key, { loop: false, rootMotion: false });
      live.playing = clip.key;
    }
    // The clock drives the body: the player never advances on its own.
    body.playbackSpeed = 0;
    body.animationTime = Math.min(local * CLIP_FPS, clip.frames - 1);
  }

  /**
   * A clip's travel on this body, sampled once per frame of the clip: the rig
   * is played through it off-screen-free (probing does not draw or move it).
   * Per body URL, since a longer-legged rig covers more ground.
   */
  private ensureTravel(live: LiveCharacter, body: Character, url: string): void {
    const key = `${live.url}|${url}`;
    if (this.travel.has(key)) return;
    const clip = this.clips.get(url);
    if (!clip || clip instanceof Promise) return;
    body.playAnimation(clip.key, { loop: false, rootMotion: false });
    // Whatever was playing must be started again.
    live.playing = null;
    // Most clips start facing the rig's forward, give or take a stance; one captured
    // turned (conversation clips are recorded side-on) is turned back, travel included.
    const facing = probeFacing(body.armature, 0) ?? 0;
    const turn = Math.abs(facing) > TURN_THRESHOLD ? facing : 0;
    const cos = Math.cos((-turn * Math.PI) / 180);
    const sin = Math.sin((-turn * Math.PI) / 180);
    const table = new Float32Array(clip.frames * 2);
    for (let f = 0; f < clip.frames; f++) {
      const d = probeRootTravel(body.armature, f);
      const x = d?.x ?? 0;
      const z = d?.z ?? 0;
      table[f * 2] = x * cos + z * sin;
      table[f * 2 + 1] = -x * sin + z * cos;
    }
    this.travel.set(key, table);
    this.turns.set(key, turn);
  }

  /** Degrees a clip is turned back by on this body; 0 until it has been probed. */
  private turnOf(bodyUrl: string, url: string): number {
    return this.turns.get(`${bodyUrl}|${url}`) ?? 0;
  }

  /** Travel `local` seconds into a clip, in the body's frame; one full lap at its length. */
  private travelAt(bodyUrl: string, url: string, local: number): [number, number] | null {
    const table = this.travel.get(`${bodyUrl}|${url}`);
    if (!table) return null;
    const frames = table.length / 2;
    const f = local * CLIP_FPS;
    if (f >= frames - 1) {
      // A lap ends a frame past the last sample: carry on at the last frame's pace so loops join up.
      const last = frames - 1;
      const extra = frames > 1 ? f - last : 0;
      const dx = frames > 1 ? table[last * 2]! - table[(last - 1) * 2]! : 0;
      const dz = frames > 1 ? table[last * 2 + 1]! - table[(last - 1) * 2 + 1]! : 0;
      return [table[last * 2]! + dx * extra, table[last * 2 + 1]! + dz * extra];
    }
    const i = Math.max(0, Math.floor(f));
    const u = f - i;
    return [
      table[i * 2]! + (table[(i + 1) * 2]! - table[i * 2]!) * u,
      table[i * 2 + 1]! + (table[(i + 1) * 2 + 1]! - table[i * 2 + 1]!) * u,
    ];
  }

  /**
   * Where a character is at stage time `t` - moves along their paths, plus
   * the ground their clips' own root motion covered - without touching the
   * clock. Root motion counts only once the body and its clips have loaded.
   */
  placementAt(c: StageCharacter, t: number): { position: Vec3Tuple; yaw: number; scale: number; moving: boolean } {
    const base = sampleMoves(c, t);
    const live = this.characters.get(c.id);
    const body = live?.character;
    const rest = body ? 2 * body.splat.localBound.halfExtents.y : 0;
    const scale = rest > 1e-6 ? c.height / rest : 1;
    if (!live) return { ...base, scale };
    // Root motion: the body is drawn in place (the rig clamps the pelvis) and
    // carried instead, by the ground its track has covered so far.
    const [tx, tz] = trackTravel(c.clips, t, (k) => this.clipLength(k.url), (k, local) => this.travelAt(live.url, k.url, local));
    // The body's frame, turned by its yaw as `setRotation` turns it, into the world.
    const a = ((base.yaw + FACING_OFFSET) * Math.PI) / 180;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    const x = tx * scale;
    const z = tz * scale;
    return {
      position: [base.position[0] + x * cos + z * sin, base.position[1], base.position[2] - x * sin + z * cos],
      yaw: base.yaw,
      scale,
      moving: base.moving || Math.hypot(tx, tz) > 0,
    };
  }

  /** `placementAt` by id; null for no such character. */
  characterAt(id: string, t: number): { position: Vec3Tuple; yaw: number } | null {
    const c = this.doc?.characters.find((k) => k.id === id);
    if (!c) return null;
    const p = this.placementAt(c, t);
    return { position: p.position, yaw: p.yaw };
  }

  // ── The floor ──────────────────────────────────────────────────────────────

  private floorIndex: { env: Environment; revision: number; index: FloorIndex; positions: Float32Array; alpha: Float32Array | null } | null = null;

  private worldSample(): { index: FloorIndex; positions: Float32Array; alpha: Float32Array | null } | null {
    const env = this.env;
    if (!env) return null;
    const f = this.floorIndex;
    // Newer engines bump a revision when a split scene attaches a chunk; the pinned one has none, and the stage never attaches.
    const revision = (env as { sampleRevision?: number }).sampleRevision ?? 0;
    if (f && f.env === env && f.revision === revision) return f;
    try {
      const sample = env.sampleWorldSample(400_000);
      // Fine cells: the sample spans the scene's far shell too, and a coarse cell lets a table top read as floor.
      const index = buildFloorIndex(sample, 256);
      this.floorIndex = { env, revision, index, positions: sample.positions, alpha: sample.alpha ?? null };
      return this.floorIndex;
    } catch {
      return null;
    }
  }

  private floor(): FloorIndex | null {
    return this.worldSample()?.index ?? null;
  }

  /**
   * How much scene stands between two points: solid splats (from a sample of
   * the scene) within `radius` of the segment, skipping its last `skipEnd`
   * metres (the subject's own body). Also how crowded the space round `from`
   * is - a camera inside a wall, curtain or sofa sees a smear.
   */
  sightline(from: Vec3Tuple, to: Vec3Tuple, radius = 0.12, skipEnd = 0.45): { blocking: number; aroundEye: number; verdict: 'clear' | 'partly_blocked' | 'blocked' } | null {
    const s = this.worldSample();
    if (!s) return null;
    const { positions: p, alpha } = s;
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return { blocking: 0, aroundEye: 0, verdict: 'clear' };
    const ux = dx / len, uy = dy / len, uz = dz / len;
    const r2 = radius * radius;
    const eye2 = 0.35 * 0.35;
    let blocking = 0;
    let aroundEye = 0;
    for (let i = 0, k = 0; i < p.length; i += 3, k++) {
      if (alpha && alpha[k]! < 0.5) continue;
      const px = p[i]! - from[0], py = p[i + 1]! - from[1], pz = p[i + 2]! - from[2];
      if (px * px + py * py + pz * pz < eye2) aroundEye++;
      const along = px * ux + py * uy + pz * uz;
      if (along < 0.2 || along > len - skipEnd) continue;
      const qx = px - ux * along, qy = py - uy * along, qz = pz - uz * along;
      if (qx * qx + qy * qy + qz * qz < r2) blocking++;
    }
    // Calibrated on a living-room capture: 0 on every clean view; 20+ behind a plant, a chair or a wall smear.
    return { blocking, aroundEye, verdict: blocking < 5 ? 'clear' : blocking <= 25 ? 'partly_blocked' : 'blocked' };
  }

  /** The floor's height under (x, z), metres; null where the scene has no floor there (a hole, a wall, outside it). */
  floorAt(x: number, z: number, fromY = 1.2): number | null {
    const index = this.floor();
    if (!index) return null;
    return index.floorAt(x, z, Math.max(index.cell, 0.15), fromY, 3);
  }

  /**
   * Where the floor is, round the capture point: a coarse grid (metres) of
   * which cells have floor, and the bounds of the floor that joins up with the
   * capture point - the room an agent can stage in.
   */
  floorMap(radius = 6, step = 0.5): { step: number; origin: [number, number]; rows: string[]; bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null } {
    const n = Math.round(radius / step);
    const rows: string[] = [];
    const grid: boolean[][] = [];
    for (let j = -n; j <= n; j++) {
      const row: boolean[] = [];
      for (let i = -n; i <= n; i++) {
        const y = this.floorAt(i * step, j * step);
        row.push(y !== null && Math.abs(y) < 0.35);
      }
      grid.push(row);
      rows.push(row.map((b) => (b ? '.' : '#')).join(''));
    }
    // Flood fill from the centre: floor reachable from where the camera was.
    const seen = grid.map((r) => r.map(() => false));
    const stack: Array<[number, number]> = grid[n]![n] ? [[n, n]] : [];
    let bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null = null;
    while (stack.length) {
      const [r, c] = stack.pop()!;
      if (seen[r]![c] || !grid[r]![c]) continue;
      seen[r]![c] = true;
      const x = (c - n) * step;
      const z = (r - n) * step;
      bounds = bounds
        ? { minX: Math.min(bounds.minX, x), maxX: Math.max(bounds.maxX, x), minZ: Math.min(bounds.minZ, z), maxZ: Math.max(bounds.maxZ, z) }
        : { minX: x, maxX: x, minZ: z, maxZ: z };
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && cc >= 0 && rr < grid.length && cc < grid.length) stack.push([rr, cc]);
      }
    }
    return { step, origin: [-n * step, -n * step], rows, bounds };
  }

  // ── Framing ────────────────────────────────────────────────────────────────

  /**
   * How each character sits in a camera's frame at stage time `t`: their box
   * in normalised frame coordinates (0..1, y down), how much of them is
   * inside, which edges cut them, and how far they are. Pure projection - no
   * occlusion test.
   */
  framing(camera: CameraSample, aspect: number, t: number): Array<{ id: string; name: string; inFront: boolean; box: [number, number, number, number] | null; visible: number; cut: string[]; head_in_frame: boolean; line_of_sight: 'clear' | 'partly_blocked' | 'blocked' | 'unknown'; distance: number; heightInFrame: number }> {
    const doc = this.doc;
    if (!doc) return [];
    const [px, py, pz] = camera.position;
    let fx = camera.target[0] - px, fy = camera.target[1] - py, fz = camera.target[2] - pz;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // Right = forward x up(0,1,0); up' = right x forward.
    let rx = -fz, rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl; rz /= rl;
    const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
    const tanV = Math.tan(((camera.fov / 2) * Math.PI) / 180);
    const tanH = tanV * aspect;
    const project = (x: number, y: number, z: number) => {
      const dx = x - px, dy = y - py, dz = z - pz;
      const depth = dx * fx + dy * fy + dz * fz;
      const sx = (dx * rx + dz * rz) / (depth * tanH);
      const sy = (dx * ux + dy * uy + dz * uz) / (depth * tanV);
      return { depth, u: 0.5 + sx / 2, v: 0.5 - sy / 2 };
    };
    return doc.characters.map((c) => {
      const at = this.placementAt(c, t).position;
      const halfW = c.height * 0.18;
      const pts = [];
      for (const k of [0, 1]) for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        pts.push(project(at[0] + sx * halfW, at[1] + c.height * k, at[2] + sz * halfW));
      }
      const distance = Math.hypot(at[0] - px, at[1] + c.height / 2 - py, at[2] - pz);
      const inFront = pts.every((p) => p.depth > 0.05);
      const head = project(at[0], at[1] + c.height * 0.92, at[2]);
      const headIn = head.depth > 0.05 && head.u >= 0 && head.u <= 1 && head.v >= 0 && head.v <= 1;
      const sight = this.sightline(camera.position, [at[0], at[1] + c.height * 0.6, at[2]])?.verdict ?? 'unknown';
      if (!inFront) return { id: c.id, name: c.name, inFront, box: null, visible: 0, cut: [], head_in_frame: headIn, line_of_sight: sight, distance, heightInFrame: 0 };
      const u0 = Math.min(...pts.map((p) => p.u)), u1 = Math.max(...pts.map((p) => p.u));
      const v0 = Math.min(...pts.map((p) => p.v)), v1 = Math.max(...pts.map((p) => p.v));
      const area = (u1 - u0) * (v1 - v0);
      const iu = Math.max(0, Math.min(1, u1) - Math.max(0, u0));
      const iv = Math.max(0, Math.min(1, v1) - Math.max(0, v0));
      const cut = [u0 < 0 && 'left', u1 > 1 && 'right', v0 < 0 && 'top', v1 > 1 && 'bottom'].filter(Boolean) as string[];
      const r = (v: number) => Math.round(v * 1000) / 1000;
      return {
        id: c.id, name: c.name, inFront, box: [r(u0), r(v0), r(u1), r(v1)], visible: area > 0 ? r((iu * iv) / area) : 0,
        cut, head_in_frame: headIn, line_of_sight: sight, distance: r(distance), heightInFrame: r(v1 - v0),
      };
    });
  }

  /** Where a character stands now, root motion included; its placed position until it has loaded. */
  characterPosition(id: string): Vec3Tuple | null {
    const live = this.livePositions.get(id);
    if (live) return [...live];
    const c = this.doc?.characters.find((k) => k.id === id);
    return c ? [...c.position] : null;
  }

  private applyCamera(sample: CameraSample): void {
    const cam = this.scene.cameraEntity;
    const [x, y, z] = sample.position;
    cam.setPosition(x, y, z);
    const [tx, ty, tz] = sample.target;
    if (Math.hypot(tx - x, ty - y, tz - z) > 1e-6) cam.lookAt(tx, ty, tz);
    if (cam.camera) cam.camera.fov = sample.fov;
  }

  private drawOverlays(doc: StageDoc): void {
    const app = this.scene.app;
    const sel = doc.characters.find((c) => c.id === this.selectedCharacter);
    if (sel) {
      const at = this.characterPosition(sel.id) ?? sel.position;
      const ring = circle(at, Math.max(0.25, sel.height * 0.22), 40);
      app.drawLineArrays(ring, colors(ring.length / 3, [1, 1, 1, 0.9]), false);
      // Where they were placed, when the track has walked them off it.
      if (Math.hypot(at[0] - sel.position[0], at[2] - sel.position[2]) > 0.05) {
        const home = circle(sel.position, 0.12, 20);
        app.drawLineArrays(home, colors(home.length / 3, [1, 1, 1, 0.35]), false);
        app.drawLineArrays([sel.position[0], sel.position[1] + 0.01, sel.position[2], at[0], at[1] + 0.01, at[2]], colors(2, [1, 1, 1, 0.35]), false);
      }
      // Which way they face.
      const yaw = (sel.yaw * Math.PI) / 180;
      const [x, y, z] = at;
      const r = Math.max(0.25, sel.height * 0.22);
      const tip = [x - Math.sin(yaw) * r * 1.8, y + 0.01, z - Math.cos(yaw) * r * 1.8];
      app.drawLineArrays([x, y + 0.01, z, tip[0]!, tip[1]!, tip[2]!], colors(2, [1, 1, 1, 0.9]), false);
    }
    // In a shot's own view the path would sit in front of the lens.
    const shot: StageShot | undefined = doc.shots.find((s) => s.id === this.pathShot);
    if (!shot || this.view.kind === 'shot') return;
    const path = shotPath(shot);
    if (path.length > 1) {
      const seg: number[] = [];
      for (let i = 1; i < path.length; i++) seg.push(...path[i - 1]!, ...path[i]!);
      app.drawLineArrays(seg, colors(seg.length / 3, [1, 1, 1, 0.55]), false);
    }
    for (const k of sortedKeys(shot.keys)) {
      const on = k.id === this.selectedKey;
      const rgba = on ? [0.37, 0.69, 1, 1] : [0.85, 0.85, 0.88, 0.85];
      const lines = frustum(k.position, k.target, k.fov, on ? 0.35 : 0.25);
      app.drawLineArrays(lines, colors(lines.length / 3, rgba), false);
    }
  }

  private inFront(p: { x: number; y: number; z: number }): boolean {
    const cam = this.scene.cameraEntity;
    const c = cam.getPosition();
    const f = cam.forward;
    return (p.x - c.x) * f.x + (p.y - c.y) * f.y + (p.z - c.z) * f.z > 0.05;
  }
}

function circle([cx, cy, cz]: Vec3Tuple, r: number, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const b = ((i + 1) / n) * Math.PI * 2;
    out.push(cx + Math.cos(a) * r, cy + 0.01, cz + Math.sin(a) * r, cx + Math.cos(b) * r, cy + 0.01, cz + Math.sin(b) * r);
  }
  return out;
}

/** A small camera frustum at `p` looking at `t`: four edges and the far rectangle. */
function frustum(p: Vec3Tuple, t: Vec3Tuple, fov: number, size: number): number[] {
  let fx = t[0] - p[0], fy = t[1] - p[1], fz = t[2] - p[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl; fy /= fl; fz /= fl;
  // Right = forward x up; up' = right x forward.
  let rx = -fz, rz = fx;
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const h = Math.tan(((fov / 2) * Math.PI) / 180) * size;
  const w = h * 16 / 9;
  const c = [p[0] + fx * size, p[1] + fy * size, p[2] + fz * size];
  const corner = (sx: number, sy: number) => [c[0]! + rx * w * sx + ux * h * sy, c[1]! + uy * h * sy, c[2]! + rz * w * sx + uz * h * sy];
  const k = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    out.push(...p, ...k[i]!);
    out.push(...k[i]!, ...k[(i + 1) % 4]!);
  }
  // A tick on top, so up reads at a glance.
  const top = corner(0, 1.6);
  out.push(...k[2]!, ...top, ...top, ...k[3]!);
  return out;
}

function colors(n: number, rgba: number[]): number[] {
  const out = new Array<number>(n * 4);
  for (let i = 0; i < out.length; i++) out[i] = rgba[i % 4]!;
  return out;
}

function filenameOf(url: string): string {
  const path = url.split('?')[0] ?? '';
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /\.(spz|ply|sog|sogs|splat)$/i.test(base) ? base : 'scene.spz';
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
