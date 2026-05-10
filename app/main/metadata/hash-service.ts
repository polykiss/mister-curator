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
  /**
   * fix/sidebar-count-and-mtime-batch round 2: per-path stat that
   * returns mtime AND size. Used by the rename-recovery path to
   * discriminate by (mtime, size) — mtime alone collapses too
   * easily on bulk-copied ROMs that share mtimes within a second
   * (refused as ambiguous → pre-fix every renamed file re-hashed
   * on connect).
   */
  statPathsWithSize(
    paths: readonly string[],
  ): Promise<Record<string, { readonly mtime: number; readonly size: number }>>;
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
   * Round 9 (PR #20) — batched mtime validation. Returns a map
   * keyed by every input path; the value is the cached `HashEntry`
   * when the cache hit is mtime-validated, or `null` when the path
   * is uncached or the recorded mtime no longer matches.
   *
   * One SSH `statWitnesses` call validates all cached paths at
   * once. Replaces the round-5 pattern of N per-ROM `getHash([
   * single])` calls — each of those was issuing its own per-path
   * stat round-trip, which serialized through `runGated` at one-
   * concurrent and produced a 32 × ~470 ms = 15 s wall on a
   * fully-cached SNES core.
   *
   * Pairs with `computeHash(client, host, path)` for the residue:
   * the orchestrator iterates the result map, uses the cached
   * entry where present, and calls `computeHash` only for the
   * `null` rows.
   */
  async checkCachedMtimes(
    client: HashClient,
    host: string,
    paths: readonly string[],
  ): Promise<Map<string, HashEntry | null>> {
    if (paths.length === 0) return new Map();
    return this.runGated(host, () =>
      this.doCheckCachedMtimes(client, host, paths),
    );
  }

  /**
   * Round 9 — single-path hash compute that bypasses the cache
   * lookup + mtime check (the caller already did those via
   * `checkCachedMtimes`). Issues one SSH `hashPaths` exec for the
   * one path, updates the cache with the result, returns the
   * entry. Returns `undefined` when the device drops the path
   * (vanished mid-flight).
   */
  async computeHash(
    client: HashClient,
    host: string,
    path: string,
  ): Promise<HashEntry | undefined> {
    return this.runGated(host, () => this.doComputeHash(client, host, path));
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

    // feat/rename-aware-hash-cache: stat ALL input paths (cached +
    // uncached) in one SSH batch instead of just the cached subset.
    // For uncached paths the extra mtime data fuels the rename
    // recovery below — a rename (Unix `mv`) preserves mtime, so a
    // mtime collision against an existing cache entry is a strong
    // signal the file just moved. Pre-fix every dot-prefixed file
    // (every hidden ROM) re-hashed on every connect because the
    // path-keyed cache stranded the entry under the old un-dotted
    // key. For mame with 600+ hidden ROMs this was ~30-60s of
    // re-hashing per session.
    const cachedPaths = paths.filter((p) => entries[p] !== undefined);
    const needsHash: string[] = paths.filter((p) => entries[p] === undefined);
    const uncachedPaths = [...needsHash];

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

    // Stat both cached + uncached in one SSH op so the rename-
    // recovery pass below has (mtime, size) for each uncached path.
    // Skip the stat for uncached paths when the cache is empty —
    // there's nothing to migrate them onto, and the empty-cache
    // first-run path was the previous behavior (kept fast).
    //
    // round 2 (fix/sidebar-count-and-mtime-batch): use
    // `statPathsWithSize` instead of `statWitnesses` so the
    // migration discriminates by (mtime, size) — bulk-copied ROMs
    // (e.g. mame's 600+ files copied via SMB in one batch) share
    // mtimes within the second, and mtime-only matching refused
    // them as ambiguous.
    const cacheIsEmpty = Object.keys(entries).length === 0;
    const statTargets = cacheIsEmpty
      ? cachedPaths
      : [...cachedPaths, ...uncachedPaths];
    const stats = statTargets.length > 0
      ? await client.statPathsWithSize(statTargets)
      : ({} as Record<string, { mtime: number; size: number }>);

    for (const p of cachedPaths) {
      const entry = entries[p];
      const current = stats[p];
      if (
        entry !== undefined &&
        current !== undefined &&
        current.mtime !== 0 &&
        current.mtime === entry.mtime
      ) {
        diagLog('info', 'meta', '·', 'hash-decision', {
          path: pathBasename(p),
          action: 'use-cache',
          reason: 'mtime-match',
          mtime: current.mtime,
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
            current === undefined || current.mtime === 0
              ? 'missing-on-device'
              : 'mtime-drift',
          cachedMtime: entry?.mtime,
          currentMtime: current?.mtime,
        });
        needsHash.push(p);
      }
    }

    // Rename recovery: for each uncached path, see if its current
    // (mtime, size) uniquely identifies an existing cache entry
    // under a different (old) key. If so, rewrite the key — the
    // file just moved. Track `claimed` keys so a 2+ collision
    // (multiple renamed-to paths trying to claim the same old key)
    // refuses ambiguous migrations rather than aliasing two paths
    // to one hash entry.
    const migrated: { from: string; to: string; entry: HashEntry }[] = [];
    const claimed = new Set<string>();
    for (const p of uncachedPaths) {
      const current = stats[p];
      if (current === undefined || current.mtime === 0) continue;
      const oldKey = findCacheKeyByMtimeAndSize(
        entries,
        current.mtime,
        current.size,
        claimed,
      );
      if (oldKey === null || oldKey === p) continue;
      const entry = entries[oldKey]!;
      claimed.add(oldKey);
      migrated.push({ from: oldKey, to: p, entry });
      result.set(p, entry);
      diagLog('info', 'meta', '·', 'hash-decision', {
        path: pathBasename(p),
        action: 'use-cache',
        reason: 'rename-migrated',
        mtime: current.mtime,
        size: current.size,
        oldKey: pathBasename(oldKey),
      });
    }
    if (migrated.length > 0) {
      const next: Record<string, HashEntry> = { ...entries };
      for (const m of migrated) {
        delete next[m.from];
        next[m.to] = m.entry;
      }
      this.memCache.set(host, next);
      await this.writeEntries(host, next);
      // Drop migrated paths from needsHash (they're now in result).
      const stillNeeds = needsHash.filter(
        (p) => !migrated.some((m) => m.to === p),
      );
      needsHash.length = 0;
      needsHash.push(...stillNeeds);
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

  private async doCheckCachedMtimes(
    client: HashClient,
    host: string,
    paths: readonly string[],
  ): Promise<Map<string, HashEntry | null>> {
    const entries = await this.loadEntries(host);
    const result = new Map<string, HashEntry | null>();
    const cachedPaths = paths.filter((p) => entries[p] !== undefined);
    const uncachedPaths = paths.filter((p) => entries[p] === undefined);
    if (paths.length === 0) return result;
    // feat/rename-aware-hash-cache: stat ALL paths so the rename
    // recovery (uncached paths whose (mtime, size) uniquely identify
    // an existing cache entry) can run alongside the normal
    // cached-path mtime validation. Skip the stat for uncached paths
    // when the cache is empty — there's nothing to migrate them onto.
    //
    // round 2 (fix/sidebar-count-and-mtime-batch): use
    // `statPathsWithSize` so the migration discriminates by (mtime,
    // size). Mtime-only collisions on bulk-copied ROMs prevented the
    // PR-#35 migration from firing on the dominant real-world case
    // (mame's 600+ files copied via SMB in one batch share mtimes
    // within the second).
    const cacheIsEmpty = Object.keys(entries).length === 0;
    const statTargets = cacheIsEmpty ? cachedPaths : paths;
    if (statTargets.length === 0) {
      for (const p of paths) {
        if (!result.has(p)) result.set(p, null);
      }
      return result;
    }
    let stats: Awaited<ReturnType<HashClient['statPathsWithSize']>>;
    try {
      stats = await client.statPathsWithSize(statTargets);
    } catch {
      // Stat batch failed (transport error, etc.) — return all paths
      // as null so the caller falls through to computeHash for each.
      // The orchestrator's per-path error handling is the right shape
      // for this.
      for (const p of paths) result.set(p, null);
      return result;
    }
    for (const p of cachedPaths) {
      const entry = entries[p];
      const current = stats[p];
      if (
        entry !== undefined &&
        current !== undefined &&
        current.mtime !== 0 &&
        current.mtime === entry.mtime
      ) {
        result.set(p, entry);
      } else {
        // Either missing on device or mtime drifted. Caller will
        // re-hash (or skip if vanished).
        result.set(p, null);
      }
    }
    // Rename recovery — same shape as `doGetHash`. See the comment
    // there for the full rationale.
    const migrated: { from: string; to: string; entry: HashEntry }[] = [];
    const claimed = new Set<string>();
    for (const p of uncachedPaths) {
      const current = stats[p];
      if (current === undefined || current.mtime === 0) {
        result.set(p, null);
        continue;
      }
      const oldKey = findCacheKeyByMtimeAndSize(
        entries,
        current.mtime,
        current.size,
        claimed,
      );
      if (oldKey === null || oldKey === p) {
        result.set(p, null);
        continue;
      }
      const entry = entries[oldKey]!;
      claimed.add(oldKey);
      migrated.push({ from: oldKey, to: p, entry });
      result.set(p, entry);
    }
    if (migrated.length > 0) {
      const next: Record<string, HashEntry> = { ...entries };
      for (const m of migrated) {
        delete next[m.from];
        next[m.to] = m.entry;
      }
      this.memCache.set(host, next);
      await this.writeEntries(host, next);
    }
    return result;
  }

  private async doComputeHash(
    client: HashClient,
    host: string,
    path: string,
  ): Promise<HashEntry | undefined> {
    const records = await client.hashPaths([path]);
    if (records.length === 0) return undefined;
    // hashPaths can return multiple records on one input only when
    // the script aliases (it doesn't); take the first / only one.
    const r = records[0]!;
    const entry: HashEntry = {
      md5: r.md5,
      sha1: r.sha1,
      size: r.size,
      mtime: r.mtime,
      hashedAt: this.now().toISOString(),
    };
    const entries = await this.loadEntries(host);
    const next = { ...entries, [r.path]: entry };
    this.memCache.set(host, next);
    await this.writeEntries(host, next);
    return entry;
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

  /**
   * PR-D1 round 2 (PR #27 round 2): pure-disk cache lookup for the
   * optimistic-render path. Returns the cached `HashEntry` for each
   * requested path WITHOUT a fresh SSH stat — entries may be stale
   * if the file's mtime drifted, but the renderer wants something
   * to display immediately. Stale entries are corrected in the
   * background via `checkCachedMtimes` from the normal flow.
   *
   * Returns `null` for paths the disk cache doesn't know about.
   */
  async readCachedEntries(
    host: string,
    paths: readonly string[],
  ): Promise<Map<string, HashEntry | null>> {
    const entries = await this.loadEntries(host);
    const out = new Map<string, HashEntry | null>();
    for (const p of paths) out.set(p, entries[p] ?? null);
    return out;
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

/**
 * feat/rename-aware-hash-cache (PR #35) + round 2
 * (fix/sidebar-count-and-mtime-batch): scan cache entries for one
 * whose (mtime, size) uniquely matches the target tuple. Returns
 * the key (path) of that entry, or `null` when zero or two-or-more
 * entries match.
 *
 * (mtime, size) matching is the right discriminator for the
 * dominant real-world rename case (Unix `mv` preserves both):
 * round 1 used mtime alone, but bulk-copied ROM collections
 * (mame's 600+ files copied via SMB in one batch) share mtimes
 * within the second, and mtime-only matching refused them as
 * ambiguous → every renamed file re-hashed on connect even with
 * the migration logic in place. Adding size cleanly resolves
 * those collisions: distinct ROM dumps almost never share a byte
 * count to the byte.
 *
 * `claimed` excludes keys already migrated in the current pass so
 * a 2+ collision (two renamed-to paths both targeting the same
 * old key) refuses ambiguous migrations rather than aliasing both
 * to one hash entry.
 */
export function findCacheKeyByMtimeAndSize(
  entries: Readonly<Record<string, HashEntry>>,
  targetMtime: number,
  targetSize: number,
  claimed: ReadonlySet<string>,
): string | null {
  let match: string | null = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (claimed.has(key)) continue;
    if (entry.mtime !== targetMtime) continue;
    if (entry.size !== targetSize) continue;
    if (match !== null) return null; // 2+ matches → ambiguous
    match = key;
  }
  return match;
}

/**
 * Mtime-only variant kept exported for tests + callers that don't
 * have size data on hand. Production code paths use the (mtime,
 * size) discriminator above.
 */
export function findCacheKeyByMtime(
  entries: Readonly<Record<string, HashEntry>>,
  target: number,
  claimed: ReadonlySet<string>,
): string | null {
  let match: string | null = null;
  for (const [key, entry] of Object.entries(entries)) {
    if (claimed.has(key)) continue;
    if (entry.mtime !== target) continue;
    if (match !== null) return null;
    match = key;
  }
  return match;
}
