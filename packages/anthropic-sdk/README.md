# @jenz-ai/anthropic-sdk

Zero-config [Jenz](https://jenz.dev) observability for [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk)'s `client.beta.messages.toolRunner()`. One wrap captures every LLM call, every tool invocation (with real input + output), and token usage — including cache reads/writes — as an observable Run.

## Install

```bash
npm install @jenz-ai/anthropic-sdk @anthropic-ai/sdk
```

## Usage

```ts
import Anthropic from '@anthropic-ai/sdk';
import { wrapToolRunner } from '@jenz-ai/anthropic-sdk';

const client = new Anthropic();

// before
const runner = client.beta.messages.toolRunner({
  model: 'claude-opus-4-7',
  tools,
  messages: [{ role: 'user', content: 'plan and write a blog post' }],
  stream: true,
});

// after — one wrap, agent loop unchanged
const runner = wrapToolRunner(
  client.beta.messages.toolRunner({ /* ...same params... */ }),
  { agentName: 'blog-writer' },
);

for await (const stream of runner) {
  for await (const event of stream) {
    // your existing event handling — no changes
  }
}

const finalMessage = await runner.done(); // also unchanged
```

Set `JENZ_API_KEY` in your environment. Get a key at <https://jenz.dev/api-keys>.

## What gets captured

| Source | Captured as |
|---|---|
| `toolRunner(...)` constructed + first iteration | A new Run (`framework=generic`, `agentType=options.agentType ?? 'manual'`, `agentName=options.agentName`) |
| Each yielded `messageStream` | One `llm_call` event with provider=anthropic, model, conversation-snapshot input, output text, input/output/cache tokens |
| Each `tool_use` block in the assistant message | A `tool_call` event with the tool's `name` + JSON-stringified `input`, correlated by `tool_use_id` |
| Matching `tool_result` block on the next iteration | The tool event's `output` (or `errorMessage` when `is_error: true`) |
| Iterator completes normally | `Run.finish({ status: 'completed' })` |
| Iterator throws | `Run.finish({ status: 'errored', errorMessage })` |

## How the tool lifecycle works

`toolRunner`'s post-yield code (push assistant message, run tools, push tool_result) runs AFTER your `for await` body returns control to it. The wrapper takes advantage of this:

1. **Iteration N**: read the assistant's `tool_use` blocks (via `messageStream.finalMessage()`). Start jenz tool events with their real input. Hold them open.
2. **Iteration N+1**: the previous iteration's `tool_result` is now at the tail of `runner.params.messages`. Match by `tool_use_id` and finish each held event with its real output.
3. **After the for-await ends**: scan one final time in case `max_iterations` was hit and a trailing `tool_result` never triggered another iteration.

## Options

```ts
interface WrapToolRunnerOptions {
  agentName: string;
  agentType?: 'scheduled' | 'triggered' | 'manual';  // default: 'manual'
  model?: string;                                     // default: runner.params.model
}
```

## Dormant by default

If `JENZ_API_KEY` is unset, the wrapper prints one warning per process and returns the runner unchanged. Your agent runs untouched — no events sent, no overhead.

## Custom backend

Set `JENZ_BASE_URL` to point at a self-hosted Jenz API.

## Failure handling

Network errors when posting events are swallowed (logged by the core SDK). Your `toolRunner` stream is never interrupted by observability failures.

## Documentation

Full docs at <https://jenz.dev/docs>.
