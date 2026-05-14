# @jenz-ai/openai-agents

## 0.1.0

### Minor Changes

- feat: initial release — Jenz observability adapter for OpenAI Agents SDK

  Tracing-processor-based adapter for @openai/agents v0.11+. One setup call
  (setupJenz()) installs a TracingProcessor that maps every SDK span (LLM
  call, tool call, handoff, guardrail) to a Jenz event. Optional withRun()
  wrapper for explicit per-run metadata + remote stop via run.signal.

  - Auto-populates Run.toolsAvailable from agent spans (union across handoffs)
  - Per-event metadata.agentName for multi-agent attribution
  - Dormant when JENZ_API_KEY is missing — host agent runs untouched
