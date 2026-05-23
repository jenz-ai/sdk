import type { Run } from '@jenz-ai/sdk';
import { runContext } from './als.js';

/**
 * Returns the active Jenz run from AsyncLocalStorage, if any. Returns undefined
 * outside a `query()` iteration (or when the adapter is dormant).
 *
 * Typical use: pass `run.signal` to user-controlled abort logic.
 *
 * ```ts
 * for await (const msg of query({ prompt: 'hi' })) {
 *   const run = getActiveRun();
 *   if (run?.signal.aborted) break;  // honor dashboard stop
 *   // ...
 * }
 * ```
 */
export function getActiveRun(): Run | undefined {
  return runContext.getStore()?.run;
}
