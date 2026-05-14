# @jenz-ai/sdk

## 1.1.0

### Minor Changes

- feat: add Run.updateAvailableTools for incremental tool discovery

  PATCHes /v1/runs/{id} with `toolsAvailable` so adapters can populate the
  canonical tools column incrementally as agents are discovered (e.g. OpenAI
  Agents handoffs). Server merges union/dedup. Fires the run's AbortSignal
  if the response includes `stopRequested=true`.

## 1.0.0

### Major Changes

- Initial 1.0.0 release: rebuilt core SDK from scratch.

  - `JenzClient` with env-var auth (`JENZ_API_KEY`, optional `JENZ_BASE_URL`) and configurable per-request timeout.
  - `Run` exposes an `AbortSignal` that fires when the dashboard requests a stop (via `stopRequested` flag returned on every event POST or run PATCH). Forward this to your framework's own cancellation.
  - `Event` carries the full phase-2 telemetry surface: `provider`, `cacheReadTokens`, `cacheWriteTokens`, `ttftMs`, `attempt`, plus the existing `model`, `inputTokens`, `outputTokens`, `latencyMs`.
  - `Transport` is fire-and-forget — never throws, returns parsed response body on 2xx so adapters can read backend control signals.
