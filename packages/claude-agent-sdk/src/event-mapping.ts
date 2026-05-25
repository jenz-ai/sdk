import type { StartEventInput, EventFinishInput } from '@jenz-ai/sdk';

// Minimal structural type — we only read these fields. Avoids tight coupling to the
// full SDKAssistantMessage type, which is large. Contract test (Task 6) verifies the
// real shape against this structural one.
export interface AssistantMessageLike {
  type: 'assistant';
  message: {
    model?: string;
    content?: unknown;
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
  const output = llmOutputText(msg.message.content);
  return {
    start: {
      type: 'llm_call',
      model: msg.message.model,
      provider: 'anthropic',
    },
    finish: {
      output: output || undefined,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      cacheReadTokens: usage?.cache_read_input_tokens,
      cacheWriteTokens: usage?.cache_creation_input_tokens,
    },
  };
}

const TOOL_INPUT_LIMIT = 4096;
const LLM_OUTPUT_LIMIT = 8000;

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

/**
 * Concatenate text blocks from an assistant message's `content` array into a
 * single string for the event's `output` field. Tool-use blocks are kept as
 * JSON so the dashboard's outputPreview() can render "→ wants to call X" on
 * ReAct-style intermediate steps that produced no text. Mirrors the equivalent
 * helper in `@jenz-ai/anthropic-sdk`. Returns '' for non-arrays / empty input.
 */
export function llmOutputText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      parts.push(safeStringify(block));
    }
  }
  return clip(parts.join('\n'), LLM_OUTPUT_LIMIT);
}

/**
 * Best-effort detection of the upstream service from a tool name. Used to set
 * `Event.integration` so the jenz dashboard can render a brand logo per
 * tool_call. Returns undefined for built-in / unknown tools — the dashboard
 * falls back to a generic icon.
 *
 * Claude Code MCP tools follow the convention `mcp__<plugin>__<tool>`. Plugin
 * names usually look like `claude_ai_Linear` or `plugin_slack_slack`; the first
 * underscore-segment after stripping the conventional prefixes is the service
 * name (e.g. `linear`, `slack`, `sentry`, `vercel`).
 *
 * Built-in tools (`Bash`, `Read`, `Edit`, `Glob`, ...) return undefined.
 */
export function detectIntegration(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  const parts = toolName.split('__');
  if (parts.length < 3) return undefined;
  const plugin = (parts[1] ?? '')
    .toLowerCase()
    .replace(/^claude_ai_/, '')
    .replace(/^plugin_/, '');
  const first = plugin.split('_')[0];
  return first || undefined;
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
      integration: detectIntegration(input.tool_name),
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

export interface SubagentStartInput {
  hook_event_name: 'SubagentStart';
  agent_id: string;
  agent_type: string;
}

export interface SubagentStopInput {
  hook_event_name: 'SubagentStop';
  stop_hook_active: boolean;
  agent_id: string;
  agent_transcript_path: string;
  agent_type: string;
  last_assistant_message?: string;
}

export interface MappedSubagentStart {
  start: StartEventInput;
  subagentId: string;
}

export interface MappedSubagentStop {
  finish: EventFinishInput;
  subagentId: string;
}

export function mapSubagentStart(input: SubagentStartInput): MappedSubagentStart {
  return {
    start: {
      type: 'tool_call',
      name: `subagent:${input.agent_type}`,
    },
    subagentId: input.agent_id,
  };
}

export function mapSubagentStop(input: SubagentStopInput): MappedSubagentStop {
  return {
    finish: {
      output: input.last_assistant_message,
    },
    subagentId: input.agent_id,
  };
}
