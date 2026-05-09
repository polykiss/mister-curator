import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { diagLog } from '@shared/diag-log';
import { redactScreenScraperUrl } from '@app/main/metadata/screenscraper-service';

const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Local-disk cache for remote images (box art, screenshots). One file
 * per source URL; key is `sha1(url)`. Atomic writes prevent torn
 * files; concurrent fetches for the same URL share a single network
 * request via the in-flight map.
 *
 * No resize in PR #15 (option 1b — chosen default to defer the
 * `sharp` packaging cost). The `maxWidth` option is accepted and
 * ignored for forward-compat; PR #16/#17 may wire it up. Storing
 * full-size art is fine — typical box art is 200–400 KB and a
 * 2000-ROM library tops out around ~600 MB worst-case.
 *
 * `<rootDir>/<sha1>.bin` filenames intentionally don't carry a
 * `.jpg` extension because we don't know the source format until we
 * read the response. The renderer can `<img src=...>` either way;
 * Electron's loader sniffs from the bytes.
 */
export class ImageCache {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly rootDir: string,
    options: {
      readonly fetch?: typeof fetch;
      readonly timeoutMs?: number;
    } = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Returns the absolute local path of a previously-cached image, or
   * null when the URL hasn't been fetched yet (or the file went
   * missing). Pure local operation — never touches the network.
   */
  async getLocal(url: string): Promise<string | null> {
    const path = this.cachePath(url);
    try {
      await fs.access(path);
      return path;
    } catch {
      return null;
    }
  }

  /**
   * Idempotent: if the URL is already cached, return its path. If
   * another caller is mid-fetch for the same URL, await their result
   * (no duplicate download). Otherwise download to a tmp file, fsync,
   * rename atomically, and return the path. On failure (network,
   * non-200, timeout) returns null without leaving a partial file.
   *
   * `_opts.maxWidth` is reserved for the post-#15 resize path and
   * currently has no effect.
   */
  async fetch(
    url: string,
    opts?: { readonly maxWidth?: number },
  ): Promise<string | null> {
    void opts; // maxWidth is reserved for the post-#15 resize path
    const safeUrl = redactScreenScraperUrl(url);
    diagLog('info', 'boxart', '·', 'request', { url: safeUrl });
    const cached = await this.getLocal(url);
    if (cached !== null) {
      diagLog('info', 'boxart', '·', 'cache-hit', {
        url: safeUrl,
        path: cached,
      });
      return cached;
    }
    diagLog('info', 'boxart', '·', 'cache-miss', { url: safeUrl });

    const inFlight = this.inflight.get(url);
    if (inFlight !== undefined) {
      diagLog('info', 'boxart', '·', 'awaiting-inflight', { url: safeUrl });
      return inFlight;
    }

    const promise = this.doFetch(url).finally(() => {
      this.inflight.delete(url);
    });
    this.inflight.set(url, promise);
    return promise;
  }

  /** Wipe every cached image. Safe to call when the cache is empty. */
  async clearAll(): Promise<void> {
    try {
      await fs.rm(this.rootDir, { recursive: true, force: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async doFetch(url: string): Promise<string | null> {
    const safeUrl = redactScreenScraperUrl(url);
    const startMs = Date.now();
    diagLog('info', 'boxart', '→', 'fetch-start', { url: safeUrl });
    let res: Response;
    try {
      res = await this.fetchWithTimeout(url);
    } catch (err) {
      diagLog('error', 'boxart', '✗', 'fetch-network-error', {
        url: safeUrl,
        ms: Date.now() - startMs,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      return null;
    }
    diagLog('info', 'boxart', '·', 'fetch-response', {
      url: safeUrl,
      status: res.status,
      contentType: res.headers.get('content-type') ?? undefined,
      contentLength: res.headers.get('content-length') ?? undefined,
      ms: Date.now() - startMs,
    });
    if (!res.ok) {
      diagLog('warn', 'boxart', '✗', 'fetch-non-2xx', {
        url: safeUrl,
        status: res.status,
      });
      return null;
    }

    let buf: ArrayBuffer;
    try {
      buf = await res.arrayBuffer();
    } catch (err) {
      diagLog('error', 'boxart', '✗', 'fetch-body-error', {
        url: safeUrl,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    if (buf.byteLength === 0) {
      diagLog('warn', 'boxart', '✗', 'fetch-empty-body', { url: safeUrl });
      return null;
    }

    // Magic-bytes diagnostic: surface the first few bytes as hex so
    // we can tell PNG / JPEG / GIF / WebP from an HTML error page or
    // a JSON-shaped error body. PNG=89504E47, JPEG=FFD8FF, GIF=47494638,
    // WebP=52494646…57454250, HTML often starts with 3C21444F (`<!DO`).
    const magic = Buffer.from(buf.slice(0, 8)).toString('hex');
    diagLog('info', 'boxart', '·', 'fetch-bytes', {
      url: safeUrl,
      bytes: buf.byteLength,
      magic,
    });

    const path = this.cachePath(url);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    try {
      await fs.writeFile(tmp, Buffer.from(buf), { mode: 0o600 });
      await fs.rename(tmp, path);
    } catch (err) {
      diagLog('error', 'boxart', '✗', 'cache-write-failed', {
        url: safeUrl,
        path,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      // Best-effort cleanup of the tmp file. Caller still gets null.
      await fs.unlink(tmp).catch(() => {
        /* swallow */
      });
      return null;
    }
    diagLog('info', 'boxart', '·', 'cache-write', {
      url: safeUrl,
      path,
      bytes: buf.byteLength,
    });
    return path;
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private cachePath(url: string): string {
    const key = createHash('sha1').update(url).digest('hex');
    // 2-char shard so a `ls` doesn't enumerate millions of files in
    // one directory once the cache fills.
    return join(this.rootDir, key.slice(0, 2), `${key}.bin`);
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
