import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { wrapModel } from './wrap-model.js';
import { withRun } from './with-run.js';

function fakeModel(overrides: Partial<LanguageModelV3> = {}): LanguageModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'openai',
    modelId: 'gpt-4o',
    supportedUrls: {},
    doGenerate: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'hello' }],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    }),
    doStream: vi.fn(),
    ...overrides,
  } as unknown as LanguageModelV3;
}

function streamingModel(parts: LanguageModelV3StreamPart[]): LanguageModelV3 {
  return fakeModel({
    doStream: vi.fn().mockImplementation(async () => ({
      stream: new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          for (const part of parts) {
            await new Promise((r) => setTimeout(r, 5));
            controller.enqueue(part);
          }
          controller.close();
        },
      }),
      request: {},
      response: {},
    })),
  });
}

const genCallOpts = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
} as never;

async function drainStream(stream: ReadableStream): Promise<void> {
  const reader = stream.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
}

describe('wrapModel', () => {
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

  it('emits llm_call with model + provider + tokens on generate', async () => {
    const model = wrapModel(fakeModel(), { agentName: 'wrap-test', agentType: 'manual' });
    await model.doGenerate(genCallOpts);

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(1);
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.type).toBe('llm_call');
    expect(body.model).toBe('gpt-4o');
    expect(body.provider).toBe('openai');
    expect(body.inputTokens).toBe(10);
    expect(body.outputTokens).toBe(5);
  });

  it('captures cacheReadTokens from result.usage.cachedInputTokens', async () => {
    const model = wrapModel(
      fakeModel({
        doGenerate: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'cached' }],
          finishReason: 'stop',
          usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 1000 },
          warnings: [],
        }),
      }),
      { agentName: 'cache', agentType: 'manual' },
    );
    await model.doGenerate(genCallOpts);

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.cacheReadTokens).toBe(1000);
  });

  it('auto-starts a run when no run is active and auto-finishes after', async () => {
    const model = wrapModel(fakeModel(), { agentName: 'auto-run', agentType: 'manual' });
    await model.doGenerate(genCallOpts);

    const runCalls = fetchMock.mock.calls.filter(
      (c) => c[0].endsWith('/v1/runs') && c[1].method === 'POST',
    );
    expect(runCalls).toHaveLength(1);

    const patchCalls = fetchMock.mock.calls.filter(
      (c) => c[0].includes('/v1/runs/r1') && c[1].method === 'PATCH',
    );
    expect(patchCalls).toHaveLength(1);
    expect(JSON.parse(patchCalls[0][1].body).status).toBe('completed');
  });

  it('attaches to existing run from withRun (no new run, no auto-finish)', async () => {
    const model = wrapModel(fakeModel(), { agentName: 'attach', agentType: 'manual' });

    await withRun({ agentName: 'attach', agentType: 'manual' }, async () => {
      await model.doGenerate(genCallOpts);
      await model.doGenerate(genCallOpts);
    });

    const runCalls = fetchMock.mock.calls.filter(
      (c) => c[0].endsWith('/v1/runs') && c[1].method === 'POST',
    );
    expect(runCalls).toHaveLength(1); // only the one from withRun
    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(2);
  });

  it('records errorMessage when doGenerate throws', async () => {
    const failing = fakeModel({ doGenerate: vi.fn().mockRejectedValue(new Error('rate_limit')) });
    const model = wrapModel(failing, { agentName: 'fail', agentType: 'manual' });

    await expect(model.doGenerate(genCallOpts)).rejects.toThrow('rate_limit');

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(1);
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.errorMessage).toBe('rate_limit');
  });

  it('captures TTFT + usage in streaming', async () => {
    const model = wrapModel(
      streamingModel([
        { type: 'stream-start', warnings: [] } as never,
        { type: 'text-start', id: 't1' } as never,
        { type: 'text-delta', id: 't1', delta: 'Hello' } as never,
        { type: 'text-delta', id: 't1', delta: ' world' } as never,
        { type: 'text-end', id: 't1' } as never,
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
        } as never,
      ]),
      { agentName: 'stream', agentType: 'manual' },
    );

    const { stream } = await model.doStream(genCallOpts);
    await drainStream(stream);
    // event is emitted from the TransformStream flush; let microtask queue settle
    await new Promise((r) => setTimeout(r, 30));

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    expect(eventCalls).toHaveLength(1);
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.type).toBe('llm_call');
    expect(body.inputTokens).toBe(20);
    expect(body.outputTokens).toBe(8);
    expect(body.ttftMs).toBeGreaterThan(0);
  });

  it('records errorMessage when stream emits an error chunk', async () => {
    const model = wrapModel(
      streamingModel([
        { type: 'stream-start', warnings: [] } as never,
        { type: 'error', error: new Error('stream-fail') } as never,
        {
          type: 'finish',
          finishReason: 'error',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } as never,
      ]),
      { agentName: 'stream-err', agentType: 'manual' },
    );

    const { stream } = await model.doStream(genCallOpts);
    await drainStream(stream);
    await new Promise((r) => setTimeout(r, 30));

    const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
    const body = JSON.parse(eventCalls[0][1].body);
    expect(body.errorMessage).toBe('stream-fail');
  });

  it('falls through to model without observability when backend unreachable on generate', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const inner = fakeModel();
    const model = wrapModel(inner, { agentName: 'no-backend', agentType: 'manual' });
    const result = await model.doGenerate(genCallOpts);
    expect(inner.doGenerate).toHaveBeenCalled();
    expect((result as { content: unknown[] }).content).toBeDefined();
  });
});
