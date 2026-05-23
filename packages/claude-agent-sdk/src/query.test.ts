import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const claudeQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => claudeQueryMock(params),
}));

const startRunMock = vi.fn();
const startEventMock = vi.fn().mockImplementation(() => ({ finish: vi.fn().mockResolvedValue({ eventId: 'e', stopRequested: false }) }));
const updateAvailableToolsMock = vi.fn().mockResolvedValue(undefined);
const finishRunMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@jenz-ai/sdk', () => ({
  JenzClient: vi.fn().mockImplementation(() => ({ startRun: startRunMock })),
}));

import { query } from './query.js';
import { __resetClientForTests } from './client.js';

async function* fakeUpstream(msgs: any[]) {
  for (const m of msgs) yield m;
}

describe('query() — instrumented path', () => {
  const origKey = process.env.JENZ_API_KEY;

  beforeEach(() => {
    __resetClientForTests();
    process.env.JENZ_API_KEY = 'jk_test_123';
    claudeQueryMock.mockReset();
    startRunMock.mockReset();
    startEventMock.mockReset();
    updateAvailableToolsMock.mockReset();
    finishRunMock.mockReset();
    startRunMock.mockResolvedValue({
      id: 'run-1',
      signal: new AbortController().signal,
      startEvent: startEventMock,
      updateAvailableTools: updateAvailableToolsMock,
      finish: finishRunMock,
    });
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.JENZ_API_KEY;
    else process.env.JENZ_API_KEY = origKey;
  });

  it('starts a Run with framework=claude-agent + agentType=claude_code + agentName from options.agent', async () => {
    claudeQueryMock.mockReturnValue(fakeUpstream([
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ]));
    for await (const _ of query({ prompt: 'hi', options: { agent: 'reviewer' } } as any)) { /* drain */ }
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const args = startRunMock.mock.calls[0][0];
    expect(args.framework).toBe('claude-agent');
    expect(args.agentType).toBe('claude_code');
    expect(args.agentName).toBe('reviewer');
    expect(args.sdkVersion).toBeTruthy();
  });

  it('defaults agentName to "claude-agent" when options.agent missing', async () => {
    claudeQueryMock.mockReturnValue(fakeUpstream([
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ]));
    for await (const _ of query({ prompt: 'hi' } as any)) { /* drain */ }
    expect(startRunMock.mock.calls[0][0].agentName).toBe('claude-agent');
  });

  it('injects jenz hooks into options.hooks alongside user hooks', async () => {
    const userPreHook = vi.fn().mockResolvedValue({ continue: true });
    claudeQueryMock.mockImplementation((p) => {
      expect(p.options.hooks.PreToolUse).toHaveLength(2);
      expect(p.options.hooks.PreToolUse[0].hooks[0]).toBe(userPreHook);
      return fakeUpstream([{ type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 }]);
    });
    for await (const _ of query({
      prompt: 'hi',
      options: { hooks: { PreToolUse: [{ hooks: [userPreHook] }] } },
    } as any)) { /* drain */ }
    expect(claudeQueryMock).toHaveBeenCalledTimes(1);
  });

  it('emits llm_call + finishes the Run on success result', async () => {
    claudeQueryMock.mockReturnValue(fakeUpstream([
      { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 7 } } },
      { type: 'result', subtype: 'success', result: 'done', total_cost_usd: 0, duration_ms: 100, num_turns: 1 },
    ]));
    for await (const _ of query({ prompt: 'hi' } as any)) { /* drain */ }
    expect(startEventMock).toHaveBeenCalledWith({ type: 'llm_call', model: 'claude-sonnet-4-6', provider: 'anthropic' });
    expect(finishRunMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock.mock.calls[0][0].status).toBe('completed');
  });

  it('startRun returning null → pass-through, no instrumentation', async () => {
    startRunMock.mockResolvedValueOnce(null);
    claudeQueryMock.mockReturnValue(fakeUpstream([
      { type: 'assistant', message: { model: 'x', usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ]));
    for await (const _ of query({ prompt: 'hi' } as any)) { /* drain */ }
    expect(startEventMock).not.toHaveBeenCalled();
    expect(finishRunMock).not.toHaveBeenCalled();
  });

  it('startRun throwing → log + pass-through (does not break user code)', async () => {
    startRunMock.mockRejectedValueOnce(new Error('network down'));
    claudeQueryMock.mockReturnValue(fakeUpstream([
      { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 },
    ]));
    const seen: any[] = [];
    for await (const m of query({ prompt: 'hi' } as any)) seen.push(m);
    expect(seen).toHaveLength(1);
    expect(finishRunMock).not.toHaveBeenCalled();
  });
});
