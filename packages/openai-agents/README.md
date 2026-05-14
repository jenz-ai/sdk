# @jenz-ai/openai-agents

Zero-config OpenAI Agents SDK adapter for [Jenz](https://jenz.dev) observability.

## Install

```bash
npm install @jenz-ai/openai-agents
```

## Usage

```ts
import { setupJenz, withRun, getActiveRun } from '@jenz-ai/openai-agents';
import { Agent, run } from '@openai/agents';

setupJenz(); // once at boot

// Auto-mode:
await run(new Agent({ name: 'my-agent', instructions: '...' }), 'help');

// Or with explicit metadata + remote stop:
await withRun({ agentName: 'support', agentType: 'scheduled' }, async () => {
  const jenz = getActiveRun();
  await run(agent, 'help', { signal: jenz?.signal });
});
```

Without `JENZ_API_KEY`, the adapter runs dormant — your agent works normally, no data is sent. Get a key at https://jenz.dev/api-keys.

See full docs at https://jenz.dev/docs.
