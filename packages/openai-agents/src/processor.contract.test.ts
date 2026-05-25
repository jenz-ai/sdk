// Contract test: feeds REAL spans constructed via @openai/agents-core factories
// (createAgentSpan / createFunctionSpan / createGenerationSpan / createHandoffSpan)
// through JenzTracingProcessor. Catches upstream-SDK shape drift that mocked tests miss.
//
// Background: Phase 2B v0.1.0 mocked agent spans with `tools: ['x', 'y']` and passed.
// Real `@openai/agents-core@0.11.4` emits agent spans with no `tools` field (or empty)
// on onSpanStart. The bug only surfaced during prod E2E. This test would have failed
// against the broken 0.1.0 impl. See Decisions/ADR-005 in the vault.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createAgentSpan,
  createFunctionSpan,
  createGenerationSpan,
  createHandoffSpan,
  withTrace,
  setTracingDisabled,
} from '@openai/agents-core';
import { JenzTracingProcessor } from './processor.js';
import type { Run } from '@jenz-ai/sdk';

function fakeRun() {
  const abortCtrl = new AbortController();
  return {
    id: 'r-contract',
    get signal() { return abortCtrl.signal; },
    finish: vi.fn().mockResolvedValue(undefined),
    updateAvailableTools: vi.fn().mockResolvedValue(undefined),
    startEvent: vi.fn().mockImplementation(() => ({
      finish: vi.fn().mockResolvedValue({ eventId: 'e1', stopRequested: false }),
    })),
    heartbeat: vi.fn(),
  } as unknown as Run;
}

function fakeClient(run: Run) {
  return { startRun: vi.fn().mockResolvedValue(run) } as any;
}

describe('JenzTracingProcessor — real SDK contract', () => {
  beforeEach(() => {
    setTracingDisabled(false);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Silence the upstream ConsoleSpanExporter — we don't care about export side-effects.
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('real agent span at onSpanStart has no `tools` field by default (Phase 2B bug shape)', async () => {
    await withTrace('contract', async () => {
      const agentSpan = createAgentSpan({ data: { name: 'a' } });
      agentSpan.start();
      // This is the bug-shape: the SDK doesn't auto-populate tools from Agent config.
      // If a future SDK release starts populating this, this test will fail loudly
      // — at which point we should reconsider whether to harvest from agent spans.
      expect(agentSpan.spanData.tools).toBeUndefined();
      agentSpan.end();
    });
  });

  it('real function span carries `name` on onSpanStart (the field we harvest from)', async () => {
    await withTrace('contract', async () => {
      const fnSpan = createFunctionSpan({
        data: { name: 'echo', input: '{}', output: '' },
      });
      fnSpan.start();
      expect(fnSpan.spanData).toMatchObject({
        type: 'function',
        name: 'echo',
      });
      fnSpan.end();
    });
  });

  it('processor harvests toolsAvailable from real function span', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await withTrace('contract', async () => {
      // Mirror real run order: agent span first (empty tools), then function spans
      const agentSpan = createAgentSpan({ data: { name: 'phase2b-e2e' } });
      agentSpan.start();
      const fnSpan = createFunctionSpan({
        data: { name: 'echo', input: '{}', output: 'echo: hello' },
      });
      fnSpan.start();

      await p.onTraceStart({ traceId: agentSpan.traceId, name: 'contract' } as any);
      await p.onSpanStart(agentSpan);
      await p.onSpanStart(fnSpan);

      expect(run.updateAvailableTools).toHaveBeenCalledWith(['echo']);

      fnSpan.end();
      agentSpan.end();
    });
  });

  it('processor maps real generation span → llm_call event with model + usage + output text', async () => {
    // JEN-62: assert that assistant text from spanData.output flows into the
    // finish payload. @openai/agents-openai sets `spanData.output = [response]`
    // where `response` is the raw OpenAI chat-completion. Mirror that shape so
    // any contract drift in the upstream type lights up here.
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await withTrace('contract', async () => {
      const genSpan = createGenerationSpan({
        data: {
          model: 'gpt-4o',
          usage: { input_tokens: 10, output_tokens: 5 } as any,
          output: [
            {
              choices: [
                { message: { role: 'assistant', content: 'Hello from gpt-4o.' } },
              ],
            },
          ] as any,
        },
      });
      genSpan.start();
      genSpan.end();

      await p.onTraceStart({ traceId: genSpan.traceId, name: 'contract' } as any);
      await p.onSpanEnd(genSpan);

      expect(run.startEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'llm_call', model: 'gpt-4o' }),
      );
      // The finish payload was passed to evt.finish — pull it from the mock.
      const finishMock = (run.startEvent as any).mock.results.at(-1)?.value.finish;
      expect(finishMock).toHaveBeenCalledWith(
        expect.objectContaining({ output: 'Hello from gpt-4o.' }),
      );
    });
  });

  it('processor maps real handoff span → log event named handoff:<from>→<to>', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await withTrace('contract', async () => {
      const handoffSpan = createHandoffSpan({
        data: { from_agent: 'triage', to_agent: 'billing' },
      });
      handoffSpan.start();
      handoffSpan.end();

      await p.onTraceStart({ traceId: handoffSpan.traceId, name: 'contract' } as any);
      await p.onSpanEnd(handoffSpan);

      const call = (run.startEvent as any).mock.calls.at(-1)?.[0];
      expect(call).toMatchObject({ type: 'log' });
      expect(call?.name).toBe('handoff:triage→billing');
    });
  });

  it('processor harvests names across mixed-shape function spans (real SDK union behavior)', async () => {
    const run = fakeRun();
    const p = new JenzTracingProcessor(fakeClient(run), {});
    await withTrace('contract', async () => {
      const agentSpan = createAgentSpan({ data: { name: 'a' } });
      agentSpan.start();
      const echo = createFunctionSpan({ data: { name: 'echo', input: '{}', output: '' } });
      const lookup = createFunctionSpan({ data: { name: 'lookup_account', input: '{}', output: '' } });
      const echoAgain = createFunctionSpan({ data: { name: 'echo', input: '{"x":2}', output: '' } });
      echo.start();
      lookup.start();
      echoAgain.start();

      await p.onTraceStart({ traceId: agentSpan.traceId, name: 'contract' } as any);
      await p.onSpanStart(agentSpan);
      await p.onSpanStart(echo);
      await p.onSpanStart(lookup);
      await p.onSpanStart(echoAgain); // duplicate name — must not trigger another PATCH

      expect((run.updateAvailableTools as any).mock.calls).toEqual([
        [['echo']],
        [['echo', 'lookup_account']],
      ]);

      echoAgain.end();
      lookup.end();
      echo.end();
      agentSpan.end();
    });
  });
});
