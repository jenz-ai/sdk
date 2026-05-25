// Pure functions for mapping @anthropic-ai/sdk BetaMessage shapes into the
// fields Jenz expects on startEvent / finish. Kept dependency-free so
// wrap-tool-runner stays easy to test.

const TOOL_INPUT_LIMIT = 4096;
const LLM_INPUT_LIMIT = 8000;
const LLM_OUTPUT_LIMIT = 8000;
const TOOL_OUTPUT_LIMIT = 8000;
const ERROR_LIMIT = 1000;

export interface AssistantMessageLike {
  role: 'assistant';
  content?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface UserMessageLike {
  role: 'user';
  content?: unknown;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ToolUseBlockLike {
  type: 'tool_use';
  id: string;
  name: string;
  input?: unknown;
}

export interface ToolResultBlockLike {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
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
 * Snapshot of the conversation going INTO an LLM call, used as the event's
 * `input` field. The dashboard parses chat-shape JSON and surfaces the last
 * user message as the ↑ preview.
 */
export function llmInputSnapshot(messages: unknown[]): string {
  return clip(safeStringify(messages), LLM_INPUT_LIMIT);
}

/**
 * Concatenate text blocks from an assistant message into a single string for
 * the event's `output` field. Tool-use blocks are noted in the JSON form so
 * the dashboard's outputPreview() can detect "→ wants to call X" even when
 * the assistant produced no text alongside the tool call.
 */
export function llmOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      // Stringify so dashboard's tool-use detector recognises it.
      parts.push(safeStringify(block));
    }
  }
  return clip(parts.join('\n'), LLM_OUTPUT_LIMIT);
}

/** Pull jenz-shaped token usage from an assistant message's usage object. */
export function extractUsage(usage: AssistantMessageLike['usage']): TokenUsage {
  if (!usage) return {};
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens,
    cacheWriteTokens: usage.cache_creation_input_tokens,
  };
}

/** All tool_use blocks in an assistant message, in stream order. */
export function extractToolUseBlocks(content: unknown): ToolUseBlockLike[] {
  if (!Array.isArray(content)) return [];
  const blocks: ToolUseBlockLike[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (
      block?.type === 'tool_use' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      blocks.push({
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return blocks;
}

/** All tool_result blocks in a user message (toolRunner's reply form). */
export function extractToolResultBlocks(content: unknown): ToolResultBlockLike[] {
  if (!Array.isArray(content)) return [];
  const blocks: ToolResultBlockLike[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
      blocks.push({
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error === true,
      });
    }
  }
  return blocks;
}

/** Stringify a tool_use's input arg for the startEvent input field. */
export function toolUseInputString(input: unknown): string {
  return clip(safeStringify(input ?? {}), TOOL_INPUT_LIMIT);
}

/** Stringify a tool_result's content for the finish output/errorMessage. */
export function toolResultOutputString(content: unknown): string {
  return clip(safeStringify(content), TOOL_OUTPUT_LIMIT);
}

/** Trim an error message for the finish errorMessage field. */
export function clipError(err: unknown): string {
  const s = err instanceof Error ? err.message : safeStringify(err);
  return clip(s, ERROR_LIMIT);
}
