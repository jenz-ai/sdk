import { describe, it, expect, vi } from 'vitest';
import { buildJenzHooks, mergeHooks } from './hooks.js';

// Fake Event with a finish spy
function makeFakeEvent() {
  const finish = vi.fn().mockResolvedValue({ eventId: 'evt-' + Math.random(), stopRequested: false });
  return { finish };
}

// Fake Run: records startEvent calls and returns fresh fake events.
function makeFakeRun() {
  const events: any[] = [];
  const updateAvailableTools = vi.fn().mockResolvedValue(undefined);
  const startEvent = vi.fn().mockImplementation((input: any) => {
    const evt = makeFakeEvent();
    events.push({ input, evt });
    return evt;
  });
  return { events, startEvent, updateAvailableTools } as any;
}

describe('buildJenzHooks', () => {
  it('returns hooks for the 5 expected events', () => {
    const run = makeFakeRun();
    const hooks = buildJenzHooks(Promise.resolve(run));
    expect(Object.keys(hooks).sort()).toEqual(
      ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SubagentStart', 'SubagentStop'].sort(),
    );
  });

  it('PreToolUse hook records tool_call start + updates available tools (first time only)', async () => {
    const run = makeFakeRun();
    const hooks = buildJenzHooks(Promise.resolve(run));
    const preHook = hooks.PreToolUse![0].hooks[0];

    await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1', tool_name: 'Read', tool_input: { file_path: '/x' } } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-2', tool_name: 'Read', tool_input: { file_path: '/y' } } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-3', tool_name: 'Edit', tool_input: {} } as any,
      undefined,
      { signal: new AbortController().signal },
    );

    expect(run.startEvent).toHaveBeenCalledTimes(3);
    expect(run.updateAvailableTools).toHaveBeenCalledTimes(2);
    expect(run.updateAvailableTools).toHaveBeenNthCalledWith(1, ['Read']);
    expect(run.updateAvailableTools).toHaveBeenNthCalledWith(2, ['Edit']);
  });

  it('PostToolUse hook finishes the in-flight tool_call by tool_use_id', async () => {
    const run = makeFakeRun();
    const hooks = buildJenzHooks(Promise.resolve(run));
    const preHook = hooks.PreToolUse![0].hooks[0];
    const postHook = hooks.PostToolUse![0].hooks[0];

    await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-X', tool_name: 'Read', tool_input: {} } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    await postHook(
      { hook_event_name: 'PostToolUse', tool_use_id: 'tu-X', tool_name: 'Read', tool_input: {}, tool_response: 'OK' } as any,
      undefined,
      { signal: new AbortController().signal },
    );

    const evt = run.events.find((e: any) => e.input.name === 'Read')!.evt;
    expect(evt.finish).toHaveBeenCalledWith({ output: 'OK' });
  });

  it('orphaned PostToolUse (no matching Pre) is silently dropped, never throws', async () => {
    const run = makeFakeRun();
    const hooks = buildJenzHooks(Promise.resolve(run));
    const postHook = hooks.PostToolUse![0].hooks[0];

    const out = await postHook(
      { hook_event_name: 'PostToolUse', tool_use_id: 'tu-orphan', tool_name: 'Read', tool_input: {}, tool_response: 'OK' } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ continue: true });
  });

  it('hook always returns { continue: true } even if internals throw', async () => {
    const brokenRun = { startEvent: () => { throw new Error('boom'); }, updateAvailableTools: () => Promise.reject() } as any;
    const hooks = buildJenzHooks(Promise.resolve(brokenRun));
    const preHook = hooks.PreToolUse![0].hooks[0];

    const out = await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1', tool_name: 'X', tool_input: {} } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ continue: true });
  });

  it('runPromise resolves to null → hook is a no-op, returns { continue: true }', async () => {
    const hooks = buildJenzHooks(Promise.resolve(null));
    const preHook = hooks.PreToolUse![0].hooks[0];

    const out = await preHook(
      { hook_event_name: 'PreToolUse', tool_use_id: 'tu-1', tool_name: 'X', tool_input: {} } as any,
      undefined,
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({ continue: true });
  });
});

describe('mergeHooks', () => {
  it('appends jenz matchers after user matchers (user fires first)', () => {
    const userMatcher = { hooks: [vi.fn()] };
    const jenzMatcher = { hooks: [vi.fn()] };
    const merged = mergeHooks({ PreToolUse: [userMatcher] } as any, { PreToolUse: [jenzMatcher] } as any);
    expect(merged.PreToolUse).toEqual([userMatcher, jenzMatcher]);
  });

  it('preserves user hooks for events jenz doesn\'t observe', () => {
    const userMatcher = { hooks: [vi.fn()] };
    const merged = mergeHooks({ Notification: [userMatcher] } as any, { PreToolUse: [{ hooks: [vi.fn()] }] } as any);
    expect((merged as any).Notification).toEqual([userMatcher]);
  });

  it('handles undefined user hooks', () => {
    const jenzMatcher = { hooks: [vi.fn()] };
    const merged = mergeHooks(undefined, { PreToolUse: [jenzMatcher] } as any);
    expect(merged.PreToolUse).toEqual([jenzMatcher]);
  });
});
