import type { Transport } from './transport.js';

export type EventType = 'llm_call' | 'tool_call' | 'log';

export interface EventInit {
  transport: Transport;
  runId: string;
  parentEventId?: string;
  type: EventType;
  model?: string;
  provider?: string;
  name?: string;
  integration?: string;
  attempt?: number;
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface EventFinishInput {
  output?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  ttftMs?: number;
  attempt?: number;
  costUsd?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

export interface EventResponse {
  eventId: string;
  stopRequested: boolean;
}

/**
 * A single observable step inside a Run — an LLM call, a tool invocation, or a log entry.
 *
 * Created via `Run.startEvent(...)`. The constructor records `startedAt`; `finish()` POSTs the
 * payload to /v1/events with computed `latencyMs` and any token / cost / TTFT metrics. Each Event
 * can only be finished once; subsequent calls throw.
 */
export class Event {
  private readonly transport: Transport;
  private readonly init: EventInit;
  private readonly startedAt: Date = new Date();
  private finished = false;

  constructor(init: EventInit) {
    this.transport = init.transport;
    this.init = init;
  }

  async finish(input: EventFinishInput): Promise<EventResponse | null> {
    if (this.finished) throw new Error('Event already finished');
    this.finished = true;
    const endedAt = new Date();
    return await this.transport.post<EventResponse>('/v1/events', {
      runId: this.init.runId,
      parentEventId: this.init.parentEventId,
      type: this.init.type,
      model: this.init.model,
      provider: this.init.provider,
      name: this.init.name,
      integration: this.init.integration,
      attempt: input.attempt ?? this.init.attempt,
      input: this.init.input,
      output: input.output,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      ttftMs: input.ttftMs,
      costUsd: input.costUsd,
      errorMessage: input.errorMessage,
      metadata: input.metadata ?? this.init.metadata,
      startedAt: this.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      latencyMs: endedAt.getTime() - this.startedAt.getTime(),
    });
  }
}
