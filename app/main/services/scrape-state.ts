import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { sanitiseFsSegment } from '@app/main/cache/cache-types';

/**
 * feat/auto-scrape-persistence — per-host record of when each core
 * finished a full auto-scrape pass. Pre-fix the engine had no notion
 * of "done" beyond "queue is currently empty" — a fresh connect
 * re-walked every core's metadata even though the cache was warm,
 * burning user wall-time on cold cores that DID finish last session.
 *
 * Store shape: a small JSON file at
 * `<rootDir>/<host>/scrape-state.json`. Keyed by host (matches the
 * hash-cache + cores-cache layout) so two profiles at the same IP
 * with different SD cards stay partitioned.
 *
 * Entry shape: coreId → ISO 8601 timestamp of last successful
 * scrape completion. Hash-strategy-style schema versioning lets us
 * invalidate the whole file when the algorithm changes upstream.
 *
 * Read pattern: load once on connect (small file, fast), keep a
 * lazy in-memory map. Write pattern: append per core completion
 * (atomic JSON rewrite — file is tiny so the rewrite cost is
 * negligible). No batching; ~100 cores × 1 write per scrape
 * session = bounded.
 */

const SCRAPE_STATE_SCHEMA_VERSION = 1 as const;

interface ScrapeStateFile {
  readonly version: typeof SCRAPE_STATE_SCHEMA_VERSION;
  readonly host: string;
  readonly entries: Readonly<Record<string, string>>;
}

export interface ScrapeStateOptions {
  /** Test seam — override for deterministic timestamps. */
  readonly now?: () => Date;
}

/**
 * Per-host scrape-state cache. Methods are async because the disk
 * write is awaited; the in-memory hot path stays synchronous after
 * the first load.
 */
export class ScrapeStateStore {
  private readonly memCache = new Map<string, Map<string, string>>();
  private readonly now: () => Date;

  constructor(
    private readonly rootDir: string,
    options: ScrapeStateOptions = {},
  ) {
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Load all `(coreId, lastScrapedAt)` entries for a host. Returns an
   * empty map when the file doesn't exist (first connect, post-cache-
   * wipe, etc.).
   */
  async load(host: string): Promise<ReadonlyMap<string, string>> {
    const cached = this.memCache.get(host);
    if (cached !== undefined) return cached;
    const file = await readJsonOrNull<unknown>(this.cachePath(host));
    if (file === null || !isScrapeStateFile(file) || file.host !== host) {
      const empty = new Map<string, string>();
      this.memCache.set(host, empty);
      return empty;
    }
    const m = new Map<string, string>(Object.entries(file.entries));
    this.memCache.set(host, m);
    return m;
  }

  /**
   * Mark a core as scraped right now (or at the test-supplied time).
   * Atomic disk rewrite + in-memory update.
   */
  async markScraped(host: string, coreId: string): Promise<void> {
    const m = await this.loadMutable(host);
    m.set(coreId, this.now().toISOString());
    await this.persist(host, m);
  }

  /**
   * Drop a core's recorded timestamp — used when the renderer
   * forces a rescan via Refresh, or when the user re-clicks a
   * completed core in the same session.
   */
  async clear(host: string, coreId: string): Promise<void> {
    const m = await this.loadMutable(host);
    if (!m.has(coreId)) return;
    m.delete(coreId);
    await this.persist(host, m);
  }

  /** Wipe every entry for a host. */
  async clearForHost(host: string): Promise<void> {
    this.memCache.delete(host);
    const path = this.cachePath(host);
    try {
      await fs.unlink(path);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  /**
   * Return the set of coreIds whose last-scraped timestamp is within
   * `windowMs` of now. The wiring layer uses this to seed the
   * engine's in-session completed-set on connect — those cores get
   * SKIPPED on this session's queue walk.
   */
  async coresScrapedWithin(
    host: string,
    windowMs: number,
  ): Promise<ReadonlySet<string>> {
    const m = await this.load(host);
    const cutoff = this.now().getTime() - windowMs;
    const out = new Set<string>();
    for (const [coreId, iso] of m) {
      const t = Date.parse(iso);
      if (Number.isFinite(t) && t >= cutoff) out.add(coreId);
    }
    return out;
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async loadMutable(host: string): Promise<Map<string, string>> {
    await this.load(host); // populate memCache if missing
    // Cache returned by `load` IS the in-memory map; safe to mutate.
    return this.memCache.get(host)!;
  }

  private async persist(host: string, m: Map<string, string>): Promise<void> {
    const file: ScrapeStateFile = {
      version: SCRAPE_STATE_SCHEMA_VERSION,
      host,
      entries: Object.fromEntries(m),
    };
    await writeJsonAtomic(this.cachePath(host), file);
  }

  private cachePath(host: string): string {
    return join(this.rootDir, sanitiseFsSegment(host), 'scrape-state.json');
  }
}

// ─── helpers (mirrored from hash-service.ts) ────────────────────────

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return null;
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
  await fs.rename(tmp, path);
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isScrapeStateFile(v: unknown): v is ScrapeStateFile {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== SCRAPE_STATE_SCHEMA_VERSION) return false;
  if (typeof o.host !== 'string') return false;
  if (o.entries === null || typeof o.entries !== 'object') return false;
  for (const v of Object.values(o.entries as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}
