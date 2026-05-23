import type { Run } from '@jenz-ai/sdk';
import { mapAssistantMessage } from './event-mapping.js';

interface AnyMessage { type: string; [k: string]: any; }

/**
 * Wrap an upstream AsyncGenerator<SDKMessage>. Yields every message untouched.
 * On each `SDKAssistantMessage`, emits an llm_call event. On `SDKResultMessage`,
 * finishes the Run. On upstream throw, marks Run errored and re-throws.
 *
 * Awaits runPromise on entry; if it resolves to null, the wrapper degrades to a
 * pure pass-through with zero observation (no startEvent, no run.finish).
 */
export async function* wrapQueryStream(
  upstream: AsyncGenerator<AnyMessage, void>,
  runPromise: Promise<Run | null>,
): AsyncGenerator<AnyMessage, void> {
  const run = await runPromise;

  if (!run) {
    yield* upstream;
    return;
  }

  let finishCalled = false;
  try {
    for await (const msg of upstream) {
      try {
        if (msg.type === 'assistant') {
          const { start, finish } = mapAssistantMessage(msg as any);
          const evt = (run as any).startEvent(start);
          await evt.finish(finish);
        } else if (msg.type === 'result') {
          if (msg.subtype === 'success') {
            finishCalled = true;
            await (run as any).finish({
              status: 'completed',
              output: typeof msg.result === 'string' ? msg.result : undefined,
              metadata: {
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                ttftMs: msg.ttft_ms ?? null,
              },
            });
          } else if (typeof msg.subtype === 'string' && msg.subtype.startsWith('error_')) {
            finishCalled = true;
            await (run as any).finish({ status: 'errored', errorMessage: msg.subtype });
          }
        }
      } catch (err) {
        console.error('[@jenz-ai/claude-agent-sdk] stream observation error', err);
      }
      yield msg;
    }
    if (!finishCalled) {
      try {
        await (run as any).finish({ status: 'completed' });
      } catch { /* swallow */ }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      if (!finishCalled) await (run as any).finish({ status: 'errored', errorMessage: message });
    } catch { /* swallow */ }
    throw err;
  }
}
