import { useMemo, useState } from 'react';

import type { StageToolHost, ToolResult } from '@stage';
import { runStageTool, STAGE_TOOLS } from '@stage';

import { Icon } from './icons.tsx';

/** Starter inputs, so each tool can be tried in one click. */
const EXAMPLES: Record<string, Record<string, unknown>> = {
  get_stage: { time: 0 },
  get_world_layout: { radius: 5, step: 0.5 },
  look: { view: 'top_down' },
  check_framing: { shot_id: '' },
  contact_sheet: { shot_id: '', frames: 6 },
  probe_floor: { points: [[0, -2], [1.5, -3]] },
  list_assets: { kind: 'motion' },
  generate_asset: { kind: 'motion', prompt: 'sits down on a chair', seconds: 4 },
  check_jobs: {},
  set_scene: { scene: 'Modern living room' },
  set_timeline: { duration: 10, aspect: '16:9' },
  add_character: { asset: 'Frodo', position: [0, -2.5], face: 'camera' },
  update_character: { character: 'Frodo', face: [1, -3] },
  remove_character: { character: 'Frodo' },
  set_motion_sequence: { character: 'Frodo', sequence: [{ motion: 'Wave' }, { motion: 'Nod', gap: 0.3 }] },
  add_motion: { character: 'Frodo', motion: 'Cheer', start: 'after_last' },
  edit_motion_clip: { character: 'Frodo', clip_id: '', loop: true },
  move_character: { character: 'Frodo', start: 4, to: [1.5, -3], gait: 'walk', end_face: 'camera' },
  clear_moves: { character: 'Frodo' },
  add_shot: { name: 'Shot A' },
  frame_shot: { shot_id: '', subject: 'Frodo', size: 'medium', angle: 'eye_level', side: 'three_quarter_left', time: 0 },
  camera_move: { shot_id: '', kind: 'push_in', subject: 'Frodo', size: 'full', to_size: 'medium_close', start: 0, end: 4 },
  set_camera_keys: { shot_id: '', keys: [{ t: 0, position: [2, 1.6, 0], look_at: 'Frodo', fov: 40 }] },
  edit_shot: { shot_id: '', easing: 'easeInOut' },
  preview: { shot_id: '', time: 0, play: true },
  undo: {},
  export_shot: { shot_id: '', format: 'png', time: 0 },
};

const EFFECT_LABEL = { read: '只读', edit: '编辑', cost: '消耗额度', ui: '界面' } as const;

/**
 * The agent's tools, by hand: pick one, edit its JSON input, run it, see what
 * an agent would get back (text and pictures). The bench the agent mode is
 * built on.
 */
export function ToolConsole({ host, shotId }: { host: StageToolHost; shotId: string | null }) {
  const [name, setName] = useState('get_world_layout');
  const tool = STAGE_TOOLS.find((t) => t.name === name)!;
  const example = useMemo(() => fill(EXAMPLES[name] ?? {}, shotId), [name, shotId]);
  const [input, setInput] = useState(() => JSON.stringify(example, null, 1));
  const [result, setResult] = useState<ToolResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState(0);

  const pick = (n: string) => {
    setName(n);
    setInput(JSON.stringify(fill(EXAMPLES[n] ?? {}, shotId), null, 1));
    setResult(null);
  };

  const run = async () => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(input || '{}') as Record<string, unknown>; } catch {
      setResult({ content: [{ type: 'text', text: '输入不是合法的 JSON' }], is_error: true });
      return;
    }
    if (tool.effect === 'cost' && !confirm('这个工具会消耗 Viggle 额度，继续吗？')) return;
    setBusy(true);
    const t0 = performance.now();
    setResult(await runStageTool(name, parsed, host));
    setMs(Math.round(performance.now() - t0));
    setBusy(false);
  };

  return (
    <div className="composer tool-console">
      <div className="console-head">
        <Icon name="sparkle" size={16} />
        <strong>Agent 工具台</strong>
        <span className="muted small">{STAGE_TOOLS.length} 个工具 · 手动调用即 Agent 视角</span>
      </div>
      <label className="pill select-pill console-select">
        <select value={name} onChange={(e) => pick(e.target.value)}>
          {(['read', 'edit', 'cost', 'ui'] as const).map((eff) => (
            <optgroup key={eff} label={EFFECT_LABEL[eff]}>
              {STAGE_TOOLS.filter((t) => t.effect === eff).map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
            </optgroup>
          ))}
        </select>
        <Icon name="chevronDown" size={14} />
      </label>
      <p className="muted small tool-desc">{tool.description}</p>
      <textarea className="mono console-input" rows={5} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
      <div className="composer-row">
        <span className={`effect ${tool.effect}`}>{EFFECT_LABEL[tool.effect]}</span>
        {result && <span className="muted small">{ms} ms</span>}
        <div className="spacer" />
        <button className="send run" disabled={busy} onClick={() => void run()} title="运行"><Icon name={busy ? 'loop' : 'play'} size={15} /></button>
      </div>
      {result && (
        <div className={`console-result ${result.is_error ? 'error' : ''}`}>
          {result.content.map((c, i) => (c.type === 'image'
            ? <img key={i} src={`data:${c.source.media_type};base64,${c.source.data}`} alt="" />
            : <pre key={i}>{pretty(c.text)}</pre>))}
        </div>
      )}
    </div>
  );
}

/** Put the active shot into an example's empty shot_id. */
function fill(example: Record<string, unknown>, shotId: string | null): Record<string, unknown> {
  return 'shot_id' in example && example.shot_id === '' ? { ...example, shot_id: shotId ?? '' } : example;
}

function pretty(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 1); } catch { return text; }
}
