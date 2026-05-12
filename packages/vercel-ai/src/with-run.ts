import { JenzClient, type AgentType, type Run } from '@jenz-ai/sdk';
import { runContext } from './als.js';

export interface WithRunInput {
  agentName: string;
  agentType: AgentType;
  sdkVersion?: string;
  toolsAvailable?: string[];
  input?: string;
  expectedDurationMs?: number;
  metadata?: Record<string, unknown>;
}

const SDK_VERSION = '0.1.0';

/**
 * Returns the active Jenz run from AsyncLocalStorage, if any.
 *
 * - Inside a `withRun` callback this returns the run created for that scope.
 * - Outside any `withRun` it returns `undefined` — wrappers fall back to
 *   auto-starting a new run when this is the case.
 */
export function getActiveRun(): Run | undefined {
  return runContext.getStore()?.run;
}

/**
 * Run a function inside an active Jenz run. All `wrapModel` / `wrapTools`
 * calls inside the callback (and any async descendants) will share the same
 * run, producing one tree of events instead of one run per LLM call.
 *
 * ```ts
 * await withRun({ agentName: 'research', agentType: 'scheduled' }, async () => {
 *   const plan = await generateText({ model, prompt: '...' });
 *   await generateText({ model, prompt: plan.text });
 * });
 * ```
 *
 * - On success: run finishes with `status: 'completed'`.
 * - On thrown error: run finishes with `status: 'errored'` and `errorMessage`
 *   from the thrown error, then re-throws.
 * - If the dashboard requests a stop via `run.signal` during the callback, the
 *   run finishes with `status: 'stopped'`.
 * - If the backend is unreachable when starting the run, the callback runs
 *   without observability — observability must not break the host agent.
 */
export async function withRun<T>(
  input: WithRunInput,
  fn: () => Promise<T>,
): Promise<T> {
  const client = new JenzClient();
  const run = await client.startRun({
    agentName: input.agentName,
    agentType: input.agentType,
    framework: 'vercel-ai',
    sdkVersion: input.sdkVersion ?? SDK_VERSION,
    toolsAvailable: input.toolsAvailable,
    input: input.input,
    expectedDurationMs: input.expectedDurationMs,
    metadata: input.metadata,
  });

  if (!run) {
    // Backend unreachable — execute callback without observability.
    return await fn();
  }

  try {
    const result = await runContext.run({ run }, fn);
    if (run.signal.aborted) {
      await run.finish({ status: 'stopped', errorMessage: errorMessageFromSignal(run.signal) });
    } else {
      await run.finish({ status: 'completed' });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run.signal.aborted) {
      await run.finish({ status: 'stopped', errorMessage: errorMessageFromSignal(run.signal) });
    } else {
      await run.finish({ status: 'errored', errorMessage: message });
    }
    throw err;
  }
}

function errorMessageFromSignal(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return undefined;
}
