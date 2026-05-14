import { JenzClient, type AgentType, type Run } from '@jenz-ai/sdk';
import { runContext } from './als.js';
import { SDK_VERSION } from './version.js';

let dormantWarningShown = false;

export interface WithRunInput {
  agentName: string;
  agentType: AgentType;
  sdkVersion?: string;
  toolsAvailable?: string[];
  input?: string;
  expectedDurationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Returns the active Jenz run from AsyncLocalStorage, if any. Returns undefined
 * outside `withRun` (or when the adapter is dormant due to missing JENZ_API_KEY).
 */
export function getActiveRun(): Run | undefined {
  return runContext.getStore()?.run;
}

/**
 * Run a function inside an active Jenz run. The processor installed by
 * `setupJenz` will attach any SDK trace fired inside the callback to this run.
 *
 * On success: run finishes with status 'completed'.
 * On thrown error: run finishes with status 'errored' (re-throws).
 * On `run.signal.aborted` (remote stop): run finishes with status 'stopped'.
 * If `JENZ_API_KEY` is missing: callback runs as a passthrough; no run created.
 */
export async function withRun<T>(
  input: WithRunInput,
  fn: () => Promise<T>,
): Promise<T> {
  const client = tryCreateClient();
  if (!client) {
    return await fn();
  }

  const run = await client.startRun({
    agentName: input.agentName,
    agentType: input.agentType,
    framework: 'openai-agents',
    sdkVersion: input.sdkVersion ?? SDK_VERSION,
    toolsAvailable: input.toolsAvailable,
    input: input.input,
    expectedDurationMs: input.expectedDurationMs,
    metadata: input.metadata,
  });

  if (!run) {
    return await fn();
  }

  try {
    const result = await runContext.run({ run }, fn);
    if (run.signal.aborted) {
      await run.finish({
        status: 'stopped',
        errorMessage: errorMessageFromSignal(run.signal),
      });
    } else {
      await run.finish({ status: 'completed' });
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run.signal.aborted) {
      await run.finish({
        status: 'stopped',
        errorMessage: errorMessageFromSignal(run.signal) ?? message,
      });
    } else {
      await run.finish({ status: 'errored', errorMessage: message });
    }
    throw err;
  }
}

function tryCreateClient(): JenzClient | null {
  try {
    return new JenzClient();
  } catch {
    if (!dormantWarningShown) {
      dormantWarningShown = true;
      console.warn(
        '[jenz] Observability is dormant — JENZ_API_KEY not set.\n' +
          '       Get a key at https://jenz.dev/api-keys, add JENZ_API_KEY=... to .env, restart.\n' +
          '       Your agent will run normally; no data is being sent.',
      );
    }
    return null;
  }
}

function errorMessageFromSignal(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return undefined;
}

/** @internal — used by tests to reset module state between cases. */
export function __resetWithRunForTests(): void {
  dormantWarningShown = false;
}
