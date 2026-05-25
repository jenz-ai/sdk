import type { Span } from '@openai/agents-core';
import type { StartEventInput, EventFinishInput } from '@jenz-ai/sdk';

export interface MappedEvent {
  start: StartEventInput;
  finish: EventFinishInput;
}

/**
 * Map an OpenAI Agents span to a Jenz event payload. Returns null for span types
 * we don't surface in v0.1 (agent containers, speech, transcription, mcp_tools).
 */
export function mapSpanToEvent(
  span: Span<any>,
  parentAgentName: string | undefined,
): MappedEvent | null {
  const data = span.spanData as { type: string } & Record<string, any>;
  const errorMessage = span.error?.message;
  const metadata = parentAgentName ? { agentName: parentAgentName } : undefined;

  switch (data.type) {
    case 'generation':
      return mapGeneration(data, errorMessage, metadata);
    case 'response':
      return mapResponse(data, errorMessage, metadata);
    case 'function':
      return {
        start: { type: 'tool_call', name: data.name, metadata },
        finish: { errorMessage },
      };
    case 'handoff':
      return {
        start: {
          type: 'log',
          name: `handoff:${data.from_agent ?? '?'}→${data.to_agent ?? '?'}`,
          metadata,
        },
        finish: { errorMessage },
      };
    case 'guardrail':
      return {
        start: { type: 'log', name: `guardrail:${data.name}`, metadata },
        finish: { errorMessage: data.triggered ? 'triggered' : errorMessage },
      };
    default:
      return null;
  }
}

function mapGeneration(
  data: any,
  errorMessage: string | undefined,
  metadata: Record<string, unknown> | undefined,
): MappedEvent {
  const usage = data.usage ?? {};
  const cacheReadTokens =
    usage.details?.input_tokens_details?.cached_tokens;
  const output = generationOutputText(data.output);
  return {
    start: {
      type: 'llm_call',
      model: data.model,
      provider: data.model_config?.provider ?? 'openai',
      metadata,
    },
    finish: {
      output: output || undefined,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      errorMessage,
    },
  };
}

function mapResponse(
  data: any,
  errorMessage: string | undefined,
  metadata: Record<string, unknown> | undefined,
): MappedEvent {
  const resp = data._response ?? {};
  const usage = resp.usage ?? {};
  const cacheReadTokens =
    usage.details?.input_tokens_details?.cached_tokens;
  return {
    start: {
      type: 'llm_call',
      model: resp.model,
      provider: 'openai',
      metadata,
    },
    finish: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens,
      errorMessage,
    },
  };
}

const LLM_OUTPUT_LIMIT = 8000;

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
 * Extract assistant text from a generation span's `output` (chat-completions
 * shape: `[response]` where response is the raw OpenAI ChatCompletion). Walks
 * each choice's `message.content` (string) and `message.tool_calls`, joining
 * with newlines. Tool calls are normalised into a `{ type: 'tool_use', name }`
 * JSON blob so the dashboard's outputPreview() can render "→ wants to call X"
 * on ReAct-style intermediate steps that produced no text. Output is clipped
 * to LLM_OUTPUT_LIMIT chars. Returns '' when nothing usable is found.
 */
export function generationOutputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const response of output as Array<Record<string, unknown>>) {
    const choices = (response?.choices as unknown[]) ?? [];
    if (!Array.isArray(choices)) continue;
    for (const choice of choices as Array<Record<string, unknown>>) {
      const message = choice?.message as Record<string, unknown> | undefined;
      if (!message) continue;
      const content = message.content;
      if (typeof content === 'string' && content.length > 0) {
        parts.push(content);
      }
      const toolCalls = message.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls as Array<Record<string, unknown>>) {
          const fn = tc?.function as Record<string, unknown> | undefined;
          const name = typeof fn?.name === 'string' ? fn.name : undefined;
          if (!name) continue;
          parts.push(
            safeStringify({
              type: 'tool_use',
              id: typeof tc.id === 'string' ? tc.id : undefined,
              name,
              input: fn?.arguments,
            }),
          );
        }
      }
    }
  }
  return clip(parts.join('\n'), LLM_OUTPUT_LIMIT);
}
