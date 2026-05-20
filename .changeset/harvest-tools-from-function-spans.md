---
'@jenz-ai/openai-agents': patch
---

fix: harvest toolsAvailable from function spans, not agent spans

The real @openai/agents-core SDK emits agent spans with `tools: []` on
onSpanStart, so the prior agent-span-based harvest never captured anything.
Now we also pull tool names from each function span as it starts, which
reflects actually-invoked tools and works against the real SDK shape.
