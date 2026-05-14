import { addTraceProcessor } from '@openai/agents-core';
import { JenzClient, type AgentType } from '@jenz-ai/sdk';
import { JenzTracingProcessor } from './processor.js';

export interface SetupJenzConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  defaultAgentType?: AgentType;
  defaultAgentName?: string;
}

let installed = false;
let dormantWarningShown = false;

/**
 * Install the Jenz tracing processor on the OpenAI Agents SDK. Call once at
 * application boot.
 *
 * - With `JENZ_API_KEY` set: registers a TracingProcessor that emits a Jenz Run
 *   per SDK Trace and Jenz events per span. Coexists with OpenAI's default
 *   tracing (additive via `addTraceProcessor`).
 * - Without `JENZ_API_KEY`: logs a one-time friendly warning with the dashboard
 *   link and returns without registering anything. The host agent runs untouched.
 * - Calling twice: warns and no-ops.
 */
export function setupJenz(config: SetupJenzConfig = {}): void {
  if (installed) {
    console.warn('[jenz] setupJenz() has already been called — ignoring second invocation.');
    return;
  }

  let client: JenzClient;
  try {
    client = new JenzClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    });
  } catch {
    if (!dormantWarningShown) {
      dormantWarningShown = true;
      console.warn(
        '[jenz] Observability is dormant — JENZ_API_KEY not set.\n' +
          '       Get a key at https://jenz.dev/api-keys, add JENZ_API_KEY=... to .env, restart.\n' +
          '       Your agent will run normally; no data is being sent.',
      );
    }
    return;
  }

  addTraceProcessor(
    new JenzTracingProcessor(client, {
      defaultAgentType: config.defaultAgentType,
      defaultAgentName: config.defaultAgentName,
    }),
  );
  installed = true;
}

/** @internal — used by tests to reset module state between cases. */
export function __resetSetupForTests(): void {
  installed = false;
  dormantWarningShown = false;
}
