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

const TOOL_INPUT_LIMIT = 4096;

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

function clip(s: string, max = TOOL_INPUT_LIMIT): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Structural types — see Task 6 contract test for real-SDK conformance.
export interface PreToolUseInput {
  hook_event_name: 'PreToolUse';
  tool_use_id: string;
  tool_name: string;
  tool_input: unknown;
}

export interface PostToolUseInput {
  hook_event_name: 'PostToolUse';
  tool_use_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
}

export interface PostToolUseFailureInput {
  hook_event_name: 'PostToolUseFailure';
  tool_use_id: string;
  tool_name: string;
  tool_input: unknown;
  error: unknown;
}

export interface MappedToolStart {
  start: StartEventInput;
  toolUseId: string;
  toolName: string;
}

export interface MappedToolFinish {
  finish: EventFinishInput;
  toolUseId: string;
}

export function mapPreToolUse(input: PreToolUseInput): MappedToolStart {
  return {
    start: {
      type: 'tool_call',
      name: input.tool_name,
      input: clip(safeStringify(input.tool_input)),
    },
    toolUseId: input.tool_use_id,
    toolName: input.tool_name,
  };
}

export function mapPostToolUse(input: PostToolUseInput): MappedToolFinish {
  return {
    finish: { output: clip(safeStringify(input.tool_response)) },
    toolUseId: input.tool_use_id,
  };
}

export function mapPostToolUseFailure(input: PostToolUseFailureInput): MappedToolFinish {
  return {
    finish: { errorMessage: clip(safeStringify(input.error)) },
    toolUseId: input.tool_use_id,
  };
}
