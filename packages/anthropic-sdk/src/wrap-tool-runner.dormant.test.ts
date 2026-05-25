import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { wrapToolRunner } from './wrap-tool-runner.js';
import { __resetClientForTests } from './client.js';

// NO vi.mock of @jenz-ai/sdk here — we rely on the real JenzClient
// constructor, which throws when JENZ_API_KEY is unset. That's how
// tryCreateClient() decides to return null and trigger pass-through mode.

function makeRunner(streams: AsyncIterable<unknown>[]) {
  return {
    params: { model: 'claude-opus-4-7', messages: [] },
    async *[Symbol.asyncIterator]() {
      for (const s of streams) yield s;
    },
  } as any;
}

describe('wrapToolRunner — dormant mode (no JENZ_API_KEY)', () => {
  const origKey = process.env.JENZ_API_KEY;

  beforeEach(() => {
    __resetClientForTests();
    delete process.env.JENZ_API_KEY;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.JENZ_API_KEY;
    else process.env.JENZ_API_KEY = origKey;
    vi.restoreAllMocks();
  });

  it('returns the runner pass-through and warns once', async () => {
    const innerStream: AsyncIterable<unknown> = {
      async *[Symbol.asyncIterator]() {
        yield { type: 'placeholder' };
      },
    };
    const runner = makeRunner([innerStream]);
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });

    const seen: unknown[] = [];
    for await (const stream of wrapped) {
      for await (const ev of stream as AsyncIterable<unknown>) seen.push(ev);
    }
    expect(seen).toEqual([{ type: 'placeholder' }]);
  });

  it('warns at most once per process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runner1 = makeRunner([]);
    const runner2 = makeRunner([]);
    wrapToolRunner(runner1, { agentName: 'a' });
    wrapToolRunner(runner2, { agentName: 'b' });
    // Only the first call emits the warning; the cached null/state lets us
    // skip on the second.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('JENZ_API_KEY');
  });
});
