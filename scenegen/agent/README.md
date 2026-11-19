# scenegen/agent — the layout agent

Edits the **blockout** by conversation ("move the sofa to the east wall", "add a floor lamp left of it"). Not part of
the one-shot text → scene path (that is `server/quickLayout.ts`); it is what the scene editor's chat column and
`/scenegen/` use afterwards, and it can also trigger generation.

| File | Responsibility |
|---|---|
| `prompt.ts` | `SCENEGEN_INSTRUCTIONS`: the system prompt (blockout → style → capture point → generate; world axes; relations) |
| `tools.ts` | The tools (`get_layout`, `set_room`, `place_objects`, `update_object`, `look`, `choose_capture_point`, `generate_scene`, …). They mutate the in-memory `Layout` via `core/layout.ts` and reach the server only through an injected `host` (renders, capture search, generation) |
| `loop.ts` | `runAgentTurn`: user message → model turns → tool calls → … until the model stops. `respond` is injected: in the page it POSTs to `/scenegen/api/agent/respond` (the server relays to OpenAI Responses, keeping the key), in tests it is a fake |

The host that connects tools to a project's HTTP API is `web/agentHost.ts` (shared by the test page, the canvas
scene editor and `eval/e2e.mts`).
