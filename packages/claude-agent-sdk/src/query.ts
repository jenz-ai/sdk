import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import type { Run } from '@jenz-ai/sdk';
import { tryCreateClient } from './client.js';
import { buildJenzHooks, mergeHooks } from './hooks.js';
import { wrapQueryStream } from './stream.js';
import { runContext } from './als.js';
import { SDK_VERSION } from './version.js';

/**
 * Drop-in wrapped `query()` for @anthropic-ai/claude-agent-sdk.
 *
 * Behavior:
 * - With JENZ_API_KEY set: starts a Run, injects jenz hooks alongside user hooks,
 *   observes the Query stream for assistant messages + result, finishes the Run.
 * - Without JENZ_API_KEY: pass-through. One warning per process.
 * - On startRun() failure: logs, falls back to pass-through. User code untouched.
 */
export const query: typeof claudeQuery = (params) => {
  const client = tryCreateClient();
  if (!client) return claudeQuery(params);

  const runPromise: Promise<Run | null> = (async () => {
    try {
      const agentName = (params.options as any)?.agent ?? 'claude-agent';
      return await client.startRun({
        agentName,
        agentType: 'claude_code',
        framework: 'claude-agent',
        sdkVersion: SDK_VERSION,
      });
    } catch (err) {
      console.error('[@jenz-ai/claude-agent-sdk] startRun failed — observability disabled for this call', err);
      return null;
    }
  })();

  const jenzHooks = buildJenzHooks(runPromise);
  const userHooks = (params.options as any)?.hooks;
  const mergedHooks = mergeHooks(userHooks, jenzHooks);
  const wrappedParams = { ...params, options: { ...(params.options ?? {}), hooks: mergedHooks } } as any;

  const upstream = claudeQuery(wrappedParams) as any;
  const wrapped = wrapQueryStream(upstream, runPromise);

  runPromise.then((run) => {
    if (!run) return;
    runContext.enterWith({ run });
    // Phase 3 remote-stop: dashboard `POST /api/runs/:id/kill` flips
    // `Run.stopRequested`, which core observes in the next event-POST response
    // and synchronously fires `run.signal`. The `aborted` check covers the
    // race where that happens before this `.then` callback runs.
    const onAbort = () => {
      try {
        (upstream as { interrupt?: () => unknown }).interrupt?.();
      } catch (err) {
        console.warn('[@jenz-ai/claude-agent-sdk] upstream.interrupt() threw', err);
      }
    };
    if (run.signal.aborted) onAbort();
    else run.signal.addEventListener('abort', onAbort, { once: true });
  }).catch(() => { /* swallow */ });

  return new Proxy(wrapped as any, {
    get(target, prop) {
      // Iterator protocol: bind to the wrapped (observed) generator so `this` is correct.
      if (prop === 'next' || prop === 'return' || prop === 'throw') {
        const method = (target as any)[prop];
        return typeof method === 'function' ? method.bind(target) : method;
      }
      if (prop === Symbol.asyncIterator) {
        return () => target;
      }
      // Control methods (interrupt, setModel, setPermissionMode, etc.): forward to upstream.
      const upstreamProp = (upstream as any)[prop];
      if (typeof upstreamProp === 'function') return upstreamProp.bind(upstream);
      return upstreamProp;
    },
  }) as ReturnType<typeof claudeQuery>;
};
