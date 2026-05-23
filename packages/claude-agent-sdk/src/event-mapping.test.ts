import { describe, it, expect } from 'vitest';
import { mapAssistantMessage, mapPreToolUse, mapPostToolUse, mapPostToolUseFailure, detectIntegration } from './event-mapping.js';

// Minimal SDKAssistantMessage shape — we only read what we map.
// Real shape: { type:'assistant', message: BetaMessage, parent_tool_use_id, uuid, session_id }
// BetaMessage.usage has input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens?.
function fakeAssistantMessage(opts: {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}) {
  return {
    type: 'assistant' as const,
    message: {
      model: opts.model ?? 'claude-sonnet-4-6',
      usage: {
        input_tokens: opts.inputTokens ?? 100,
        output_tokens: opts.outputTokens ?? 50,
        cache_read_input_tokens: opts.cacheReadTokens,
        cache_creation_input_tokens: opts.cacheWriteTokens,
      },
    },
    parent_tool_use_id: null,
    uuid: 'msg-uuid-1',
    session_id: 'sess-1',
  } as any;
}

describe('mapAssistantMessage', () => {
  it('extracts model + provider=anthropic + token counts', () => {
    const msg = fakeAssistantMessage({ model: 'claude-sonnet-4-6', inputTokens: 100, outputTokens: 50 });
    const { start, finish } = mapAssistantMessage(msg);
    expect(start).toEqual({
      type: 'llm_call',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    expect(finish.inputTokens).toBe(100);
    expect(finish.outputTokens).toBe(50);
  });

  it('maps cache_read_input_tokens → cacheReadTokens, cache_creation_input_tokens → cacheWriteTokens', () => {
    const msg = fakeAssistantMessage({ cacheReadTokens: 1024, cacheWriteTokens: 512 });
    const { finish } = mapAssistantMessage(msg);
    expect(finish.cacheReadTokens).toBe(1024);
    expect(finish.cacheWriteTokens).toBe(512);
  });

  it('omits cache token fields when upstream does not include them', () => {
    const msg = fakeAssistantMessage({});
    const { finish } = mapAssistantMessage(msg);
    expect(finish.cacheReadTokens).toBeUndefined();
    expect(finish.cacheWriteTokens).toBeUndefined();
  });

  it('handles missing model gracefully (returns undefined model)', () => {
    const msg = fakeAssistantMessage({});
    delete (msg.message as any).model;
    const { start } = mapAssistantMessage(msg);
    expect(start.model).toBeUndefined();
    expect(start.provider).toBe('anthropic');
  });

  it('handles missing usage gracefully (undefined tokens passthrough)', () => {
    const msg = fakeAssistantMessage({});
    delete (msg.message as any).usage;
    const { finish } = mapAssistantMessage(msg);
    expect(finish.inputTokens).toBeUndefined();
    expect(finish.outputTokens).toBeUndefined();
  });
});

describe('mapPreToolUse', () => {
  it('extracts tool_name + tool_input + tool_use_id', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-123',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
    };
    const { start, toolUseId, toolName } = mapPreToolUse(input);
    expect(start.type).toBe('tool_call');
    expect(start.name).toBe('Read');
    expect(start.input).toBe(JSON.stringify({ file_path: '/etc/hosts' }));
    expect(toolUseId).toBe('tu-123');
    expect(toolName).toBe('Read');
  });

  it('handles empty tool_input', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'NoArgsTool',
      tool_input: {},
    };
    const { start } = mapPreToolUse(input);
    expect(start.input).toBe('{}');
  });

  it('caps tool_input serialization at 4kB to avoid sending huge JSON blobs', () => {
    const huge = { data: 'x'.repeat(10_000) };
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'X',
      tool_input: huge,
    };
    const { start } = mapPreToolUse(input);
    expect((start.input ?? '').length).toBeLessThanOrEqual(4096);
  });

  it('handles undefined tool_input without throwing', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-undef',
      tool_name: 'X',
      tool_input: undefined,
    };
    const { start } = mapPreToolUse(input);
    expect(start.input).toBe('');
  });

  it('populates integration from MCP tool name (claude_ai_*)', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'mcp__claude_ai_Linear__list_issues',
      tool_input: {},
    };
    const { start } = mapPreToolUse(input);
    expect(start.integration).toBe('linear');
  });

  it('populates integration from MCP tool name (plugin_*)', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'mcp__plugin_slack_slack__send_message',
      tool_input: {},
    };
    const { start } = mapPreToolUse(input);
    expect(start.integration).toBe('slack');
  });

  it('integration is undefined for built-in tools (Bash, Read, etc.)', () => {
    const input = {
      hook_event_name: 'PreToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    };
    const { start } = mapPreToolUse(input);
    expect(start.integration).toBeUndefined();
  });
});

describe('detectIntegration', () => {
  it('extracts service from mcp__claude_ai_<Service>__<tool>', () => {
    expect(detectIntegration('mcp__claude_ai_Linear__list_issues')).toBe('linear');
    expect(detectIntegration('mcp__claude_ai_Vercel__deploy')).toBe('vercel');
    expect(detectIntegration('mcp__claude_ai_Notion__authenticate')).toBe('notion');
    expect(detectIntegration('mcp__claude_ai_Higgsfield__generate_image')).toBe('higgsfield');
  });

  it('extracts service from mcp__plugin_<service>_<service>__<tool>', () => {
    expect(detectIntegration('mcp__plugin_slack_slack__send_message')).toBe('slack');
    expect(detectIntegration('mcp__plugin_sentry_sentry__find_issues')).toBe('sentry');
    expect(detectIntegration('mcp__plugin_supabase_supabase__authenticate')).toBe('supabase');
    expect(detectIntegration('mcp__plugin_stripe_stripe__authenticate')).toBe('stripe');
  });

  it('returns undefined for non-MCP tools', () => {
    expect(detectIntegration('Bash')).toBeUndefined();
    expect(detectIntegration('Read')).toBeUndefined();
    expect(detectIntegration('ToolSearch')).toBeUndefined();
    expect(detectIntegration('subagent:reviewer')).toBeUndefined();
    expect(detectIntegration('')).toBeUndefined();
  });

  it('returns undefined for malformed MCP names', () => {
    expect(detectIntegration('mcp__')).toBeUndefined();
    expect(detectIntegration('mcp__foo')).toBeUndefined();
  });
});

describe('mapPostToolUse', () => {
  it('extracts tool_response as output (success)', () => {
    const input = {
      hook_event_name: 'PostToolUse' as const,
      tool_use_id: 'tu-123',
      tool_name: 'Read',
      tool_input: { file_path: '/etc/hosts' },
      tool_response: '127.0.0.1 localhost',
    };
    const { finish, toolUseId } = mapPostToolUse(input);
    expect(toolUseId).toBe('tu-123');
    expect(finish.output).toBe('127.0.0.1 localhost');
    expect(finish.errorMessage).toBeUndefined();
  });

  it('stringifies non-string tool_response', () => {
    const input = {
      hook_event_name: 'PostToolUse' as const,
      tool_use_id: 'tu-1',
      tool_name: 'X',
      tool_input: {},
      tool_response: { nested: { value: 42 } },
    };
    const { finish } = mapPostToolUse(input);
    expect(finish.output).toBe(JSON.stringify({ nested: { value: 42 } }));
  });

  it('handles undefined tool_response without throwing', () => {
    const input = {
      hook_event_name: 'PostToolUse' as const,
      tool_use_id: 'tu-undef',
      tool_name: 'X',
      tool_input: {},
      tool_response: undefined,
    };
    const { finish } = mapPostToolUse(input);
    expect(finish.output).toBe('');
  });
});

describe('mapPostToolUseFailure', () => {
  it('extracts error', () => {
    const input = {
      hook_event_name: 'PostToolUseFailure' as const,
      tool_use_id: 'tu-1',
      tool_name: 'Read',
      tool_input: {},
      error: 'File not found: /missing',
    };
    const { finish, toolUseId } = mapPostToolUseFailure(input);
    expect(toolUseId).toBe('tu-1');
    expect(finish.errorMessage).toBe('File not found: /missing');
  });

  it('stringifies non-string error', () => {
    const input = {
      hook_event_name: 'PostToolUseFailure' as const,
      tool_use_id: 'tu-1',
      tool_name: 'X',
      tool_input: {},
      error: { code: 'ENOENT', detail: 'nope' },
    };
    const { finish } = mapPostToolUseFailure(input);
    expect(finish.errorMessage).toContain('ENOENT');
  });

  it('handles undefined error without throwing', () => {
    const input = {
      hook_event_name: 'PostToolUseFailure' as const,
      tool_use_id: 'tu-undef',
      tool_name: 'X',
      tool_input: {},
      error: undefined,
    };
    const { finish } = mapPostToolUseFailure(input);
    expect(finish.errorMessage).toBe('');
  });
});

import { mapSubagentStart, mapSubagentStop } from './event-mapping.js';

describe('mapSubagentStart', () => {
  it('names the tool_call subagent:<agent_type> and uses agent_id as correlation key', () => {
    const input = {
      hook_event_name: 'SubagentStart' as const,
      agent_id: 'sub-abc-123',
      agent_type: 'code-reviewer',
    };
    const { start, subagentId } = mapSubagentStart(input);
    expect(start.type).toBe('tool_call');
    expect(start.name).toBe('subagent:code-reviewer');
    expect(subagentId).toBe('sub-abc-123');
  });
});

describe('mapSubagentStop', () => {
  it('returns last_assistant_message as output when present', () => {
    const input = {
      hook_event_name: 'SubagentStop' as const,
      stop_hook_active: false,
      agent_id: 'sub-1',
      agent_transcript_path: '/tmp/transcript.jsonl',
      agent_type: 'code-reviewer',
      last_assistant_message: 'Done reviewing — 3 issues found.',
    };
    const { finish, subagentId } = mapSubagentStop(input);
    expect(subagentId).toBe('sub-1');
    expect(finish.output).toBe('Done reviewing — 3 issues found.');
  });

  it('finishes without output when last_assistant_message is absent', () => {
    const input = {
      hook_event_name: 'SubagentStop' as const,
      stop_hook_active: false,
      agent_id: 'sub-1',
      agent_transcript_path: '/tmp/transcript.jsonl',
      agent_type: 'code-reviewer',
    };
    const { finish } = mapSubagentStop(input);
    expect(finish.output).toBeUndefined();
  });
});
