import type { Easing, Interpolation, StageDoc, StageRenderer } from '@stage';

import type { Selection } from './ops.ts';
import { clamp, patchCharacter, patchClip, patchKey, patchShot, removeCharacter, removeClip, removeKey, removeShot } from './ops.ts';
import type { StageStore } from './useStage.ts';

interface Props {
  doc: StageDoc;
  selection: Selection;
  renderer: StageRenderer | null;
  update: StageStore['update'];
  onSelect: (s: Selection) => void;
  onTime: (t: number) => void;
}

/** What is selected, and its numbers. */
export function Inspector({ doc, selection, renderer, update, onSelect, onTime }: Props) {
  if (!selection) {
    return (
      <div className="inspector">
        <h3>片场</h3>
        <Field label="标题"><input value={doc.title} onChange={(e) => update((d) => ({ ...d, title: e.target.value }))} /></Field>
        <Field label="场景">{doc.scene ? doc.scene.name : <span className="muted">未选择</span>}</Field>
        {doc.scene?.placement && (
          <Field label="场景比例 (米/单位)">
            <Num value={doc.scene.placement.scale} step={0.1} min={0.05}
              onChange={(scale) => update((d) => (d.scene?.placement ? { ...d, scene: { ...d.scene, placement: { ...d.scene.placement, scale } } } : d))} />
          </Field>
        )}
        <p className="muted small">角色 {doc.characters.length} · 镜头 {doc.shots.length}</p>
        <p className="muted small">提示：在视口里点角色选中；在时间轴点关键帧跳过去。</p>
      </div>
    );
  }

  if (selection.kind === 'character') {
    const c = doc.characters.find((x) => x.id === selection.id);
    if (!c) return <div className="inspector" />;
    const set = (patch: Parameters<typeof patchCharacter>[2]) => update((d) => patchCharacter(d, c.id, patch));
    return (
      <div className="inspector">
        <h3>🧍 角色</h3>
        <Field label="名字"><input value={c.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="位置 X / Y / Z (米)">
          <div className="vec">
            {[0, 1, 2].map((i) => (
              <Num key={i} value={c.position[i]!} step={0.05}
                onChange={(v) => { const p = [...c.position] as [number, number, number]; p[i] = v; set({ position: p }); }} />
            ))}
          </div>
        </Field>
        <Field label={`朝向 ${Math.round(c.yaw)}°`}>
          <input type="range" min={-180} max={180} value={wrap(c.yaw)} onChange={(e) => set({ yaw: Number(e.target.value) })} />
        </Field>
        <Field label="身高 (米)"><Num value={c.height} step={0.05} min={0.3} max={4} onChange={(height) => set({ height })} /></Field>
        <div className="btn-row">
          <button className="btn" onClick={() => renderer?.focusOn(renderer.characterPosition(c.id) ?? c.position)}>聚焦 (F)</button>
          <button className="btn danger" onClick={() => { update((d) => removeCharacter(d, c.id)); onSelect(null); }}>删除</button>
        </div>
        <h4 className="section-title">动作片段</h4>
        {c.clips.length ? c.clips.map((k) => (
          <button key={k.id} className="row-btn" onClick={() => { onSelect({ kind: 'clip', characterId: c.id, clipId: k.id }); onTime(k.start); }}>
            <span>{k.loop ? '⟳ ' : ''}{k.name}</span><span className="muted">{k.start.toFixed(1)}–{k.end.toFixed(1)}s</span>
          </button>
        )) : <p className="muted small">从左侧「动作」里添加。没有动作时角色原地待机。</p>}
      </div>
    );
  }

  if (selection.kind === 'clip') {
    const c = doc.characters.find((x) => x.id === selection.characterId);
    const k = c?.clips.find((x) => x.id === selection.clipId);
    if (!c || !k) return <div className="inspector" />;
    const len = renderer?.clipLength(k.url) ?? null;
    const set = (patch: Parameters<typeof patchClip>[3]) => update((d) => patchClip(d, c.id, k.id, patch));
    return (
      <div className="inspector">
        <h3>🎬 动作片段</h3>
        <p className="muted small">{c.name}</p>
        <Field label="名字"><input value={k.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="开始 (秒)"><Num value={k.start} step={0.1} min={0} onChange={(start) => set({ start, end: Math.max(start + 0.1, k.end - k.start + start) })} /></Field>
        <Field label="结束 (秒)"><Num value={k.end} step={0.1} min={k.start + 0.1} onChange={(end) => set({ end })} /></Field>
        <label className="check"><input type="checkbox" checked={k.loop} onChange={(e) => set({ loop: e.target.checked })} /> 循环到结束</label>
        <label className="check" title="走路、跑步这类动作会带着角色移动；关掉则原地播放">
          <input type="checkbox" checked={k.rootMotion !== false} onChange={(e) => set({ rootMotion: e.target.checked })} /> 跟随动作位移
        </label>
        {len !== null && (
          <>
            <p className="muted small">动作本身 {len.toFixed(2)} 秒</p>
            <button className="btn" onClick={() => set({ end: k.start + len, loop: false })}>按动作原长裁剪</button>
          </>
        )}
        <div className="btn-row"><button className="btn danger" onClick={() => { update((d) => removeClip(d, c.id, k.id)); onSelect({ kind: 'character', id: c.id }); }}>删除片段</button></div>
      </div>
    );
  }

  const shot = doc.shots.find((s) => s.id === selection.shotId);
  if (!shot) return <div className="inspector" />;

  if (selection.kind === 'key') {
    const k = shot.keys.find((x) => x.id === selection.keyId);
    if (!k) return <div className="inspector" />;
    const set = (patch: Parameters<typeof patchKey>[3]) => update((d) => patchKey(d, shot.id, k.id, patch));
    return (
      <div className="inspector">
        <h3>◆ 镜头关键帧</h3>
        <p className="muted small">{shot.name}</p>
        <Field label="时间 (秒)"><Num value={k.t} step={1 / 24} min={0} max={doc.duration} onChange={(t) => { set({ t }); onTime(t); }} /></Field>
        <Field label={`视场角 ${k.fov.toFixed(0)}°（焦距约 ${focal(k.fov)}mm）`}>
          <input type="range" min={10} max={100} value={k.fov} onChange={(e) => set({ fov: Number(e.target.value) })} />
        </Field>
        <Field label="相机位置"><span className="mono small">{k.position.map((v) => v.toFixed(2)).join(', ')}</span></Field>
        <Field label="看向"><span className="mono small">{k.target.map((v) => v.toFixed(2)).join(', ')}</span></Field>
        <div className="btn-row">
          <button className="btn" title="用自由相机当前的位置和朝向覆盖这一帧" onClick={() => {
            if (!renderer) return;
            const cam = renderer.getCamera(Math.hypot(k.target[0] - k.position[0], k.target[1] - k.position[1], k.target[2] - k.position[2]) || 3);
            set({ position: cam.position, target: cam.target });
          }}>用当前视角更新</button>
          <button className="btn danger" onClick={() => { update((d) => removeKey(d, shot.id, k.id)); onSelect({ kind: 'shot', shotId: shot.id }); }}>删除</button>
        </div>
      </div>
    );
  }

  return (
    <div className="inspector">
      <h3>🎥 镜头</h3>
      <Field label="名字"><input value={shot.name} onChange={(e) => update((d) => patchShot(d, shot.id, { name: e.target.value }))} /></Field>
      <Field label="关键帧间连接">
        <select value={shot.interpolation} onChange={(e) => update((d) => patchShot(d, shot.id, { interpolation: e.target.value as Interpolation }))}>
          <option value="smooth">平滑曲线</option><option value="linear">线性</option><option value="step">到点切换</option>
        </select>
      </Field>
      <Field label="时间节奏">
        <select value={shot.easing} onChange={(e) => update((d) => patchShot(d, shot.id, { easing: e.target.value as Easing }))}>
          <option value="easeInOut">缓入缓出</option><option value="easeIn">缓入</option><option value="easeOut">缓出</option><option value="linear">匀速</option>
        </select>
      </Field>
      <h4 className="section-title">关键帧 {shot.keys.length}</h4>
      {shot.keys.map((k) => (
        <button key={k.id} className="row-btn" onClick={() => { onSelect({ kind: 'key', shotId: shot.id, keyId: k.id }); onTime(k.t); }}>
          <span>◆ {k.t.toFixed(2)}s</span><span className="muted">{k.fov.toFixed(0)}°</span>
        </button>
      ))}
      {shot.keys.length < 2 && <p className="muted small">至少两个关键帧才有运镜：移动自由相机，在不同时间点「＋关键帧」。</p>}
      <div className="btn-row"><button className="btn danger" onClick={() => { update((d) => removeShot(d, shot.id)); onSelect(null); }}>删除镜头</button></div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Num({ value, step, min, max, onChange }: { value: number; step: number; min?: number; max?: number; onChange: (v: number) => void }) {
  return (
    <input type="number" step={step} min={min} max={max} value={Number(value.toFixed(3))}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(clamp(v, min ?? -Infinity, max ?? Infinity));
      }} />
  );
}

const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;
/** Full-frame equivalent focal length for a vertical field of view on a 24 mm-tall frame. */
const focal = (fov: number) => Math.round(12 / Math.tan((fov * Math.PI) / 360));
