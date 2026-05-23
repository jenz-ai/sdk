import { describe, it, expect } from 'vitest';
import { runContext } from './als.js';
import { getActiveRun } from './with-run.js';

describe('getActiveRun', () => {
  it('returns undefined outside any ALS scope', () => {
    expect(getActiveRun()).toBeUndefined();
  });

  it('returns the active run inside runContext.run(...)', () => {
    const fakeRun = { id: 'r1' } as any;
    let captured: unknown;
    runContext.run({ run: fakeRun }, () => {
      captured = getActiveRun();
    });
    expect(captured).toBe(fakeRun);
  });

  it('returns the active run inside runContext.enterWith(...)', async () => {
    const fakeRun = { id: 'r2' } as any;
    await new Promise<void>((resolve) => {
      runContext.run({ run: fakeRun }, () => {
        Promise.resolve().then(() => {
          expect(getActiveRun()).toBe(fakeRun);
          resolve();
        });
      });
    });
  });
});
