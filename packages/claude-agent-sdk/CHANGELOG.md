# @jenz-ai/claude-agent-sdk

## 0.1.3

### Patch Changes

- a7bf229: Capture assistant text into `llm_call` event `output` (JEN-60).

  `mapAssistantMessage` previously dropped the assistant's response text, so
  events arrived at the jenz API with empty `output` despite `outputTokens > 0`.
  The mapper now reads `message.content` and joins text blocks (plus
  JSON-stringified `tool_use` blocks for ReAct-style intermediate steps) into
  `finish.output`, mirroring the helper already used by `@jenz-ai/anthropic-sdk`.
  Output is clipped to 8000 chars.

## 0.1.2

### Patch Changes

- a34b008: Forward `Run.signal` aborts to the upstream `Query.interrupt()` so the jenz dashboard "Stop run" button cleanly cancels in-flight Claude Agent SDK runs. The other adapters already plumb `Run.signal` through user-supplied AbortSignals; Claude SDK hides its cancellation behind `Query.interrupt()`, so the adapter now wires the bridge internally — no user action required.

## 0.1.1

### Patch Changes

- Detect integration from MCP tool name and set it on `Event.integration` for tool_call events. The jenz dashboard uses this to render brand logos (Linear, Slack, Vercel, Sentry, etc.) per tool invocation. Built-in Claude Code tools (Bash, Read, Edit, ...) remain undefined and render with a generic icon.

## 0.1.0

### Minor Changes

- First release. Drop-in observability adapter for `@anthropic-ai/claude-agent-sdk` — one import-line change captures runs, llm_call events with token+cache data, tool_call events (including subagents), and final cost/duration/ttft via the SDK's hooks + Query stream.
