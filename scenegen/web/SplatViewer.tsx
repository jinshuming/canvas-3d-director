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
  const layers = useRef(new Map<string, Environment>());
  const key = [url, ...objects.map((o) => o.url)].join('|');

  useEffect(() => {
    let dead = false;
    let scene: Scene | null = null;
    let fly: FlyControls | null = null;
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
        fly = new FlyControls({ flySpeed: 1.5 });
        fly.attach({ canvas: canvas.current!, cameraEntity: scene.cameraEntity });
        scene.start();
        // The video mock's preview is written the same way JST-2 writes files (Y up), so no flip either way by default.
        const opts = (name: string) => ({ rotation: { x: upAxisFlip ? 180 : 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, scale: 1, filename: `${name}.spz`, name });
        const all = [{ id: 'environment', url }, ...objects];
        await Promise.all(all.map(async (l) => {
          const env = await Environment.load(scene!, l.url, opts(l.id));
          if (dead) { env.destroy(); return; }
          loaded.set(l.id, env);
        }));
        if (dead) return;
        setState('ready');
      } catch (e) {
        if (!dead) { setError((e as Error).message); setState('error'); }
      }
    })();
    return () => { dead = true; fly?.detach(); for (const e of loaded.values()) e.destroy(); loaded.clear(); scene?.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, yaw, upAxisFlip]);

  useEffect(() => {
    for (const [id, env] of layers.current) env.entity.enabled = !hidden.has(id);
  }, [hidden, state]);

  const toggle = (id: string) => setHidden((h) => { const n = new Set(h); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="splat-viewer">
      <canvas ref={canvas} />
      {state !== 'ready' && <div className="overlay">{state === 'loading' ? '加载 3D 场景…' : `加载失败：${error}`}</div>}
      {objects.length > 0 && <div className="layers">
        <label><input type="checkbox" checked={!hidden.has('environment')} onChange={() => toggle('environment')} />环境</label>
        {objects.map((o) => <label key={o.id} title={o.label}><input type="checkbox" checked={!hidden.has(o.id)} onChange={() => toggle(o.id)} />{o.id}</label>)}
      </div>}
      <div className="hint">拖动看四周 · WASD 移动 · QE 上下 · 起点就是全景的拍摄点</div>
    </div>
  );
}
