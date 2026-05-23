import type { StartEventInput, EventFinishInput } from '@jenz-ai/sdk';

// Minimal structural type — we only read these fields. Avoids tight coupling to the
// full SDKAssistantMessage type, which is large. Contract test (Task 6) verifies the
// real shape against this structural one.
export interface AssistantMessageLike {
  type: 'assistant';
  message: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

export interface MappedEvent {
  start: StartEventInput;
  finish: EventFinishInput;
}

export function mapAssistantMessage(msg: AssistantMessageLike): MappedEvent {
  const usage = msg.message.usage;
  return {
    start: {
      type: 'llm_call',
      model: msg.message.model,
      provider: 'anthropic',
    },
    finish: {
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheWriteTokens: usage?.cache_creation_input_tokens,
    },
  };
}
