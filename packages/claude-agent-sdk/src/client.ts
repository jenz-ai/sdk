import { JenzClient } from '@jenz-ai/sdk';

let cached: JenzClient | null = null;
let warned = false;

/**
 * Returns a singleton JenzClient if JENZ_API_KEY is set; otherwise returns null
 * and prints a one-time warning. Subsequent calls reuse the cached instance.
 */
export function tryCreateClient(): JenzClient | null {
  if (cached) return cached;
  try {
    cached = new JenzClient();
    return cached;
  } catch {
    if (!warned) {
      warned = true;
      console.warn(
        '[jenz] Observability is dormant — JENZ_API_KEY not set.\n' +
          '       Get a key at https://jenz.dev/api-keys, add JENZ_API_KEY=... to .env, restart.\n' +
          '       Your agent will run normally; no data is being sent.',
      );
    }
    return null;
  }
}

/** @internal — used by tests to reset module state between cases. */
export function __resetClientForTests(): void {
  cached = null;
  warned = false;
}
