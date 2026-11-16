/**
 * The generated 3DGS scene, in the page: the director's own engine
 * (@viggle/splat-engine), so what you see here is what the director shows.
 * Every file has the capture point at its origin (metres, Y up) - the
 * environment and each SAM 3D object were fitted into that one frame by the
 * blockout - so the layers load with identity transforms and line up. The
 * camera starts at the capture point, at the panorama's front. WASD / QE to
 * move, drag to look.
 */
import { useEffect, useRef, useState } from 'react';
import { Environment, FlyControls, Scene, SplatRelight } from '@viggle/splat-engine';

import { forwardOf } from '../core/frame.ts';

export interface SplatLayer { id: string; label: string; url: string }
/**
 * Relighting (Atlas's Relight, with the Viggle Splat Engine's SplatRelight): a key light - where it
 * comes from (azimuth 0 from +Z, 90 from +X), how high, how strong, its colour - a sky fill, how dark
 * its shadows are, and how far it replaces the scene's captured light (`scene`, 0-1). The same
 * fields as the 3D director's StageLighting, plus `scene`.
 */
export interface ViewerLighting { azimuth: number; elevation: number; intensity: number; color: string; ambient: number; shadows: number; scene: number }
/** The box the environment is relit in (file frame): its room, so the relit area ends at its walls. */
export interface RelightBox { min: [number, number, number]; max: [number, number, number] }

/** A camera in the scene file's frame: metres, our yaw (0 north / -Z, 90 east), pitch up positive. */
export interface ViewerPose { position: [number, number, number]; yaw: number; pitch: number }

export function SplatViewer({ url, objects = [], yaw = 0, upAxisFlip = false, start, onExpand, expanding = false, expandHint, lighting = null, relightBox = null }: {
  url: string; objects?: SplatLayer[]; yaw?: number; upAxisFlip?: boolean;
  /** Open at this camera instead of the capture point (e.g. where the user was before a rebuild). */
  start?: ViewerPose | null;
  /** Show an Expand button: the scene is expanded from the camera's current pose. */
  onExpand?: (pose: ViewerPose) => void;
  expanding?: boolean;
  expandHint?: string;
  /** Relight the scene and its objects; null keeps the light they were captured with. */
  lighting?: ViewerLighting | null;
  relightBox?: RelightBox | null;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  // Per layer: loading, loaded or failed. Bumping `attempt` reloads everything.
  const [layerState, setLayerState] = useState<Record<string, 'loading' | 'ready' | 'failed'>>({});
  const [attempt, setAttempt] = useState(0);
  const layers = useRef(new Map<string, Environment>());
  const cam = useRef<{ scene: Scene; fly: FlyControls } | null>(null);
  const relight = useRef<{ r: SplatRelight; added: Set<string> } | null>(null);
  const [relightError, setRelightError] = useState<string | null>(null);
  const key = [url, ...objects.map((o) => o.url)].join('|');

  useEffect(() => {
    let dead = false;
    let scene: Scene | null = null;
    let fly: FlyControls | null = null;
    let tick: ((dt: number) => void) | null = null;
    const loaded = layers.current;
    setState('loading');
    void (async () => {
      try {
        const y0 = start?.yaw ?? yaw, p0 = start?.pitch ?? -5, c0 = start?.position ?? [0, 0, 0];
        const f = forwardOf(y0, p0);
        scene = await Scene.create(canvas.current!, {
          bgColor: { r: 0.06, g: 0.07, b: 0.08, a: 1 },
          fov: 60, near: 0.03, far: 500,
          cameraPosition: { x: c0[0], y: c0[1], z: c0[2] },
          cameraTarget: { x: c0[0] + f[0] * 3, y: c0[1] + f[1] * 3, z: c0[2] + f[2] * 3 },
        });
        if (dead) { scene.destroy(); return; }
        // FlyControls sets the camera's heading itself on attach (its yaw turns left, ours right), and
        // moves it for held keys only in update(dt): without the per-frame tick WASD / QE do nothing
        // (dragging still looks around - that is applied straight from the pointer events).
        fly = new FlyControls({ flySpeed: 1.5, yaw: -y0, pitch: p0 });
        fly.attach({ canvas: canvas.current!, cameraEntity: scene.cameraEntity });
        const f2 = fly;
        tick = (dt: number) => f2.update(dt);
        scene.app.on('update', tick);
        cam.current = { scene, fly };
        scene.start();
        // The video mock's preview is written the same way JST-2 writes files (Y up), so no flip either way by default.
        const opts = (name: string) => ({ rotation: { x: upAxisFlip ? 180 : 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, scale: 1, filename: `${name}.spz`, name });
        // Each layer on its own, with a deadline: one aborted or stalled download (seen when the dev
        // server restarted mid-load) must not leave the whole viewer on "loading" forever. The
        // environment shows as soon as it is in; objects appear as they arrive.
        const all = [{ id: 'environment', url }, ...objects];
        setLayerState(Object.fromEntries(all.map((l) => [l.id, 'loading'])));
        const mark = (id: string, v: 'ready' | 'failed') => { if (!dead) setLayerState((m) => ({ ...m, [id]: v })); };
        await Promise.all(all.map(async (l) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const load = Environment.load(scene!, l.url, opts(l.id));
          try {
            const env = await Promise.race([load, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${l.id} timed out`)), 90_000); })]);
            if (dead) { env.destroy(); return; }
            loaded.set(l.id, env);
            env.entity.enabled = !hiddenRef.current.has(l.id);
            mark(l.id, 'ready');
            if (l.id === 'environment') setState('ready');
          } catch (e) {
            // A load that finishes after its deadline is dropped, not left in the scene unseen.
            void load.then((env) => { if (dead || !loaded.has(l.id)) env.destroy(); }, () => {});
            mark(l.id, 'failed');
            if (l.id === 'environment' && !dead) { setError((e as Error).message); setState('error'); }
          } finally { clearTimeout(timer); }
        }));
      } catch (e) {
        if (!dead) { setError((e as Error).message); setState('error'); }
      }
    })();
    return () => { dead = true; cam.current = null; relight.current?.r.destroy(); relight.current = null; if (tick) scene?.app.off('update', tick); fly?.detach(); for (const e of loaded.values()) e.destroy(); loaded.clear(); scene?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, yaw, upAxisFlip, attempt]);

  useEffect(() => {
    for (const [id, env] of layers.current) env.entity.enabled = !hidden.has(id);
  }, [hidden]);

  // Relighting: created once per scene, every loaded layer handed to it once (the environment
  // cropped to its room - a relit area ends at the edge of the box it was built from, so at the
  // walls that edge does not show), and the light updated on every change.
  const layerState2 = layerState; // re-run when layers finish loading
  useEffect(() => {
    const c = cam.current;
    if (!c || state !== 'ready') return;
    if (!lighting) { if (relight.current) relight.current.r.enabled = false; return; }
    try {
      if (!relight.current) {
        relight.current = { r: SplatRelight.create(c.scene, {
          strength: lighting.scene, shadowStrength: lighting.shadows, receiveShadows: true,
          light: { azimuth: lighting.azimuth, elevation: lighting.elevation, intensity: lighting.intensity, color: lighting.color, castShadows: true },
          sky: { color: '#ffffff', intensity: lighting.ambient },
        }), added: new Set() };
      }
    } catch (e) { setRelightError((e as Error).message); return; }
    const { r, added } = relight.current;
    r.enabled = true;
    r.strength = lighting.scene;
    r.shadowStrength = lighting.shadows;
    r.lightAzimuth = lighting.azimuth;
    r.lightElevation = lighting.elevation;
    r.lightIntensity = lighting.intensity;
    r.setLightColor(lighting.color);
    r.skyIntensity = lighting.ambient;
    for (const [id, env] of layers.current) {
      if (added.has(id)) { r.setParams(env, { strength: lighting.scene }); continue; }
      added.add(id);
      const box = id === 'environment' && relightBox ? { bounds: { min: { x: relightBox.min[0], y: relightBox.min[1], z: relightBox.min[2] }, max: { x: relightBox.max[0], y: relightBox.max[1], z: relightBox.max[2] } } } : undefined;
      r.add(env, box).then(() => r.setParams(env, { strength: lighting.scene })).catch((e: unknown) => setRelightError((e as Error).message));
    }
  }, [lighting, relightBox, state, layerState2]);

  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="splat-viewer">
      <canvas ref={canvas} />
      {state !== 'ready' && <div className="overlay">{state === 'loading' ? '加载 3D 场景…' : <span>加载失败：{error} <button onClick={() => setAttempt((n) => n + 1)}>重试</button></span>}</div>}
      {relightError && <div className="relight-error">光照：{relightError}</div>}
      {objects.length > 0 && <div className="layers">
        <label><input type="checkbox" checked={!hidden.has('environment')} onChange={() => toggle('environment')} />环境</label>
        {objects.map((o) => <label key={o.id} title={o.label} className={layerState[o.id] ?? ''}><input type="checkbox" checked={!hidden.has(o.id)} disabled={layerState[o.id] !== 'ready'} onChange={() => toggle(o.id)} />{o.id}{layerState[o.id] === 'loading' ? ' …' : layerState[o.id] === 'failed' ? ' ✕' : ''}</label>)}
        {objects.some((o) => layerState[o.id] === 'failed') && <button onClick={() => setAttempt((n) => n + 1)}>重试</button>}
      </div>}
      <div className="hint">拖动看四周 · WASD 移动 · QE 上下 · 起点就是全景的拍摄点{onExpand ? ' · 走到有缺口的地方点 Expand' : ''}</div>
      {onExpand && <button className="expand-btn" disabled={expanding || state !== 'ready'} title={expandHint ?? '从当前相机位置生成这个视角，并重建场景'}
        onClick={() => {
          const c = cam.current;
          if (!c) return;
          const e = c.scene.cameraEntity;
          const p = e.getPosition(), f = e.forward;
          // From where the camera actually looks (its -Z), in our convention: yaw 0 north (-Z), 90 east.
          const yawDeg = (Math.atan2(f.x, -f.z) * 180) / Math.PI;
          onExpand({ position: [p.x, p.y, p.z], yaw: ((yawDeg % 360) + 360) % 360, pitch: (Math.asin(Math.max(-1, Math.min(1, f.y))) * 180) / Math.PI });
        }}>{expanding ? '扩展中…' : 'Expand'}</button>}
    </div>
  );
}
