import { useEffect, useRef, useState } from 'react';

import type { StageAssetState, StageDoc, StageView } from '@stage';
import { ASPECTS, StageRenderer } from '@stage';

import type { Selection } from './ops.ts';
import { patchCharacter } from './ops.ts';
import type { StageStore } from './useStage.ts';

interface Props {
  doc: StageDoc;
  time: number;
  view: StageView;
  selection: Selection;
  activeShot: string | null;
  update: StageStore['update'];
  onSelect: (s: Selection) => void;
  onRenderer: (r: StageRenderer | null) => void;
}

/**
 * The stage on a canvas. Free camera: drag to look, WASD/QE to fly, wheel to
 * dolly. Drag a character to move them on their floor; Shift-drag turns them.
 */
export function Viewport({ doc, time, view, selection, activeShot, update, onSelect, onRenderer }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<StageRenderer | null>(null);
  const [assets, setAssets] = useState<StageAssetState | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const docRef = useRef(doc);
  docRef.current = doc;
  const updateRef = useRef(update);
  updateRef.current = update;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let r: StageRenderer | null = null;
    let live = true;
    StageRenderer.create(canvas, {
      onAssetState: setAssets,
      // A scene seen for the first time is measured; keep what was measured.
      onSceneLoaded: (placement) => {
        const d = docRef.current;
        if (d.scene && !d.scene.placement) updateRef.current((x) => (x.scene ? { ...x, scene: { ...x.scene, placement } } : x), { history: false });
      },
    }).then((created) => {
      if (!live) { created.destroy(); return; }
      r = created;
      // For poking at from the console while developing.
      if (import.meta.env.DEV) (window as unknown as { __stage?: StageRenderer }).__stage = r;
      r.setDoc(docRef.current);
      setRenderer(r);
      onRenderer(r);
    }).catch((e: unknown) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
      onRenderer(null);
      r?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one renderer per mount
  }, []);

  useEffect(() => { renderer?.setDoc(doc); }, [renderer, doc]);
  useEffect(() => { renderer?.setTime(time); }, [renderer, time]);
  useEffect(() => { renderer?.setView(view); }, [renderer, view]);
  useEffect(() => {
    renderer?.setHighlights({
      character: selection?.kind === 'character' ? selection.id : selection?.kind === 'clip' ? selection.characterId : null,
      shot: selection?.kind === 'shot' || selection?.kind === 'key' ? selection.shotId : activeShot,
      key: selection?.kind === 'key' ? selection.keyId : null,
    });
  }, [renderer, selection, activeShot]);

  // Drag a character on its floor; Shift-drag turns them. Captured before the fly camera sees the press.
  const drag = useRef<{ id: string; pointer: number; startX: number; startY: number; offset: [number, number]; yaw0: number; turn: boolean; moved: boolean } | null>(null);
  const press = useRef<{ x: number; y: number } | null>(null);

  const local = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDownCapture = (e: React.PointerEvent) => {
    press.current = { x: e.clientX, y: e.clientY };
    if (!renderer || e.button !== 0 || view.kind === 'shot') return;
    const { x, y } = local(e);
    const id = renderer.pickCharacter(x, y);
    if (!id) return;
    const c = doc.characters.find((k) => k.id === id)!;
    const hit = renderer.floorPoint(x, y, c.position[1]);
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = {
      id, pointer: e.pointerId, startX: e.clientX, startY: e.clientY,
      offset: hit ? [c.position[0] - hit[0], c.position[2] - hit[2]] : [0, 0],
      yaw0: c.yaw, turn: e.shiftKey, moved: false,
    };
    onSelect({ kind: 'character', id });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || !renderer || e.pointerId !== d.pointer) return;
    if (!d.moved && Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < 3) return;
    d.moved = true;
    const c = docRef.current.characters.find((k) => k.id === d.id);
    if (!c) return;
    if (d.turn) {
      const yaw = Math.round(d.yaw0 - (e.clientX - d.startX) * 0.6);
      update((x) => patchCharacter(x, d.id, { yaw }), { commit: false });
      return;
    }
    const { x, y } = local(e);
    const hit = renderer.floorPoint(x, y, c.position[1]);
    if (!hit) return;
    const position: [number, number, number] = [round2(hit[0] + d.offset[0]), c.position[1], round2(hit[2] + d.offset[1])];
    update((x2) => patchCharacter(x2, d.id, { position }), { commit: false });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d && e.pointerId === d.pointer) {
      drag.current = null;
      // Commit the drag as one undo step.
      if (d.moved) update((x) => ({ ...x }), { commit: true });
      return;
    }
    // A click (not a look-around drag) on empty space clears the selection.
    const p = press.current;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 3 && view.kind === 'free') onSelect(null);
  };

  const frame = view.kind === 'shot' ? ASPECTS[doc.aspect] : null;
  const loading = assets && (assets.sceneLoading || assets.loadingCharacters.length > 0 || assets.loadingClips.length > 0);

  return (
    <div
      ref={wrap}
      className="viewport"
      onPointerDownCapture={onPointerDownCapture}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <canvas ref={canvasRef} className="viewport-canvas" tabIndex={0} />
      {frame && <FrameGuide aspect={frame} />}
      {!doc.scene && <div className="viewport-empty">从左侧素材库选一个场景，或生成一个新场景</div>}
      {failed && <div className="viewport-empty error">3D 视图无法启动：{failed}</div>}
      <div className="viewport-status">
        {loading && <span className="chip">加载中… {assets!.sceneLoading ? '场景 ' : ''}{assets!.loadingCharacters.length ? `角色 ${assets!.loadingCharacters.length} ` : ''}{assets!.loadingClips.length ? `动作 ${assets!.loadingClips.length}` : ''}</span>}
        {assets?.errors.slice(-2).map((e, i) => <span key={i} className="chip error">{e}</span>)}
      </div>
      <div className="viewport-hint">
        {view.kind === 'free' ? '拖动转视角 · WASD/QE 移动 · 滚轮推拉 · 拖角色移动 · Shift+拖角色旋转' : '镜头视角（只读）· 切回自由相机可编辑'}
      </div>
    </div>
  );
}

/** Darkens what falls outside the shot's frame: the part of the canvas an export keeps. */
function FrameGuide({ aspect }: { aspect: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth, H = el.clientHeight;
      let w = W, h = W / aspect;
      if (h > H) { h = H; w = H * aspect; }
      setBox({ w, h });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect]);
  return <div ref={ref} className="frame-guide"><div style={{ width: box.w, height: box.h }} /></div>;
}

const round2 = (v: number) => Math.round(v * 100) / 100;
