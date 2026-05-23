# @jenz-ai/claude-agent-sdk

## 0.1.1

### Patch Changes

- Detect integration from MCP tool name and set it on `Event.integration` for tool_call events. The jenz dashboard uses this to render brand logos (Linear, Slack, Vercel, Sentry, etc.) per tool invocation. Built-in Claude Code tools (Bash, Read, Edit, ...) remain undefined and render with a generic icon.

## 0.1.0

### Minor Changes

- First release. Drop-in observability adapter for `@anthropic-ai/claude-agent-sdk` — one import-line change captures runs, llm_call events with token+cache data, tool_call events (including subagents), and final cost/duration/ttft via the SDK's hooks + Query stream.
