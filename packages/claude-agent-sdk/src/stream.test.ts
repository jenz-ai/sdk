import { describe, it, expect, vi } from 'vitest';
import { wrapQueryStream } from './stream.js';

function makeFakeRun() {
  const events: any[] = [];
  const finishedAs: any[] = [];
  const finishEvent = vi.fn().mockResolvedValue({ eventId: 'e', stopRequested: false });
  const startEvent = vi.fn().mockImplementation((input: any) => {
    const evt = { finish: finishEvent };
    events.push({ input, evt });
    return evt;
  });
  const finishRun = vi.fn().mockImplementation(async (input: any) => {
    finishedAs.push(input);
  });
  return { events, finishedAs, startEvent, finish: finishRun } as any;
}

async function* makeStream<T>(msgs: T[]): AsyncGenerator<T, void> {
  for (const m of msgs) yield m;
}

describe('wrapQueryStream', () => {
  it('yields every upstream message unchanged', async () => {
    const run = makeFakeRun();
    const upstream = makeStream<any>([
      { type: 'system', subtype: 'init' },
      { type: 'user', message: { content: 'hi' } },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, duration_ms: 100, num_turns: 1 } as any,
    ]);
    const seen: any[] = [];
    for await (const msg of wrapQueryStream(upstream as any, Promise.resolve(run))) {
      seen.push(msg);
    }
    expect(seen).toHaveLength(3);
    expect(seen[0].type).toBe('system');
  });

  it('emits llm_call event on SDKAssistantMessage with token usage', async () => {
    const run = makeFakeRun();
    const upstream = makeStream<any>([
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 50 },
        },
      },
      { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.001, duration_ms: 500, num_turns: 1 } as any,
    ]);
    for await (const _ of wrapQueryStream(upstream as any, Promise.resolve(run))) { /* drain */ }
    expect(run.startEvent).toHaveBeenCalledWith({ type: 'llm_call', model: 'claude-sonnet-4-6', provider: 'anthropic' });
    const evt = run.events[0].evt;
    expect(evt.finish).toHaveBeenCalledWith({ inputTokens: 200, outputTokens: 80, cacheReadTokens: 50, cacheWriteTokens: undefined });
  });

  it('calls run.finish on SDKResultMessage with status=completed + metadata.costUsd/durationMs/numTurns/ttftMs', async () => {
    const run = makeFakeRun();
    const upstream = makeStream<any>([
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0.005, duration_ms: 1234, num_turns: 3, ttft_ms: 250 } as any,
    ]);
    for await (const _ of wrapQueryStream(upstream as any, Promise.resolve(run))) { /* drain */ }
    expect(run.finish).toHaveBeenCalledTimes(1);
    expect(run.finish.mock.calls[0][0]).toMatchObject({
      status: 'completed',
      output: 'done',
      metadata: { costUsd: 0.005, durationMs: 1234, numTurns: 3, ttftMs: 250 },
    });
  });

  it('calls run.finish with status=errored on SDKResultMessage with subtype starting "error_"', async () => {
    const run = makeFakeRun();
    const upstream = makeStream<any>([
      { type: 'result', subtype: 'error_max_turns' } as any,
    ]);
    for await (const _ of wrapQueryStream(upstream as any, Promise.resolve(run))) { /* drain */ }
    expect(run.finish.mock.calls[0][0]).toMatchObject({ status: 'errored', errorMessage: 'error_max_turns' });
  });

  it('calls run.finish with status=errored and re-throws when upstream throws', async () => {
    const run = makeFakeRun();
    async function* throwing(): AsyncGenerator<any, void> {
      yield { type: 'system', subtype: 'init' };
      throw new Error('boom');
    }
    await expect(async () => {
      for await (const _ of wrapQueryStream(throwing() as any, Promise.resolve(run))) { /* drain */ }
    }).rejects.toThrow('boom');
    expect(run.finish).toHaveBeenCalledWith({ status: 'errored', errorMessage: 'boom' });
  });

  it('runPromise resolves to null → no events emitted, but yielding still works', async () => {
    const upstream = makeStream<any>([
      { type: 'assistant', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'result', subtype: 'success', result: 'x', total_cost_usd: 0, duration_ms: 1, num_turns: 1 } as any,
    ]);
    const seen: any[] = [];
    for await (const m of wrapQueryStream(upstream as any, Promise.resolve(null))) seen.push(m);
    expect(seen).toHaveLength(2);
  });
});
