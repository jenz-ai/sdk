import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JenzClient } from './client.js';

describe('JenzClient', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ runId: 'r1' }), { status: 200 }));
  });
  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.JENZ_API_KEY;
    delete process.env.JENZ_BASE_URL;
  });

  it('reads apiKey from JENZ_API_KEY env var by default', async () => {
    process.env.JENZ_API_KEY = 'env-key';
    const client = new JenzClient();
    await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer env-key' }),
      }),
    );
  });

  it('explicit apiKey overrides env var', async () => {
    process.env.JENZ_API_KEY = 'env-key';
    const client = new JenzClient({ apiKey: 'explicit' });
    await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer explicit' }),
      }),
    );
  });

  it('throws if neither apiKey nor JENZ_API_KEY env var is set', () => {
    expect(() => new JenzClient()).toThrow(/No API key/);
  });

  it('uses default baseUrl https://api.jenz.dev', async () => {
    process.env.JENZ_API_KEY = 'k';
    const client = new JenzClient();
    await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.jenz.dev/v1/runs',
      expect.anything(),
    );
  });

  it('respects JENZ_BASE_URL env var', async () => {
    process.env.JENZ_API_KEY = 'k';
    process.env.JENZ_BASE_URL = 'https://staging.api.jenz.dev';
    const client = new JenzClient();
    await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://staging.api.jenz.dev/v1/runs',
      expect.anything(),
    );
  });

  it('explicit baseUrl overrides env', async () => {
    process.env.JENZ_API_KEY = 'k';
    process.env.JENZ_BASE_URL = 'https://staging.api.jenz.dev';
    const client = new JenzClient({ baseUrl: 'https://other.example.com' });
    await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://other.example.com/v1/runs',
      expect.anything(),
    );
  });

  it('startRun sends framework, sdkVersion, toolsAvailable when provided', async () => {
    process.env.JENZ_API_KEY = 'k';
    const client = new JenzClient();
    await client.startRun({
      agentName: 'a',
      agentType: 'scheduled',
      framework: 'vercel-ai',
      sdkVersion: '0.1.0',
      toolsAvailable: ['search', 'summarize'],
    });
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.framework).toBe('vercel-ai');
    expect(body.sdkVersion).toBe('0.1.0');
    expect(body.toolsAvailable).toEqual(['search', 'summarize']);
  });

  it('startRun returns null if backend returns 4xx', async () => {
    process.env.JENZ_API_KEY = 'k';
    global.fetch = vi
      .fn()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = new JenzClient();
    const run = await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(run).toBeNull();
  });

  it('startRun returns a Run with the assigned id on success', async () => {
    process.env.JENZ_API_KEY = 'k';
    const client = new JenzClient();
    const run = await client.startRun({ agentName: 'a', agentType: 'manual' });
    expect(run?.id).toBe('r1');
  });
});
