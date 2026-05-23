# @jenz-ai/claude-agent-sdk

Zero-config Claude Agent SDK adapter for [Jenz](https://jenz.dev) observability.

## Install

```bash
npm install @jenz-ai/claude-agent-sdk
```

## Usage

```ts
// Change one import line:
import { query } from '@jenz-ai/claude-agent-sdk';

for await (const msg of query({ prompt: 'fix the bug' })) {
  // your code unchanged
}
```

Without `JENZ_API_KEY`, the adapter runs dormant — your agent works normally, no data is sent. Get a key at https://jenz.dev/api-keys.

See full docs at https://jenz.dev/docs.
