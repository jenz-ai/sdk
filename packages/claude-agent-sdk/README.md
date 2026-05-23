# @jenz-ai/claude-agent-sdk

Zero-config [Jenz](https://jenz.dev) observability for the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk). One import-line change captures every `query()` call as an observable Run with model calls, tool invocations, token usage (including cache reads/writes), and subagent activity.

## Install

```bash
npm install @jenz-ai/claude-agent-sdk @anthropic-ai/claude-agent-sdk
```

## Usage

```ts
// before
import { query } from '@anthropic-ai/claude-agent-sdk';

// after — one line changed
import { query } from '@jenz-ai/claude-agent-sdk';

for await (const msg of query({ prompt: 'fix the bug' })) {
  // your iteration unchanged
}
```

Set `JENZ_API_KEY` in your environment. Get a key at https://jenz.dev/api-keys.

## What gets captured

| Source | Captured as |
|---|---|
| `query()` call starts | A new Run (`framework=claude-agent`, `agentType=claude_code`, `agentName=options.agent ?? 'claude-agent'`) |
| `SDKAssistantMessage` | An `llm_call` event with `provider=anthropic`, model, input/output/cache tokens |
| `PreToolUse` / `PostToolUse` hook | A `tool_call` event correlated by `tool_use_id` |
| `PostToolUseFailure` | A failed `tool_call` event |
| `SubagentStart` / `SubagentStop` | A `tool_call` event named `subagent:<agent_type>` |
| `SDKResultMessage` (success) | `Run.finish({status:'completed', output, metadata:{costUsd, durationMs, numTurns, ttftMs}})` |
| `SDKResultMessage` (error_*) | `Run.finish({status:'errored', errorMessage: subtype})` |

## Advanced: access the active Run

```ts
import { query, getActiveRun } from '@jenz-ai/claude-agent-sdk';

for await (const msg of query({ prompt: 'go' })) {
  const run = getActiveRun();
  if (run?.signal.aborted) break; // honor dashboard "Stop"
  // ...
}
```

## Dormant by default

If `JENZ_API_KEY` is unset, the adapter prints one warning per process and passes every `query()` straight through. Your agent runs untouched.

## Custom backend

Set `JENZ_BASE_URL` to point at a self-hosted Jenz API.

## Documentation

Full docs at https://jenz.dev/docs.
