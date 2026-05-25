---
'@jenz-ai/claude-agent-sdk': patch
---

Capture assistant text into `llm_call` event `output` (JEN-60).

`mapAssistantMessage` previously dropped the assistant's response text, so
events arrived at the jenz API with empty `output` despite `outputTokens > 0`.
The mapper now reads `message.content` and joins text blocks (plus
JSON-stringified `tool_use` blocks for ReAct-style intermediate steps) into
`finish.output`, mirroring the helper already used by `@jenz-ai/anthropic-sdk`.
Output is clipped to 8000 chars.
