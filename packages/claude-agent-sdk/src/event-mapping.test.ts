import { describe, it, expect } from 'vitest';
import { mapAssistantMessage, mapPreToolUse, mapPostToolUse, mapPostToolUseFailure } from './event-mapping.js';

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
});
