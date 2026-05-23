import type { Run } from '@jenz-ai/sdk';
import {
  mapPreToolUse,
  mapPostToolUse,
  mapPostToolUseFailure,
  mapSubagentStart,
  mapSubagentStop,
  type PreToolUseInput,
  type PostToolUseInput,
  type PostToolUseFailureInput,
  type SubagentStartInput,
  type SubagentStopInput,
} from './event-mapping.js';

// Minimal local shape — the real `Event` type lives in @jenz-ai/sdk core but
// we only call .finish(...). This keeps the file decoupled and easy to test.
interface EventLike {
  finish(input: { output?: string; errorMessage?: string }): Promise<unknown>;
}

type HookCallback = (input: any, toolUseID: string | undefined, opts: { signal: AbortSignal }) => Promise<{ continue: boolean }>;
type HookCallbackMatcher = { matcher?: string; hooks: HookCallback[]; timeout?: number };
type Hooks = Partial<Record<string, HookCallbackMatcher[]>>;

/**
 * Build the hook matchers we inject into the user's `options.hooks`. Each hook
 * awaits the runPromise (so we don't block upstream query() startup waiting on
 * backend round-trips for Run creation), records observations against the Run,
 * and always returns { continue: true } so user code is never blocked or altered.
 */
export function buildJenzHooks(runPromise: Promise<Run | null>): Hooks {
  const inFlightTools = new Map<string, EventLike>();
  const inFlightSubagents = new Map<string, EventLike>();
  const seenToolNames = new Set<string>();

  async function preToolUse(input: PreToolUseInput): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const { start, toolUseId, toolName } = mapPreToolUse(input);
    const evt = (run as any).startEvent(start) as EventLike;
    inFlightTools.set(toolUseId, evt);
    if (!seenToolNames.has(toolName)) {
      seenToolNames.add(toolName);
      (run as any).updateAvailableTools([toolName]).catch(() => { /* swallow */ });
    }
  }

  async function postToolUse(input: PostToolUseInput): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const { finish, toolUseId } = mapPostToolUse(input);
    const evt = inFlightTools.get(toolUseId);
    if (!evt) return;
    inFlightTools.delete(toolUseId);
    await evt.finish(finish);
  }

  async function postToolUseFailure(input: PostToolUseFailureInput): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const { finish, toolUseId } = mapPostToolUseFailure(input);
    const evt = inFlightTools.get(toolUseId);
    if (!evt) return;
    inFlightTools.delete(toolUseId);
    await evt.finish(finish);
  }

  async function subagentStart(input: SubagentStartInput): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const { start, subagentId } = mapSubagentStart(input);
    const evt = (run as any).startEvent(start) as EventLike;
    inFlightSubagents.set(subagentId, evt);
  }

  async function subagentStop(input: SubagentStopInput): Promise<void> {
    const run = await runPromise;
    if (!run) return;
    const { finish, subagentId } = mapSubagentStop(input);
    const evt = inFlightSubagents.get(subagentId);
    if (!evt) return;
    inFlightSubagents.delete(subagentId);
    await evt.finish(finish);
  }

  function wrap(fn: (input: any) => Promise<void>): HookCallback {
    return async (input) => {
      try { await fn(input); } catch (err) {
        console.error('[@jenz-ai/claude-agent-sdk] hook error', err);
      }
      return { continue: true };
    };
  }

  return {
    PreToolUse: [{ hooks: [wrap(preToolUse)] }],
    PostToolUse: [{ hooks: [wrap(postToolUse)] }],
    PostToolUseFailure: [{ hooks: [wrap(postToolUseFailure)] }],
    SubagentStart: [{ hooks: [wrap(subagentStart)] }],
    SubagentStop: [{ hooks: [wrap(subagentStop)] }],
  };
}

/**
 * Merge user's existing hooks with jenz hooks. User matchers fire first
 * (their semantic behavior), then ours append as pure observers.
 */
export function mergeHooks(userHooks: Hooks | undefined, jenzHooks: Hooks): Hooks {
  const merged: Hooks = { ...userHooks };
  for (const [event, ours] of Object.entries(jenzHooks)) {
    if (!ours) continue;
    merged[event] = [...(userHooks?.[event] ?? []), ...ours];
  }
  return merged;
}
