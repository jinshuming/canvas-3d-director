/**
 * The generated 3DGS scene, in the page: the director's own engine
 * (@viggle/splat-engine), so what you see here is what the director shows.
 * The file has the capture point at its origin (metres, Y up), so the camera
 * starts there, at the panorama's front. WASD / QE to move, drag to look.
 */
import { useEffect, useRef, useState } from 'react';
import { Environment, FlyControls, Scene } from '@viggle/splat-engine';

import { forwardOf } from '../core/frame.ts';

export function SplatViewer({ url, yaw = 0, upAxisFlip = false }: { url: string; yaw?: number; upAxisFlip?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let dead = false;
    let scene: Scene | null = null;
    let fly: FlyControls | null = null;
    let env: Environment | null = null;
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
        env = await Environment.load(scene, url, { rotation: { x: upAxisFlip ? 180 : 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, scale: 1, filename: 'scene.spz' });
        if (dead) { env.destroy(); return; }
        setState('ready');
      } catch (e) {
        if (!dead) { setError((e as Error).message); setState('error'); }
      }
    })();
    return () => { dead = true; fly?.detach(); env?.destroy(); scene?.destroy(); };
  }, [url, yaw, upAxisFlip]);

  return (
    <div className="splat-viewer">
      <canvas ref={canvas} />
      {state !== 'ready' && <div className="overlay">{state === 'loading' ? '加载 3D 场景…' : `加载失败：${error}`}</div>}
      <div className="hint">拖动看四周 · WASD 移动 · QE 上下 · 起点就是全景的拍摄点</div>
    </div>
  );
}
