---
"@jenz-ai/claude-agent-sdk": patch
---

Forward `Run.signal` aborts to the upstream `Query.interrupt()` so the jenz dashboard "Stop run" button cleanly cancels in-flight Claude Agent SDK runs. The other adapters already plumb `Run.signal` through user-supplied AbortSignals; Claude SDK hides its cancellation behind `Query.interrupt()`, so the adapter now wires the bridge internally — no user action required.
