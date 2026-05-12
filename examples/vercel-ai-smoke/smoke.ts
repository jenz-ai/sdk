// Runnable smoke test for @jenz-ai/vercel-ai.
// Usage:
//   JENZ_API_KEY=jz_live_xxx OPENAI_API_KEY=sk-xxx \
//     pnpm --filter @jenz-ai/example-vercel-ai-smoke smoke
//
// Hits jenz.dev with a tiny one-shot agent — verifies install + auth.

import { openai } from '@ai-sdk/openai';
import { generateText } from 'ai';
import { wrapModel } from '@jenz-ai/vercel-ai';

const model = wrapModel(openai('gpt-4o-mini'), {
  agentName: 'vercel-ai-smoke',
  agentType: 'manual',
});

const result = await generateText({
  model,
  prompt: 'Reply with exactly the word: ok',
});

console.log('LLM said:', result.text);
console.log('Check https://jenz.dev — you should see a run named "vercel-ai-smoke"');
