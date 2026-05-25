---
'@jenz-ai/openai-agents': patch
---

Capture assistant text into `llm_call` event `output` for both generation and
response spans (JEN-62).

`mapGeneration` and `mapResponse` previously built `finish` from `usage` only —
the model's actual response text was silently dropped, so events arrived at
the jenz API with empty `output` despite `outputTokens > 0`. This is the same
observability gap fixed in `@jenz-ai/claude-agent-sdk` for JEN-60.

The mappers now extract text from each span shape:

- Generation spans (chat-completions): walk `spanData.output[0].choices[i].message.{content,tool_calls}`.
- Response spans (Responses API): walk `spanData._response.output[i]` for
  `message`/`output_text` and `function_call` items.

Tool calls from either shape are normalised to a `{ type: 'tool_use', name }`
JSON blob so the dashboard's `outputPreview()` can render
"→ wants to call X" on ReAct-style intermediate steps that produced no text.
Output is clipped to 8000 chars.
