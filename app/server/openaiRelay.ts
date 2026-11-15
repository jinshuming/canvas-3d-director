/**
 * One streamed model turn, relayed to the OpenAI Responses API. The key stays
 * on the server; the page runs the tools and sends their results back as the
 * next turn's input, chained by previous_response_id. Shared by the director's
 * World agent and the scene generator's layout agent - only the instructions differ.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RelayConfig { apiKey?: string; base?: string; model: string; instructions: string }
export interface TurnBody { input: unknown; previous_response_id?: string; tools: unknown[]; tool_choice?: string }

const fail = (status: number, message: string) => Object.assign(new Error(message), { status });

export async function relayResponses(req: IncomingMessage, res: ServerResponse, cfg: RelayConfig | undefined, body: TurnBody): Promise<true> {
  if (!cfg?.apiKey) throw fail(503, 'OPENAI_API_KEY is not set on the server.');
  const upstream = await fetch(`${cfg.base ?? 'https://api.openai.com/v1'}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      instructions: cfg.instructions,
      input: body.input,
      tools: body.tools,
      ...(body.tool_choice ? { tool_choice: body.tool_choice } : {}),
      ...(body.previous_response_id ? { previous_response_id: body.previous_response_id } : {}),
      store: true,
      stream: true,
    }),
  });
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    let msg = `OpenAI ${upstream.status}`;
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not JSON */ }
    // Our key refused is a server problem (502), not the page's.
    throw fail(upstream.status === 401 ? 502 : upstream.status, msg);
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  const reader = upstream.body.getReader();
  req.on('close', () => { void reader.cancel().catch(() => {}); });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(value);
  }
  res.end();
  return true;
}
