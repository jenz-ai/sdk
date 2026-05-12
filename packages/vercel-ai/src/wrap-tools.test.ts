import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { wrapTools } from './wrap-tools.js';
import { withRun } from './with-run.js';

describe('wrapTools', () => {
  const realFetch = global.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.JENZ_API_KEY = 'test-key';
    let runId = 0;
    let eventId = 0;
    fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/v1/runs')) {
        runId += 1;
        return Promise.resolve(new Response(JSON.stringify({ runId: `r${runId}` }), { status: 200 }));
      }
      if (url.endsWith('/v1/events')) {
        eventId += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ eventId: `e${eventId}`, stopRequested: false }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, stopRequested: false }), { status: 200 }));
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.JENZ_API_KEY;
  });

  it('preserves the tool shape (description, inputSchema, etc.)', () => {
    const original = {
      search: {
        description: 'Search the web',
        inputSchema: { type: 'object' as const },
        execute: async (input: { q: string }) => `result for ${input.q}`,
      },
    };
    const wrapped = wrapTools(original);
    expect(wrapped.search.description).toBe('Search the web');
    expect(wrapped.search.inputSchema).toEqual({ type: 'object' });
    expect(typeof wrapped.search.execute).toBe('function');
  });

  it('emits a tool_call event when execute is called inside a run', async () => {
    const original = {
      search: {
        description: 'Search',
        execute: async (input: { q: string }) => `result for ${input.q}`,
      },
    };
    const wrapped = wrapTools(original);

    await withRun({ agentName: 'tool-test', agentType: 'manual' }, async () => {
      await wrapped.search.execute({ q: 'jenz' });
    });

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(1);
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.type).toBe('tool_call');
    expect(body.name).toBe('search');
  });

  it('records errorMessage when tool execute throws', async () => {
    const original = {
      failing: { execute: async () => { throw new Error('tool boom'); } },
    };
    const wrapped = wrapTools(original);

    await expect(
      withRun({ agentName: 'tool-fail', agentType: 'manual' }, async () => {
        await wrapped.failing.execute({});
      }),
    ).rejects.toThrow('tool boom');

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(1);
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.errorMessage).toBe('tool boom');
  });

  it('passes through tool result and second argument (toolCallOptions)', async () => {
    let capturedSecondArg: unknown;
    const original = {
      echo: {
        execute: async (i: { s: string }, opts?: unknown) => {
          capturedSecondArg = opts;
          return i.s;
        },
      },
    };
    const wrapped = wrapTools(original);

    let result: string | undefined;
    await withRun({ agentName: 'echo', agentType: 'manual' }, async () => {
      result = await wrapped.echo.execute({ s: 'hello' }, { toolCallId: 'tc1' });
    });

    expect(result).toBe('hello');
    expect(capturedSecondArg).toEqual({ toolCallId: 'tc1' });
  });

  it('is a no-op (no event) when called outside a run', async () => {
    const original = { search: { execute: async () => 'ok' } };
    const wrapped = wrapTools(original);

    await wrapped.search.execute({});
    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(0);
  });

  it('leaves tools without execute (provider-executed tools) untouched', () => {
    const original = {
      web_search: { description: 'Built-in web search' /* no execute */ },
    };
    const wrapped = wrapTools(original);
    expect(wrapped.web_search).toBe(original.web_search);
  });
});
