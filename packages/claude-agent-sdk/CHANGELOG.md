# @jenz-ai/claude-agent-sdk

## 0.1.0

### Minor Changes

- First release. Drop-in observability adapter for `@anthropic-ai/claude-agent-sdk` — one import-line change captures runs, llm_call events with token+cache data, tool_call events (including subagents), and final cost/duration/ttft via the SDK's hooks + Query stream.
