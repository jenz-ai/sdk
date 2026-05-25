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

  // JEN-62: output text was being dropped from generation spans — llm_call events
  // arrived at the api with empty `output` despite `outputTokens > 0`. The
  // upstream sets `spanData.output = [response]` where `response` is the raw
  // OpenAI chat-completion response (with `.choices[0].message.{content,tool_calls}`).
  it('captures assistant text from generation span output[0].choices[0].message.content', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 },
      output: [
        {
          choices: [
            { message: { role: 'assistant', content: 'Hello from the model.' } },
          ],
        },
      ],
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBe('Hello from the model.');
  });

  it('captures generation span tool_calls as JSON the dashboard can render as → wants to call X', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      output: [
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search_web', arguments: '{"q":"hi"}' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const payload = mapSpanToEvent(span, undefined);
    // Dashboard's describeToolUse parses the JSON and looks for `type: 'tool_use'`
    // with a `name` field — so normalise OpenAI's nested function-call shape.
    expect(payload!.finish.output).toBeDefined();
    const parsed = JSON.parse(payload!.finish.output!);
    expect(parsed).toMatchObject({ type: 'tool_use', name: 'search_web' });
  });

  it('joins assistant text + tool_calls into a single output (mixed)', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      output: [
        {
          choices: [
            {
              message: {
                role: 'assistant',
                content: 'Let me search that.',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'search_web', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toContain('Let me search that.');
    expect(payload!.finish.output).toContain('search_web');
    expect(payload!.finish.output).toContain('"type":"tool_use"');
  });

  it('omits finish.output when generation span has no output array', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBeUndefined();
  });

  it('omits finish.output when generation choices yield no usable content', () => {
    const span = fakeSpan({
      type: 'generation',
      model: 'gpt-4o',
      output: [{ choices: [{ message: { role: 'assistant', content: null } }] }],
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBeUndefined();
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

  // JEN-62: response spans (Responses API) emit `_response.output` as an array
  // of items — `{ type: 'message', content: [{ type: 'output_text', text }] }`
  // for assistant text, `{ type: 'function_call', name, arguments }` for tool
  // calls. Both were being dropped, leaving llm_call events with empty `output`.
  it('captures assistant text from response span _response.output output_text items', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        model: 'gpt-4o',
        usage: { input_tokens: 10, output_tokens: 5 },
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello there!' }],
          },
        ],
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBe('Hello there!');
  });

  it('captures response span function_call items as JSON the dashboard can render', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        model: 'gpt-4o',
        output: [
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup_account',
            arguments: '{"id":"acc-9"}',
          },
        ],
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBeDefined();
    const parsed = JSON.parse(payload!.finish.output!);
    expect(parsed).toMatchObject({ type: 'tool_use', name: 'lookup_account' });
  });

  it('joins response span message text + function_call into mixed output', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        model: 'gpt-4o',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'I will look that up.' }],
          },
          {
            type: 'function_call',
            call_id: 'call_1',
            name: 'lookup_account',
            arguments: '{}',
          },
        ],
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toContain('I will look that up.');
    expect(payload!.finish.output).toContain('lookup_account');
    expect(payload!.finish.output).toContain('"type":"tool_use"');
  });

  it('concatenates multiple output_text segments in a single message item', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        model: 'gpt-4o',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'first' },
              { type: 'output_text', text: 'second' },
            ],
          },
        ],
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBe('first\nsecond');
  });

  it('omits finish.output when response span has no output items', () => {
    const span = fakeSpan({
      type: 'response',
      _response: { model: 'gpt-4o', usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBeUndefined();
  });

  it('omits finish.output when response span has only unknown item types', () => {
    const span = fakeSpan({
      type: 'response',
      _response: {
        output: [{ type: 'reasoning', summary: [] }],
      },
    });
    const payload = mapSpanToEvent(span, undefined);
    expect(payload!.finish.output).toBeUndefined();
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
