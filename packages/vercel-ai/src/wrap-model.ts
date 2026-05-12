import { wrapLanguageModel } from 'ai';
import type {
  LanguageModelV3,
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { JenzClient, type AgentType, type Run, type Event } from '@jenz-ai/sdk';
import { runContext } from './als.js';

export interface WrapModelConfig {
  agentName: string;
  agentType: AgentType;
  sdkVersion?: string;
}

const SDK_VERSION = '0.1.0';

interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

function normalizeUsage(usage: LanguageModelV3Usage | undefined): NormalizedUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.inputTokens?.total,
    outputTokens: usage.outputTokens?.total,
    cacheReadTokens: usage.inputTokens?.cacheRead,
    cacheWriteTokens: usage.inputTokens?.cacheWrite,
  };
}

/**
 * Wrap a Vercel AI SDK model so every LLM call emits a `llm_call` event to
 * Jenz. Returns a new `LanguageModelV3` that behaves identically to the input.
 *
 * Behaviour:
 * - If a run is already active (via `withRun`), the event is attached to it.
 * - Otherwise a new run is auto-started for this single call (`agentName` /
 *   `agentType` from `config`) and auto-finished when the call returns.
 * - Token usage is read from `result.usage` (V3 fields: `inputTokens`,
 *   `outputTokens`, `cachedInputTokens`).
 * - For streaming (`doStream`), the stream is piped through a TransformStream
 *   that captures **TTFT** at the first content chunk and reads final usage
 *   from the `finish` chunk.
 * - If the backend is unreachable, the underlying model is invoked directly
 *   with no observability — observability never breaks the host agent.
 *
 * ```ts
 * const model = wrapModel(openai('gpt-4o'), {
 *   agentName: 'seo-agent',
 *   agentType: 'scheduled',
 * });
 * await generateText({ model, prompt: '...' });
 * ```
 */
export function wrapModel(
  model: LanguageModelV3,
  config: WrapModelConfig,
): LanguageModelV3 {
  return wrapLanguageModel({
    model,
    middleware: createJenzMiddleware(config),
  }) as LanguageModelV3;
}

function createJenzMiddleware(config: WrapModelConfig): LanguageModelV3Middleware {
  return {
    specificationVersion: 'v3',
    wrapGenerate: async ({ doGenerate, model }) => {
      const { run, ownedByUs } = await acquireRun(config);
      if (!run) return doGenerate();

      const evt = run.startEvent({
        type: 'llm_call',
        model: model.modelId,
        provider: model.provider,
      });

      try {
        const result = await doGenerate();
        const usage = normalizeUsage(result.usage);
        await evt.finish({
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        });
        if (ownedByUs) await run.finish({ status: 'completed' });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await evt.finish({ errorMessage: message });
        if (ownedByUs) await run.finish({ status: 'errored', errorMessage: message });
        throw err;
      }
    },

    wrapStream: async ({ doStream, model }) => {
      const { run, ownedByUs } = await acquireRun(config);
      if (!run) return doStream();

      const evt = run.startEvent({
        type: 'llm_call',
        model: model.modelId,
        provider: model.provider,
      });

      let streamResult;
      try {
        streamResult = await doStream();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await evt.finish({ errorMessage: message });
        if (ownedByUs) await run.finish({ status: 'errored', errorMessage: message });
        throw err;
      }

      const { stream, ...rest } = streamResult;
      const startMs = Date.now();
      let ttftMs: number | undefined;
      let usage: NormalizedUsage | undefined;
      let errorMessage: string | undefined;

      const instrumented = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          if (ttftMs === undefined && isFirstTokenChunk(chunk)) {
            ttftMs = Date.now() - startMs;
          }
          if (chunk.type === 'finish') {
            usage = normalizeUsage(chunk.usage);
          }
          if (chunk.type === 'error') {
            const err = (chunk as { error: unknown }).error;
            errorMessage = err instanceof Error ? err.message : String(err);
          }
          controller.enqueue(chunk);
        },
        async flush() {
          await finalizeStreamEvent(evt, run, ownedByUs, ttftMs, usage, errorMessage);
        },
      });

      return { stream: stream.pipeThrough(instrumented), ...rest };
    },
  };
}

function isFirstTokenChunk(chunk: LanguageModelV3StreamPart): boolean {
  return (
    chunk.type === 'text-delta' ||
    chunk.type === 'reasoning-delta' ||
    chunk.type === 'tool-call' ||
    chunk.type === 'tool-input-delta'
  );
}

async function finalizeStreamEvent(
  evt: Event,
  run: Run,
  ownedByUs: boolean,
  ttftMs: number | undefined,
  usage: NormalizedUsage | undefined,
  errorMessage: string | undefined,
): Promise<void> {
  await evt.finish({
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cacheReadTokens: usage?.cacheReadTokens,
    cacheWriteTokens: usage?.cacheWriteTokens,
    ttftMs,
    errorMessage,
  });
  if (ownedByUs) {
    await run.finish({
      status: errorMessage ? 'errored' : 'completed',
      errorMessage,
    });
  }
}

async function acquireRun(
  config: WrapModelConfig,
): Promise<{ run: Run | null; ownedByUs: boolean }> {
  const existing = runContext.getStore()?.run;
  if (existing) return { run: existing, ownedByUs: false };

  const client = new JenzClient();
  const run = await client.startRun({
    agentName: config.agentName,
    agentType: config.agentType,
    framework: 'vercel-ai',
    sdkVersion: config.sdkVersion ?? SDK_VERSION,
  });
  return { run, ownedByUs: true };
}
