/**
 * The layout agent's loop: one user message → model turns until it stops
 * calling tools. The server relays each turn to the OpenAI Responses API
 * (it holds the key); tools run here. `respond` is injectable so the loop runs
 * in the page (fetch to /scenegen/api/agent/respond) and in Node tests.
 */
import type { AgentHost } from './tools.ts';
import { OPENAI_TOOLS, runTool } from './tools.ts';

export type ChatItem =
  | { role: 'user'; text: string; image?: string }
  | { role: 'assistant'; text: string }
  | { role: 'tool'; name: string; args: Record<string, unknown>; text: string; image?: string; isError?: boolean };

interface ModelResponse { id: string; output: Array<{ type: string; name?: string; arguments?: string; call_id?: string; content?: Array<{ type: string; text?: string }> }>; usage?: { input_tokens: number; output_tokens: number } }

export type Respond = (body: unknown, signal?: AbortSignal) => Promise<Response>;

export const MAX_STEPS = 24;

export async function readStream(res: Response, onText?: (d: string) => void): Promise<ModelResponse> {
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
      const ev = JSON.parse(data) as { type: string; delta?: string; response?: ModelResponse & { error?: { message?: string } }; message?: string };
      if (ev.type === 'response.output_text.delta' && ev.delta) onText?.(ev.delta);
      else if (ev.type === 'response.completed' && ev.response) done = ev.response;
      else if (ev.type === 'response.failed' || ev.type === 'error') throw new Error(ev.response?.error?.message ?? ev.message ?? 'The model failed.');
    }
  }
  if (!done) throw new Error('The model stream ended early.');
  return done;
}

export interface TurnStats { steps: number; toolCalls: number; toolErrors: number; tools: string[]; inputTokens: number; outputTokens: number }

/**
 * Run one user message. `previousId` chains to the last response of the chat;
 * returns the new one to keep. `emit` receives every chat item as it happens.
 */
export async function runAgentTurn(text: string, host: AgentHost, opts: { respond: Respond; previousId?: string | null; emit: (item: ChatItem) => void; onText?: (delta: string) => void; signal?: AbortSignal; images?: string[] }): Promise<{ previousId: string; stats: TurnStats }> {
  const stats: TurnStats = { steps: 0, toolCalls: 0, toolErrors: 0, tools: [], inputTokens: 0, outputTokens: 0 };
  let previousId = opts.previousId ?? null;
  const pictures = opts.images ?? [];
  // A picture from the user is the scene to rebuild: say so, so the model lays it out from the picture.
  const lead = !pictures.length ? text : pictures.length === 1
    ? `${text || 'Build this place.'}\n\n[The attached picture is the place to build: read its layout - the room or ground, every major object, where each stands and faces, and their sizes - and lay out the blockout to match it from a similar viewpoint. Take the style from it too.]`
    : `${text || 'Build this place.'}\n\n[The ${pictures.length} attached pictures are frames of ONE walkthrough video of the place to build, in time order. The camera moves, so the same object appears in several frames from different sides: merge them into one layout - the room or ground, every major object once, where each stands and faces, their sizes, and how they relate (what is next to, in front of, on what). Take the style from them too.]`;
  let input: unknown[] = [{ role: 'user', content: [{ type: 'input_text', text: lead }, ...pictures.map((u) => ({ type: 'input_image', image_url: u }))] }];
  opts.emit({ role: 'user', text: text || '(picture)', ...(pictures[0] ? { image: pictures[0] } : {}) });
  for (let step = 0; step < MAX_STEPS; step++) {
    const last = step === MAX_STEPS - 1;
    const res = await opts.respond({ input, previous_response_id: previousId ?? undefined, tools: OPENAI_TOOLS, ...(last ? { tool_choice: 'none' } : {}) }, opts.signal);
    const r = await readStream(res, opts.onText);
    stats.steps++;
    stats.inputTokens += r.usage?.input_tokens ?? 0;
    stats.outputTokens += r.usage?.output_tokens ?? 0;
    previousId = r.id;
    const calls = r.output.filter((o) => o.type === 'function_call');
    const said = r.output.filter((o) => o.type === 'message').flatMap((o) => o.content ?? []).filter((c) => c.type === 'output_text').map((c) => c.text ?? '').join('').trim();
    if (said) opts.emit({ role: 'assistant', text: said });
    if (!calls.length) break;
    input = [];
    const images: string[] = [];
    for (const c of calls) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(c.arguments ?? '{}') as Record<string, unknown>; } catch { /* model sent bad JSON */ }
      const out = await runTool(c.name!, args, host);
      stats.toolCalls++;
      stats.tools.push(c.name!);
      if (out.isError) stats.toolErrors++;
      opts.emit({ role: 'tool', name: c.name!, args, text: out.text, ...(out.image ? { image: out.image } : {}), ...(out.isError ? { isError: true } : {}) });
      input.push({ type: 'function_call_output', call_id: c.call_id, output: out.isError ? `ERROR: ${out.text}` : out.text });
      if (out.image) images.push(out.image);
    }
    // Pictures go back as a user message after the tool outputs.
    if (images.length) input.push({ role: 'user', content: images.map((u) => ({ type: 'input_image', image_url: u })) });
  }
  return { previousId: previousId!, stats };
}
