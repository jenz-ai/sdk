# Jenz SDKs

Observability SDKs for AI agents — runs, events, costs, latency. Powers [jenz.dev](https://jenz.dev).

## Packages

- [`@jenz-ai/sdk`](./packages/core) — core HTTP client (`JenzClient`, `Run`, `Event`)
- [`@jenz-ai/vercel-ai`](./packages/vercel-ai) — zero-config wrapper for the [Vercel AI SDK](https://sdk.vercel.ai)
- *(more adapters coming: OpenAI Agents SDK, Claude Agent SDK)*

## Quick start (Vercel AI)

```ts
import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { wrapModel } from '@jenz-ai/vercel-ai';

const model = wrapModel(openai('gpt-4o'), {
  agentName: 'seo-agent',
  agentType: 'scheduled',
});

await generateText({ model, prompt: 'Write a tagline' });
```

That's it — runs, LLM calls, tokens, cost, and TTFT show up in real time on [jenz.dev](https://jenz.dev). Set `JENZ_API_KEY` in `.env` (get one at [jenz.dev/api-keys](https://jenz.dev/api-keys)).

## Multi-step agents

Use `withRun` to group multiple LLM calls and tool calls under one run:

```ts
import { withRun, wrapModel, wrapTools } from '@jenz-ai/vercel-ai';

const model = wrapModel(openai('gpt-4o'), { agentName: 'research', agentType: 'scheduled' });
const tools = wrapTools({
  search: { execute: async ({ q }) => fetch(`/api/search?q=${q}`).then(r => r.json()) },
});

await withRun({ agentName: 'research', agentType: 'scheduled' }, async () => {
  const plan = await generateText({ model, prompt: 'Plan the research', tools });
  const results = await generateText({ model, prompt: plan.text, tools });
  return results.text;
});
```

## Manual instrumentation

For agent loops not built on Vercel AI (raw `openai`/`anthropic` clients), use `@jenz-ai/sdk` directly:

```ts
import { JenzClient } from '@jenz-ai/sdk';

const jenz = new JenzClient();
const run = await jenz.startRun({ agentName: 'support-bot', agentType: 'triggered' });
if (!run) throw new Error('No run');

const evt = run.startEvent({ type: 'llm_call', model: 'claude-sonnet-4-6', provider: 'anthropic' });
const res = await callClaude(prompt);
await evt.finish({
  inputTokens: res.usage.input_tokens,
  outputTokens: res.usage.output_tokens,
  cacheReadTokens: res.usage.cache_read_input_tokens,
  cacheWriteTokens: res.usage.cache_creation_input_tokens,
});

await run.finish({ status: 'completed', output: res.text });
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

## Releasing

Each PR with user-visible changes should include a Changeset:

```bash
pnpm changeset
```

Pushing to `main` runs the Release workflow, which publishes to npm.

## License

MIT
