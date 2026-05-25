import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LanguageModelV3, LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { wrapModel, llmOutputText, llmOutputFromStreamChunks } from './wrap-model.js';
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
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5 },
        totalTokens: 15,
      },
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
          usage: {
            inputTokens: { total: 100, noCache: 0, cacheRead: 1000, cacheWrite: undefined },
            outputTokens: { total: 50 },
            totalTokens: 150,
          },
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
          usage: {
            inputTokens: { total: 20, noCache: 20, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 8 },
            totalTokens: 28,
          },
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
          usage: {
            inputTokens: { total: 0 },
            outputTokens: { total: 0 },
            totalTokens: 0,
          },
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

  // JEN-61: output text was being dropped — llm_call events arrived at the api
  // with empty output despite outputTokens > 0. Cover wrapGenerate's text-only,
  // tool-call-only, mixed, and empty fall-throughs; then the streaming side.
  describe('JEN-61: finish.output from generate result.content', () => {
    it('captures text content blocks into finish.output', async () => {
      const model = wrapModel(fakeModel(), { agentName: 'gen-text', agentType: 'manual' });
      await model.doGenerate(genCallOpts);

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      expect(body.output).toBe('hello');
    });

    it('captures tool-call blocks into finish.output (JSON-stringified tool_use shape)', async () => {
      const model = wrapModel(
        fakeModel({
          doGenerate: vi.fn().mockResolvedValue({
            content: [
              {
                type: 'tool-call',
                toolCallId: 'tc-1',
                toolName: 'lookup',
                input: '{"q":"hi"}',
              },
            ],
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { total: 10 },
              outputTokens: { total: 0 },
              totalTokens: 10,
            },
            warnings: [],
          }),
        }),
        { agentName: 'gen-tool', agentType: 'manual' },
      );
      await model.doGenerate(genCallOpts);

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      // Dashboard's preview detector requires the `tool_use` shape (with `name`)
      // so we normalise from Vercel's `tool-call` shape on the way out.
      const parsed = JSON.parse(body.output);
      expect(parsed.type).toBe('tool_use');
      expect(parsed.name).toBe('lookup');
      expect(parsed.id).toBe('tc-1');
    });

    it('joins mixed text + tool-call blocks with newline', async () => {
      const model = wrapModel(
        fakeModel({
          doGenerate: vi.fn().mockResolvedValue({
            content: [
              { type: 'text', text: 'Let me check.' },
              {
                type: 'tool-call',
                toolCallId: 'tc-1',
                toolName: 'lookup',
                input: '{}',
              },
            ],
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { total: 5 },
              outputTokens: { total: 4 },
              totalTokens: 9,
            },
            warnings: [],
          }),
        }),
        { agentName: 'gen-mixed', agentType: 'manual' },
      );
      await model.doGenerate(genCallOpts);

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      const lines = body.output.split('\n');
      expect(lines[0]).toBe('Let me check.');
      const parsed = JSON.parse(lines[1]);
      expect(parsed.type).toBe('tool_use');
      expect(parsed.name).toBe('lookup');
    });

    it('omits finish.output when content is empty', async () => {
      const model = wrapModel(
        fakeModel({
          doGenerate: vi.fn().mockResolvedValue({
            content: [],
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1 },
              outputTokens: { total: 0 },
              totalTokens: 1,
            },
            warnings: [],
          }),
        }),
        { agentName: 'gen-empty', agentType: 'manual' },
      );
      await model.doGenerate(genCallOpts);

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      expect(body.output).toBeUndefined();
    });
  });

  describe('JEN-61: finish.output from streaming chunks', () => {
    it('accumulates text-delta chunks into finish.output', async () => {
      const model = wrapModel(
        streamingModel([
          { type: 'stream-start', warnings: [] } as never,
          { type: 'text-start', id: 't1' } as never,
          { type: 'text-delta', id: 't1', delta: 'Hello' } as never,
          { type: 'text-delta', id: 't1', delta: ', world' } as never,
          { type: 'text-end', id: 't1' } as never,
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 20 },
              outputTokens: { total: 8 },
              totalTokens: 28,
            },
          } as never,
        ]),
        { agentName: 'stream-text', agentType: 'manual' },
      );

      const { stream } = await model.doStream(genCallOpts);
      await drainStream(stream);
      await new Promise((r) => setTimeout(r, 30));

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      expect(body.output).toBe('Hello, world');
    });

    it('records tool-call chunks into finish.output (JSON-stringified tool_use shape)', async () => {
      const model = wrapModel(
        streamingModel([
          { type: 'stream-start', warnings: [] } as never,
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'lookup',
            input: '{"q":"x"}',
          } as never,
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { total: 5 },
              outputTokens: { total: 4 },
              totalTokens: 9,
            },
          } as never,
        ]),
        { agentName: 'stream-tool', agentType: 'manual' },
      );

      const { stream } = await model.doStream(genCallOpts);
      await drainStream(stream);
      await new Promise((r) => setTimeout(r, 30));

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      const parsed = JSON.parse(body.output);
      expect(parsed.type).toBe('tool_use');
      expect(parsed.name).toBe('lookup');
      expect(parsed.id).toBe('tc-1');
    });

    it('joins mixed text-delta + tool-call chunks with newline', async () => {
      const model = wrapModel(
        streamingModel([
          { type: 'stream-start', warnings: [] } as never,
          { type: 'text-start', id: 't1' } as never,
          { type: 'text-delta', id: 't1', delta: 'Looking up.' } as never,
          { type: 'text-end', id: 't1' } as never,
          {
            type: 'tool-call',
            toolCallId: 'tc-1',
            toolName: 'lookup',
            input: '{}',
          } as never,
          {
            type: 'finish',
            finishReason: 'tool-calls',
            usage: {
              inputTokens: { total: 10 },
              outputTokens: { total: 6 },
              totalTokens: 16,
            },
          } as never,
        ]),
        { agentName: 'stream-mixed', agentType: 'manual' },
      );

      const { stream } = await model.doStream(genCallOpts);
      await drainStream(stream);
      await new Promise((r) => setTimeout(r, 30));

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      const lines = body.output.split('\n');
      expect(lines[0]).toBe('Looking up.');
      const parsed = JSON.parse(lines[1]);
      expect(parsed.type).toBe('tool_use');
      expect(parsed.name).toBe('lookup');
    });

    it('omits finish.output when stream contains no text or tool chunks', async () => {
      const model = wrapModel(
        streamingModel([
          { type: 'stream-start', warnings: [] } as never,
          {
            type: 'finish',
            finishReason: 'stop',
            usage: {
              inputTokens: { total: 1 },
              outputTokens: { total: 0 },
              totalTokens: 1,
            },
          } as never,
        ]),
        { agentName: 'stream-empty', agentType: 'manual' },
      );

      const { stream } = await model.doStream(genCallOpts);
      await drainStream(stream);
      await new Promise((r) => setTimeout(r, 30));

      const eventCalls = fetchMock.mock.calls.filter((c) => c[0].endsWith('/v1/events'));
      const body = JSON.parse(eventCalls[0][1].body);
      expect(body.output).toBeUndefined();
    });
  });
});

describe('llmOutputText (content array helper)', () => {
  it('returns empty string for non-array input', () => {
    expect(llmOutputText(undefined)).toBe('');
    expect(llmOutputText(null)).toBe('');
    expect(llmOutputText('not-an-array')).toBe('');
    expect(llmOutputText({} as unknown)).toBe('');
  });

  it('returns empty string for an empty array', () => {
    expect(llmOutputText([])).toBe('');
  });

  it('joins text blocks with newline', () => {
    expect(
      llmOutputText([
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });

  it('serialises tool-call blocks into the dashboard-friendly tool_use shape', () => {
    const block = {
      type: 'tool-call',
      toolCallId: 'tc-1',
      toolName: 'Edit',
      input: '{"path":"/a"}',
    };
    const out = llmOutputText([block]);
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe('tool_use');
    expect(parsed.name).toBe('Edit');
    expect(parsed.id).toBe('tc-1');
    // input is stringified JSON on the wire — preserve as-is
    expect(parsed.input).toBe('{"path":"/a"}');
  });

  it('skips unknown block types', () => {
    expect(
      llmOutputText([
        { type: 'reasoning', text: 'internal' },
        { type: 'text', text: 'visible' },
      ]),
    ).toBe('visible');
  });

  it('clips output at 8000 chars', () => {
    const huge = { type: 'text', text: 'x'.repeat(10_000) };
    const out = llmOutputText([huge]);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('llmOutputFromStreamChunks (stream accumulator helper)', () => {
  it('returns empty string when no relevant chunks were collected', () => {
    expect(llmOutputFromStreamChunks('', [])).toBe('');
  });

  it('returns just text when there are no tool-call chunks', () => {
    expect(llmOutputFromStreamChunks('Hello, world', [])).toBe('Hello, world');
  });

  it('returns just tool_use JSON when there is no text', () => {
    const out = llmOutputFromStreamChunks('', [
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'X', input: '{}' },
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.type).toBe('tool_use');
    expect(parsed.name).toBe('X');
  });

  it('joins text then tool calls with newlines', () => {
    const out = llmOutputFromStreamChunks('Thinking…', [
      { type: 'tool-call', toolCallId: 'tc-1', toolName: 'A', input: '{}' },
      { type: 'tool-call', toolCallId: 'tc-2', toolName: 'B', input: '{}' },
    ]);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Thinking…');
    expect(JSON.parse(lines[1]).name).toBe('A');
    expect(JSON.parse(lines[2]).name).toBe('B');
  });

  it('clips output at 8000 chars', () => {
    const out = llmOutputFromStreamChunks('x'.repeat(10_000), []);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.endsWith('…')).toBe(true);
  });
});
