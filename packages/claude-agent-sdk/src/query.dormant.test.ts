import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claudeQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => claudeQueryMock(params),
}));

import { query } from './query.js';
import { __resetClientForTests } from './client.js';

async function* fakeUpstream(msgs: any[]) {
  for (const m of msgs) yield m;
}

describe('query() — dormant mode (no JENZ_API_KEY)', () => {
  const origKey = process.env.JENZ_API_KEY;

  beforeEach(() => {
    __resetClientForTests();
    delete process.env.JENZ_API_KEY;
    claudeQueryMock.mockReset();
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.JENZ_API_KEY;
    else process.env.JENZ_API_KEY = origKey;
  });

  it('passes params through to upstream untouched (no hooks injected)', async () => {
    claudeQueryMock.mockReturnValue(fakeUpstream([{ type: 'result', subtype: 'success' }]));
    const userHooks = { PreToolUse: [{ hooks: [vi.fn()] }] };
    for await (const _ of query({ prompt: 'hi', options: { hooks: userHooks } } as any)) { /* drain */ }
    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
    const passed = claudeQueryMock.mock.calls[0][0];
    expect(passed.options.hooks).toEqual(userHooks);
  });

  it('yields every upstream message unchanged', async () => {
    const msgs = [
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { model: 'x' } },
      { type: 'result', subtype: 'success' },
    ];
    claudeQueryMock.mockReturnValue(fakeUpstream(msgs));
    const seen: any[] = [];
    for await (const m of query({ prompt: 'hi' } as any)) seen.push(m);
    expect(seen).toEqual(msgs);
  });

  it('warns once per process about missing JENZ_API_KEY', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    claudeQueryMock.mockReturnValue(fakeUpstream([{ type: 'result', subtype: 'success' }]));
    for await (const _ of query({ prompt: 'a' } as any)) { /* drain */ }
    for await (const _ of query({ prompt: 'b' } as any)) { /* drain */ }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('JENZ_API_KEY');
    warn.mockRestore();
  });
});
