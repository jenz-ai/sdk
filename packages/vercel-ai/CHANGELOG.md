# @jenz-ai/vercel-ai

## 0.1.2

### Patch Changes

- e87c5c6: Capture assistant text into `llm_call` event `output` (JEN-61).

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

## 0.1.1

### Patch Changes

- Fix `@jenz-ai/sdk` dependency in published package — 0.1.0 had the literal `workspace:^` protocol string instead of a real npm version range (caused by publishing via `npm publish` instead of `pnpm publish`). 0.1.1 has the correct `^1.0.0` range.

## 0.1.0

### Minor Changes

- Initial 0.1.0 release: zero-config Vercel AI SDK wrapper.

  Uses the official `wrapLanguageModel` + `LanguageModelV3Middleware` API (peer dep `ai >= 5.0.0`). Exports:

  - `wrapModel(model, config)` — Instruments any Vercel AI model. `wrapGenerate` emits a `llm_call` event per call; `wrapStream` pipes the stream through a `TransformStream` that captures **TTFT** at the first content chunk and reads final usage from the `finish` chunk.
  - `wrapTools(tools)` — Wraps an AI SDK tools object so each `execute` invocation emits a `tool_call` event.
  - `withRun(input, fn)` — Starts a Jenz run and threads it through `AsyncLocalStorage` so nested `wrapModel`/`wrapTools` calls all attach to the same run. Auto-finishes with `completed` / `errored` / `stopped` depending on outcome.
  - `getActiveRun()` — Returns the current run, if any.

  Standalone `wrapModel` calls (no `withRun`) auto-start and auto-finish a run for that single call.

### Patch Changes

- Depends on @jenz-ai/sdk@1.0.0
