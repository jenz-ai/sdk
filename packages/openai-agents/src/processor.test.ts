import { describe, it, expect, vi, beforeEach } from 'vitest';
import { JenzTracingProcessor } from './processor.js';
import { runContext } from './als.js';
import type { Run } from '@jenz-ai/sdk';

// Lightweight Run mock — supports the methods the processor calls.
function fakeRun(overrides: Record<string, unknown> = {}) {
  const abortCtrl = new AbortController();
  const finished = vi.fn().mockResolvedValue(undefined);
  const updateTools = vi.fn().mockResolvedValue(undefined);
  const startEvent = vi.fn().mockImplementation(() => ({
    finish: vi.fn().mockResolvedValue({ eventId: 'e1', stopRequested: false }),
  }));
  return {
    id: 'r-fake',
    get signal() { return abortCtrl.signal; },
    finish: finished,
    updateAvailableTools: updateTools,
    startEvent,
    heartbeat: vi.fn(),
    __abortCtrl: abortCtrl,
    ...overrides,
  } as unknown as Run & { __abortCtrl: AbortController };
}

function fakeClient(run: Run | null) {
  return {
    startRun: vi.fn().mockResolvedValue(run),
  } as any;
}

function fakeTrace(name = 'Agent workflow', traceId = 't1') {
  return { traceId, name, groupId: null, metadata: {} } as any;
}
function fakeSpan(data: any, traceId = 't1', parentId: string | null = null) {
  const spanId = 's' + Math.random().toString(36).slice(2, 8);
  return {
    traceId,
    spanId,
    parentId,
    spanData: data,
    startedAt: '2026-05-14T12:00:00.000Z',
    endedAt: '2026-05-14T12:00:00.500Z',
    error: null,
  } as any;
}

describe('JenzTracingProcessor', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('onTraceStart auto-creates Run when no ALS context', async () => {
    const run = fakeRun();
    const client = fakeClient(run);
    const p = new JenzTracingProcessor(client, { defaultAgentType: 'manual' });
    await p.onTraceStart(fakeTrace('my-flow'));
    expect(client.startRun).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'my-flow',
        agentType: 'manual',
        framework: 'openai-agents',
      }),
    );
  });

  it('onTraceStart binds to existing Run when withRun is active', async () => {
    const existing = fakeRun();
    const client = fakeClient(fakeRun());
    const p = new JenzTracingProcessor(client, {});
    await runContext.run({ run: existing }, async () => {
      await p.onTraceStart(fakeTrace());
    });
    expect(client.startRun).not.toHaveBeenCalled();
  });

  it('onSpanStart(agent) calls updateAvailableTools with the tools', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    await p.onSpanStart(fakeSpan({ type: 'agent', name: 'a', tools: ['x', 'y'] }));
    expect(run.updateAvailableTools).toHaveBeenCalledWith(['x', 'y']);
  });

  it('onSpanStart(agent) unions tools across multiple agent spans', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    await p.onSpanStart(fakeSpan({ type: 'agent', name: 'a', tools: ['x'] }));
    await p.onSpanStart(fakeSpan({ type: 'agent', name: 'b', tools: ['x', 'y'] }));
    expect((run.updateAvailableTools as any).mock.calls).toEqual([
      [['x']],
      [['x', 'y']],
    ]);
  });

  it('onSpanEnd(generation) emits llm_call event on the bound Run', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    await p.onSpanEnd(
      fakeSpan({ type: 'generation', model: 'gpt-4o', usage: { input_tokens: 5, output_tokens: 3 } }),
    );
    expect(run.startEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'llm_call', model: 'gpt-4o' }),
    );
  });

  it('onSpanEnd(function) attaches parent agent name to metadata', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    const agentSpan = fakeSpan({ type: 'agent', name: 'billing', tools: ['t'] });
    const fnSpan = fakeSpan(
      { type: 'function', name: 'lookup', input: '{}', output: 'x' },
      't1',
      agentSpan.spanId,
    );
    await p.onSpanStart(agentSpan);  // registers agent name in spanId map
    await p.onSpanEnd(agentSpan);    // no-op for agent spans (early return)
    await p.onSpanEnd(fnSpan);
    const lastCall = (run.startEvent as any).mock.calls.at(-1)[0];
    expect(lastCall).toMatchObject({
      type: 'tool_call',
      name: 'lookup',
      metadata: { agentName: 'billing' },
    });
  });

  it('onTraceEnd finishes Run when ownedByUs=true (auto-path)', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    const trace = fakeTrace();
    await p.onTraceStart(trace);
    await p.onTraceEnd(trace);
    expect(run.finish).toHaveBeenCalledWith({ status: 'completed' });
  });

  it('onTraceEnd does NOT finish Run when ownedByUs=false (withRun-bound)', async () => {
    const existing = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(fakeRun()), {});
    const trace = fakeTrace();
    await runContext.run({ run: existing }, async () => {
      await p.onTraceStart(trace);
      await p.onTraceEnd(trace);
    });
    expect(existing.finish).not.toHaveBeenCalled();
  });

  it('finishes Run as stopped when run.signal aborted (auto-path)', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    const trace = fakeTrace();
    await p.onTraceStart(trace);
    (run as any).__abortCtrl.abort(new Error('stop'));
    await p.onTraceEnd(trace);
    expect(run.finish).toHaveBeenCalledWith({ status: 'stopped' });
  });

  it('swallows errors from updateAvailableTools (does not throw)', async () => {
    const run = fakeRun({
      updateAvailableTools: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    await expect(
      p.onSpanStart(fakeSpan({ type: 'agent', name: 'a', tools: ['x'] })),
    ).resolves.toBeUndefined();
  });

  it('swallows errors from startEvent.finish (does not throw)', async () => {
    const run = fakeRun({
      startEvent: vi.fn().mockReturnValue({
        finish: vi.fn().mockRejectedValue(new Error('boom')),
      }),
    });
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await p.onTraceStart(fakeTrace());
    await expect(
      p.onSpanEnd(fakeSpan({ type: 'generation', model: 'gpt-4o' })),
    ).resolves.toBeUndefined();
  });

  it('cleans up trace state even when run.finish rejects', async () => {
    const run = fakeRun({
      finish: vi.fn().mockRejectedValue(new Error('network down')),
    });
    const p = new JenzTracingProcessor(fakeClient(run), {});
    const trace = fakeTrace();
    await p.onTraceStart(trace);
    // Confirm state exists
    expect((p as any).traces.has(trace.traceId)).toBe(true);
    // onTraceEnd should swallow the rejection AND clean up the map
    await p.onTraceEnd(trace);
    expect((p as any).traces.has(trace.traceId)).toBe(false);
  });
});
