import type { Event, Run } from '@jenz-ai/sdk';
import { tryCreateClient } from './client.js';
import {
  clipError,
  extractToolResultBlocks,
  extractToolUseBlocks,
  extractUsage,
  llmInputSnapshot,
  llmOutputText,
  toolResultOutputString,
  toolUseInputString,
} from './event-mapping.js';
import { SDK_VERSION } from './version.js';

export interface WrapToolRunnerOptions {
  /** Human-readable agent name surfaced in the Jenz dashboard. */
  agentName: string;
  /**
   * Agent category — `manual` for one-shot CLI runs, `scheduled` for cron-
   * triggered jobs, `triggered` for webhook/event-driven flows. Defaults to
   * `manual` since toolRunner is typically used in scripts.
   */
  agentType?: 'scheduled' | 'triggered' | 'manual';
  /** Inferred from `runner.params.model` when omitted. */
  model?: string;
}

// Minimal structural type so we don't need to depend on @anthropic-ai/sdk at
// runtime. Real BetaToolRunner has many more methods we forward via Proxy.
interface ToolRunnerLike {
  params: { messages: unknown[]; model?: string };
  [Symbol.asyncIterator](): AsyncIterator<MessageStreamLike>;
}

interface MessageStreamLike {
  finalMessage(): Promise<{
    role: 'assistant';
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  }>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

/**
 * Wrap a `client.beta.messages.toolRunner(...)` instance to emit Jenz events
 * for every LLM call and tool invocation, without any other changes to your
 * agent loop.
 *
 * Before:
 * ```ts
 * const runner = client.beta.messages.toolRunner({ ... });
 * for await (const stream of runner) { ... }
 * ```
 *
 * After (one wrap, rest unchanged):
 * ```ts
 * const runner = wrapToolRunner(
 *   client.beta.messages.toolRunner({ ... }),
 *   { agentName: 'blog-writer' },
 * );
 * for await (const stream of runner) { ... }
 * ```
 *
 * **What gets captured:**
 *
 * - One `Run` (`framework=generic`, `agentType=options.agentType ?? 'manual'`)
 *   for the full toolRunner lifecycle. Started lazily on first iteration,
 *   finished after the iterator completes.
 * - One `llm_call` event per yielded message stream, with the input snapshot
 *   (full conversation up to that point), output text, and token usage
 *   (including cache reads/writes).
 * - One `tool_call` event per `tool_use` block in each assistant message,
 *   started with the real tool input and finished with the real tool output
 *   once the NEXT iteration's `tool_result` lands in `params.messages`.
 *   (toolRunner only pushes the assistant + runs tools AFTER our for-await
 *   body returns control to it.)
 *
 * **Dormant mode:** If `JENZ_API_KEY` is unset, the wrapper logs one warning
 * per process and returns the runner unchanged. Your agent runs untouched.
 *
 * **Failure modes:** Network errors when posting events are swallowed
 * (logged via core SDK). Your toolRunner stream is never interrupted.
 */
export function wrapToolRunner<R extends ToolRunnerLike>(
  runner: R,
  options: WrapToolRunnerOptions,
): R {
  const client = tryCreateClient();
  if (!client) return runner;

  const runPromise: Promise<Run | null> = client
    .startRun({
      agentName: options.agentName,
      agentType: options.agentType ?? 'manual',
      framework: 'generic',
      sdkVersion: SDK_VERSION,
    })
    .catch((err) => {
      console.error(
        '[@jenz-ai/anthropic-sdk] startRun failed — observability disabled for this call',
        err,
      );
      return null;
    });

  const wrappedIter = wrapIterator(runner, runPromise, options);

  return new Proxy(runner, {
    get(target, prop) {
      if (prop === Symbol.asyncIterator) {
        return () => wrappedIter;
      }
      // Iterator protocol forwarding (so consumers can call .next/.return/.throw
      // on the wrapped iterator if they bypass for-await).
      if (prop === 'next' || prop === 'return' || prop === 'throw') {
        const method = (wrappedIter as unknown as Record<string, unknown>)[
          prop as string
        ];
        return typeof method === 'function' ? method.bind(wrappedIter) : method;
      }
      // Everything else (params, done, runUntilDone, pushMessages, then, ...)
      // is forwarded straight to the underlying runner, bound to it so private
      // fields resolve correctly.
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as R;
}

async function* wrapIterator<R extends ToolRunnerLike>(
  runner: R,
  runPromise: Promise<Run | null>,
  options: WrapToolRunnerOptions,
): AsyncGenerator<MessageStreamLike, void, void> {
  const run = await runPromise;
  if (!run) {
    // Pass-through: dormant mode after startRun failure or no API key.
    yield* runner as AsyncIterable<MessageStreamLike>;
    return;
  }

  const inFlightTools = new Map<string, Event>();
  let errored = false;
  let errorMessage: string | undefined;

  async function finishToolsFromResult(content: unknown): Promise<void> {
    for (const block of extractToolResultBlocks(content)) {
      const evt = inFlightTools.get(block.tool_use_id);
      if (!evt) continue;
      inFlightTools.delete(block.tool_use_id);
      const output = toolResultOutputString(block.content);
      if (block.is_error) {
        await evt.finish({ errorMessage: output });
      } else {
        await evt.finish({ output });
      }
    }
  }

  try {
    for await (const messageStream of runner as AsyncIterable<MessageStreamLike>) {
      // 1. Drain any prior iteration's tool_result message (now at the tail
      //    of params.messages thanks to toolRunner's post-yield push).
      const prev = runner.params.messages[runner.params.messages.length - 1] as
        | { role?: string; content?: unknown }
        | undefined;
      if (prev?.role === 'user') {
        await finishToolsFromResult(prev.content);
      }

      // 2. Start the LLM event with the conversation snapshot as input.
      const llmEvent = run.startEvent({
        type: 'llm_call',
        model: options.model ?? runner.params.model ?? 'claude',
        provider: 'anthropic',
        input: llmInputSnapshot(runner.params.messages),
      });

      // 3. Resolve final assistant message in parallel with the user's stream
      //    consumption. The promise settles once they exhaust the stream.
      const finalMsgPromise = messageStream.finalMessage();
      // Prevent unhandled-rejection: actual error surface comes through the
      // user's own iteration of the stream.
      finalMsgPromise.catch(() => {});

      // 4. Hand the stream to the user.
      yield messageStream;

      // 5. User's for-await body has now completed. Finish the LLM event
      //    with text + tokens, then open tool_call events for each tool_use
      //    block. Their .finish() runs at step 1 of the next iteration.
      try {
        const finalMsg = await finalMsgPromise;
        const usage = extractUsage(finalMsg.usage);
        await llmEvent.finish({
          output: llmOutputText(finalMsg.content),
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        });
        for (const block of extractToolUseBlocks(finalMsg.content)) {
          const evt = run.startEvent({
            type: 'tool_call',
            name: block.name,
            input: toolUseInputString(block.input),
          });
          inFlightTools.set(block.id, evt);
        }
      } catch (err) {
        // Stream errored — record on the LLM event so the trace explains
        // where the run died. Re-thrown via the runner; user sees the same
        // exception in their own iteration.
        await llmEvent.finish({ errorMessage: clipError(err) });
        throw err;
      }
    }

    // 6. After the iteration ends naturally, the LAST message MAY be a
    //    trailing tool_result that no further iteration consumed (happens
    //    when toolRunner hits max_iterations after running tools). Drain.
    const finalLast = runner.params.messages[runner.params.messages.length - 1] as
      | { role?: string; content?: unknown }
      | undefined;
    if (finalLast?.role === 'user') {
      await finishToolsFromResult(finalLast.content);
    }
  } catch (err) {
    errored = true;
    errorMessage = clipError(err);
    throw err;
  } finally {
    // 7. Always finish the Run, even if the iteration broke early or threw.
    // Any in-flight tools that never saw a result are abandoned (no .finish)
    // — they won't appear in the trace, which is the right signal for
    // "execution interrupted before this tool completed."
    try {
      await run.finish(
        errored
          ? { status: 'errored', errorMessage }
          : { status: 'completed' },
      );
    } catch {
      // Swallow — the user's exception (if any) is more important.
    }
  }
}
