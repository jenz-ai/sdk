import { describe, it, expect } from 'vitest';
import { mapSpanToEvent } from './span-mapping.js';
import type { Span } from '@openai/agents-core';

// Minimal Span stub — we only read the fields we map.
function fakeSpan<TData extends { type: string }>(
  data: TData,
  opts: { startedAt?: string; endedAt?: string; error?: { message: string } } = {},
): Span<any> {
  return {
    spanData: data,
    startedAt: opts.startedAt ?? '2026-05-14T12:00:00.000Z',
    endedAt: opts.endedAt ?? '2026-05-14T12:00:00.500Z',
    error: opts.error ?? null,
    traceId: 't1',
    spanId: 's1',
    parentId: null,
  } as unknown as Span<any>;
}

describe('mapSpanToEvent — generation spans', () => {
  it('maps generation span → llm_call with model + provider + tokens', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      model_config: { provider: 'openai' },
      usage: { input_tokens: 142, output_tokens: 23 },
    });
    const payload = mapSpanToEvent(span, 'research-bot');
    expect(payload).not.toBeNull();
    expect(payload!.start).toMatchObject({
      type: 'llm_call',
      model: 'gpt-4o',
      provider: 'openai',
      metadata: { agentName: 'research-bot' },
    });
    expect(payload!.finish).toMatchObject({
      inputTokens: 142,
      outputTokens: 23,
    });
  });

  it('extracts cacheReadTokens from usage.details.input_tokens_details.cached_tokens', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        details: { input_tokens_details: { cached_tokens: 150 } },
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.cacheReadTokens).toBe(150);
  });

  it('emits llm_call with undefined tokens when usage missing', () => {
    const span = fakeSpan({ type: 'generation', model: 'gpt-4o' });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.inputTokens).toBeUndefined();
    expect(payload!.finish.outputTokens).toBeUndefined();
  });

  it('propagates span error to errorMessage', () => {
    const span = fakeSpan(
      { type: 'generation', model: 'gpt-4o' },
      { error: { message: 'rate limited' } },
    );
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.errorMessage).toBe('rate limited');
  });

  it('defaults provider to "openai" when model_config absent', () => {
    const span = fakeSpan({ type: 'generation', model: 'gpt-4o' });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.start.provider).toBe('openai');
  });
});

describe('mapSpanToEvent — response spans', () => {
  it('maps response span → llm_call with model from _response', () => {
    const span = fakeSpan({
      type: 'response',
      response_id: 'resp_123',
      _response: { model: 'gpt-4o-mini', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const payload = mapSpanToEvent(span, 'agent-a');
    expect(payload!.start.type).toBe('llm_call');
    expect(payload!.start.model).toBe('gpt-4o-mini');
    expect(payload!.finish.inputTokens).toBe(10);
    expect(payload!.finish.outputTokens).toBe(5);
  });

  it('handles response span without _response (minimal)', () => {
    const span = fakeSpan({ type: 'response', response_id: 'resp_456' });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.start.type).toBe('llm_call');
    expect(payload!.finish.inputTokens).toBeUndefined();
  });

  it('extracts cacheReadTokens from response _response.usage.details', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        model: 'gpt-4o',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          details: { input_tokens_details: { cached_tokens: 75 } },
        },
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.cacheReadTokens).toBe(75);
  });
});

describe('mapSpanToEvent — function spans', () => {
  it('maps function span → tool_call with name', () => {
    const span = fakeSpan({ type: 'function', name: 'search_web', input: '{}', output: '...' });
    const payload = mapSpanToEvent(span, 'agent-a');
    expect(payload!.start).toMatchObject({
      type: 'tool_call',
      name: 'search_web',
      metadata: { agentName: 'agent-a' },
    });
  });

  it('propagates function error to errorMessage', () => {
    const span = fakeSpan(
      { type: 'function', name: 'search_web', input: '{}', output: '' },
      { error: { message: 'tool exploded' } },
    );
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.errorMessage).toBe('tool exploded');
  });
});

describe('mapSpanToEvent — handoff spans', () => {
  it('maps handoff span → log with name "handoff:A→B"', () => {
    const span = fakeSpan({ type: 'handoff', from_agent: 'triage', to_agent: 'billing' });
    const payload = mapSpanToEvent(span, 'triage');
    expect(payload!.start).toMatchObject({
      type: 'log',
      name: 'handoff:triage→billing',
      metadata: { agentName: 'triage' },
    });
  });

  it('handles handoff span with missing agent names', () => {
    const span = fakeSpan({ type: 'handoff' });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.start.name).toBe('handoff:?→?');
  });
});

describe('mapSpanToEvent — guardrail spans', () => {
  it('maps guardrail (not triggered) → log without error', () => {
    const span = fakeSpan({ type: 'guardrail', name: 'profanity', triggered: false });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.start.name).toBe('guardrail:profanity');
    expect(payload!.finish.errorMessage).toBeUndefined();
  });

  it('maps guardrail (triggered) → log with errorMessage="triggered"', () => {
    const span = fakeSpan({ type: 'guardrail', name: 'profanity', triggered: true });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.errorMessage).toBe('triggered');
  });

  it('triggered=true takes priority over span error in errorMessage', () => {
    const span = fakeSpan(
      { type: 'guardrail', name: 'profanity', triggered: true },
      { error: { message: 'evaluation crashed' } },
    );
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.errorMessage).toBe('triggered');
  });
});

describe('mapSpanToEvent — skipped span types', () => {
  it('returns null for agent spans', () => {
    expect(mapSpanToEvent(fakeSpan({ type: 'agent', name: 'x' }), undefined)).toBeNull();
  });

  it('returns null for speech/transcription/mcp_tools/speech_group', () => {
    for (const type of ['speech', 'transcription', 'mcp_tools', 'speech_group'] as const) {
      expect(mapSpanToEvent(fakeSpan({ type } as any), undefined)).toBeNull();
    }
  });
});
