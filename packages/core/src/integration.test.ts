import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import { JenzClient } from './client.js';

describe('core SDK integration against fake backend', () => {
  let baseUrl: string;
  let server: ServerType;
  let receivedRuns: unknown[] = [];
  let receivedEvents: unknown[] = [];
  let receivedPatches: unknown[] = [];
  let stopFlag = false;

  beforeAll(async () => {
    const app = new Hono();

    app.post('/v1/runs', async (c) => {
      const body = await c.req.json();
      receivedRuns.push(body);
      return c.json({ runId: 'fake-run-id' });
    });
    app.post('/v1/events', async (c) => {
      const body = await c.req.json();
      receivedEvents.push(body);
      return c.json({ eventId: `e-${receivedEvents.length}`, stopRequested: stopFlag });
    });
    app.patch('/v1/runs/:id', async (c) => {
      const body = await c.req.json();
      receivedPatches.push({ id: c.req.param('id'), body });
      return c.json({ ok: true, stopRequested: stopFlag });
    });

    server = serve({ fetch: app.fetch, port: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const addr = (server as unknown as { address: () => AddressInfo }).address();
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(() => {
    server.close();
  });

  beforeEach(() => {
    receivedRuns = [];
    receivedEvents = [];
    receivedPatches = [];
    stopFlag = false;
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('startRun → startEvent → finish → run.finish round-trip', async () => {
    const client = new JenzClient({ apiKey: 'test', baseUrl });
    const run = await client.startRun({
      agentName: 'integ-test',
      agentType: 'scheduled',
      framework: 'vercel-ai',
      sdkVersion: '0.1.0',
      toolsAvailable: ['search'],
    });
    expect(run).not.toBeNull();
    expect(receivedRuns).toHaveLength(1);
    expect((receivedRuns[0] as { framework: string }).framework).toBe('vercel-ai');
    expect((receivedRuns[0] as { sdkVersion: string }).sdkVersion).toBe('0.1.0');
    expect((receivedRuns[0] as { toolsAvailable: string[] }).toolsAvailable).toEqual(['search']);

    const evt = run!.startEvent({
      type: 'llm_call',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
    });
    await evt.finish({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 1000,
      ttftMs: 240,
    });

    expect(receivedEvents).toHaveLength(1);
    expect((receivedEvents[0] as { provider: string }).provider).toBe('anthropic');
    expect((receivedEvents[0] as { cacheReadTokens: number }).cacheReadTokens).toBe(1000);
    expect((receivedEvents[0] as { ttftMs: number }).ttftMs).toBe(240);

    await run!.finish({ status: 'completed', output: 'done' });
    expect(receivedPatches).toHaveLength(1);
    expect((receivedPatches[0] as { body: { status: string } }).body.status).toBe('completed');
  });

  it('run.signal fires when backend returns stopRequested', async () => {
    stopFlag = true;
    const client = new JenzClient({ apiKey: 'test', baseUrl });
    const run = await client.startRun({ agentName: 'stop-integ', agentType: 'manual' });
    expect(run!.signal.aborted).toBe(false);

    const evt = run!.startEvent({ type: 'log' });
    await evt.finish({});
    expect(run!.signal.aborted).toBe(true);
  });

  it('heartbeat alone can fire run.signal', async () => {
    const client = new JenzClient({ apiKey: 'test', baseUrl });
    const run = await client.startRun({ agentName: 'heartbeat', agentType: 'manual' });
    expect(run!.signal.aborted).toBe(false);

    stopFlag = true;
    await run!.heartbeat();
    expect(run!.signal.aborted).toBe(true);
  });
});
