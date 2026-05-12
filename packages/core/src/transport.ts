export interface TransportOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in milliseconds. Defaults to 10_000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Fire-and-forget HTTP client.
 *
 * - Never throws: every error path returns `null`. Observability must not crash the host agent.
 * - Returns the parsed JSON body on 2xx so callers can read `stopRequested` and other backend signals.
 * - Aborts requests that exceed `timeoutMs` (default 10s).
 */
export class Transport {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(opts: TransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async post<T>(path: string, body: unknown): Promise<T | null> {
    return this.send<T>('POST', path, body);
  }

  async patch<T>(path: string, body: unknown): Promise<T | null> {
    return this.send<T>('PATCH', path, body);
  }

  async get<T>(path: string): Promise<T | null> {
    return this.send<T>('GET', path, undefined);
  }

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
  ): Promise<T | null> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[jenz] ${method} ${path} → ${res.status} ${text}`);
        return null;
      }
      if (res.status === 204) return null;
      return (await res.json()) as T;
    } catch (err) {
      // AbortError is the timeout; everything else is network/parse error.
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[jenz] ${method} ${path} failed: ${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
