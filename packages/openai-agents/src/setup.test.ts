import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@openai/agents-core', async () => {
  // Provide a mock with `addTraceProcessor` that we can assert on.
  return {
    addTraceProcessor: vi.fn(),
  };
});

vi.mock('@jenz-ai/sdk', async () => {
  return {
    JenzClient: vi.fn().mockImplementation(function (this: any, opts: any) {
      const apiKey = opts.apiKey || process.env.JENZ_API_KEY;
      if (!apiKey) {
        throw new Error('apiKey is required');
      }
      this.opts = opts;
    }),
  };
});

import { addTraceProcessor } from '@openai/agents-core';
import { JenzClient } from '@jenz-ai/sdk';
import { setupJenz, __resetSetupForTests } from './setup.js';

describe('setupJenz', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    __resetSetupForTests();
    delete process.env.JENZ_API_KEY;
  });
  afterEach(() => {
    delete process.env.JENZ_API_KEY;
  });

  it('registers a processor when JENZ_API_KEY is set', () => {
    process.env.JENZ_API_KEY = 'test';
    setupJenz();
    expect(addTraceProcessor).toHaveBeenCalledTimes(1);
  });

  it('logs dormant warning and registers NO processor when key missing', () => {
    setupJenz();
    expect(addTraceProcessor).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('dormant'));
  });

  it('is idempotent: second call warns, does not double-register', () => {
    process.env.JENZ_API_KEY = 'test';
    setupJenz();
    setupJenz();
    expect(addTraceProcessor).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('already'));
  });

  it('passes apiKey/baseUrl/timeoutMs through to JenzClient constructor', () => {
    setupJenz({ apiKey: 'explicit', baseUrl: 'https://example.test', timeoutMs: 1000 });
    expect(JenzClient).toHaveBeenCalledWith({
      apiKey: 'explicit',
      baseUrl: 'https://example.test',
      timeoutMs: 1000,
    });
    expect(addTraceProcessor).toHaveBeenCalledTimes(1);
  });
});
