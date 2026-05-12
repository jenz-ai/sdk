import { runContext } from './als.js';

type ToolLike = {
  execute?: (input: unknown, options?: unknown) => Promise<unknown>;
  [key: string]: unknown;
};

type ToolMap = Record<string, ToolLike>;

/**
 * Wrap a Vercel AI SDK tools object so every `execute` call emits a `tool_call`
 * event to Jenz. The returned object has the same shape — same descriptions,
 * same `inputSchema`, same call signatures — so it's a drop-in replacement.
 *
 * Tools without an `execute` function (provider-executed tools like
 * `web_search`) are left untouched.
 *
 * Only emits events when a Jenz run is active (via `withRun`); outside of a
 * run the wrapped tool is identical to the original.
 *
 * ```ts
 * const tools = wrapTools({
 *   search: tool({
 *     inputSchema: z.object({ q: z.string() }),
 *     execute: async ({ q }) => searchWeb(q),
 *   }),
 * });
 * await generateText({ model, prompt: '...', tools });
 * ```
 */
export function wrapTools<T extends ToolMap>(tools: T): T {
  const wrapped = {} as Record<string, ToolLike>;
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool || typeof tool.execute !== 'function') {
      wrapped[name] = tool;
      continue;
    }
    const original = tool.execute;
    wrapped[name] = {
      ...tool,
      execute: async (input: unknown, options?: unknown) => {
        const run = runContext.getStore()?.run;
        if (!run) {
          return original(input, options);
        }
        const evt = run.startEvent({ type: 'tool_call', name });
        try {
          const result = await original(input, options);
          await evt.finish({});
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await evt.finish({ errorMessage: message });
          throw err;
        }
      },
    };
  }
  return wrapped as T;
}
