import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { StageAspect, StageRenderer, StageView } from '@stage';
import { ASPECTS, nextFreeStart, runStageTool, STAGE_TOOLS } from '@stage';

import { api } from './api.ts';
import { createDirectorHost } from './agentHost.ts';

import type { ExportProgress } from './exporter.ts';
import { download, exportEditVideo, exportFrame, exportShotVideo } from './exporter.ts';
import { Icon, Logo } from './icons.tsx';
import { Inspector } from './Inspector.tsx';
import type { LibraryTab } from './LibraryPanel.tsx';
import { LibraryPanel } from './LibraryPanel.tsx';
import type { Selection } from './ops.ts';
import { addClip, addShot, clamp, uid, upsertKey } from './ops.ts';
import type { LibraryCharacter, LibraryMotion, LibraryScene } from './shared/library.ts';
import { Timeline } from './Timeline.tsx';
import { linkProps } from './router.ts';
import type { WorldChat } from './shared/world.ts';
import { isEmptyWorld } from './shared/world.ts';
import { ToolConsole } from './ToolConsole.tsx';
import { AgentPanel } from './agent/AgentPanel.tsx';
import { useAgent } from './agent/useAgent.ts';
import { useStage } from './useStage.ts';
import { Viewport } from './Viewport.tsx';
import { WorldBrowser } from './WorldBrowser.tsx';

const SELECTION_TITLE = { none: '片场', character: '角色', clip: '动作片段', shot: '镜头', key: '镜头关键帧', cut: '剪辑片段' } as const;
const SAVE_LABEL ={ saved: '已保存', pending: '待保存…', saving: '保存中…', error: '保存失败', conflict: '版本冲突' } as const;

interface StudioProps { stageId: string; nodeId: string | null; live: boolean; agentModel: string | null }

/** One World project in the 3D Studio: the world file is read first, for the conversation that built it. */
export function Studio(props: StudioProps) {
  const [chat, setChat] = useState<{ chat: WorldChat; empty: boolean; coverAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getWorld(props.stageId)
      .then((w) => { if (live) setChat({ chat: w.chat, empty: isEmptyWorld(w), coverAt: w.cover?.updatedAt ?? null }); })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [props.stageId]);
  if (error) return <div className="center error">无法打开 World：{error} <a {...linkProps('/canvas')}>返回画布</a></div>;
  if (!chat) return <div className="center muted">加载 World…</div>;
  return <StudioEditor {...props} initialChat={chat.chat} fresh={chat.empty} coverAt={chat.coverAt} />;
}

function StudioEditor({ stageId, nodeId, live, agentModel, initialChat, fresh, coverAt }: StudioProps & { initialChat: WorldChat; fresh: boolean; coverAt: string | null }) {
  const store = useStage(stageId);
  const { doc, update } = store;
  const [renderer, setRenderer] = useState<StageRenderer | null>(null);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<StageView>({ kind: 'free' });
  const [selection, setSelection] = useState<Selection>(null);
  const [activeShot, setActiveShot] = useState<string | null>(null);
  const [exporting, setExporting] = useState<{ label: string; progress: ExportProgress | null; abort: AbortController } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // A new world opens agent-first: the library stays shut until asked for.
  const [library, setLibrary] = useState<LibraryTab | null>(fresh ? null : 'scene');
  const [history, setHistory] = useState(false);

  // The active shot: the one picked, else the first.
  const shot = doc?.shots.find((s) => s.id === activeShot) ?? doc?.shots[0] ?? null;
  useEffect(() => { if (shot && shot.id !== activeShot) setActiveShot(shot.id); }, [shot, activeShot]);
  const hasEdit = !!doc?.cuts?.length;
  // The edit going away (its last cut deleted) leaves the viewport on the active shot.
  useEffect(() => { if (view.kind === 'edit' && !hasEdit) setView(shot ? { kind: 'shot', shotId: shot.id } : { kind: 'free' }); }, [view.kind, hasEdit, shot]);

  // Playback: the clock runs on wall time and wraps at the end.
  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!playing || !doc) return;
    let last = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = timeRef.current + (now - last) / 1000;
      last = now;
      setTime(t >= doc.duration ? 0 : t);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, doc?.duration]);

  const say = (msg: string) => { setNotice(msg); setTimeout(() => setNotice((n) => (n === msg ? null : n)), 3500); };

  const selectedCharacter = doc?.characters.find((c) => (selection?.kind === 'character' && c.id === selection.id) || (selection?.kind === 'clip' && c.id === selection.characterId)) ?? null;

  // ── Library actions ──────────────────────────────────────────────────────
  const useScene = (s: LibraryScene) => {
    update((d) => ({ ...d, scene: { name: s.name, url: s.url, placement: null, viggle: s.viggle, panoramaUrl: s.panoramaUrl } }));
    say(`场景：${s.name}（首次加载会自动测量地面和比例）`);
  };

  const addCharacter = (c: LibraryCharacter) => {
    if (!doc) return;
    // In front of the camera, on the floor, facing it.
    const cam = renderer?.getCamera(3);
    const at: [number, number, number] = cam ? [round(cam.target[0]), 0, round(cam.target[2])] : [0, 0, -2];
    const yaw = cam ? Math.round((Math.atan2(cam.position[0] - at[0], cam.position[2] - at[2]) * 180) / Math.PI) + 180 : 180;
    const id = uid('chr');
    update((d) => ({ ...d, characters: [...d.characters, { id, name: c.name, url: c.url, position: at, yaw, height: 1.7, clips: [] }] }));
    setSelection({ kind: 'character', id });
  };

  const addMotion = async (m: LibraryMotion) => {
    const c = selectedCharacter;
    if (!c || !doc) return;
    const len = (await renderer?.measureClip(m.url)) ?? 3;
    const start = clamp(Math.max(time, 0), 0, 600);
    const clashes = c.clips.some((k) => k.start < start + len && start < k.end);
    const at = clashes ? nextFreeStart(c.clips) : start;
    const clip = { id: uid('clip'), name: m.name, url: m.url, start: round(at), end: round(at + len), loop: false };
    update((d) => addClip(d, c.id, clip));
    setSelection({ kind: 'clip', characterId: c.id, clipId: clip.id });
    if (at + len > doc.duration) say('时长已自动延长以容纳这段动作');
  };

  // ── Camera keys ──────────────────────────────────────────────────────────
  const addKey = useCallback(() => {
    if (!renderer || !doc) return;
    if (view.kind !== 'free') { say('切到自由相机，摆好机位再加关键帧'); return; }
    let shotId = shot?.id;
    let next = doc;
    if (!shotId) {
      const made = addShot(doc);
      next = made.doc;
      shotId = made.shot.id;
      setActiveShot(shotId);
    }
    // Aim distance: the selected character if there is one, else 3 m.
    const target = selectedCharacter;
    const camNow = renderer.getCamera(3);
    const focus = target ? Math.hypot(target.position[0] - camNow.position[0], target.position[1] + 1 - camNow.position[1], target.position[2] - camNow.position[2]) : 3;
    const cam = renderer.getCamera(Math.max(0.5, focus));
    const { doc: withKey, key } = upsertKey(next, shotId, { t: round(time), position: cam.position, target: cam.target, fov: cam.fov });
    update(() => withKey);
    setSelection({ kind: 'key', shotId, keyId: key.id });
  }, [renderer, doc, view, shot, selectedCharacter, time, update]);

  const selectKey = (shotId: string, keyId: string) => {
    const k = doc?.shots.find((s) => s.id === shotId)?.keys.find((x) => x.id === keyId);
    setSelection({ kind: 'key', shotId, keyId });
    if (!k) return;
    setTime(k.t);
    // In the free view, step the camera onto the key to tweak it.
    if (view.kind === 'free') renderer?.setCamera(k);
  };

  // ── Export ───────────────────────────────────────────────────────────────
  const runExport = async (kind: 'png' | 'mp4' | 'edit', shotId = shot?.id, at = time): Promise<string> => {
    const d = store.get();
    const target = d?.shots.find((s) => s.id === shotId);
    if (!renderer || !d || (kind !== 'edit' && !target)) { say('先建一个镜头'); return 'No shot to export.'; }
    setPlaying(false);
    const abort = new AbortController();
    setExporting({ label: kind === 'png' ? '导出画面' : kind === 'edit' ? '渲染成片' : '渲染视频', progress: null, abort });
    try {
      if (kind === 'edit') {
        const blob = await exportEditVideo(renderer, d, (progress) => setExporting((e) => (e ? { ...e, progress } : e)), abort.signal);
        download(blob, `${slug(d.title)}-成片.mp4`);
        say('已导出成片');
        return 'Exported the edit as mp4; it downloaded for the user.';
      }
      if (!target) return 'No shot to export.';
      if (kind === 'png') {
        const blob = await exportFrame(renderer, d, target.id, at);
        download(blob, `${slug(d.title)}-${slug(target.name)}-${at.toFixed(2)}s.png`);
      } else {
        const blob = await exportShotVideo(renderer, d, target.id, (progress) => setExporting((e) => (e ? { ...e, progress } : e)), abort.signal);
        download(blob, `${slug(d.title)}-${slug(target.name)}.mp4`);
      }
      say('已导出');
      return `Exported ${target!.name} as ${kind}; it downloaded for the user.`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if ((e as Error).name !== 'AbortError') say(`导出失败：${msg}`);
      return `Export failed: ${msg}`;
    } finally {
      setExporting(null);
    }
  };

  // ── The agent's tools ────────────────────────────────────────────────────
  const rendererRef = useRef(renderer);
  rendererRef.current = renderer;
  const exportRef = useRef(runExport);
  exportRef.current = runExport;
  const host = useMemo(() => createDirectorHost({
    getDoc: () => store.get()!,
    update: (fn) => store.update(fn),
    renderer: () => rendererRef.current,
    ui: {
      preview: ({ shotId, edit, time: t, play }) => {
        if (edit) setView({ kind: 'edit' });
        else if (shotId) { setActiveShot(shotId); setView({ kind: 'shot', shotId }); } else if (shotId === null) setView({ kind: 'free' });
        if (typeof t === 'number') setTime(t);
        setPlaying(Boolean(play));
      },
      select: (s) => setSelection(s?.characterId ? { kind: 'character', id: s.characterId } : s?.shotId ? { kind: 'shot', shotId: s.shotId } : null),
      undo: () => store.undo(),
      redo: () => store.redo(),
      exportShot: (shotId, kind, t) => exportRef.current(kind, shotId, t ?? 0),
      exportEdit: () => exportRef.current('edit'),
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the store's functions read refs; one host per stage
  }), [store.get]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    // For driving the tools from the console (or a test) while developing.
    (window as unknown as { __director?: unknown }).__director = { host, run: (name: string, input: Record<string, unknown> = {}) => runStageTool(name, input, host), tools: STAGE_TOOLS.map((t) => t.name) };
  }, [host]);

  // What the agent is told about the editor with each message: where the user is and what they have picked.
  const ctx = useRef({ time, selection, shot: shot?.id ?? null, view });
  ctx.current = { time, selection, shot: shot?.id ?? null, view };
  const editorContext = useCallback(() => {
    const c = ctx.current;
    const d = store.get();
    const s = c.selection;
    const sel = s?.kind === 'character' ? `${d?.characters.find((k) => k.id === s.id)?.name ?? s.id} (${s.id})` : s ? JSON.stringify(s) : 'nothing';
    return `[Editor] playhead ${c.time.toFixed(2)}s; selected: ${sel}; active shot: ${c.shot ?? 'none'}; viewport: ${c.view.kind === 'shot' ? 'through the active shot' : c.view.kind === 'edit' ? 'through the edit' : 'free camera'}.`;
  }, [store]);
  const agent = useAgent(stageId, initialChat, host, editorContext);
  useEffect(() => { if (import.meta.env.DEV) (window as unknown as { __agentLast?: unknown }).__agentLast = agent.lastTurn; }, [agent.lastTurn]);

  // ── Cover ────────────────────────────────────────────────────────────────
  // The world's card on the canvas and in history: a still taken a few seconds after the stage
  // settles, only when it changed since the last cover (so opening a world never replaces it), and
  // through a shot when the world has one - the agent ends each turn previewing its main shot.
  const coverFrom = useRef(coverAt ?? '');
  const openedAt = useRef(performance.now());
  useEffect(() => {
    if (!renderer || !doc?.scene || playing || agent.busy || exporting) return;
    if (doc.updatedAt <= coverFrom.current) return;
    const hasShot = doc.shots.some((s) => s.keys.length);
    if (hasShot && view.kind !== 'shot' && view.kind !== 'edit') return;
    let timer: ReturnType<typeof setTimeout>;
    const attempt = async () => {
      const state = renderer.getAssetState();
      // Assets still arriving, or the scene still fading in after the editor opened: try again shortly.
      if (state.sceneLoading || state.loadingCharacters.length || state.loadingClips.length || performance.now() - openedAt.current < COVER_SETTLE_MS) {
        timer = setTimeout(() => void attempt(), 1500);
        return;
      }
      const at = doc.updatedAt;
      try {
        const still = await renderer.capture(ASPECTS[doc.aspect], 640);
        await api.saveCover(stageId, still.toDataURL('image/jpeg', 0.82));
        coverFrom.current = at;
      } catch { /* next change tries again */ }
    };
    timer = setTimeout(() => void attempt(), 3000);
    return () => clearTimeout(timer);
  }, [renderer, doc?.updatedAt, doc?.scene, doc?.aspect, doc?.shots, view, playing, agent.busy, exporting, stageId]);

  // ── Keys ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) store.redo(); else store.undo(); return; }
      if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); return; }
      if (e.key.toLowerCase() === 'k' && !mod) { addKey(); return; }
      if (e.key.toLowerCase() === 'f' && !mod && selectedCharacter) { renderer?.focusOn(renderer.characterPosition(selectedCharacter.id) ?? selectedCharacter.position); return; }
      if (e.key.toLowerCase() === 'c' && !mod && shot) { setView((v) => (v.kind === 'shot' ? { kind: 'free' } : { kind: 'shot', shotId: shot.id })); }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [store, addKey, selectedCharacter, renderer, shot]);

  if (store.error) return <div className="center error">无法打开片场：{store.error} <a {...linkProps('/canvas')}>返回画布</a></div>;
  if (!doc) return <div className="center muted">加载片场…</div>;

  const openLibrary = (t: LibraryTab) => setLibrary((cur) => (cur === t ? null : t));

  return (
    <div className="studio">
      <section className="stage-area">
        <div className="canvas-area">
          <Viewport doc={doc} time={time} view={view} selection={selection} activeShot={shot?.id ?? null}
            update={update} onSelect={setSelection} onRenderer={setRenderer} />

          {/* Top left: the app pill, as the reference product's "3D Studio 2.0" */}
          <div className="float pill-group top-left">
            <a className="pill brand" {...linkProps('/canvas')} title="回到画布"><Logo /><span className="divider" /><span className="brand-name">World</span></a>
            <button className="pill icon" onClick={() => setHistory(true)} title="历史 World：打开、加载或复制以前的 World"><Icon name="history" /></button>
            <div className="pill title-pill">
              <input className="title-input" value={doc.title} onChange={(e) => update((d) => ({ ...d, title: e.target.value }))} />
              <span className={`save-dot ${store.saveStatus}`} title={SAVE_LABEL[store.saveStatus]} />
              <span className="save-text">{SAVE_LABEL[store.saveStatus]}</span>
              {store.saveStatus === 'error' && <button className="link" onClick={store.retrySave}>重试</button>}
              {store.saveStatus === 'conflict' && <button className="link" onClick={store.reloadLatest}>加载最新</button>}
            </div>
          </div>

          {/* Top right: history, format, export */}
          <div className="float pill-group top-right">
            <button className="pill icon" disabled={!store.canUndo} onClick={store.undo} title="撤销 ⌘Z"><Icon name="undo" /></button>
            <button className="pill icon" disabled={!store.canRedo} onClick={store.redo} title="重做 ⇧⌘Z"><Icon name="redo" /></button>
            <label className="pill select-pill" title="画幅">
              <Icon name="film" />
              <select value={doc.aspect} onChange={(e) => update((d) => ({ ...d, aspect: e.target.value as StageAspect }))}>
                {Object.keys(ASPECTS).map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
            <label className="pill select-pill" title="帧率">
              <select value={doc.fps} onChange={(e) => update((d) => ({ ...d, fps: Number(e.target.value) }))}>
                {[24, 25, 30].map((f) => <option key={f} value={f}>{f} fps</option>)}
              </select>
            </label>
            <button className="pill" disabled={!shot || !!exporting} onClick={() => void runExport('png')}><Icon name="image" />导出当前帧</button>
            {hasEdit
              ? <>
                  <button className="pill" disabled={!shot || !!exporting} onClick={() => void runExport('mp4')} title="只导出当前镜头"><Icon name="download" />导出镜头</button>
                  <button className="pill primary" disabled={!!exporting} onClick={() => void runExport('edit')} title="按剪辑轨导出整条成片"><Icon name="film" />导出成片</button>
                </>
              : <button className="pill primary" disabled={!shot || !!exporting} onClick={() => void runExport('mp4')}><Icon name="download" />导出镜头视频</button>}
          </div>

          {!doc.scene && !doc.characters.length && (
            <div className="empty-hint">
              <Icon name="globe" size={28} />
              <strong>这是一个新的 World</strong>
              <span>在右侧告诉 Agent 你想拍什么，它会选场景、放角色、编排动作、架好镜头。<br />也可以从左侧 ＋ 打开素材库自己搭。</span>
            </div>
          )}

          {/* Left rail */}
          <nav className="float rail">
            <button className={`rail-btn plus ${library ? 'open' : ''}`} onClick={() => setLibrary((l) => (l ? null : 'scene'))} title="素材库">
              <Icon name={library ? 'x' : 'plus'} size={20} />
            </button>
            <button className={`rail-btn ${library === 'scene' ? 'on' : ''}`} onClick={() => openLibrary('scene')} title="场景"><Icon name="scene" size={20} /></button>
            <button className={`rail-btn ${library === 'character' ? 'on' : ''}`} onClick={() => openLibrary('character')} title="角色"><Icon name="character" size={20} /></button>
            <button className={`rail-btn ${library === 'motion' ? 'on' : ''}`} onClick={() => openLibrary('motion')} title="动作">
              <Icon name="motion" size={20} />{selectedCharacter && <span className="badge" />}
            </button>
            <span className="rail-sep" />
            <button className={`rail-btn ${selection?.kind === 'shot' ? 'on' : ''}`} disabled={!shot} onClick={() => shot && setSelection({ kind: 'shot', shotId: shot.id })} title="镜头设置"><Icon name="settings" size={20} /></button>
          </nav>

          {library && (
            <LibraryPanel tab={library} onTab={setLibrary} onClose={() => setLibrary(null)} live={live} selectedCharacter={selectedCharacter}
              onUseScene={useScene} onAddCharacter={addCharacter} onAddMotion={(m) => void addMotion(m)} />
          )}

          {/* Bottom centre: camera controls */}
          <div className="float pill-group shot-dock">
            <div className="seg">
              <button className={view.kind === 'free' ? 'on' : ''} onClick={() => setView({ kind: 'free' })}><Icon name="move" size={16} />自由相机</button>
              <button className={view.kind === 'shot' ? 'on' : ''} disabled={!shot} onClick={() => shot && setView({ kind: 'shot', shotId: shot.id })}><Icon name="camera" size={16} />镜头视角</button>
              <button className={view.kind === 'edit' ? 'on' : ''} disabled={!hasEdit} onClick={() => setView({ kind: 'edit' })} title={hasEdit ? '按剪辑轨播放：每段时间切到对应镜头' : '在时间轴的「剪辑」轨上切入镜头后可用'}><Icon name="film" size={16} />剪辑</button>
            </div>
            <label className="pill select-pill">
              <select value={shot?.id ?? ''} onChange={(e) => { setActiveShot(e.target.value); if (view.kind === 'shot') setView({ kind: 'shot', shotId: e.target.value }); }} disabled={!doc.shots.length}>
                {doc.shots.length ? doc.shots.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.keys.length} 帧</option>) : <option value="">还没有镜头</option>}
              </select>
              <Icon name="chevronDown" size={14} />
            </label>
            <button className="pill" onClick={() => { const made = addShot(doc); update(() => made.doc); setActiveShot(made.shot.id); setSelection({ kind: 'shot', shotId: made.shot.id }); }}><Icon name="plus" size={16} />新镜头</button>
            <button className="pill primary" onClick={addKey} disabled={view.kind !== 'free'} title="把自由相机当前的机位记成播放头时刻的关键帧 (K)"><Icon name="key" size={14} />关键帧 <kbd>K</kbd></button>
          </div>

          {selection && (
            <aside className="float inspector-card">
              <header className="side-head">
                <Icon name="folder" size={18} />
                <strong>{SELECTION_TITLE[selection.kind]}</strong>
                <div className="spacer" />
                <button className="ghost-icon" title="关闭" onClick={() => setSelection(null)}><Icon name="x" size={16} /></button>
              </header>
              <Inspector doc={doc} selection={selection} renderer={renderer} update={update} onSelect={setSelection} onTime={(t) => { setPlaying(false); setTime(t); }}
                time={time} runTool={(name, input) => runStageTool(name, input, host)} />
            </aside>
          )}
        </div>

        <Timeline doc={doc} time={time} playing={playing} selection={selection} activeShot={shot?.id ?? null}
          update={update} onTime={(t) => { setPlaying(false); setTime(t); }} onSelect={setSelection}
          onPlay={() => setPlaying((p) => !p)} onSelectKey={selectKey} />
      </section>

      <AgentPanel items={agent.items} busy={agent.busy} model={agentModel} lastTurn={agent.lastTurn} fresh={!doc.scene && !doc.characters.length}
        onSend={(m) => void agent.send(m)} onStop={agent.stop} onReset={agent.reset} onAnswer={agent.answer}
        bench={<ToolConsole host={host} shotId={shot?.id ?? null} />} />

      {history && (
        <div className="drawer" onClick={(e) => { if (e.target === e.currentTarget) setHistory(false); }}>
          <div className="drawer-box">
            <header className="drawer-head">
              <Icon name="history" size={20} />
              <h2>历史 World</h2>
              <div className="spacer" />
              <a className="pill sm" {...linkProps('/canvas/world')}>全部 World</a>
              <button className="pill sm icon" onClick={() => setHistory(false)} title="关闭"><Icon name="x" size={16} /></button>
            </header>
            <WorldBrowser currentId={stageId} nodeId={nodeId} onClose={() => setHistory(false)} />
          </div>
        </div>
      )}
      {notice && <div className="toast">{notice}</div>}
      {exporting && (
        <div className="modal">
          <div className="modal-box">
            <h3>{exporting.label}…</h3>
            <div className="bar"><div style={{ width: `${exporting.progress ? (exporting.progress.frame / exporting.progress.frames) * 100 : 4}%` }} /></div>
            <p className="muted small">{exporting.progress ? `第 ${exporting.progress.frame} / ${exporting.progress.frames} 帧 · 逐帧离线渲染，画面与机器快慢无关` : '准备中…'}</p>
            <button className="pill" onClick={() => exporting.abort.abort()}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;
/** The scene fades in when it loads; a cover taken sooner is fog. */
const COVER_SETTLE_MS = 8000;
const slug = (s: string) => s.trim().replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40) || 'stage';
