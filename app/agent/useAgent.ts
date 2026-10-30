import { useCallback, useEffect, useRef, useState } from 'react';

import type { StageToolHost, ToolResult } from '@stage';
import { runStageTool, STAGE_TOOLS } from '@stage';

/** One line in the chat. */
export type ChatItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; streaming?: boolean }
  | { kind: 'tool'; id: string; name: string; args: string; status: 'running' | 'done' | 'error'; result?: string; image?: string }
  | { kind: 'confirm'; id: string; text: string; answer?: boolean }
  | { kind: 'error'; id: string; text: string };

/** What one user turn cost, for the evaluation and the usage ring. */
export interface TurnStats {
  steps: number;
  toolCalls: number;
  toolErrors: number;
  tools: string[];
  ms: number;
  inputTokens: number;
  outputTokens: number;
}

interface Saved { items: ChatItem[]; previousId: string | null }

/** Model turns per request. Near the end the agent is told to wrap up; the last turn may not call tools. */
const MAX_STEPS = 24;
const WRAP_UP_AT = MAX_STEPS - 5;
const OPENAI_TOOLS = STAGE_TOOLS.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.input_schema }));
const uid = () => Math.random().toString(36).slice(2, 10);

/**
 * The World agent's loop, in the page: the server relays each model turn
 * (it holds the key); every tool runs here, on the live stage and renderer,
 * and its result - pictures included - goes back as the next turn's input.
 */
export function useAgent(stageId: string, host: StageToolHost, context: () => string) {
  const key = `viggle-director:chat:${stageId}`;
  const [items, setItems] = useState<ChatItem[]>(() => load(key).items);
  const [busy, setBusy] = useState(false);
  const [lastTurn, setLastTurn] = useState<TurnStats | null>(null);
  const previousId = useRef<string | null>(load(key).previousId);
  const abort = useRef<AbortController | null>(null);
  const confirms = useRef(new Map<string, (ok: boolean) => void>());

  useEffect(() => { save(key, { items, previousId: previousId.current }); }, [key, items]);

  const patch = (id: string, p: Partial<ChatItem>) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...p } as ChatItem : x)));
  const push = (item: ChatItem) => setItems((xs) => [...xs, item]);

  const confirm = (text: string) => new Promise<boolean>((resolve) => {
    const id = uid();
    confirms.current.set(id, resolve);
    push({ kind: 'confirm', id, text });
  });
  const answer = useCallback((id: string, ok: boolean) => {
    confirms.current.get(id)?.(ok);
    confirms.current.delete(id);
    patch(id, { answer: ok });
  }, []);

  const send = useCallback(async (text: string): Promise<TurnStats | null> => {
    const t = text.trim();
    if (!t || busy) return null;
    setBusy(true);
    const ctl = new AbortController();
    abort.current = ctl;
    push({ kind: 'user', id: uid(), text: t });
    const stats: TurnStats = { steps: 0, toolCalls: 0, toolErrors: 0, tools: [], ms: 0, inputTokens: 0, outputTokens: 0 };
    const t0 = performance.now();
    let input: unknown[] = [{ role: 'user', content: [{ type: 'input_text', text: `${context()}\n\n${t}` }] }];
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        stats.steps++;
        const replyId = uid();
        let replyStarted = false;
        const last = step === MAX_STEPS - 1;
        const response = await streamTurn(input, previousId.current, ctl.signal, last, (delta) => {
          if (!replyStarted) { replyStarted = true; push({ kind: 'assistant', id: replyId, text: delta, streaming: true }); } else {
            setItems((xs) => xs.map((x) => (x.id === replyId && x.kind === 'assistant' ? { ...x, text: x.text + delta } : x)));
          }
        });
        if (replyStarted) patch(replyId, { streaming: false });
        previousId.current = response.id;
        stats.inputTokens += response.usage?.input_tokens ?? 0;
        stats.outputTokens += response.usage?.output_tokens ?? 0;
        const calls = (response.output ?? []).filter((o): o is FunctionCall => o.type === 'function_call');
        if (!calls.length) break;
        const outputs: unknown[] = [];
        for (const call of calls) {
          if (ctl.signal.aborted) throw new DOMException('Stopped', 'AbortError');
          const id = uid();
          push({ kind: 'tool', id, name: call.name, args: call.arguments, status: 'running' });
          stats.toolCalls++;
          stats.tools.push(call.name);
          let args: Record<string, unknown> = {};
          let result: ToolResult;
          try { args = JSON.parse(call.arguments || '{}') as Record<string, unknown>; } catch { /* the tool reports the bad input */ }
          const tool = STAGE_TOOLS.find((x) => x.name === call.name);
          if (tool?.effect === 'cost' && !(await confirm(costText(args)))) {
            result = { content: [{ type: 'text', text: 'The user declined to spend credits on this. Use an existing asset instead.' }], is_error: true };
          } else {
            result = await runStageTool(call.name, args, host);
          }
          if (result.is_error) stats.toolErrors++;
          const textOut = result.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
          const img = result.content.find((c) => c.type === 'image') as { source: { media_type: string; data: string } } | undefined;
          patch(id, { status: result.is_error ? 'error' : 'done', result: textOut, image: img ? `data:${img.source.media_type};base64,${img.source.data}` : undefined });
          outputs.push({
            type: 'function_call_output',
            call_id: call.call_id,
            output: img
              ? [{ type: 'input_text', text: (result.is_error ? 'ERROR: ' : '') + textOut }, { type: 'input_image', image_url: `data:${img.source.media_type};base64,${img.source.data}` }]
              : (result.is_error ? 'ERROR: ' : '') + textOut,
          });
        }
        if (step + 1 >= WRAP_UP_AT) {
          outputs.push({ role: 'user', content: [{ type: 'input_text', text: `[System] ${MAX_STEPS - step - 1} turns left in this request. Stop editing now: preview the main shot if you have not, then reply to the user with what you built and what is left.` }] });
        }
        input = outputs;
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') push({ kind: 'error', id: uid(), text: '已停止。' });
      else push({ kind: 'error', id: uid(), text: e instanceof Error ? e.message : String(e) });
      // A turn cut off mid tool-call cannot be continued from: start the next one fresh.
      previousId.current = null;
    } finally {
      stats.ms = Math.round(performance.now() - t0);
      setLastTurn(stats);
      setBusy(false);
      abort.current = null;
      for (const resolve of confirms.current.values()) resolve(false);
      confirms.current.clear();
    }
    return stats;
  }, [busy, host, context]);

  const stop = useCallback(() => abort.current?.abort(), []);
  const reset = useCallback(() => {
    abort.current?.abort();
    previousId.current = null;
    setItems([]);
    setLastTurn(null);
  }, []);

  return { items, busy, send, stop, reset, answer, lastTurn };
}

interface FunctionCall { type: 'function_call'; name: string; arguments: string; call_id: string }
interface ModelResponse { id: string; output?: Array<{ type: string } & Partial<FunctionCall>>; usage?: { input_tokens: number; output_tokens: number }; error?: { message?: string } | null }

/** One model turn through the server, streaming text deltas; resolves with the finished response. */
async function streamTurn(input: unknown[], previousId: string | null, signal: AbortSignal, noTools: boolean, onText: (delta: string) => void): Promise<ModelResponse> {
  const res = await fetch('/api/agent/respond', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, previous_response_id: previousId ?? undefined, tools: OPENAI_TOOLS, ...(noTools ? { tool_choice: 'none' } : {}) }),
  });
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(body?.error?.message ?? `Agent request failed (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let done: ModelResponse | null = null;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!data || data === '[DONE]') continue;
      const ev = JSON.parse(data) as { type: string; delta?: string; response?: ModelResponse; message?: string };
      if (ev.type === 'response.output_text.delta' && ev.delta) onText(ev.delta);
      else if (ev.type === 'response.completed' && ev.response) done = ev.response;
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message ?? ev.message ?? 'The model failed.');
    }
  }
  if (!done) throw new Error('The model stream ended early.');
  return done;
}

function costText(args: Record<string, unknown>): string {
  const credits = { scene: 6, character: 30, motion: 10 }[String(args.kind)] ?? '?';
  const what = { scene: '场景', character: '角色', motion: '动作' }[String(args.kind)] ?? '素材';
  const detail = String(args.prompt ?? args.image_url ?? '');
  return `Agent 想生成一个${what}${detail ? `：「${detail.slice(0, 80)}」` : ''}，会消耗 ${credits} 额度。`;
}

function load(key: string): Saved {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as Saved;
  } catch { /* fresh */ }
  return { items: [], previousId: null };
}

function save(key: string, s: Saved): void {
  try {
    // Pictures stay out of storage; the transcript keeps the words. Unanswered confirms cannot survive a reload.
    const items = s.items.filter((x) => x.kind !== 'confirm' || x.answer !== undefined).map((x) => (x.kind === 'tool' ? { ...x, image: undefined, status: x.status === 'running' ? 'error' as const : x.status } : x));
    localStorage.setItem(key, JSON.stringify({ items, previousId: s.previousId }));
  } catch { /* full or private: not remembered */ }
}
