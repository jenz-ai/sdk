import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRun, getActiveRun, __resetWithRunForTests } from './with-run.js';

const realFetch = global.fetch;

describe('withRun', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    process.env.JENZ_API_KEY = 'test-key';
    __resetWithRunForTests();
    fetchMock = vi.fn().mockImplementation((url: string, init?: { method?: string }) => {
      if (url.endsWith('/v1/runs') && (!init?.method || init.method === 'POST')) {
        return Promise.resolve(new Response(JSON.stringify({ runId: 'r1' }), { status: 200 }));
      }
      return Promise.resolve(
        new Response(JSON.stringify({ ok: true, stopRequested: false }), { status: 200 }),
      );
    });
    global.fetch = fetchMock;
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.JENZ_API_KEY;
  });

  it('starts a Run with framework=openai-agents', async () => {
    await withRun({ agentName: 'a', agentType: 'scheduled' }, async () => 'result');
    const startCall = fetchMock.mock.calls.find((c) => c[0].endsWith('/v1/runs'));
    expect(startCall).toBeDefined();
    const body = JSON.parse(startCall![1].body);
    expect(body).toMatchObject({
      agentName: 'a',
      agentType: 'scheduled',
      framework: 'openai-agents',
      sdkVersion: '0.1.0',
    });
  });

  it('finishes Run as completed on success and returns callback value', async () => {
    const result = await withRun({ agentName: 'a', agentType: 'scheduled' }, async () => 42);
    expect(result).toBe(42);
    const finishCall = fetchMock.mock.calls.find(
      (c) => c[0].includes('/v1/runs/r1') && c[1]?.method === 'PATCH',
    );
    expect(finishCall).toBeDefined();
    expect(JSON.parse(finishCall![1].body)).toMatchObject({ status: 'completed' });
  });

  it('finishes Run as errored and re-throws on thrown error', async () => {
    await expect(
      withRun({ agentName: 'a', agentType: 'scheduled' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const finishCall = fetchMock.mock.calls.find(
      (c) => c[0].includes('/v1/runs/r1') && c[1]?.method === 'PATCH',
    );
    expect(JSON.parse(finishCall![1].body)).toMatchObject({
      status: 'errored',
      errorMessage: 'boom',
    });
  });

  it('finishes Run as stopped when backend signals stopRequested via heartbeat', async () => {
    // Override fetchMock so the heartbeat PATCH returns stopRequested: true.
    fetchMock.mockImplementation((url: string, init?: { method?: string; body?: string }) => {
      if (url.endsWith('/v1/runs') && (!init?.method || init.method === 'POST')) {
        return Promise.resolve(new Response(JSON.stringify({ runId: 'r1' }), { status: 200 }));
      }
      // PATCH path: if body is empty `{}` (heartbeat), report stopRequested=true.
      const isHeartbeat = init?.body === '{}';
      return Promise.resolve(
        new Response(
          JSON.stringify({ ok: true, stopRequested: isHeartbeat }),
          { status: 200 },
        ),
      );
    });

    await expect(
      withRun({ agentName: 'a', agentType: 'scheduled' }, async () => {
        const r = getActiveRun()!;
        await r.heartbeat();  // Backend responds stopRequested → fires AbortSignal
        // Callback observes abort and propagates
        if (r.signal.aborted) throw new Error(String(r.signal.reason ?? 'aborted'));
        return 'should not reach';
      }),
    ).rejects.toThrow(/Stop requested/);

    // The finish PATCH should have body containing status: 'stopped'
    const finishCalls = fetchMock.mock.calls.filter(
      (c) => c[0].includes('/v1/runs/r1') && c[1]?.method === 'PATCH' && c[1]?.body !== '{}',
    );
    const finishBody = JSON.parse(finishCalls.at(-1)![1].body);
    expect(finishBody).toMatchObject({ status: 'stopped' });
  });

  it('runs callback dormant when JENZ_API_KEY is missing (no Run created)', async () => {
    delete process.env.JENZ_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let activeInside: unknown = 'untouched';
    const result = await withRun(
      { agentName: 'a', agentType: 'scheduled' },
      async () => {
        activeInside = getActiveRun();
        return 'done';
      },
    );
    expect(result).toBe('done');
    expect(activeInside).toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some((c) => c[0].endsWith('/v1/runs'))).toBe(false);
  });
});
