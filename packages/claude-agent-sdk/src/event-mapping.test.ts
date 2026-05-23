import { describe, it, expect } from 'vitest';
import { mapAssistantMessage } from './event-mapping.js';

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
