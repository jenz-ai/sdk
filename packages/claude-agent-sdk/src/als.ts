import { AsyncLocalStorage } from 'node:async_hooks';
import type { Run } from '@jenz-ai/sdk';

interface RunContext {
  run: Run;
}

export const runContext = new AsyncLocalStorage<RunContext>();
