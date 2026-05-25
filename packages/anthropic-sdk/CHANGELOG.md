# @jenz-ai/anthropic-sdk

## 0.1.0

Initial release.

- `wrapToolRunner(runner, { agentName })` wraps a `client.beta.messages.toolRunner(...)` instance from `@anthropic-ai/sdk` and emits Jenz observability events for the full agent lifecycle.
- Captures one `Run` per toolRunner instance (framework=generic), one `llm_call` event per yielded message stream (with input snapshot, output text, token usage incl. cache reads/writes), and one `tool_call` event per `tool_use` block (correlated by `tool_use_id` to the next iteration's `tool_result`).
- Dormant by default: no `JENZ_API_KEY` → wrapper passes through unchanged with one console warning.
- Peer dependency: `@anthropic-ai/sdk >=0.60.0`.
