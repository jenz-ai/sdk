import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRun, getActiveRun } from './with-run.js';

describe('withRun + getActiveRun', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.JENZ_API_KEY = 'test-key';
    let runCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/runs')) {
        runCount += 1;
        return Promise.resolve(new Response(JSON.stringify({ runId: `r${runCount}` }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, stopRequested: false }), { status: 200 }));
    });
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.JENZ_API_KEY;
  });

  it('returns undefined outside withRun', () => {
    expect(getActiveRun()).toBeUndefined();
  });

  it('exposes the active run inside the callback', async () => {
    let captured: string | undefined;
    await withRun({ agentName: 'test', agentType: 'manual' }, async () => {
      const run = getActiveRun();
      captured = run?.id;
    });
    expect(captured).toBe('r1');
  });

  it('threads run through nested async calls', async () => {
    const ids: (string | undefined)[] = [];
    await withRun({ agentName: 'test', agentType: 'manual' }, async () => {
      ids.push(getActiveRun()?.id);
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      ids.push(getActiveRun()?.id);
    });
    expect(ids).toEqual(['r1', 'r1']);
  });

  it('finishes the run with completed status on success', async () => {
    await withRun({ agentName: 'test', agentType: 'manual' }, async () => {
      // no-op body
    });
    const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      c[0].includes('/v1/runs/r1'),
    );
    expect(patchCalls).toHaveLength(1);
    const body = JSON.parse(patchCalls[0][1].body);
    expect(body.status).toBe('completed');
  });

  it('finishes the run with errored status when callback throws', async () => {
    await expect(
      withRun({ agentName: 'test', agentType: 'manual' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter((c) =>
      c[0].includes('/v1/runs/r1'),
    );
    expect(patchCalls).toHaveLength(1);
    const body = JSON.parse(patchCalls[0][1].body);
    expect(body.status).toBe('errored');
    expect(body.errorMessage).toBe('boom');
  });

  it('finishes with stopped status when AbortSignal fires from within', async () => {
    // simulate a stopRequested response by switching after the first run is started
    let stopFlag = false;
    let runCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/runs')) {
        runCount += 1;
        return Promise.resolve(new Response(JSON.stringify({ runId: `r${runCount}` }), { status: 200 }));
      }
      if (url.endsWith('/v1/events')) {
        return Promise.resolve(
          new Response(JSON.stringify({ eventId: 'e1', stopRequested: stopFlag }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, stopRequested: stopFlag }), { status: 200 }));
    });

    await withRun({ agentName: 'stop', agentType: 'manual' }, async () => {
      stopFlag = true;
      const run = getActiveRun();
      run!.startEvent({ type: 'log' });
      await run!.heartbeat();
      // signal is now aborted — callback bails by itself
    });
    const patchCalls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0].includes('/v1/runs/r1') && c[1].method === 'PATCH',
    );
    // PATCHes: 1 heartbeat (empty body) + 1 finish. Find the finish (has status field).
    const finish = patchCalls.find((c) => JSON.parse(c[1].body).status);
    expect(finish).toBeDefined();
    expect(JSON.parse(finish![1].body).status).toBe('stopped');
  });

  it('passes through callback return value', async () => {
    const result = await withRun({ agentName: 'test', agentType: 'manual' }, async () => {
      return { answer: 42 };
    });
    expect(result).toEqual({ answer: 42 });
  });

  it('falls back to running the callback without observability when backend is unreachable', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const result = await withRun(
      { agentName: 'test', agentType: 'manual' },
      async () => 'still ran',
    );
    expect(result).toBe('still ran');
  });
});
