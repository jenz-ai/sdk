import { describe, it, expect, vi } from 'vitest';
import { Run } from './run.js';
import type { Transport } from './transport.js';

function fakeTransport(eventResponse: { eventId: string; stopRequested: boolean } = { eventId: 'e1', stopRequested: false }) {
  return {
    post: vi.fn().mockResolvedValue(eventResponse),
    patch: vi.fn().mockResolvedValue({ ok: true, stopRequested: false }),
    get: vi.fn(),
  } as unknown as Transport;
}

describe('Run', () => {
  it('exposes the runId and an AbortSignal', () => {
    const run = new Run({ transport: fakeTransport(), runId: 'r1' });
    expect(run.id).toBe('r1');
    expect(run.signal).toBeInstanceOf(AbortSignal);
    expect(run.signal.aborted).toBe(false);
  });

  it('startEvent returns an Event tied to this run', () => {
    const run = new Run({ transport: fakeTransport(), runId: 'r1' });
    const evt = run.startEvent({ type: 'llm_call', model: 'gpt-4o' });
    expect(evt).toBeDefined();
  });

  it('finish sends PATCH /v1/runs/:id with status + output', async () => {
    const t = fakeTransport();
    const run = new Run({ transport: t, runId: 'r1' });
    await run.finish({ status: 'completed', output: 'done' });
    expect(t.patch).toHaveBeenCalledWith('/v1/runs/r1', {
      status: 'completed',
      output: 'done',
      errorMessage: undefined,
      metadata: undefined,
    });
  });

  it('throws if finished twice', async () => {
    const run = new Run({ transport: fakeTransport(), runId: 'r1' });
    await run.finish({ status: 'completed' });
    await expect(run.finish({ status: 'completed' })).rejects.toThrow(/already finished/);
  });

  it('fires the AbortSignal when an event response says stopRequested=true', async () => {
    const t = fakeTransport({ eventId: 'e1', stopRequested: true });
    const run = new Run({ transport: t, runId: 'r1' });
    const evt = run.startEvent({ type: 'log' });
    expect(run.signal.aborted).toBe(false);
    await evt.finish({});
    expect(run.signal.aborted).toBe(true);
  });

  it('fires the AbortSignal when a heartbeat says stopRequested=true', async () => {
    const t = {
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ok: true, stopRequested: true }),
      get: vi.fn(),
    } as unknown as Transport;
    const run = new Run({ transport: t, runId: 'r1' });
    await run.heartbeat();
    expect(run.signal.aborted).toBe(true);
  });

  it('AbortSignal reason explains the stop source', async () => {
    const t = fakeTransport({ eventId: 'e1', stopRequested: true });
    const run = new Run({ transport: t, runId: 'r1' });
    const evt = run.startEvent({ type: 'log' });
    await evt.finish({});
    expect(run.signal.reason).toBeInstanceOf(Error);
    expect((run.signal.reason as Error).message).toMatch(/Stop requested/);
  });

  it('only fires the signal once even if multiple stopRequested responses arrive', async () => {
    const t = fakeTransport({ eventId: 'e1', stopRequested: true });
    const run = new Run({ transport: t, runId: 'r1' });
    const firstReason: unknown[] = [];
    run.signal.addEventListener('abort', () => firstReason.push(run.signal.reason));
    const evt1 = run.startEvent({ type: 'log' });
    await evt1.finish({});
    const evt2 = run.startEvent({ type: 'log' });
    await evt2.finish({});
    expect(firstReason).toHaveLength(1);
  });

  it('updateAvailableTools PATCHes /v1/runs/:id with the names array', async () => {
    const t = fakeTransport();
    const run = new Run({ transport: t, runId: 'r1' });
    await run.updateAvailableTools(['search_web', 'lookup_account']);
    expect(t.patch).toHaveBeenCalledWith('/v1/runs/r1', {
      toolsAvailable: ['search_web', 'lookup_account'],
    });
  });

  it('updateAvailableTools fires AbortSignal when backend returns stopRequested', async () => {
    const t = {
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue({ ok: true, stopRequested: true }),
      get: vi.fn(),
    } as unknown as Transport;
    const run = new Run({ transport: t, runId: 'r1' });
    expect(run.signal.aborted).toBe(false);
    await run.updateAvailableTools(['x']);
    expect(run.signal.aborted).toBe(true);
  });

  it('updateAvailableTools swallows null transport response', async () => {
    const t = {
      post: vi.fn(),
      patch: vi.fn().mockResolvedValue(null),
      get: vi.fn(),
    } as unknown as Transport;
    const run = new Run({ transport: t, runId: 'r1' });
    await expect(run.updateAvailableTools(['x'])).resolves.toBeUndefined();
  });

  it('updateAvailableTools is a no-op on empty array (no network call)', async () => {
    const t = fakeTransport();
    const run = new Run({ transport: t, runId: 'r1' });
    await run.updateAvailableTools([]);
    expect(t.patch).not.toHaveBeenCalled();
  });
});
