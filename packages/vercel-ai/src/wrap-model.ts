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

const LLM_OUTPUT_LIMIT = 8000;

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

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalise a Vercel AI SDK `tool-call` content/stream block into the
 * Anthropic-style `tool_use` shape the dashboard's outputPreview() detector
 * recognises ("→ wants to call X" labels). Returns the JSON string the
 * caller should drop into the output, or `null` if the block doesn't look
 * like a tool call.
 */
function toolCallToJson(block: Record<string, unknown>): string | null {
  if (block?.type !== 'tool-call') return null;
  const toolName = typeof block.toolName === 'string' ? block.toolName : undefined;
  if (!toolName) return null;
  // V3 spec types `input` as a JSON-stringified string, but the Anthropic
  // `tool_use` shape the dashboard expects has `input` as a parsed object —
  // unwrap before nesting so the wire payload isn't double-encoded.
  let input: unknown = block.input;
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { /* leave as raw string if malformed */ }
  }
  return safeStringify({
    type: 'tool_use',
    id: typeof block.toolCallId === 'string' ? block.toolCallId : undefined,
    name: toolName,
    input,
  });
}

/**
 * Concatenate text + tool-call blocks from a Vercel AI SDK
 * `LanguageModelV3GenerateResult.content` array into a single string for the
 * event's `output` field. Text blocks are joined with newlines; tool-call
 * blocks are JSON-stringified in the Anthropic `tool_use` shape so the
 * dashboard's outputPreview() can render "→ wants to call X" on ReAct-style
 * intermediate steps that produced no text alongside the tool call. Output
 * is clipped to {@link LLM_OUTPUT_LIMIT} chars. Returns '' for non-arrays /
 * empty input / blocks of unknown types.
 *
 * Mirrors the sibling helper in `@jenz-ai/anthropic-sdk` and
 * `@jenz-ai/claude-agent-sdk`.
 */
export function llmOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else {
      const toolJson = toolCallToJson(block ?? {});
      if (toolJson !== null) parts.push(toolJson);
    }
  }
  return clip(parts.join('\n'), LLM_OUTPUT_LIMIT);
}

/**
 * Stream-side counterpart of {@link llmOutputText}. Combines the accumulated
 * text-delta string and the collected `tool-call` chunks (in arrival order)
 * into the same `output` string format. The chunk parameter has the Vercel
 * AI `LanguageModelV3StreamPart` `tool-call` shape (kebab-case, with
 * `toolName` / `toolCallId` / `input`). Clipped to {@link LLM_OUTPUT_LIMIT}.
 */
export function llmOutputFromStreamChunks(
  text: string,
  toolCalls: Array<Record<string, unknown>>,
): string {
  const parts: string[] = [];
  if (text) parts.push(text);
  for (const tc of toolCalls) {
    const json = toolCallToJson(tc);
    if (json !== null) parts.push(json);
  }
  return clip(parts.join('\n'), LLM_OUTPUT_LIMIT);
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
        const output = llmOutputText(result.content);
        await evt.finish({
          output: output || undefined,
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
      const textParts: string[] = [];
      const toolCallChunks: Array<Record<string, unknown>> = [];

      const instrumented = new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(chunk, controller) {
          if (ttftMs === undefined && isFirstTokenChunk(chunk)) {
            ttftMs = Date.now() - startMs;
          }
          if (chunk.type === 'text-delta') {
            const delta = (chunk as { delta?: unknown }).delta;
            if (typeof delta === 'string') textParts.push(delta);
          }
          if (chunk.type === 'tool-call') {
            toolCallChunks.push(chunk as unknown as Record<string, unknown>);
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
          const output = llmOutputFromStreamChunks(textParts.join(''), toolCallChunks);
          await finalizeStreamEvent(evt, run, ownedByUs, ttftMs, usage, errorMessage, output);
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
  output: string,
): Promise<void> {
  await evt.finish({
    output: output || undefined,
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
