import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tryCreateClient, __resetClientForTests } from './client.js';

describe('tryCreateClient', () => {
  const origKey = process.env.JENZ_API_KEY;

  beforeEach(() => {
    __resetClientForTests();
    delete process.env.JENZ_API_KEY;
  });

  afterEach(() => {
    if (origKey === undefined) delete process.env.JENZ_API_KEY;
    else process.env.JENZ_API_KEY = origKey;
  });

  it('returns null + warns once when JENZ_API_KEY is missing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = tryCreateClient();
    const b = tryCreateClient();
    expect(a).toBeNull();
    expect(b).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('JENZ_API_KEY');
    warn.mockRestore();
  });

  it('returns a JenzClient when JENZ_API_KEY is set', () => {
    process.env.JENZ_API_KEY = 'jk_test_123';
    const client = tryCreateClient();
    expect(client).not.toBeNull();
    expect(typeof (client as any).startRun).toBe('function');
  });

  it('caches the client (singleton) across calls', () => {
    process.env.JENZ_API_KEY = 'jk_test_123';
    const a = tryCreateClient();
    const b = tryCreateClient();
    expect(a).toBe(b);
  });
});
