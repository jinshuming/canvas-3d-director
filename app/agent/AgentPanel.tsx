import { useEffect, useRef, useState } from 'react';

import type { IconName } from '../icons.tsx';
import { Icon } from '../icons.tsx';
import { AGENT_SUGGESTIONS, WORLD_STARTERS } from '../shared/agentPrompt.ts';
import '../canvas/canvas.css';
import './agent.css';
import type { ChatItem, TurnStats } from './useAgent.ts';

/** How each tool reads in the transcript. */
const TOOL_LABEL: Record<string, string> = {
  get_stage: '查看片场', get_world_layout: '查看地面布局', look: '观察画面', check_framing: '检查构图', contact_sheet: '生成联系表', probe_floor: '探测地面',
  list_assets: '浏览素材', generate_asset: '生成素材', check_jobs: '查看生成进度', wait_for_jobs: '等待生成完成', find_scene_gaps: '检测场景瑕疵', fill_scene_view: '补全场景视角', set_scene: '设置场景', set_timeline: '设置时间轴',
  add_character: '添加角色', update_character: '调整角色', remove_character: '移除角色', set_motion_sequence: '编排动作', add_motion: '添加动作',
  edit_motion_clip: '调整动作片段', move_character: '设计走位', clear_moves: '清除走位', add_shot: '新建镜头', frame_shot: '架设机位',
  camera_move: '设计运镜', set_camera_keys: '设置相机关键帧', edit_shot: '调整镜头', preview: '预览给你看', undo: '撤销', export_shot: '导出镜头',
};

interface Props {
  items: ChatItem[];
  busy: boolean;
  model: string | null;
  lastTurn: TurnStats | null;
  /** The world is empty: greet with starters that build a scene from nothing. */
  fresh?: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onReset: () => void;
  onAnswer: (id: string, ok: boolean) => void;
  /** The tool bench, behind the "…" menu. */
  bench?: React.ReactNode;
  /** How this agent's tools read in the transcript, over the director's own labels. */
  toolLabels?: Record<string, string>;
  /** What a running group of steps says (default: the director's). */
  workingLabel?: string;
  /** The empty chat, instead of the director's greeting. */
  hello?: React.ReactNode;
  /** More controls in the composer row (the scene editor's 生成场景). */
  actions?: React.ReactNode;
  /** The input box's placeholder. */
  placeholder?: string;
}

export function AgentPanel({ items, busy, model, lastTurn, fresh = false, onSend, onStop, onReset, onAnswer, bench, toolLabels, workingLabel, hello, actions, placeholder }: Props) {
  const [text, setText] = useState('');
  const [wide, setWide] = useState(false);
  const [showBench, setShowBench] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  // A new world is built by talking: the cursor starts in the box.
  useEffect(() => { if (fresh && model) box.current?.focus(); }, [fresh, model]);
  const title = items.find((i) => i.kind === 'user')?.text;

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  const send = () => {
    if (!text.trim() || busy || !model) return;
    onSend(text);
    setText('');
  };

  return (
    <aside className={`cv-chat ag-panel ${wide ? 'wide' : ''}`}>
      <header className="cv-chat-head">
        <Icon name="folder" size={22} />
        <strong className="ag-title">{title ? title.slice(0, 18) + (title.length > 18 ? '…' : '') : 'New chat'}</strong><Icon name="chevronDown" size={14} className="cv-muted" />
        <div className="cv-spacer" />
        <button className="cv-ghost" title="新对话" onClick={onReset}><Icon name="edit" size={20} /></button>
        <button className="cv-ghost" title={wide ? '收窄' : '加宽'} onClick={() => setWide((w) => !w)}><Icon name="expand" size={20} /></button>
        {bench && <button className={`cv-ghost ${showBench ? 'on' : ''}`} title="工具台（手动调用 Agent 工具）" onClick={() => setShowBench((b) => !b)}><Icon name="more" size={20} /></button>}
      </header>

      {showBench ? <div className="ag-bench">{bench}</div> : (
        <div className="cv-chat-body ag-body" ref={scroller}>
          {items.length === 0 && hello ? <div className="cv-hello">{hello}</div> : items.length === 0 ? (
            <div className="cv-hello">
              {fresh ? (
                <>
                  <h2>新的 World</h2>
                  <h1>想拍一场什么样的戏？</h1>
                  <p className="ag-lead">描述人物、地点、动作和镜头，我来选场景、放角色、编排动作、架好机位，做完给你预览。</p>
                </>
              ) : (
                <>
                  <h2>Hi there!</h2>
                  <h1>What are we making today?</h1>
                </>
              )}
              <div className={`ag-suggest ${fresh ? 'starters' : ''}`}>
                {(fresh ? WORLD_STARTERS : AGENT_SUGGESTIONS).map((s, i) => (
                  <button key={s.title} className={`cv-card ${fresh ? '' : i % 2 ? 'tilt-r' : 'tilt-l'}`} disabled={fresh && !model}
                    onClick={() => (fresh && model ? onSend(s.prompt) : setText(s.prompt))}>
                    <span className="ag-card-head"><Icon name={s.icon as IconName} size={20} /><strong>{s.title}</strong></span>
                    <span>{s.prompt}</span>
                    <Icon name="arrowRight" size={16} className="cv-card-arrow" />
                  </button>
                ))}
              </div>
              {!model && <p className="ag-warn">服务端没有设置 OPENAI_API_KEY，Agent 不可用。</p>}
            </div>
          ) : (
            <div className="ag-thread">
              {group(items).map((g) => (g.kind === 'tools'
                ? <ToolGroup key={g.items[0]!.id} tools={g.items} open={busy && g.last} onZoom={setZoom} labels={toolLabels} working={workingLabel} />
                : <Line key={g.item.id} item={g.item} onAnswer={onAnswer} />))}
              {busy && !items.some((i) => i.kind === 'assistant' && i.streaming) && <div className="ag-thinking"><span /><span /><span /></div>}
              {!busy && lastTurn && <div className="ag-stats">{lastTurn.toolCalls} 次工具调用 · {(lastTurn.ms / 1000).toFixed(1)}s · {Math.round((lastTurn.inputTokens + lastTurn.outputTokens) / 1000)}k tokens</div>}
            </div>
          )}
        </div>
      )}

      <div className="cv-composer">
        <textarea ref={box} rows={2} value={text} disabled={!model} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
          placeholder={model ? placeholder ?? (fresh && !items.length ? '描述你想搭的场景…' : 'Type anything') : 'Agent 未配置'} />
        <div className="cv-composer-row">
          <button className="cv-pill cv-square sm" title="添加参考（即将支持）"><Icon name="plus" size={18} /></button>
          <button className="cv-ghost" title="手动模式：每次由你发起"><Icon name="hand" size={20} /></button>
          <div className="cv-spacer" />
          <span className="cv-ring" title={lastTurn ? `上一轮 ${lastTurn.inputTokens + lastTurn.outputTokens} tokens` : ''} />
          {actions}
          <span className="cv-ghost ag-model" title={model ?? ''}><Icon name="sparkle" size={18} /></span>
          <button className="cv-ghost" title="语音（即将支持）"><Icon name="mic" size={20} /></button>
          {busy
            ? <button className="cv-send on" onClick={onStop} title="停止"><span className="ag-stop" /></button>
            : <button className={`cv-send ${text.trim() ? 'on' : ''}`} onClick={send} title="发送"><Icon name="arrowUp" size={20} /></button>}
        </div>
      </div>
      {zoom && <div className="ag-zoom" onClick={() => setZoom(null)}><img src={zoom} alt="" /></div>}
    </aside>
  );
}

type Group = { kind: 'line'; item: ChatItem } | { kind: 'tools'; items: Extract<ChatItem, { kind: 'tool' }>[]; last: boolean };

/** Runs of tool calls fold into one block. */
function group(items: ChatItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    const prev = out[out.length - 1];
    if (it.kind === 'tool' && prev?.kind === 'tools') prev.items.push(it);
    else if (it.kind === 'tool') out.push({ kind: 'tools', items: [it], last: false });
    else out.push({ kind: 'line', item: it });
  }
  const lastTools = [...out].reverse().find((g) => g.kind === 'tools');
  if (lastTools && lastTools.kind === 'tools' && out[out.length - 1] === lastTools) lastTools.last = true;
  return out;
}

function Line({ item, onAnswer }: { item: ChatItem; onAnswer: (id: string, ok: boolean) => void }) {
  if (item.kind === 'user') return <div className="cv-msg me">{item.text}</div>;
  if (item.kind === 'assistant') return <div className="cv-msg agent ag-reply">{rich(item.text)}{item.streaming && <span className="ag-caret" />}</div>;
  if (item.kind === 'error') return <div className="ag-error">{item.text}</div>;
  if (item.kind === 'confirm') {
    return (
      <div className="ag-confirm">
        <span>{item.text}</span>
        {item.answer === undefined
          ? <div className="ag-confirm-row"><button className="cv-enter" onClick={() => onAnswer(item.id, true)}>确认生成</button><button className="cv-ghost" onClick={() => onAnswer(item.id, false)}>不用了</button></div>
          : <small className="cv-muted">{item.answer ? '已确认' : '已拒绝'}</small>}
      </div>
    );
  }
  return null;
}

function ToolGroup({ tools, open, onZoom, labels, working }: { tools: Extract<ChatItem, { kind: 'tool' }>[]; open: boolean; onZoom: (src: string) => void; labels?: Record<string, string>; working?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const running = tools.some((t) => t.status === 'running');
  const errors = tools.filter((t) => t.status === 'error').length;
  const shown = expanded || open ? tools : tools.slice(-2);
  const images = tools.filter((t) => t.image);
  return (
    <div className="ag-tools">
      <button className="ag-tools-head" onClick={() => setExpanded((e) => !e)}>
        <span className={`ag-spin ${running ? 'on' : ''}`}><Icon name={running ? 'loop' : 'sparkle'} size={14} /></span>
        <span>{running ? working ?? '正在操作片场…' : `执行了 ${tools.length} 步操作`}{errors ? <em> · {errors} 步出错后已调整</em> : null}</span>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} className="cv-muted" />
      </button>
      {!expanded && !open && tools.length > 2 && <div className="ag-more">… 还有 {tools.length - 2} 步</div>}
      {shown.map((t) => (
        <div key={t.id} className={`ag-tool ${t.status}`}>
          <button className="ag-tool-row" onClick={() => setDetail((d) => (d === t.id ? null : t.id))}>
            <span className="ag-dot" />
            <span className="ag-tool-name">{labels?.[t.name] ?? TOOL_LABEL[t.name] ?? t.name}</span>
            <span className="ag-tool-args">{brief(t.args)}</span>
          </button>
          {detail === t.id && <pre className="ag-tool-detail">{t.name}({pretty(t.args)}){'\n→ '}{(t.result ?? '…').slice(0, 1500)}</pre>}
        </div>
      ))}
      {images.length > 0 && (
        <div className="ag-shots">{images.slice(-3).map((t) => <img key={t.id} src={t.image} alt="" onClick={() => onZoom(t.image!)} />)}</div>
      )}
    </div>
  );
}

/** Bold and line breaks - all the formatting replies use. */
function rich(text: string): React.ReactNode {
  return text.split('\n').map((line, i) => (
    <p key={i}>{line.split(/(\*\*[^*]+\*\*)/).map((part, j) => (part.startsWith('**') && part.endsWith('**') ? <strong key={j}>{part.slice(2, -2)}</strong> : part.replace(/^[-*] /, '• ')))}</p>
  ));
}

function brief(args: string): string {
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    const pick = ['character', 'asset', 'motion', 'kind', 'view', 'subject', 'size', 'side', 'scene', 'shot_id', 'message', 'id', 'wall', 'title', 'summary'].filter((k) => a[k] !== undefined).map((k) => (typeof a[k] === 'string' ? a[k] : JSON.stringify(a[k])));
    return pick.join(' · ').slice(0, 48);
  } catch { return ''; }
}

function pretty(args: string): string {
  try { return JSON.stringify(JSON.parse(args)); } catch { return args; }
}
