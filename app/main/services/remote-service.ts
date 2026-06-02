/**
 * feat/launch — mrext Remote HTTP API client.
 *
 * Wraps the two operations needed for "Launch on MiSTer":
 *   - probe(host)   → GET  /api/sysinfo (availability + version check)
 *   - launch(host, path) → POST /api/launch  {path}
 *
 * Per-host status cache is populated by probe() and cleared on
 * disconnect. All requests carry a 2.5 s AbortController timeout so
 * a non-responsive Remote never blocks the connect flow.
 *
 * The `fetch` constructor option is a test seam (mirrors
 * screenscraper-service.ts); production code uses `global.fetch`
 * (available in Electron main via Node 18+ / Chromium).
 */

const REMOTE_PORT = 8182;
const TIMEOUT_MS = 2500;

export interface RemoteStatus {
  readonly available: boolean;
  readonly version: string | null;
}

export interface LaunchResult {
  readonly ok: boolean;
  readonly httpStatus: number;
}

interface SysInfoWire {
  readonly version?: string;
}

export interface RemoteServiceOptions {
  /** Test seam — defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
}

export class RemoteService {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, RemoteStatus>();

  constructor(options: RemoteServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  /**
   * Probe the Remote API on `host`. Results are cached per-host.
   * Never throws — any error resolves to unavailable.
   */
  async probe(host: string): Promise<RemoteStatus> {
    const url = `http://${host}:${String(REMOTE_PORT)}/api/sysinfo`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
      });
      if (!res.ok) {
        const status: RemoteStatus = { available: false, version: null };
        this.cache.set(host, status);
        return status;
      }
      const body = await res.json() as SysInfoWire;
      const status: RemoteStatus = {
        available: true,
        version: body.version ?? null,
      };
      this.cache.set(host, status);
      return status;
    } catch {
      const status: RemoteStatus = { available: false, version: null };
      this.cache.set(host, status);
      return status;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Return the cached status for `host`, or unavailable if never probed.
   */
  getStatus(host: string | null): RemoteStatus {
    if (host === null) return { available: false, version: null };
    return this.cache.get(host) ?? { available: false, version: null };
  }

  /**
   * Launch the game at `path` on the connected MiSTer.
   * Uses POST /api/launch — handles .mra, .rbf, and ROM files.
   * Returns {ok:false, httpStatus:0} on network error or timeout.
   */
  async launch(host: string | null, path: string): Promise<LaunchResult> {
    if (host === null) return { ok: false, httpStatus: 0 };
    const url = `http://${host}:${String(REMOTE_PORT)}/api/launch`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        signal: controller.signal,
      });
      return { ok: res.ok, httpStatus: res.status };
    } catch {
      return { ok: false, httpStatus: 0 };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Drop the cached status for `host`.
   */
  clearStatus(host: string): void {
    this.cache.delete(host);
  }

  /**
   * Drop all cached statuses (call on disconnect when the host is no longer known).
   */
  clearAll(): void {
    this.cache.clear();
  }
}
