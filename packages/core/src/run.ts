import { Event, type EventInit, type EventType, type EventResponse } from './event.js';
import type { Transport } from './transport.js';

export type RunStatus = 'running' | 'completed' | 'errored' | 'stopped';

export interface RunInit {
  transport: Transport;
  runId: string;
}

export interface StartEventInput {
  type: EventType;
  parentEventId?: string;
  model?: string;
  provider?: string;
  name?: string;
  integration?: string;
  attempt?: number;
  input?: string;
  metadata?: Record<string, unknown>;
}

export interface RunFinishInput {
  status: RunStatus;
  output?: string;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
}

interface HeartbeatResponse {
  ok: boolean;
  stopRequested: boolean;
}

/**
 * A live run — the unit of work being observed (one cron firing, one webhook,
 * one chat turn, ...).
 *
 * `run.signal` is an `AbortSignal` that fires when the backend tells us the
 * dashboard has requested a stop. Forward it to your framework's own
 * cancellation (`generateText({ abortSignal: run.signal })` etc.).
 */
export class Run {
  readonly id: string;
  private readonly transport: Transport;
  private readonly abortController = new AbortController();
  private finished = false;

  constructor(init: RunInit) {
    this.id = init.runId;
    this.transport = init.transport;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  startEvent(input: StartEventInput): Event {
    const eventInit: EventInit = {
      transport: this.transport,
      runId: this.id,
      type: input.type,
      parentEventId: input.parentEventId,
      model: input.model,
      provider: input.provider,
      name: input.name,
      integration: input.integration,
      attempt: input.attempt,
      input: input.input,
      metadata: input.metadata,
    };
    const evt = new Event(eventInit);
    // Wrap finish so we observe stopRequested in the response.
    const originalFinish = evt.finish.bind(evt);
    evt.finish = async (finishInput): Promise<EventResponse | null> => {
      const res = await originalFinish(finishInput);
      if (res?.stopRequested) this.maybeAbort();
      return res;
    };
    return evt;
  }

  /**
   * Poll for a remote-stop signal without recording an event. Useful for long
   * sleep / wait phases where no other event would fire.
   */
  async heartbeat(): Promise<void> {
    const res = await this.transport.patch<HeartbeatResponse>(`/v1/runs/${this.id}`, {});
    if (res?.stopRequested) this.maybeAbort();
  }

  /**
   * Tell the backend about tools this run has access to. Idempotent and additive
   * — the server merges with any existing list (union, dedup). Adapters call this
   * incrementally as agents (and their tools) are discovered mid-run.
   *
   * Passing an empty array is a no-op (no network call, no stop-signal check).
   * Use `heartbeat()` when you need to poll for remote stop without other state.
   */
  async updateAvailableTools(names: string[]): Promise<void> {
    if (!names.length) return;
    const res = await this.transport.patch<HeartbeatResponse>(`/v1/runs/${this.id}`, {
      toolsAvailable: names,
    });
    if (res?.stopRequested) this.maybeAbort();
  }

  async finish(input: RunFinishInput): Promise<void> {
    if (this.finished) throw new Error('Run already finished');
    this.finished = true;
    await this.transport.patch(`/v1/runs/${this.id}`, {
      status: input.status,
      output: input.output,
      errorMessage: input.errorMessage,
      metadata: input.metadata,
    });
  }

  private maybeAbort(): void {
    if (!this.abortController.signal.aborted) {
      this.abortController.abort(new Error('Stop requested by Jenz dashboard'));
    }
  }
}
