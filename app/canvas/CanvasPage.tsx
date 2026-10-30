import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import type { WorldSummary } from '../shared/world.ts';
import type { IconName } from '../icons.tsx';
import { Icon, Logo } from '../icons.tsx';
import { navigate, worldPath } from '../router.ts';
import './canvas.css';
import type { CanvasNode, CanvasState, NodeKind } from './model.ts';
import { loadCanvas, newId, NODE_LABEL, NODE_SIZE, saveCanvas } from './model.ts';

/**
 * A stand-in for TapNow's canvas, for the demo: the board, its nodes and the
 * Agent panel look the part, and one node is real - World, which opens the
 * 3D Studio on its own stage.
 */
export function CanvasPage() {
  const [state, setState] = useState<CanvasState>(() => loadCanvas(seed));
  const [selected, setSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const board = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => { saveCanvas(state); }, [state]);

  // What each World node shows: its project's summary, fetched again when the page comes back into view.
  const [worlds, setWorlds] = useState<Map<string, WorldSummary> | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.listWorlds().then((list) => { if (live) setWorlds(new Map(list.map((w) => [w.id, w]))); }).catch(() => {});
    void load();
    addEventListener('focus', load);
    return () => { live = false; removeEventListener('focus', load); };
  }, []);

  // The seed's picture and World come from this project's own assets: a scene's panorama, and the latest World that has a scene.
  useEffect(() => {
    if (!state.nodes.some((n) => n.kind === 'image' && !n.src)) return;
    void api.library().then((lib) => {
      const pano = lib.scenes.find((s) => s.panoramaUrl)?.panoramaUrl;
      if (pano) setState((s) => ({ ...s, nodes: s.nodes.map((n) => (n.kind === 'image' && !n.src ? { ...n, src: pano } : n)) }));
    }).catch(() => {});
    if (state.nodes.some((n) => n.kind === 'world')) return;
    void api.listWorlds().then((list) => {
      const w = list.find((x) => x.sceneName);
      if (!w) return;
      const [nw, nh] = NODE_SIZE.world;
      setState((st) => (st.nodes.some((n) => n.kind === 'world') ? st : {
        ...st,
        nodes: [...st.nodes, { id: 'seed_world', kind: 'world', x: 720, y: 440, w: nw, h: nh, worldId: w.id, title: w.title }],
        edges: [...st.edges, { from: 'seed_img', to: 'seed_world' }],
      }));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the seed
  }, []);

  const { view } = state;
  // The whole canvas UI scales with the window, in TapNow's proportions; the board draws at view.zoom × ui.
  const ui = useUiScale();
  const scale = view.zoom * ui;
  const setView = (v: Partial<CanvasState['view']>) => setState((s) => ({ ...s, view: { ...s.view, ...v } }));

  // ── Pan, zoom, drag ──────────────────────────────────────────────────────
  const onBoardPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.cv-node, .cv-float')) return;
    setSelected(null);
    setMenu(false);
    const x0 = e.clientX, y0 = e.clientY, vx = view.x, vy = view.y;
    const move = (ev: PointerEvent) => setView({ x: vx + ev.clientX - x0, y: vy + ev.clientY - y0 });
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  const zoomAt = useCallback((zoom: number, cx: number, cy: number) => {
    setState((s) => {
      const z = Math.min(2, Math.max(0.25, zoom));
      const k = z / s.view.zoom;
      return { ...s, view: { zoom: z, x: cx - (cx - s.view.x) * k, y: cy - (cy - s.view.y) * k } };
    });
  }, []);

  useEffect(() => {
    const el = board.current;
    if (!el) return;
    // Pinch (ctrl+wheel) or ⌘-wheel zooms round the cursor; a plain wheel pans, as on TapNow.
    const onWheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.cv-float')) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) zoomAt(stateRef.current.view.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - rect.left, e.clientY - rect.top);
      else setState((s) => ({ ...s, view: { ...s.view, x: s.view.x - e.deltaX, y: s.view.y - e.deltaY } }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  const onNodePointerDown = (e: React.PointerEvent, n: CanvasNode) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, input, textarea')) return;
    e.stopPropagation();
    setSelected(n.id);
    setMenu(false);
    const x0 = e.clientX, y0 = e.clientY, nx = n.x, ny = n.y, z = scale;
    const move = (ev: PointerEvent) => setState((s) => ({ ...s, nodes: s.nodes.map((k) => (k.id === n.id ? { ...k, x: nx + (ev.clientX - x0) / z, y: ny + (ev.clientY - y0) / z } : k)) }));
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        setState((s) => ({ ...s, nodes: s.nodes.filter((n) => n.id !== selected), edges: s.edges.filter((x) => x.from !== selected && x.to !== selected) }));
        setSelected(null);
      }
      if (e.key === 'Escape') setMenu(false);
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [selected]);

  // ── Adding nodes ─────────────────────────────────────────────────────────
  const centre = () => {
    const el = board.current!;
    return { x: (el.clientWidth / 2 - view.x) / scale, y: (el.clientHeight / 2 - view.y) / scale };
  };
  const add = async (kind: NodeKind, extra: Partial<CanvasNode> = {}) => {
    setMenu(false);
    const [w, h] = NODE_SIZE[kind];
    const c = centre();
    const node: CanvasNode = { id: newId(), kind, x: c.x - w / 2 + (Math.random() - 0.5) * 60, y: c.y - h / 2 + (Math.random() - 0.5) * 60, w, h, ...extra };
    if (kind === 'world' && !node.worldId) {
      // Every World node is its own project file.
      const w = await api.createWorld({ title: `World ${state.nodes.filter((n) => n.kind === 'world').length + 1}` });
      node.worldId = w.id;
      node.title = w.title;
      setWorlds((m) => new Map(m ?? []).set(w.id, { id: w.id, title: w.title, createdAt: w.createdAt, updatedAt: w.updatedAt, coverUrl: null, sceneName: null, characters: 0, shots: 0, prompts: 0, lastPrompt: null, origin: w.origin }));
    }
    setState((s) => ({ ...s, nodes: [...s.nodes, node] }));
    setSelected(node.id);
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const onUpload = (file: File | undefined) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = () => void add('image', { src: String(r.result) });
    r.readAsDataURL(file);
  };

  const fit = () => {
    const el = board.current;
    if (!el || !state.nodes.length) return;
    const minX = Math.min(...state.nodes.map((n) => n.x)), maxX = Math.max(...state.nodes.map((n) => n.x + n.w));
    const minY = Math.min(...state.nodes.map((n) => n.y - 28)), maxY = Math.max(...state.nodes.map((n) => n.y + n.h));
    const fitted = Math.min((el.clientWidth - 240 * ui) / (maxX - minX), (el.clientHeight - 240 * ui) / (maxY - minY)) / ui;
    const zoom = Math.min(1.4, Math.max(0.25, fitted));
    const sc = zoom * ui;
    setState((s) => ({ ...s, view: { zoom, x: el.clientWidth / 2 - ((minX + maxX) / 2) * sc, y: el.clientHeight / 2 - ((minY + maxY) / 2) * sc } }));
  };

  const byId = new Map(state.nodes.map((n) => [n.id, n]));

  return (
    <div className="cv-root" style={{ '--cv-ui': ui } as React.CSSProperties}>
      <section className="cv-board" ref={board} onPointerDown={onBoardPointerDown}
        style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${22 * scale}px ${22 * scale}px` }}>
        <div className="cv-world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${scale})` }}>
          <svg className="cv-edges" width="1" height="1">
            {state.edges.map((e) => {
              const a = byId.get(e.from), b = byId.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2;
              const dx = Math.max(60, (x2 - x1) / 2);
              return <path key={`${e.from}-${e.to}`} d={`M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`} />;
            })}
          </svg>
          {state.nodes.map((n) => (
            <NodeView key={n.id} node={n} world={n.worldId ? worlds?.get(n.worldId) ?? (worlds ? null : undefined) : null} selected={selected === n.id} onPointerDown={(e) => onNodePointerDown(e, n)}
              onText={(text) => setState((s) => ({ ...s, nodes: s.nodes.map((k) => (k.id === n.id ? { ...k, text } : k)) }))} />
          ))}
        </div>

        {/* Top left: the project pill */}
        <div className="cv-float cv-top-left">
          <button className="cv-pill cv-project"><Logo size={30} /><span className="cv-divider" /><span>3D Studio 2.0</span><Icon name="chevronDown" size={16} /></button>
        </div>

        {/* Top right of the board */}
        <div className="cv-float cv-top-right">
          <button className="cv-pill cv-square" title="Apps"><Icon name="plug" size={20} /></button>
          <button className="cv-pill" title="Credits"><Icon name="credits" size={20} /><span>71</span></button>
          <button className="cv-pill" title="Community"><Icon name="users" size={20} /><span>Community</span></button>
          <button className="cv-pill cv-round" title="Share"><Icon name="share" size={20} /></button>
        </div>

        {/* Left rail */}
        <nav className="cv-float cv-rail">
          <button className={`cv-rail-plus ${menu ? 'open' : ''}`} onClick={() => setMenu((m) => !m)} title="Add">
            <Icon name={menu ? 'x' : 'plus'} size={24} />{!menu && <span className="cv-dot" />}
          </button>
          {(['search', 'copy', 'layout', 'chat', 'history'] as IconName[]).map((i) => (
            <button key={i} className="cv-rail-btn"><Icon name={i} size={22} /></button>
          ))}
          <span className="cv-rail-sep" />
          <span className="cv-avatar">m</span>
        </nav>

        {menu && (
          <div className="cv-float cv-menu">
            <MenuRow icon="upload" title="Upload" sub="Images / Video / Audio / 3D" hot onClick={() => fileInput.current?.click()} />
            <MenuRow icon="camera" title="Capture" onClick={() => setMenu(false)} />
            <div className="cv-menu-head">Add Nodes</div>
            <MenuRow icon="text" title="Text" onClick={() => void add('text', { text: '' })} />
            <MenuRow icon="image" title="Image" onClick={() => fileInput.current?.click()} />
            <MenuRow icon="video" title="Video" onClick={() => void add('video')} />
            <MenuRow icon="audio" title="Audio" dot onClick={() => setMenu(false)} />
            <MenuRow icon="box" title="3D" dot onClick={() => void add('3d')} />
            <MenuRow icon="globe" title="World" badge="New" dot onClick={() => void add('world')} />
            <div className="cv-menu-head">Utilities</div>
            <MenuRow icon="film" title="Timeline Editor" badge="Beta" dot onClick={() => setMenu(false)} />
            <MenuRow icon="previs" title="3D Studio" chevron dot onClick={() => void add('previs')} />
            <MenuRow icon="imageEdit" title="Image Editor" onClick={() => setMenu(false)} />
          </div>
        )}
        <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => { onUpload(e.target.files?.[0]); e.target.value = ''; }} />

        {/* Bottom left: board tools and zoom */}
        <div className="cv-float cv-bottom-left">
          <div className="cv-pill cv-tools">
            <button title="Select"><Icon name="cursorBox" size={20} /></button>
            <button title="Connect"><Icon name="curve" size={20} /></button>
            <button title="Snap"><Icon name="magnet" size={20} /></button>
            <button title="Fit to screen" onClick={fit}><Icon name="fullscreen" size={20} /></button>
            <input type="range" min={0.25} max={2} step={0.01} value={view.zoom}
              onChange={(e) => { const el = board.current!; zoomAt(Number(e.target.value), el.clientWidth / 2, el.clientHeight / 2); }} />
          </div>
          <button className="cv-pill cv-round cv-help" title="Help"><Icon name="help" size={22} /></button>
        </div>
      </section>

      <ChatPanel />
    </div>
  );
}

function MenuRow({ icon, title, sub, hot, dot, badge, chevron, onClick }: { icon: IconName; title: string; sub?: string; hot?: boolean; dot?: boolean; badge?: string; chevron?: boolean; onClick: () => void }) {
  return (
    <button className={`cv-menu-row ${hot ? 'hot' : ''}`} onClick={onClick}>
      <span className="cv-menu-tile"><Icon name={icon} size={19} />{dot && <span className="cv-dot sm" />}</span>
      <span className="cv-menu-text"><span>{title}{badge && <em className="cv-badge">{badge}</em>}</span>{sub && <small>{sub}</small>}</span>
      {chevron && <Icon name="chevronRight" size={16} className="cv-muted" />}
    </button>
  );
}

const KIND_ICON: Record<NodeKind, IconName> = { image: 'image', video: 'video', '3d': 'box', text: 'text', previs: 'previs', world: 'globe' };

/** `world`: the World node's project - undefined while loading, null when it is gone. */
function NodeView({ node: n, world, selected, onPointerDown, onText }: { node: CanvasNode; world: WorldSummary | null | undefined; selected: boolean; onPointerDown: (e: React.PointerEvent) => void; onText: (t: string) => void }) {
  return (
    <div className={`cv-node cv-${n.kind} ${selected ? 'selected' : ''}`} style={{ left: n.x, top: n.y, width: n.w, height: n.h }} onPointerDown={onPointerDown}
      onDoubleClick={() => { if (n.kind === 'world' && world) navigate(worldPath(world.id, n.id)); }}>
      <div className="cv-node-label">
        <Icon name={KIND_ICON[n.kind]} size={14} />
        {n.kind === 'image' ? <Icon name="focus" size={14} /> : <span>{NODE_LABEL[n.kind]}</span>}
      </div>
      {n.kind === 'image' && (n.src ? <img src={n.src} alt="" draggable={false} /> : <div className="cv-node-empty"><Icon name="image" size={22} /></div>)}
      {n.kind === 'video' && <div className="cv-node-empty"><Icon name="video" size={22} /></div>}
      {n.kind === '3d' && <div className="cv-node-empty"><Icon name="box" size={22} /></div>}
      {n.kind === 'text' && <textarea className="cv-node-text" placeholder="Write something…" value={n.text ?? ''} onChange={(e) => onText(e.target.value)} />}
      {n.kind === 'previs' && <div className="cv-node-empty cv-col"><Icon name="previs" size={20} /><span className="cv-mini-btn">Enter Studio</span></div>}
      {n.kind === 'world' && <WorldCard node={n} world={world} />}
    </div>
  );
}

/** The real node: a World project - its cover, what is in it, and the way into the 3D Studio. */
function WorldCard({ node, world }: { node: CanvasNode; world: WorldSummary | null | undefined }) {
  const enter = () => world && navigate(worldPath(world.id, node.id));
  const empty = world && !world.sceneName && !world.characters && !world.prompts;
  return (
    <div className="cv-world-card">
      {world?.coverUrl ? <img src={world.coverUrl} alt="" draggable={false} /> : <div className="cv-world-empty"><Icon name="globe" size={30} /></div>}
      <div className="cv-world-shade" />
      <div className="cv-world-info">
        <strong>{world === null ? 'World 已删除' : world?.title ?? node.title ?? 'World'}</strong>
        {world && (empty
          ? <small>新的 World · 进入后告诉 Agent 你想拍什么</small>
          : <small>{world.sceneName ?? '还没有场景'} · {world.characters} 个角色 · {world.shots} 个镜头</small>)}
        {world?.lastPrompt && <small className="cv-world-prompt">“{world.lastPrompt}”</small>}
      </div>
      <button className="cv-enter" disabled={!world} onClick={enter}>{empty ? '开始搭建' : 'Enter World'} <Icon name="arrowRight" size={14} /></button>
    </div>
  );
}

function ChatPanel() {
  const [text, setText] = useState('');
  const [messages, setMessages] = useState<Array<{ who: 'me' | 'agent'; text: string }>>([]);
  const [tip, setTip] = useState(true);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    setMessages((m) => [...m, { who: 'me', text: t }, { who: 'agent', text: '（演示画布）Agent 对话还没有接入。用左侧 ＋ → World 添加一个世界节点，点「Enter World」进入 3D 导演台。' }]);
    setText('');
  };
  return (
    <aside className="cv-chat">
      <header className="cv-chat-head">
        <Icon name="folder" size={22} />
        <strong>New chat</strong><Icon name="chevronDown" size={14} className="cv-muted" />
        <div className="cv-spacer" />
        <button className="cv-ghost"><Icon name="edit" size={20} /></button>
        <button className="cv-ghost"><Icon name="expand" size={20} /></button>
        <button className="cv-ghost"><Icon name="more" size={20} /></button>
      </header>
      <div className="cv-chat-body">
        {messages.length === 0 ? (
          <div className="cv-hello">
            <h2><Logo size={30} /> Hi there!</h2>
            <h1>What are we making today?</h1>
            <div className="cv-suggest">
              <button className="cv-card tilt-l" onClick={() => setText('Review this canvas and suggest the clearest next creative step.')}>
                <Icon name="bulb" size={20} /><Icon name="arrowRight" size={16} className="cv-card-arrow" />
                <strong>Find the next step</strong><span>Review this canvas and suggest the clearest next creative step.</span>
              </button>
              <button className="cv-card tilt-r" onClick={() => setText('Help me explore a few strong visual directions based on this project.')}>
                <Icon name="sparkle" size={20} /><Icon name="arrowRight" size={16} className="cv-card-arrow" />
                <strong>Explore visual ideas</strong><span>Help me explore a few strong visual directions based on this project.</span>
              </button>
            </div>
            <div className="cv-refresh"><Icon name="swap" size={16} /></div>
          </div>
        ) : (
          <div className="cv-messages">
            {messages.map((m, i) => <div key={i} className={`cv-msg ${m.who}`}>{m.text}</div>)}
          </div>
        )}
      </div>
      {tip && messages.length === 0 && (
        <div className="cv-tip"><span className="cv-tip-apps"><Icon name="globe" size={14} /></span>Use apps to extend Agent capabilities.<button className="cv-ghost sm" onClick={() => setTip(false)}><Icon name="x" size={14} /></button></div>
      )}
      <div className="cv-composer">
        <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Describe ideas, / use skills, add canvas content, @ add references or use Apps" />
        <div className="cv-composer-row">
          <button className="cv-pill cv-square sm"><Icon name="plus" size={18} /></button>
          <button className="cv-ghost cv-mode"><Icon name="hand" size={18} />Manual<Icon name="chevronDown" size={14} /></button>
          <div className="cv-spacer" />
          <span className="cv-ring" />
          <button className="cv-ghost cv-mode">Auto<Icon name="chevronDown" size={14} /></button>
          <button className="cv-ghost"><Icon name="mic" size={20} /></button>
          <button className={`cv-send ${text.trim() ? 'on' : ''}`} onClick={send}><Icon name="arrowUp" size={20} /></button>
        </div>
      </div>
    </aside>
  );
}

/** The board a first visit opens on: the shape of TapNow's 3D Studio canvas, plus a World. */
function seed(): CanvasState {
  const img: CanvasNode = { id: 'seed_img', kind: 'image', x: 140, y: 320, w: 230, h: 154 };
  const video: CanvasNode = { id: 'seed_video', kind: 'video', x: 460, y: 150, w: 190, h: 106 };
  const three: CanvasNode = { id: 'seed_3d', kind: '3d', x: 440, y: 400, w: 160, h: 106 };
  const previs: CanvasNode = { id: 'seed_previs', kind: 'previs', x: 700, y: 260, w: 160, h: 106 };
  const text: CanvasNode = { id: 'seed_text', kind: 'text', x: 140, y: 140, w: 220, h: 120, text: 'A rainy evening. Frodo walks in from the window, stops, turns to camera and waves.' };
  return {
    nodes: [text, img, video, three, previs],
    edges: [{ from: 'seed_text', to: 'seed_video' }, { from: 'seed_img', to: 'seed_3d' }],
    view: { x: 120, y: 60, zoom: 1 },
  };
}

/**
 * The canvas UI's scale: TapNow's proportions at any window size (its top
 * pills are about 5.6% of the window height, the Agent column about a quarter
 * of its width), so a small window shows the same layout, smaller. 1 at a
 * 1000 × 1600 window and up; never below 0.5, about where text stops being readable.
 */
function useUiScale(): number {
  const read = () => Math.min(1, Math.max(0.5, Math.min(innerHeight / 1000, innerWidth / 1600)));
  const [ui, setUi] = useState(read);
  useEffect(() => {
    const on = () => setUi(read());
    addEventListener('resize', on);
    return () => removeEventListener('resize', on);
  }, []);
  return ui;
}
