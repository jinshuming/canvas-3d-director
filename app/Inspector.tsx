import { useEffect, useState } from 'react';

import type { Easing, Interpolation, StageDoc, StageRenderer, StageShot, ToolResult } from '@stage';
import { renderStill, sampleShot } from '@stage';

import { Icon } from './icons.tsx';
import type { Selection } from './ops.ts';
import { clamp, cutTo, patchCharacter, patchClip, patchCut, patchKey, patchShot, removeCharacter, removeClip, removeCut, removeKey, removeShot, shotColor, sortedCuts } from './ops.ts';
import type { StageStore } from './useStage.ts';

interface Props {
  doc: StageDoc;
  selection: Selection;
  renderer: StageRenderer | null;
  update: StageStore['update'];
  onSelect: (s: Selection) => void;
  onTime: (t: number) => void;
  /** The playhead: where the shot card frames and cuts. */
  time: number;
  /** Run an agent tool on this stage (the shot card frames through `frame_shot`). */
  runTool: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
}

/** What is selected, and its numbers. */
export function Inspector({ doc, selection, renderer, update, onSelect, onTime, time, runTool }: Props) {
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

  if (selection.kind === 'cut') {
    const cut = sortedCuts(doc).find((c) => c.id === selection.cutId);
    if (!cut) return <div className="inspector" />;
    const set = (patch: Parameters<typeof patchCut>[2]) => update((d) => patchCut(d, cut.id, patch));
    return (
      <div className="inspector">
        <h3>剪辑片段</h3>
        <p className="muted small">成片在这段时间看这个镜头。所有镜头拍的是同一场表演，切换镜头只是换机位。</p>
        <Field label="镜头">
          <select value={cut.shotId} onChange={(e) => set({ shotId: e.target.value })}>
            {doc.shots.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="开始 (秒)"><Num value={cut.start} step={1 / 24} min={0} max={cut.end} onChange={(start) => { set({ start }); onTime(start); }} /></Field>
        <Field label="结束 (秒)"><Num value={cut.end} step={1 / 24} min={cut.start} max={doc.duration} onChange={(end) => set({ end })} /></Field>
        <div className="btn-row">
          <button className="btn" onClick={() => onSelect({ kind: 'shot', shotId: cut.shotId })}>编辑这个镜头</button>
          <button className="btn danger" onClick={() => { update((d) => removeCut(d, cut.id)); onSelect(null); }}>删除片段</button>
        </div>
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
      <h3><span className="shot-swatch" style={{ background: shotColor(doc.shots.indexOf(shot)) }} /> 镜头</h3>
      <Field label="名字"><input value={shot.name} onChange={(e) => update((d) => patchShot(d, shot.id, { name: e.target.value }))} /></Field>
      <ShotCard doc={doc} shot={shot} renderer={renderer} time={time} runTool={runTool}
        onCut={() => update((d) => cutTo(d, shot.id, Math.round(time * 24) / 24))} />
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

type Framing = 'single' | 'over_shoulder' | 'two_shot';
const SIZES = [['full', '全景'], ['medium', '中景'], ['medium_close', '近景'], ['close_up', '特写']] as const;
const HEIGHTS = [['low', '低'], ['eye_level', '平视'], ['high', '高']] as const;
const SIDES = [['three_quarter_right', '右前'], ['front', '正面'], ['three_quarter_left', '左前']] as const;

/**
 * Film grammar as buttons: framing, who, shot size, camera height and side,
 * then "frame it" puts the shot's camera at the playhead (through the same
 * `frame_shot` the agent uses). A still of the shot shows the result.
 */
function ShotCard({ doc, shot, renderer, time, runTool, onCut }: {
  doc: StageDoc; shot: StageShot; renderer: StageRenderer | null; time: number;
  runTool: Props['runTool']; onCut: () => void;
}) {
  const cast = doc.characters;
  const [framing, setFraming] = useState<Framing>(cast.length >= 2 ? 'over_shoulder' : 'single');
  const [subject, setSubject] = useState(cast[0]?.id ?? '');
  const [other, setOther] = useState(cast[1]?.id ?? '');
  const [size, setSize] = useState<string>('medium');
  const [height, setHeight] = useState<string>('eye_level');
  const [side, setSide] = useState<string>('front');
  const [still, setStill] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const pair = framing !== 'single';
  const t = Math.round(time * 100) / 100;

  // The still: the shot at the playhead, redrawn when the shot or the playhead settles.
  const camKey = JSON.stringify(shot.keys);
  useEffect(() => {
    if (!renderer || !shot.keys.length) { setStill(null); return; }
    let live = true;
    const timer = setTimeout(async () => {
      const cam = sampleShot(shot, time);
      if (!cam) return;
      try {
        const canvas = await renderStill(renderer, doc, cam, time, { width: 320 });
        if (live) setStill(canvas.toDataURL('image/jpeg', 0.8));
      } catch { /* the viewport is busy; the next change tries again */ }
    }, 350);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw on the shot's keys and the playhead
  }, [renderer, shot.id, camKey, time]);

  const frame = async () => {
    if (!subject || (pair && (!other || other === subject))) return;
    setBusy(true);
    setNote(null);
    // A static shot is re-framed where its one key is; a moving shot gets (or replaces) a key at the playhead.
    const moving = shot.keys.length > 1;
    const at = moving ? t : shot.keys[0]?.t ?? 0;
    const r = await runTool('frame_shot', {
      shot_id: shot.id, time: at, subject, size, angle: height,
      ...(pair ? { framing, with: other } : { side }),
    });
    setBusy(false);
    const text = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    setNote(r.is_error ? text : moving ? `已在 ${at}s 设定这一帧的机位（这个镜头有运镜）` : '已更新机位');
  };

  if (!cast.length) return <p className="muted small">先放一个角色，才能用景别取景。</p>;
  const sizes = framing === 'two_shot' ? [['full', '全景'], ['medium_full', '中全'], ['medium', '中景']] as const : SIZES;

  return (
    <div className="shot-card">
      <div className="shot-still">
        {still ? <img src={still} alt="" /> : <span className="muted small">{shot.keys.length ? '渲染中…' : '还没有机位：选好下面的选项，点「取景」'}</span>}
        <span className="shot-still-time mono">{t.toFixed(2)}s</span>
      </div>
      <div className="seg wide sm">
        {([['single', '单人'], ['over_shoulder', '过肩'], ['two_shot', '双人']] as const).map(([k, label]) => (
          <button key={k} className={framing === k ? 'on' : ''} disabled={k !== 'single' && cast.length < 2}
            onClick={() => { setFraming(k); if (k === 'two_shot' && !['full', 'medium_full', 'medium'].includes(size)) setSize('medium_full'); }}>{label}</button>
        ))}
      </div>
      <div className="shot-who">
        <label className="field"><span>{framing === 'over_shoulder' ? '拍谁（说话的人）' : '主体'}</span>
          <select value={subject} onChange={(e) => setSubject(e.target.value)}>{cast.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </label>
        {pair && (
          <label className="field"><span>{framing === 'over_shoulder' ? '越过谁的肩' : '和谁'}</span>
            <select value={other} onChange={(e) => setOther(e.target.value)}>{cast.filter((c) => c.id !== subject).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          </label>
        )}
      </div>
      <Row label="景别" options={sizes} value={size} onChange={setSize} />
      <Row label="机位高度" options={HEIGHTS} value={height} onChange={setHeight} />
      {!pair && <Row label="方位" options={SIDES} value={side} onChange={setSide} />}
      <div className="btn-row">
        <button className="btn primary" disabled={busy || (pair && (!other || other === subject))} onClick={() => void frame()}><Icon name="camera" size={14} />取景</button>
        <button className="btn" disabled={!shot.keys.length} onClick={onCut} title="从播放头开始，成片切到这个镜头"><Icon name="film" size={14} />从这里切入剪辑</button>
      </div>
      {note && <p className="muted small">{note}</p>}
    </div>
  );
}

function Row({ label, options, value, onChange }: { label: string; options: ReadonlyArray<readonly [string, string]>; value: string; onChange: (v: string) => void }) {
  return (
    <div className="shot-row">
      <span>{label}</span>
      <div className="seg sm">{options.map(([k, l]) => <button key={k} className={value === k ? 'on' : ''} onClick={() => onChange(k)}>{l}</button>)}</div>
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
