import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Agent, run } from '@openai/agents';
import { setupJenz, withRun, getActiveRun, VERSION } from './index.js';
import { __resetSetupForTests } from './setup.js';
import { __resetWithRunForTests } from './with-run.js';
import { setTraceProcessors, setTracingDisabled } from '@openai/agents-core';

// Stub LLM model — implements the bare minimum the SDK needs.
// ModelResponse shape: { usage: Usage, output: AgentOutputItem[], responseId?: string }
// Usage accepts { input_tokens, output_tokens } in its constructor.
// AssistantMessageItem shape: { role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: string }] }
function stubModel(reply: string) {
  return {
    async getResponse() {
      return {
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: reply }],
          },
        ],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, requests: 1 },
        responseId: 'resp_1',
      };
    },
    async *getStreamedResponse() {
      throw new Error('stubModel does not support streaming — non-streaming path only');
      yield;  // unreachable, satisfies generator type
    },
  } as any;
}

const realFetch = global.fetch;

describe('@jenz-ai/openai-agents integration', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let calls: Array<{ url: string; method: string; body?: unknown }>;

  beforeEach(() => {
    __resetSetupForTests();
    __resetWithRunForTests();
    setTraceProcessors([]);
    setTracingDisabled(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    calls = [];
    process.env.JENZ_API_KEY = 'test-key';
    process.env.JENZ_BASE_URL = 'http://127.0.0.1:9999';
    let runCounter = 0;
    fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ url: urlStr, method, body });
      if (urlStr.endsWith('/v1/runs') && method === 'POST') {
        runCounter += 1;
        return new Response(JSON.stringify({ runId: `r${runCounter}` }), { status: 200 });
      }
      if (urlStr.endsWith('/v1/events') && method === 'POST') {
        return new Response(
          JSON.stringify({ eventId: 'e1', stopRequested: false }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ ok: true, stopRequested: false }), { status: 200 });
    });
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
    delete process.env.JENZ_API_KEY;
    delete process.env.JENZ_BASE_URL;
    setTraceProcessors([]);
    setTracingDisabled(true);
  });

  it('exposes VERSION', () => {
    expect(VERSION).toBe('0.1.0');
  });

  it('setupJenz + run(agent) starts and finishes a Jenz Run end-to-end', async () => {
    // NOTE: This stub Model only triggers agent spans inside the SDK runner.
    // The processor intentionally skips agent spans (they are containers).
    // So we don't expect any /v1/events POSTs here — only the Run start (POST)
    // and finish (PATCH). The span → event mapping is covered by the unit
    // tests in span-mapping.test.ts and processor.test.ts.
    setupJenz();
    const agent = new Agent({ name: 'test-agent', instructions: 'echo', model: stubModel('hi') });
    await run(agent, 'hello');

    const startRunCall = calls.find((c) => c.url.endsWith('/v1/runs') && c.method === 'POST');
    expect(startRunCall).toBeDefined();
    expect(startRunCall!.body).toMatchObject({ framework: 'openai-agents' });

    // Negative assertion: no event POSTs (and if a future stub change emits one,
    // this test will surface that — flip the assertion at that point).
    const eventCalls = calls.filter((c) => c.url.endsWith('/v1/events') && c.method === 'POST');
    expect(eventCalls).toHaveLength(0);

    // Run was finished (status patch sent to /v1/runs/:id).
    const finishCalls = calls.filter(
      (c) => c.url.includes('/v1/runs/') && c.method === 'PATCH',
    );
    expect(finishCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('withRun + getActiveRun wires through with framework/agentName/signal', async () => {
    setupJenz();
    const agent = new Agent({ name: 'test-agent', instructions: 'echo', model: stubModel('hi') });
    let observedSignal: AbortSignal | undefined;
    await withRun({ agentName: 'cron-x', agentType: 'scheduled' }, async () => {
      const j = getActiveRun();
      observedSignal = j?.signal;
      await run(agent, 'hello', { signal: j?.signal });
    });
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    const runStarts = calls.filter((c) => c.url.endsWith('/v1/runs') && c.method === 'POST');
    expect(runStarts).toHaveLength(1);
    expect(runStarts[0]!.body).toMatchObject({ agentName: 'cron-x', agentType: 'scheduled' });
  });
});
