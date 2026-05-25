import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapModel, wrapTools, withRun } from './index.js';

function fakeModel(): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'openai',
    modelId: 'gpt-4o',
    supportedUrls: {},
    doGenerate: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'reply' }],
      finishReason: 'stop',
      usage: {
        inputTokens: { total: 20 },
        outputTokens: { total: 10 },
        totalTokens: 30,
      },
      warnings: [],
    }),
    doStream: vi.fn(),
  } as unknown as LanguageModelV3;
}

const genCallOpts = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
} as never;

describe('vercel-ai end-to-end (multi-step agent via withRun + wrapModel + wrapTools)', () => {
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

  it('records 1 run + 2 LLM calls + 1 tool call under same run', async () => {
    const model = wrapModel(fakeModel(), { agentName: 'multi', agentType: 'scheduled' });
    const tools = wrapTools({
      lookup: { execute: async () => 'data' },
    });

    await withRun(
      { agentName: 'multi', agentType: 'scheduled', toolsAvailable: ['lookup'] },
      async () => {
        await model.doGenerate(genCallOpts);
        await tools.lookup.execute({});
        await model.doGenerate(genCallOpts);
      },
    );

    const runCalls = fetchMock.mock.calls.filter(
      (c) => c[0].endsWith('/v1/runs') && c[1].method === 'POST',
    );
    expect(runCalls).toHaveLength(1);
    const runBody = JSON.parse(runCalls[0][1].body);
    expect(runBody.framework).toBe('vercel-ai');
    expect(runBody.toolsAvailable).toEqual(['lookup']);

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(3);
    const eventTypes = eventCalls.map((c) => JSON.parse(c[1].body).type);
    expect(eventTypes).toEqual(['llm_call', 'tool_call', 'llm_call']);

    // JEN-61: assistant text from result.content must round-trip into the
    // llm_call event's output field on the wire.
    const llmEventBodies = eventCalls
      .map((c) => JSON.parse(c[1].body))
      .filter((b) => b.type === 'llm_call');
    expect(llmEventBodies).toHaveLength(2);
    for (const body of llmEventBodies) {
      expect(body.output).toBe('reply');
    }

    const finishCalls = fetchMock.mock.calls.filter(
      (c) => c[0].includes('/v1/runs/r1') && c[1].method === 'PATCH',
    );
    expect(finishCalls).toHaveLength(1);
    expect(JSON.parse(finishCalls[0][1].body).status).toBe('completed');
  });

  // JEN-61 regression: the original bug was that 8 of 12 events had `output=""`
  // despite non-zero `outputTokens` — most of them were tool-use-only steps
  // with no trailing text. End-to-end this verifies a streamed call that emits
  // only a `tool-call` chunk (no `text-delta`) still lands `output` on the
  // event POST body.
  it('round-trips output for a streamed call that ends with only a tool-call chunk', async () => {
    function streamingToolOnlyModel(): LanguageModelV3 {
      return {
        specificationVersion: 'v3',
        provider: 'openai',
        modelId: 'gpt-4o',
        supportedUrls: {},
        doGenerate: vi.fn(),
        doStream: vi.fn().mockResolvedValue({
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'tc-stream-1',
                toolName: 'lookup',
                input: '{"q":"hi"}',
              });
              controller.enqueue({
                type: 'finish',
                finishReason: 'tool-calls',
                usage: {
                  inputTokens: { total: 8 },
                  outputTokens: { total: 12 },
                  totalTokens: 20,
                },
              });
              controller.close();
            },
          }),
        }),
      } as unknown as LanguageModelV3;
    }

    const model = wrapModel(streamingToolOnlyModel(), { agentName: 'stream-tool', agentType: 'manual' });
    const { stream } = await model.doStream(genCallOpts);
    const reader = (stream as ReadableStream).getReader();
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    const llmEvent = eventCalls.map((c) => JSON.parse(c[1].body)).find((b) => b.type === 'llm_call');
    expect(llmEvent).toBeTruthy();
    expect(llmEvent.outputTokens).toBe(12);
    // Output must be a non-empty JSON-shaped tool_use payload — not undefined,
    // not empty string.
    expect(typeof llmEvent.output).toBe('string');
    expect(llmEvent.output.length).toBeGreaterThan(0);
    const parsed = JSON.parse(llmEvent.output);
    expect(parsed.type).toBe('tool_use');
    expect(parsed.name).toBe('lookup');
    expect(parsed.input).toEqual({ q: 'hi' });
  });
});
