import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { sanitiseFsSegment } from '@app/main/cache/cache-types';
import { diagLog } from '@shared/diag-log';
import type { HashRecord } from '@shared/mister-client';

const HASH_CACHE_SCHEMA_VERSION = 1 as const;

/**
 * Bump this constant whenever the algorithm that produces the cached
 * hashes changes. Existing cache files without a matching
 * `hashStrategyVersion` are treated as a full miss and re-hashed on
 * next access — no manual `rm` required.
 *
 * Distinct from `HASH_CACHE_SCHEMA_VERSION` (the on-disk file shape):
 * the file shape can stay v1 while the values inside it become invalid
 * because the algorithm changed underneath.
 *
 * Strategy timeline:
 *   v1 (PR #15 rounds 1–5): direct `md5sum` of every file, including
 *                           .zip wrappers.
 *   v2 (PR #15 round 6+):   .zip files routed through `unzip -p |
 *                           md5sum` so the cached hash matches
 *                           OpenVGDB's inner-rom indexing.
 *   v3 (PR #16 round 2):    md5 + sha1 + extracted-content size in
 *                           one pass per file. SHA-1 alongside MD5
 *                           lets ScreenScraper match either hash;
 *                           cached size feeds SS's `romtaille`.
 */
const HASH_STRATEGY_VERSION = 3 as const;

/** Cap per SSH round-trip. Larger inputs chunk in JS. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * One persisted entry. mtime is epoch seconds of the wrapper file
 * (cache invalidation key — what the user actually touches). md5
 * and sha1 are hashes of the EXTRACTED ROM content (inner-file for
 * .zip wrappers, raw bytes for direct files). size is the extracted
 * byte count, matching SS's `romtaille` semantics.
 */
export interface HashEntry {
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
  readonly mtime: number;
  readonly hashedAt: string;
}

interface HashCacheFile {
  readonly version: typeof HASH_CACHE_SCHEMA_VERSION;
  /** Forces a re-hash when the algorithm bumps. */
  readonly hashStrategyVersion: typeof HASH_STRATEGY_VERSION;
  readonly host: string;
  readonly entries: Readonly<Record<string, HashEntry>>;
}

/**
 * Subset of `IMisterClient` we actually need. Letting the HashService
 * take this shape (rather than the full client interface) keeps the
 * unit tests independent of node-ssh or `FakeMisterClient` — a tiny
 * inline mock supplies just the two methods.
 */
export interface HashClient {
  statWitnesses(paths: readonly string[]): Promise<Record<string, number>>;
  hashPaths(paths: readonly string[]): Promise<readonly HashRecord[]>;
}

export interface HashServiceOptions {
  /** Chunk size for `hashPaths` calls. Test override. */
  readonly batchSize?: number;
  /** Test seam — override for deterministic `hashedAt` timestamps. */
  readonly now?: () => Date;
}

/**
 * Hashes of ROM files on the MiSTer, persisted per-host on local
 * disk. Keyed by the file's absolute path on the device; entries
 * invalidate when the file's mtime changes.
 *
 * Round 2 (PR #16): each entry now carries md5 + sha1 + extracted
 * size, computed in one device-side script pass. ScreenScraper takes
 * md5 + sha1 in a single multi-hash query and cross-matches; the
 * cached size feeds SS's `romtaille` parameter.
 *
 * Pipeline shape:
 *   1. Caller supplies paths to `getHash`.
 *   2. For paths we have cached, stat the device once to verify
 *      mtime. A mtime match returns the cached entry with no hash
 *      call.
 *   3. For paths we don't have cached or whose mtime drifted, batch
 *      `hashPaths` in chunks of `batchSize` (default 100).
 *   4. Write the merged result back to disk atomically.
 *
 * Concurrency: all `getHash` calls for one host serialize through a
 * per-host Promise chain. Two callers asking for overlapping paths
 * naturally share work — caller B awaits A, then sees A's freshly-
 * cached entries on its own pass. Same coalescing pattern
 * `ConnectionManager` uses for `listAllCoresWithFiles`.
 *
 * No on-device writes. The cache lives entirely under
 * `<rootDir>/<host>/hashes.json`.
 */
export class HashService {
  private readonly batchSize: number;
  private readonly now: () => Date;
  /** Lazily-loaded in-memory copy. Source of truth between calls. */
  private readonly memCache = new Map<string, Record<string, HashEntry>>();
  /** Per-host serialization gate. */
  private readonly gates = new Map<string, Promise<unknown>>();

  constructor(
    private readonly rootDir: string,
    options: HashServiceOptions = {},
  ) {
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.now = options.now ?? ((): Date => new Date());
  }

  /**
   * Hash the supplied paths. Returns a Map keyed by the original
   * input path. Each value is the full {md5, sha1, size, mtime,
   * hashedAt} entry — pulled from cache when fresh, otherwise the
   * device-side script computes it.
   *
   * `host` is the cache-key dimension. Two MiSTer profiles at the
   * same IP but different SD cards are correctly partitioned because
   * the caller passes a different `host` per profile.
   */
  async getHash(
    client: HashClient,
    host: string,
    paths: readonly string[],
  ): Promise<Map<string, HashEntry>> {
    if (paths.length === 0) return new Map();
    return this.runGated(host, () => this.doGetHash(client, host, paths));
  }

  /**
   * Drop a single path's cache entry. Used after a hide/show rename
   * so the next hash request walks fresh. Best-effort — a missing
   * entry is a no-op.
   */
  async invalidate(host: string, path: string): Promise<void> {
    return this.runGated(host, async () => {
      const entries = await this.loadEntries(host);
      if (!(path in entries)) return;
      const next = { ...entries };
      delete next[path];
      this.memCache.set(host, next);
      await this.writeEntries(host, next);
    });
  }

  /** Wipe all hash cache for one host. */
  async clearForHost(host: string): Promise<void> {
    return this.runGated(host, async () => {
      this.memCache.delete(host);
      const path = this.cachePath(host);
      try {
        await fs.unlink(path);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') return;
        throw err;
      }
    });
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async doGetHash(
    client: HashClient,
    host: string,
    paths: readonly string[],
  ): Promise<Map<string, HashEntry>> {
    const entries = await this.loadEntries(host);
    const result = new Map<string, HashEntry>();

    // Validate any cached paths in one stat batch. A cache hit needs
    // the current mtime to match the recorded one.
    const cachedPaths = paths.filter((p) => entries[p] !== undefined);
    const needsHash: string[] = paths.filter((p) => entries[p] === undefined);

    // Round 6 diag — per-path cache-check decision. For the round-6
    // investigation we only ever run with paths.length === 1 from
    // the orchestrator's per-ROM loop, so logging per-path here is
    // exactly the granularity the user wants.
    for (const p of paths) {
      const cached = entries[p];
      diagLog('info', 'meta', '·', 'hash-cache', {
        path: pathBasename(p),
        hit: cached !== undefined ? 1 : 0,
        md5: cached?.md5,
      });
    }

    if (cachedPaths.length > 0) {
      const mtimes = await client.statWitnesses(cachedPaths);
      for (const p of cachedPaths) {
        const entry = entries[p];
        const current = mtimes[p];
        if (
          entry !== undefined &&
          current !== undefined &&
          current !== 0 &&
          current === entry.mtime
        ) {
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(p),
            action: 'use-cache',
            reason: 'mtime-match',
            mtime: current,
          });
          result.set(p, entry);
        } else {
          // Either missing-on-device, or mtime drifted. Either way,
          // re-hash. (If the file is genuinely gone the hash call
          // will silently drop it and we'll just not return the path.)
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(p),
            action: 'stale-revalidate',
            reason:
              current === undefined || current === 0
                ? 'missing-on-device'
                : 'mtime-drift',
            cachedMtime: entry?.mtime,
            currentMtime: current,
          });
          needsHash.push(p);
        }
      }
    }

    if (needsHash.length === 0) return result;

    // Round 6 — log the compute decision for every path that's about
    // to hash. `cache-miss` for never-seen-before, `stale-revalidate`
    // already logged above (we don't re-log here).
    for (const p of needsHash) {
      if (entries[p] === undefined) {
        diagLog('info', 'meta', '·', 'hash-decision', {
          path: pathBasename(p),
          action: 'compute',
          reason: 'cache-miss',
        });
      }
    }

    // Hash uncached / stale paths in bounded chunks. We update the
    // in-memory map per chunk so a partial failure later in the
    // batch still preserves the work that succeeded earlier.
    const next: Record<string, HashEntry> = { ...entries };
    let dirty = false;
    const nowIso = this.now().toISOString();
    for (let i = 0; i < needsHash.length; i += this.batchSize) {
      const chunk = needsHash.slice(i, i + this.batchSize);
      const records = await client.hashPaths(chunk);
      for (const r of records) {
        const entry: HashEntry = {
          md5: r.md5,
          sha1: r.sha1,
          size: r.size,
          mtime: r.mtime,
          hashedAt: nowIso,
        };
        result.set(r.path, entry);
        next[r.path] = entry;
        dirty = true;
        diagLog('info', 'meta', '·', 'hash-computed', {
          path: pathBasename(r.path),
          md5: r.md5,
          size: r.size,
        });
      }
    }

    if (dirty) {
      this.memCache.set(host, next);
      await this.writeEntries(host, next);
    }

    return result;
  }

  /**
   * Serialize calls per host. The first call sets up the chain;
   * later calls await the tail. Failures don't break the chain —
   * the catch arm replaces a rejection with a resolved value so
   * the gate keeps advancing (the caller still sees the rejection
   * on the original promise).
   */
  private async runGated<T>(host: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.gates.get(host) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.gates.set(
      host,
      next.catch(() => undefined),
    );
    return next;
  }

  private async loadEntries(host: string): Promise<Record<string, HashEntry>> {
    const cached = this.memCache.get(host);
    if (cached !== undefined) return cached;
    const file = await readJsonOrNull<unknown>(this.cachePath(host));
    if (file === null || !isHashCacheFile(file) || file.host !== host) {
      const empty: Record<string, HashEntry> = {};
      this.memCache.set(host, empty);
      return empty;
    }
    const entries = { ...file.entries };
    this.memCache.set(host, entries);
    return entries;
  }

  private async writeEntries(
    host: string,
    entries: Record<string, HashEntry>,
  ): Promise<void> {
    const data: HashCacheFile = {
      version: HASH_CACHE_SCHEMA_VERSION,
      hashStrategyVersion: HASH_STRATEGY_VERSION,
      host,
      entries,
    };
    await writeJsonAtomic(this.cachePath(host), data);
  }

  private cachePath(host: string): string {
    return join(this.rootDir, sanitiseFsSegment(host), 'hashes.json');
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

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

function isHashCacheFile(v: unknown): v is HashCacheFile {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== HASH_CACHE_SCHEMA_VERSION) return false;
  // A missing or mismatched `hashStrategyVersion` invalidates the
  // cache wholesale. Pre-round-7 files don't have the field at all;
  // pre-round-2-of-PR-#16 files have v2 (md5 only); v3 files have
  // md5 + sha1 + size. We re-hash anything that doesn't match.
  if (o.hashStrategyVersion !== HASH_STRATEGY_VERSION) return false;
  if (typeof o.host !== 'string') return false;
  if (o.entries === null || typeof o.entries !== 'object') return false;
  for (const entry of Object.values(o.entries as Record<string, unknown>)) {
    if (!isHashEntry(entry)) return false;
  }
  return true;
}

function isHashEntry(v: unknown): v is HashEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.md5 === 'string' &&
    typeof o.sha1 === 'string' &&
    typeof o.size === 'number' &&
    typeof o.mtime === 'number' &&
    typeof o.hashedAt === 'string'
  );
}

/** Last path segment, used in diag logs to keep lines readable. */
function pathBasename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
