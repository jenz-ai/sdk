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
  return {
    start: {
      type: 'llm_call',
      model: data.model,
      provider: data.model_config?.provider ?? 'openai',
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
