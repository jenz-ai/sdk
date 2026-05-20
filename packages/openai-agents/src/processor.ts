import type { TracingProcessor, Span, Trace } from '@openai/agents-core';
import type { JenzClient, Run, AgentType } from '@jenz-ai/sdk';
import { runContext } from './als.js';
import { mapSpanToEvent } from './span-mapping.js';
import { SDK_VERSION } from './version.js';

export interface ProcessorConfig {
  defaultAgentType?: AgentType;
  defaultAgentName?: string;
}

interface TraceState {
  run: Run;
  ownedByUs: boolean;
  toolsSeen: Set<string>;
  agentNameBySpanId: Map<string, string>;
}

export class JenzTracingProcessor implements TracingProcessor {
  private readonly client: JenzClient;
  private readonly config: ProcessorConfig;
  private readonly traces = new Map<string, TraceState>();

  constructor(client: JenzClient, config: ProcessorConfig) {
    this.client = client;
    this.config = config;
  }

  async onTraceStart(trace: Trace): Promise<void> {
    try {
      const existing = runContext.getStore()?.run;
      if (existing) {
        this.traces.set(trace.traceId, {
          run: existing,
          ownedByUs: false,
          toolsSeen: new Set(),
          agentNameBySpanId: new Map(),
        });
        return;
      }
      const run = await this.client.startRun({
        agentName: trace.name || this.config.defaultAgentName || 'Agent workflow',
        agentType: this.config.defaultAgentType ?? 'manual',
        framework: 'openai-agents',
        sdkVersion: SDK_VERSION,
      });
      if (run) {
        this.traces.set(trace.traceId, {
          run,
          ownedByUs: true,
          toolsSeen: new Set(),
          agentNameBySpanId: new Map(),
        });
      }
    } catch {
      /* swallow — observability must not break the host */
    }
  }

  async onSpanStart(span: Span<any>): Promise<void> {
    try {
      const state = this.traces.get(span.traceId);
      if (!state) return;
      const data = span.spanData;
      if (data?.type === 'agent') {
        state.agentNameBySpanId.set(span.spanId, data.name);
        const tools: string[] = Array.isArray(data.tools) ? data.tools : [];
        const additions = tools.filter((t) => !state.toolsSeen.has(t));
        if (additions.length) {
          additions.forEach((t) => state.toolsSeen.add(t));
          await state.run.updateAvailableTools([...state.toolsSeen]);
        }
      } else if (data?.type === 'function') {
        // Real @openai/agents-core emits agent spans with tools: [] on start,
        // so we harvest tool names from function spans as they actually fire.
        const name = typeof data.name === 'string' ? data.name : '';
        if (name && !state.toolsSeen.has(name)) {
          state.toolsSeen.add(name);
          await state.run.updateAvailableTools([...state.toolsSeen]);
        }
      }
    } catch {
      /* swallow */
    }
  }

  async onSpanEnd(span: Span<any>): Promise<void> {
    try {
      const state = this.traces.get(span.traceId);
      if (!state) return;
      // Agent spans are containers — we already recorded the name on start; nothing to emit.
      if (span.spanData?.type === 'agent') return;
      const parentAgentName = this.findParentAgentName(state, span);
      const payload = mapSpanToEvent(span, parentAgentName);
      if (!payload) return;
      const evt = state.run.startEvent(payload.start);
      await evt.finish(payload.finish);
    } catch {
      /* swallow */
    }
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    try {
      const state = this.traces.get(trace.traceId);
      if (!state) return;
      if (state.ownedByUs) {
        const status = state.run.signal.aborted ? 'stopped' : 'completed';
        await state.run.finish({ status });
      }
    } catch {
      /* swallow */
    } finally {
      this.traces.delete(trace.traceId);
    }
  }

  async shutdown(): Promise<void> {
    for (const [traceId, state] of this.traces) {
      try {
        if (state.ownedByUs) {
          const status = state.run.signal.aborted ? 'stopped' : 'completed';
          await state.run.finish({ status });
        }
      } catch {
        /* swallow */
      }
      this.traces.delete(traceId);
    }
  }

  async forceFlush(): Promise<void> {
    /* no-op; events flush synchronously */
  }

  private findParentAgentName(state: TraceState, span: Span<any>): string | undefined {
    if (!span.parentId) return undefined;
    return state.agentNameBySpanId.get(span.parentId);
  }
}
