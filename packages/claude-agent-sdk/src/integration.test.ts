import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { AddressInfo } from 'node:net';

// Mock upstream BEFORE importing query.ts so the import wires through.
const claudeQueryMock = vi.fn();
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (params: any) => claudeQueryMock(params),
}));

import { query } from './query.js';
import { __resetClientForTests } from './client.js';

async function* upstreamFromMsgs(msgs: any[]) {
  for (const m of msgs) yield m;
}

interface Recorded {
  method: string;
  path: string;
  body: any;
}

function makeFakeBackend(): { app: Hono; recorded: Recorded[]; runId: string } {
  const recorded: Recorded[] = [];
  const runId = 'fake-run-uuid-' + Math.random().toString(36).slice(2);
  const app = new Hono();
  app.post('/v1/runs', async (c) => {
    const body = await c.req.json();
    recorded.push({ method: 'POST', path: '/v1/runs', body });
    return c.json({ runId });
  });
  app.patch('/v1/runs/:id', async (c) => {
    const body = await c.req.json();
    recorded.push({ method: 'PATCH', path: `/v1/runs/${c.req.param('id')}`, body });
    return c.json({ ok: true });
  });
  app.post('/v1/events', async (c) => {
    const body = await c.req.json();
    recorded.push({ method: 'POST', path: '/v1/events', body });
    return c.json({ eventId: 'evt-' + recorded.length, stopRequested: false });
  });
  return { app, recorded, runId };
}

describe('integration: full query() round-trip against fake Hono backend', () => {
  let server: ServerType;
  let baseUrl: string;
  let recorded: Recorded[];
  const origKey = process.env.JENZ_API_KEY;
  const origBase = process.env.JENZ_BASE_URL;

  beforeEach(async () => {
    __resetClientForTests();
    claudeQueryMock.mockReset();
    const { app, recorded: r } = makeFakeBackend();
    recorded = r;
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
    });
    const addr = (server as any).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.JENZ_API_KEY = 'jk_integration_test';
    process.env.JENZ_BASE_URL = baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (origKey === undefined) delete process.env.JENZ_API_KEY; else process.env.JENZ_API_KEY = origKey;
    if (origBase === undefined) delete process.env.JENZ_BASE_URL; else process.env.JENZ_BASE_URL = origBase;
  });

  it('records POST /v1/runs + POST /v1/events (llm_call) + PATCH /v1/runs/:id (finish)', async () => {
    claudeQueryMock.mockReturnValue(upstreamFromMsgs([
      {
        type: 'assistant',
        message: {
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'Hi there!' }],
          usage: { input_tokens: 100, output_tokens: 40 },
        },
      },
      { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.001, duration_ms: 250, num_turns: 1 },
    ]));

    for await (const _ of query({ prompt: 'hello', options: { agent: 'demo' } } as any)) { /* drain */ }

    await new Promise((r) => setTimeout(r, 50));

    const post_runs = recorded.filter((r) => r.method === 'POST' && r.path === '/v1/runs');
    const post_events = recorded.filter((r) => r.method === 'POST' && r.path === '/v1/events');
    const patch_run = recorded.filter((r) => r.method === 'PATCH' && r.path.startsWith('/v1/runs/'));

    expect(post_runs).toHaveLength(1);
    expect(post_runs[0].body).toMatchObject({
      agentName: 'demo',
      agentType: 'claude_code',
      framework: 'claude-agent',
    });

    expect(post_events.length).toBeGreaterThanOrEqual(1);
    const llmEvent = post_events.find((e) => e.body.type === 'llm_call');
    expect(llmEvent).toBeTruthy();
    expect(llmEvent!.body.provider).toBe('anthropic');
    expect(llmEvent!.body.inputTokens).toBe(100);
    expect(llmEvent!.body.outputTokens).toBe(40);
    // JEN-60: assistant text must round-trip into the event's output field.
    expect(llmEvent!.body.output).toBe('Hi there!');

    expect(patch_run).toHaveLength(1);
    expect(patch_run[0].body.status).toBe('completed');
  });

  it('records PATCH /v1/runs/:id with toolsAvailable on first PreToolUse for each tool', async () => {
    claudeQueryMock.mockImplementation((params) => {
      const preMatcher = params.options.hooks.PreToolUse?.find(Boolean);
      const preHook = preMatcher?.hooks?.[0];

      return (async function* () {
        if (preHook) {
          await preHook({ hook_event_name: 'PreToolUse', tool_use_id: 'tu-1', tool_name: 'Read', tool_input: { file_path: '/a' } }, undefined, { signal: new AbortController().signal });
          await preHook({ hook_event_name: 'PreToolUse', tool_use_id: 'tu-2', tool_name: 'Edit', tool_input: {} }, undefined, { signal: new AbortController().signal });
        }
        yield { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 1, num_turns: 1 };
      })();
    });

    for await (const _ of query({ prompt: 'go' } as any)) { /* drain */ }
    await new Promise((r) => setTimeout(r, 50));

    const tool_patches = recorded.filter((r) => r.method === 'PATCH' && r.body.toolsAvailable !== undefined);
    expect(tool_patches.length).toBeGreaterThanOrEqual(2);
    const allTools = tool_patches.flatMap((p) => p.body.toolsAvailable);
    expect(allTools).toContain('Read');
    expect(allTools).toContain('Edit');
  });

  it('upstream throw → PATCH /v1/runs/:id with status=errored', async () => {
    claudeQueryMock.mockImplementation(() => (async function* () {
      yield { type: 'system', subtype: 'init' };
      throw new Error('upstream-failed');
    })());

    await expect(async () => {
      for await (const _ of query({ prompt: 'fail' } as any)) { /* drain */ }
    }).rejects.toThrow('upstream-failed');
    await new Promise((r) => setTimeout(r, 50));

    const finish = recorded.find((r) => r.method === 'PATCH' && r.body.status === 'errored');
    expect(finish).toBeTruthy();
    expect(finish!.body.errorMessage).toBe('upstream-failed');
  });
});

describe('integration: backend stopRequested → upstream.interrupt()', () => {
  let server: ServerType;
  let baseUrl: string;
  const origKey = process.env.JENZ_API_KEY;
  const origBase = process.env.JENZ_BASE_URL;

  beforeEach(async () => {
    __resetClientForTests();
    claudeQueryMock.mockReset();
    const app = new Hono();
    app.post('/v1/runs', (c) => c.json({ runId: 'fake-run-stop' }));
    app.patch('/v1/runs/:id', async (c) => { await c.req.json(); return c.json({ ok: true, stopRequested: false }); });
    app.post('/v1/events', async (c) => { await c.req.json(); return c.json({ eventId: 'evt-stop', stopRequested: true }); });
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, port: 0 }, () => resolve());
    });
    const addr = (server as any).address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    process.env.JENZ_API_KEY = 'jk_integration_test';
    process.env.JENZ_BASE_URL = baseUrl;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (origKey === undefined) delete process.env.JENZ_API_KEY; else process.env.JENZ_API_KEY = origKey;
    if (origBase === undefined) delete process.env.JENZ_BASE_URL; else process.env.JENZ_BASE_URL = origBase;
  });

  it('calls upstream.interrupt() exactly once when backend signals stopRequested via an event response', async () => {
    const interruptSpy = vi.fn();

    claudeQueryMock.mockImplementation(() => {
      const iter = upstreamFromMsgs([
        { type: 'assistant', message: { model: 'claude-sonnet-4-6', usage: { input_tokens: 5, output_tokens: 3 } } },
        { type: 'result', subtype: 'success', result: 'ok', total_cost_usd: 0.001, duration_ms: 100, num_turns: 1 },
      ]);
      return Object.assign(iter, { interrupt: interruptSpy });
    });

    for await (const _ of query({ prompt: 'hello', options: { agent: 'demo' } } as any)) { /* drain */ }

    await new Promise((r) => setTimeout(r, 50));

    expect(interruptSpy).toHaveBeenCalledTimes(1);
  });
});
