import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { startEventMock, startRunMock, finishRunMock } = vi.hoisted(() => ({
  startEventMock: vi.fn(),
  startRunMock: vi.fn(),
  finishRunMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@jenz-ai/sdk', () => ({
  JenzClient: vi.fn().mockImplementation(() => ({ startRun: startRunMock })),
}));

import { wrapToolRunner } from './wrap-tool-runner.js';
import { __resetClientForTests } from './client.js';

// ----- fakes -----

function makeFinishedEvent() {
  return { finish: vi.fn().mockResolvedValue({ eventId: 'evt', stopRequested: false }) };
}

function makeRunner(iterations: Array<{
  // What runner.params.messages looks like AT THE TIME this iteration is yielded
  messagesBefore: unknown[];
  // What the assistant finalMessage resolves to
  assistant: { role: 'assistant'; content: unknown; usage?: unknown };
  // What gets appended to messages after this iteration (mimics toolRunner's
  // post-yield push of assistant + tool_result).
  messagesAfter: unknown[];
}>) {
  const runner = {
    params: { model: 'claude-opus-4-7', messages: [] as unknown[] },
  } as { params: { model?: string; messages: unknown[] }; [Symbol.asyncIterator]: () => AsyncIterator<unknown> };

  runner[Symbol.asyncIterator] = async function* () {
    for (const it of iterations) {
      runner.params.messages = it.messagesBefore;
      yield {
        finalMessage: () => Promise.resolve(it.assistant),
        [Symbol.asyncIterator]: async function* () { /* user iterates stream */ },
      } as any;
      runner.params.messages = it.messagesAfter;
    }
  };

  return runner as any;
}

// ----- tests -----

describe('wrapToolRunner — instrumented mode', () => {
  const origKey = process.env.JENZ_API_KEY;
  beforeEach(() => {
    __resetClientForTests();
    process.env.JENZ_API_KEY = 'jk_test_123';
    startRunMock.mockReset();
    startEventMock.mockReset();
    finishRunMock.mockReset().mockResolvedValue(undefined);
    startEventMock.mockImplementation(() => makeFinishedEvent());
    startRunMock.mockResolvedValue({
      id: 'run-1',
      startEvent: startEventMock,
      finish: finishRunMock,
    });
  });
  afterEach(() => {
    if (origKey === undefined) delete process.env.JENZ_API_KEY;
    else process.env.JENZ_API_KEY = origKey;
    // NOTE: do NOT vi.restoreAllMocks() here — it tears down the
    // module-level vi.mock for @jenz-ai/sdk, so subsequent tests
    // would see JenzClient() return undefined.
  });

  it('starts a Run with framework=generic + provided agentName', async () => {
    const runner = makeRunner([
      {
        messagesBefore: [{ role: 'user', content: 'hi' }],
        assistant: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        messagesAfter: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [] }],
      },
    ]);
    const wrapped = wrapToolRunner(runner, { agentName: 'blog-writer' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }
    expect(startRunMock).toHaveBeenCalledTimes(1);
    const args = startRunMock.mock.calls[0]![0];
    expect(args.agentName).toBe('blog-writer');
    expect(args.framework).toBe('generic');
    expect(args.agentType).toBe('manual');
  });

  it('emits one llm_call event per iteration with input/output/tokens', async () => {
    const runner = makeRunner([
      {
        messagesBefore: [{ role: 'user', content: 'hi' }],
        assistant: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hello back' }],
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        },
        messagesAfter: [],
      },
    ]);
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }

    expect(startEventMock).toHaveBeenCalledTimes(1);
    const llmStartArg = startEventMock.mock.calls[0]![0];
    expect(llmStartArg.type).toBe('llm_call');
    expect(llmStartArg.provider).toBe('anthropic');
    expect(llmStartArg.model).toBe('claude-opus-4-7');
    expect(llmStartArg.input).toContain('"role":"user"');

    const finishArg = startEventMock.mock.results[0]!.value.finish.mock.calls[0][0];
    expect(finishArg.output).toContain('hello back');
    expect(finishArg.inputTokens).toBe(100);
    expect(finishArg.outputTokens).toBe(5);
  });

  it('starts tool_call events from tool_use blocks, finishes them next iteration from tool_result', async () => {
    // Iteration 1: assistant calls web_search.
    // Iteration 2: messages.at(-1) is the tool_result; assistant says "done".
    const toolResultMsg = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_42', content: '5 results', is_error: false },
      ],
    };
    const runner = makeRunner([
      {
        messagesBefore: [{ role: 'user', content: 'find seo info' }],
        assistant: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_42', name: 'web_search', input: { q: 'seo 2026' } },
          ],
        },
        messagesAfter: [
          { role: 'user', content: 'find seo info' },
          { role: 'assistant', content: [] },
          toolResultMsg,
        ],
      },
      {
        // At step 1 of iter 2, our wrapper reads messagesBefore.at(-1)
        // which IS the tool_result message.
        messagesBefore: [
          { role: 'user', content: 'find seo info' },
          { role: 'assistant', content: [] },
          toolResultMsg,
        ],
        assistant: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        messagesAfter: [],
      },
    ]);

    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }

    // 2 llm_call + 1 tool_call = 3 startEvent calls
    expect(startEventMock).toHaveBeenCalledTimes(3);
    const types = startEventMock.mock.calls.map((c) => (c[0] as { type: string }).type);
    expect(types).toEqual(['llm_call', 'tool_call', 'llm_call']);

    const toolStartArg = startEventMock.mock.calls[1]![0];
    expect(toolStartArg.name).toBe('web_search');
    expect(toolStartArg.input).toBe('{"q":"seo 2026"}');

    // Tool was finished with the result text
    const toolEvt = startEventMock.mock.results[1]!.value;
    expect(toolEvt.finish).toHaveBeenCalledTimes(1);
    expect(toolEvt.finish.mock.calls[0]![0]).toEqual({ output: '5 results' });
  });

  it('finishes the Run with status=completed after a normal iteration', async () => {
    const runner = makeRunner([
      {
        messagesBefore: [{ role: 'user', content: 'hi' }],
        assistant: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
        messagesAfter: [],
      },
    ]);
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }
    expect(finishRunMock).toHaveBeenCalledTimes(1);
    expect(finishRunMock.mock.calls[0]![0]).toEqual({ status: 'completed' });
  });

  it('finishes the Run with status=errored if the iteration throws', async () => {
    const runner = {
      params: { model: 'claude-opus-4-7', messages: [] },
      async *[Symbol.asyncIterator]() {
        throw new Error('upstream blew up');
      },
    } as any;
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    await expect(async () => {
      for await (const _ of wrapped) { /* never */ }
    }).rejects.toThrow('upstream blew up');
    expect(finishRunMock).toHaveBeenCalledTimes(1);
    const finArg = finishRunMock.mock.calls[0]![0];
    expect(finArg.status).toBe('errored');
    expect(finArg.errorMessage).toBe('upstream blew up');
  });

  it('finishes tool events with errorMessage when is_error=true', async () => {
    const toolResultMsg = {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_99', content: 'permission denied', is_error: true },
      ],
    };
    const runner = makeRunner([
      {
        messagesBefore: [{ role: 'user', content: 'read /secret' }],
        assistant: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu_99', name: 'read_file', input: { path: '/secret' } }],
        },
        messagesAfter: [],
      },
      {
        messagesBefore: [toolResultMsg],
        assistant: { role: 'assistant', content: [{ type: 'text', text: 'sorry' }] },
        messagesAfter: [],
      },
    ]);
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }
    const toolEvt = startEventMock.mock.results[1]!.value;
    expect(toolEvt.finish.mock.calls[0]![0]).toEqual({ errorMessage: 'permission denied' });
  });

  it('forwards non-iterator methods (e.g. done, params) to the underlying runner', async () => {
    const doneMock = vi.fn().mockResolvedValue({ id: 'final', stop_reason: 'end_turn' });
    const runner = {
      params: { model: 'claude-opus-4-7', messages: [], extra: 'kept' },
      done: doneMock,
      async *[Symbol.asyncIterator]() {
        yield {
          finalMessage: () => Promise.resolve({ role: 'assistant', content: [] }),
          [Symbol.asyncIterator]: async function* () { /* no-op */ },
        } as any;
      },
    } as any;
    const wrapped = wrapToolRunner(runner, { agentName: 'a' });
    for await (const stream of wrapped) {
      for await (const _ of stream as AsyncIterable<unknown>) { /* no-op */ }
    }
    // Forwarded properties + methods
    expect((wrapped as any).params.extra).toBe('kept');
    const final = await (wrapped as any).done();
    expect(final.id).toBe('final');
    expect(doneMock).toHaveBeenCalledTimes(1);
  });
});
