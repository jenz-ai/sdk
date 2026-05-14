# @jenz-ai/vercel-ai

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
