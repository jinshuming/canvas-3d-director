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
import { Environment, FlyControls, Scene } from '@viggle/splat-engine';

import { forwardOf } from '../core/frame.ts';

export interface SplatLayer { id: string; label: string; url: string }

export function SplatViewer({ url, objects = [], yaw = 0, upAxisFlip = false }: { url: string; objects?: SplatLayer[]; yaw?: number; upAxisFlip?: boolean }) {
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
        const f = forwardOf(yaw, -5);
        scene = await Scene.create(canvas.current!, {
          bgColor: { r: 0.06, g: 0.07, b: 0.08, a: 1 },
          fov: 60, near: 0.03, far: 500,
          cameraPosition: { x: 0, y: 0, z: 0 },
          cameraTarget: { x: f[0] * 3, y: f[1] * 3, z: f[2] * 3 },
        });
        if (dead) { scene.destroy(); return; }
        // FlyControls sets the camera's heading itself on attach (its yaw turns left, ours right), and
        // moves it for held keys only in update(dt): without the per-frame tick WASD / QE do nothing
        // (dragging still looks around - that is applied straight from the pointer events).
        fly = new FlyControls({ flySpeed: 1.5, yaw: -yaw, pitch: -5 });
        fly.attach({ canvas: canvas.current!, cameraEntity: scene.cameraEntity });
        const f2 = fly;
        tick = (dt: number) => f2.update(dt);
        scene.app.on('update', tick);
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
    return () => { dead = true; if (tick) scene?.app.off('update', tick); fly?.detach(); for (const e of loaded.values()) e.destroy(); loaded.clear(); scene?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, yaw, upAxisFlip, attempt]);

  useEffect(() => {
    for (const [id, env] of layers.current) env.entity.enabled = !hidden.has(id);
  }, [hidden]);

  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="splat-viewer">
      <canvas ref={canvas} />
      {state !== 'ready' && <div className="overlay">{state === 'loading' ? '加载 3D 场景…' : <span>加载失败：{error} <button onClick={() => setAttempt((n) => n + 1)}>重试</button></span>}</div>}
      {objects.length > 0 && <div className="layers">
        <label><input type="checkbox" checked={!hidden.has('environment')} onChange={() => toggle('environment')} />环境</label>
        {objects.map((o) => <label key={o.id} title={o.label} className={layerState[o.id] ?? ''}><input type="checkbox" checked={!hidden.has(o.id)} disabled={layerState[o.id] !== 'ready'} onChange={() => toggle(o.id)} />{o.id}{layerState[o.id] === 'loading' ? ' …' : layerState[o.id] === 'failed' ? ' ✕' : ''}</label>)}
        {objects.some((o) => layerState[o.id] === 'failed') && <button onClick={() => setAttempt((n) => n + 1)}>重试</button>}
      </div>}
      <div className="hint">拖动看四周 · WASD 移动 · QE 上下 · 起点就是全景的拍摄点</div>
    </div>
  );
}
