import { Run } from './run.js';
import { Transport } from './transport.js';

export type AgentType = 'scheduled' | 'triggered' | 'manual' | 'claude_code';
export type Framework = 'vercel-ai' | 'openai-agents' | 'claude-agent' | 'generic';

export interface JenzClientOptions {
  /** Bearer token. Defaults to process.env.JENZ_API_KEY. */
  apiKey?: string;
  /** Backend URL. Defaults to process.env.JENZ_BASE_URL or https://api.jenz.dev. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
}

export interface StartRunInput {
  agentName: string;
  agentType: AgentType;
  framework?: Framework;
  sdkVersion?: string;
  toolsAvailable?: string[];
  input?: string;
  expectedDurationMs?: number;
  metadata?: Record<string, unknown>;
}

const DEFAULT_BASE_URL = 'https://api.jenz.dev';

/**
 * Top-level entry point. Authenticate once, start as many runs as you need.
 *
 * ```ts
 * const jenz = new JenzClient();  // picks up JENZ_API_KEY
 * const run = await jenz.startRun({ agentName: 'my-agent', agentType: 'scheduled' });
 * if (run) {
 *   // ... do work, emit events via run.startEvent(...)
 *   await run.finish({ status: 'completed', output: '...' });
 * }
 * ```
 */
export class JenzClient {
  private readonly transport: Transport;

  constructor(opts: JenzClientOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.JENZ_API_KEY;
    if (!apiKey) {
      throw new Error(
        '[jenz] No API key. Pass `apiKey` to JenzClient or set JENZ_API_KEY env var. Get one at https://jenz.dev/api-keys',
      );
    }
    this.transport = new Transport({
      baseUrl: opts.baseUrl ?? process.env.JENZ_BASE_URL ?? DEFAULT_BASE_URL,
      apiKey,
      timeoutMs: opts.timeoutMs,
    });
  }

  async startRun(input: StartRunInput): Promise<Run | null> {
    const res = await this.transport.post<{ runId: string }>('/v1/runs', {
      agentName: input.agentName,
      agentType: input.agentType,
      framework: input.framework,
      sdkVersion: input.sdkVersion,
      toolsAvailable: input.toolsAvailable,
      input: input.input,
      expectedDurationMs: input.expectedDurationMs,
      metadata: input.metadata,
    });
    if (!res) return null;
    return new Run({ transport: this.transport, runId: res.runId });
  }
}
