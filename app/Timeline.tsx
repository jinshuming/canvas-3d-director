import { useRef } from 'react';

import type { StageDoc } from '@stage';

import { Icon } from './icons.tsx';
import type { Selection } from './ops.ts';
import { clamp, patchClip, patchKey } from './ops.ts';
import type { StageStore } from './useStage.ts';

interface Props {
  doc: StageDoc;
  time: number;
  playing: boolean;
  selection: Selection;
  activeShot: string | null;
  update: StageStore['update'];
  onTime: (t: number) => void;
  onSelect: (s: Selection) => void;
  onPlay: () => void;
  onSelectKey: (shotId: string, keyId: string) => void;
}

const LABEL_W = 132;
const PX_PER_S = 96;
const SNAP = 1 / 24;

/**
 * The stage's clock: a ruler and playhead, the active shot's camera keys, and
 * a track per character with its motion clips. Drag the playhead to scrub,
 * a clip to move it, its right edge to trim it, a key to retime it.
 */
export function Timeline({ doc, time, playing, selection, activeShot, update, onTime, onSelect, onPlay, onSelectKey }: Props) {
  const lanes = useRef<HTMLDivElement>(null);
  const width = doc.duration * PX_PER_S;
  const shot = doc.shots.find((s) => s.id === activeShot) ?? null;

  const timeAt = (clientX: number) => {
    const rect = lanes.current!.getBoundingClientRect();
    return clamp((clientX - rect.left + lanes.current!.scrollLeft - LABEL_W) / PX_PER_S, 0, doc.duration);
  };
  const snap = (t: number) => Math.round(t / SNAP) * SNAP;

  /** A drag that reports seconds moved; `done` commits it as one undo step. */
  const dragging = (e: React.PointerEvent, move: (dt: number) => void, done?: () => void) => {
    e.stopPropagation();
    const x0 = e.clientX;
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 2) return;
      moved = true;
      move((ev.clientX - x0) / PX_PER_S);
    };
    const onUp = () => {
      removeEventListener('pointermove', onMove);
      removeEventListener('pointerup', onUp);
      if (moved) done?.();
    };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  };

  const scrub = (e: React.PointerEvent) => {
    onTime(snap(timeAt(e.clientX)));
    const onMove = (ev: PointerEvent) => onTime(snap(timeAt(ev.clientX)));
    const onUp = () => { removeEventListener('pointermove', onMove); removeEventListener('pointerup', onUp); };
    addEventListener('pointermove', onMove);
    addEventListener('pointerup', onUp);
  };

  const commit = () => update((d) => ({ ...d }), { commit: true });
  const ticks = [];
  for (let s = 0; s <= doc.duration; s++) ticks.push(s);

  return (
    <div className="timeline">
      <div className="timeline-bar">
        <button className="play" onClick={onPlay} title="播放 / 暂停 (空格)"><Icon name={playing ? 'pause' : 'play'} size={16} /></button>
        <span className="mono time">{time.toFixed(2)}<span className="muted"> / {doc.duration}s</span></span>
        <label className="field-inline">时长
          <input type="number" min={1} max={120} step={1} value={doc.duration}
            onChange={(e) => update((d) => ({ ...d, duration: clamp(Number(e.target.value) || 1, 1, 120) }))} />
        </label>
        <span className="muted">拖动播放头试看 · 拖动片段调整时间 · 拖动右边缘裁剪</span>
      </div>
      <div className="timeline-lanes" ref={lanes}>
        <div className="timeline-inner" style={{ width: LABEL_W + width + 40 }}>
          <div className="lane ruler" onPointerDown={scrub}>
            <div className="lane-label">时间</div>
            {ticks.map((s) => <div key={s} className="tick" style={{ left: LABEL_W + s * PX_PER_S }}>{s}s</div>)}
          </div>

          <div className="lane">
            <div className="lane-label"><Icon name="camera" size={14} />{shot ? shot.name : "无镜头"}</div>
            <div className="lane-body" onPointerDown={scrub} />
            {shot?.keys.map((k) => {
              const on = selection?.kind === 'key' && selection.keyId === k.id;
              return (
                <div key={k.id} className={`key ${on ? 'on' : ''}`} style={{ left: LABEL_W + k.t * PX_PER_S }} title={`${k.t.toFixed(2)}s`}
                  onPointerDown={(e) => {
                    onSelectKey(shot.id, k.id);
                    const t0 = k.t;
                    dragging(e, (dt) => {
                      const t = clamp(snap(t0 + dt), 0, doc.duration);
                      update((d) => patchKey(d, shot.id, k.id, { t }), { commit: false });
                      onTime(t);
                    }, commit);
                  }} />
              );
            })}
          </div>

          {doc.characters.map((c) => (
            <div key={c.id} className="lane">
              <div className={`lane-label ${(selection?.kind === 'character' && selection.id === c.id) || (selection?.kind === 'clip' && selection.characterId === c.id) ? 'on' : ''}`} onClick={() => onSelect({ kind: "character", id: c.id })}><Icon name="character" size={14} />{c.name}</div>
              <div className="lane-body" onPointerDown={scrub} />
              {c.clips.map((clip) => {
                const on = selection?.kind === 'clip' && selection.clipId === clip.id;
                return (
                  <div key={clip.id} className={`clip ${on ? 'on' : ''}`}
                    style={{ left: LABEL_W + clip.start * PX_PER_S, width: Math.max(8, (clip.end - clip.start) * PX_PER_S) }}
                    onPointerDown={(e) => {
                      onSelect({ kind: 'clip', characterId: c.id, clipId: clip.id });
                      const { start, end } = clip;
                      dragging(e, (dt) => {
                        const s = clamp(snap(start + dt), 0, doc.duration - (end - start));
                        update((d) => patchClip(d, c.id, clip.id, { start: s, end: s + (end - start) }), { commit: false });
                      }, commit);
                    }}>
                    <span>{clip.loop && <Icon name="loop" size={11} />}{clip.name}</span>
                    <div className="clip-edge" onPointerDown={(e) => {
                      onSelect({ kind: 'clip', characterId: c.id, clipId: clip.id });
                      const end0 = clip.end;
                      dragging(e, (dt) => {
                        const end = clamp(snap(end0 + dt), clip.start + SNAP, doc.duration);
                        update((d) => patchClip(d, c.id, clip.id, { end }), { commit: false });
                      }, commit);
                    }} />
                  </div>
                );
              })}
            </div>
          ))}
          {!doc.characters.length && <div className="lane empty"><div className="lane-label muted">没有角色</div></div>}

          <div className="playhead" style={{ left: LABEL_W + time * PX_PER_S }} onPointerDown={scrub} />
        </div>
      </div>
    </div>
  );
}
