import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Transport } from './transport.js';

describe('Transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns parsed JSON body on successful POST', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ runId: 'r1', stopRequested: false }), { status: 200 }),
    );
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    const result = await t.post<{ runId: string; stopRequested: boolean }>('/v1/runs', {});
    expect(result).toEqual({ runId: 'r1', stopRequested: false });
  });

  it('sends bearer auth + content-type headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'secret' });
    await t.post('/v1/runs', {});
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/runs',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('returns null on non-2xx response (fire-and-forget)', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    const result = await t.post('/v1/runs', {});
    expect(result).toBeNull();
  });

  it('returns null on network error (fire-and-forget)', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    const result = await t.post('/v1/runs', {});
    expect(result).toBeNull();
  });

  it('strips trailing slash from baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
    const t = new Transport({ baseUrl: 'https://api.example.com/', apiKey: 'k' });
    await t.post('/v1/runs', {});
    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/v1/runs', expect.anything());
  });

  it('handles 204 No Content', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    const result = await t.post('/v1/runs', {});
    expect(result).toBeNull();
  });

  it('PATCH passes through method correctly', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock;
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k' });
    await t.patch('/v1/runs/r1', { status: 'completed' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/runs/r1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('respects custom timeout via abort signal', async () => {
    // fetch never resolves; abort signal should make the request reject internally.
    global.fetch = vi.fn().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: 'k', timeoutMs: 50 });
    const start = Date.now();
    const result = await t.post('/v1/runs', {});
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(200);
  });

  it('does not include Authorization when apiKey is empty (signals dev/misconfigured)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock;
    const t = new Transport({ baseUrl: 'https://api.example.com', apiKey: '' });
    await t.post('/v1/runs', {});
    const call = fetchMock.mock.calls[0];
    expect(call[1].headers.Authorization).toBeUndefined();
  });
});
