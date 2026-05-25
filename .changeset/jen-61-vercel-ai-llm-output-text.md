---
'@jenz-ai/vercel-ai': patch
---

Capture assistant text into `llm_call` event `output` (JEN-61).

The middleware previously forwarded only token usage from `doGenerate()` and
`doStream()` into the event finish payload, so events arrived at the jenz API
with empty `output` despite `outputTokens > 0` — the same observability gap
JEN-60 closed for `@jenz-ai/claude-agent-sdk`.

The fix extracts text + tool-call blocks from
`LanguageModelV3GenerateResult.content` (non-streaming) and accumulates
`text-delta` + `tool-call` chunks in the streaming TransformStream, then sets
`finish.output`. Tool-call blocks are JSON-stringified in the Anthropic
`tool_use` shape so the dashboard's outputPreview() can render
"→ wants to call X" on ReAct-style intermediate steps that produced no text.
Output is clipped to 8000 chars, mirroring the helper already used by
`@jenz-ai/anthropic-sdk` and `@jenz-ai/claude-agent-sdk`.
