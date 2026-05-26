# @jenz-ai/openai-agents

## 0.1.2

### Patch Changes

- 851893b: Capture assistant text into `llm_call` event `output` for both generation and
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

## 0.1.1

### Patch Changes

- 85c42df: fix: harvest toolsAvailable from function spans, not agent spans

  The real @openai/agents-core SDK emits agent spans with `tools: []` on
  onSpanStart, so the prior agent-span-based harvest never captured anything.
  Now we also pull tool names from each function span as it starts, which
  reflects actually-invoked tools and works against the real SDK shape.

## 0.1.0

### Minor Changes

- feat: initial release — Jenz observability adapter for OpenAI Agents SDK

  Tracing-processor-based adapter for @openai/agents v0.11+. One setup call
  (setupJenz()) installs a TracingProcessor that maps every SDK span (LLM
  call, tool call, handoff, guardrail) to a Jenz event. Optional withRun()
  wrapper for explicit per-run metadata + remote stop via run.signal.

  - Auto-populates Run.toolsAvailable from agent spans (union across handoffs)
  - Per-event metadata.agentName for multi-agent attribution
  - Dormant when JENZ_API_KEY is missing — host agent runs untouched
