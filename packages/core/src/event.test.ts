import { describe, it, expect, vi } from 'vitest';
import { Event } from './event.js';
import type { Transport } from './transport.js';

function fakeTransport(response: { eventId: string; stopRequested: boolean } | null = {
  eventId: 'e1',
  stopRequested: false,
}) {
  return {
    post: vi.fn().mockResolvedValue(response),
    patch: vi.fn(),
    get: vi.fn(),
  } as unknown as Transport;
}

describe('Event', () => {
  it('sends type + model + provider on finish', async () => {
    const t = fakeTransport();
    const evt = new Event({
      transport: t,
      runId: 'r1',
      type: 'llm_call',
      model: 'gpt-4o',
      provider: 'openai',
    });
    await evt.finish({ inputTokens: 100, outputTokens: 50 });

    expect(t.post).toHaveBeenCalledWith(
      '/v1/events',
      expect.objectContaining({
        runId: 'r1',
        type: 'llm_call',
        model: 'gpt-4o',
        provider: 'openai',
        inputTokens: 100,
        outputTokens: 50,
      }),
    );
  });

  it('forwards cacheReadTokens, cacheWriteTokens, ttftMs, attempt on finish', async () => {
    const t = fakeTransport();
    const evt = new Event({ transport: t, runId: 'r1', type: 'llm_call', model: 'claude-sonnet-4-6' });
    await evt.finish({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
      ttftMs: 240,
      attempt: 2,
    });

    expect(t.post).toHaveBeenCalledWith(
      '/v1/events',
      expect.objectContaining({
        cacheReadTokens: 1000,
        cacheWriteTokens: 100,
        ttftMs: 240,
        attempt: 2,
      }),
    );
  });

  it('throws if finished twice', async () => {
    const evt = new Event({ transport: fakeTransport(), runId: 'r1', type: 'log' });
    await evt.finish({});
    await expect(evt.finish({})).rejects.toThrow(/already finished/);
  });

  it('computes latencyMs from start to finish', async () => {
    const t = fakeTransport();
    const evt = new Event({ transport: t, runId: 'r1', type: 'tool_call', name: 'search' });
    await new Promise((r) => setTimeout(r, 10));
    await evt.finish({});
    const payload = (t.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload.latencyMs).toBeGreaterThanOrEqual(10);
  });

  it('includes parentEventId when provided', async () => {
    const t = fakeTransport();
    const evt = new Event({
      transport: t,
      runId: 'r1',
      type: 'tool_call',
      name: 'inner',
      parentEventId: 'p1',
    });
    await evt.finish({});
    const payload = (t.post as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload.parentEventId).toBe('p1');
  });

  it('returns the transport response (including stopRequested)', async () => {
    const t = fakeTransport({ eventId: 'e2', stopRequested: true });
    const evt = new Event({ transport: t, runId: 'r1', type: 'log' });
    const res = await evt.finish({});
    expect(res?.stopRequested).toBe(true);
  });

  it('finish is idempotent against transport failures (returns null)', async () => {
    const t = fakeTransport(null);
    const evt = new Event({ transport: t, runId: 'r1', type: 'log' });
    const res = await evt.finish({});
    expect(res).toBeNull();
    // Calling finish again should still throw — finished flag flips before transport call.
    await expect(evt.finish({})).rejects.toThrow(/already finished/);
  });
});
