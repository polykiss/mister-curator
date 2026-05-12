import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { sanitiseFsSegment } from '@app/main/cache/cache-types';
import { diagLog } from '@shared/diag-log';
import type { HashRecord } from '@shared/mister-client';
import { mtimesMatch } from '@shared/mtime-compare';
import type { SizeAndMtime } from '@shared/prime-parse';

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
 *   v4 (fix/scrape-and-count-correctness commit 1):
 *                           adds `diskSizeBytes` (wrapper bytes via
 *                           `stat -c %s`) alongside the existing
 *                           extracted `size`. For non-archive paths
 *                           the two are identical; for `.zip` they
 *                           differ.
 *
 * fix/count-and-status-indicator commit 4: a v3-shaped entry has a
 * valid hash + mtime; only `diskSizeBytes` is missing. The lazy
 * v3→v4 migration in `migrateV3Entries` re-stats each path on
 * connect, populates the missing field for entries whose mtime
 * still matches, and persists. Eliminates the mass re-hash that
 * the v3→v4 strategy bump from PR #42 commit 1 would otherwise
 * force on every existing user.
 */
const HASH_STRATEGY_VERSION = 4 as const;
const HASH_STRATEGY_VERSION_V3 = 3 as const;

/** Cap per SSH round-trip. Larger inputs chunk in JS. */
const DEFAULT_BATCH_SIZE = 100;

/**
 * One persisted entry. mtime is epoch seconds of the wrapper file
 * (cache invalidation key — what the user actually touches). md5
 * and sha1 are hashes of the EXTRACTED ROM content (inner-file for
 * .zip wrappers, raw bytes for direct files). size is the extracted
 * byte count, matching SS's `romtaille` semantics. diskSizeBytes is
 * the wrapper's `stat -c %s` value — what the file system says the
 * file is — which differs from `size` for `.zip` archives and is
 * the right number for any "size on disk" display.
 *
 * feat/sample-based-hashing — `sampleMd5` is a cheap secondary
 * fingerprint: `md5(head 64KB + tail 64KB + size as 16 hex chars)`
 * of the WRAPPER bytes (not the extracted content). On a real
 * MAME ROM redeploy, mtimes drift but content stays identical →
 * full md5 still valid → recomputing it would burn 10-40 minutes
 * for ~600 zips. The sample acts as a "did this file actually
 * change?" check: head + (partial) tail + size catches the common
 * case of byte-identical files re-uploaded with new mtimes.
 *
 * Optional on the wire so legacy entries (pre-PR) parse cleanly;
 * absent on those, populated on the next compute path. Limitation:
 * a file modified only in its MIDDLE bytes (not in head/tail/size)
 * would slip past the sample. Extremely rare for ROM files in
 * practice — the full md5 stays the authoritative source of truth,
 * the sample is just the fast revalidation gate.
 */
export interface HashEntry {
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
  readonly diskSizeBytes: number;
  readonly mtime: number;
  readonly hashedAt: string;
  readonly sampleMd5?: string;
}

/**
 * feat/hash-failure-sentinel — persisted record of "we tried to hash
 * this file and couldn't (SSH timeout, transient error, etc.). Don't
 * retry until its stat changes." The witness is `size + mtime`; on
 * the next connect the orchestrator validates the witness against a
 * fresh stat:
 *   - witness matches  → skip the hash attempt, treat as `source=none`
 *                        with reason `cached-hash-failed`. This stops
 *                        the retry-forever loop on files whose md5
 *                        legitimately can't complete in the 120s
 *                        device-side SSH timeout (multi-GB wrapper
 *                        zips on Saturn translations, etc.).
 *   - witness drifted  → drop the sentinel, retry the hash. The user
 *                        replaced or shrunk the file; it deserves
 *                        another shot.
 *
 * Stored on `failedEntries` of the same `hashes.json` file as the
 * successful entries so a single atomic write covers both. Sentinels
 * are mutually exclusive with successful `HashEntry` for the same
 * path — `doComputeHash` clears the sentinel on a successful hash
 * and writes a sentinel after catching a hash failure.
 */
export interface HashFailureEntry {
  readonly size: number;
  readonly mtime: number;
  readonly failedAt: string;
  /** Best-effort error message captured at sentinel-write time. */
  readonly error?: string;
}

/**
 * fix/mtime-tolerance — `checkCachedMtimes` return shape.
 *
 * `entries` is the original Round-9 contract: every input path keys
 * either to its validated cache entry (warm) or `null` (re-hash
 * needed). Callers iterate this verbatim as before.
 *
 * `exactCount` / `toleranceCount` partition the validated entries
 * so the orchestrator's `mtime-batch done` diag line can surface
 * how much of the warm-cache hit relied on the ±2s tolerance vs.
 * exact equality. On an SD rebuild we expect `toleranceCount` to
 * dominate; on a steady-state ext4 device they should be ~exact.
 *
 * feat/sample-based-hashing — `sampleCount` is the count of cache
 * hits that fell out of the ±2s tolerance window but were rescued
 * by a sample-md5 re-validation (cheap head+tail+size hash instead
 * of full file md5). On a MAME ROM redeploy this is what saves the
 * 10-40 minutes of re-hashing that pre-sample behavior incurred.
 */
export interface CheckCachedMtimesResult {
  readonly entries: Map<string, HashEntry | null>;
  readonly exactCount: number;
  readonly toleranceCount: number;
  readonly sampleCount: number;
  /**
   * feat/hash-failure-sentinel — paths whose cached `HashFailureEntry`
   * witness (size + mtime) still matches the device's current stat.
   * Caller MUST skip the hash attempt for these — re-running would
   * just time out again. A stat drift (mtime past the ±2s tolerance
   * window or any size change) drops the sentinel and routes the
   * path back into the normal `entries` / re-hash flow.
   *
   * `failedPaths` and `entries.get(p) !== null` are mutually
   * exclusive: paths in this set are NOT present in the entries map
   * (deleted there to prevent the orchestrator's existing per-path
   * branch from picking them up as a hit).
   */
  readonly failedPaths: ReadonlySet<string>;
}

interface HashCacheFile {
  readonly version: typeof HASH_CACHE_SCHEMA_VERSION;
  /** Forces a re-hash when the algorithm bumps. */
  readonly hashStrategyVersion: typeof HASH_STRATEGY_VERSION;
  readonly host: string;
  readonly entries: Readonly<Record<string, HashEntry>>;
  /**
   * feat/hash-failure-sentinel — paths whose hash attempt failed
   * (SSH timeout on multi-GB Saturn wrapper zips, etc.). Persisted
   * so the next connect can validate the file's stat and skip the
   * retry. Optional on the wire so older cache files (pre-sentinel)
   * parse cleanly as `undefined` → empty.
   */
  readonly failedEntries?: Readonly<Record<string, HashFailureEntry>>;
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
  /**
   * fix/count-and-status-indicator commit 4: stat (size + mtime) per
   * path in one round-trip. Used by the lazy v3→v4 migration to
   * populate `diskSizeBytes` without recomputing the hash.
   */
  statPathsWithSize(
    paths: readonly string[],
  ): Promise<Record<string, SizeAndMtime>>;
  /**
   * feat/sample-based-hashing — cheap fingerprint of each path's
   * WRAPPER bytes (head 64KB + tail 64KB + size as 16 hex chars
   * piped through `md5sum`). The cache uses this to validate that
   * a file with drifted mtime hasn't actually changed content,
   * avoiding the 10-40 minute full re-hash on a ROM redeploy.
   *
   * Returns a `path → md5` map. Paths the device can't stat (the
   * file vanished mid-batch, permission denied, etc.) are silently
   * absent from the result so the caller treats them as a sample
   * miss and falls through to the full re-hash path.
   *
   * Implementations should cap their internal batch at ~100 paths
   * to stay under busybox argv limits; the caller chunks larger
   * inputs accordingly.
   */
  computeSampleMd5s(
    paths: readonly string[],
  ): Promise<Record<string, string>>;
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
  /**
   * feat/hash-failure-sentinel — companion to `memCache`. Populated
   * by the same `loadFromDisk` pass, persisted via the same atomic
   * `writeAll` so on-disk hashes.json always reflects a consistent
   * (entries, failedEntries) pair. A null/absent entry on disk maps
   * to `{}` in memory; the comparator treats either uniformly.
   */
  private readonly memFailedEntries = new Map<string, Record<string, HashFailureEntry>>();
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
  ): Promise<CheckCachedMtimesResult> {
    if (paths.length === 0) {
      return {
        entries: new Map(),
        exactCount: 0,
        toleranceCount: 0,
        sampleCount: 0,
        failedPaths: new Set(),
      };
    }
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

  /**
   * fix/count-and-status-indicator commit 4 — lazy v3→v4 migration.
   *
   * PR #42 commit 1 bumped HASH_STRATEGY_VERSION 3→4 to add
   * `diskSizeBytes` (wrapper bytes) alongside the existing
   * extracted `size`. The default cache validator rejects v3
   * entries wholesale, forcing every existing user into a full
   * rehash on next connect — which on cores like NEOGEO with many
   * large `.zip` files reads as a multi-minute "no metadata, no
   * box art" gap.
   *
   * This migration reads the v3 cache file directly, batch-stats
   * each path on device for size + mtime, and:
   *   - mtime matches → write `diskSizeBytes = stat.size`, upgrade
   *     entry in place to v4. Hash + sha1 are preserved.
   *   - mtime drifted → drop entry. The existing rehash path will
   *     refire when the path is next requested.
   *   - file missing → drop entry.
   *
   * Idempotent — running on an already-v4 cache is a no-op.
   * Tolerates a missing or malformed cache file (returns zeroed
   * counts).
   *
   * Triggered from `ConnectionManager` after connect, before the
   * first prefetch, so warm-cache hits land immediately.
   */
  async migrateV3Entries(
    client: HashClient,
    host: string,
  ): Promise<{ migrated: number; needsRehash: number }> {
    return this.runGated(host, () => this.doMigrateV3Entries(client, host));
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

  private async doMigrateV3Entries(
    client: HashClient,
    host: string,
  ): Promise<{ migrated: number; needsRehash: number }> {
    const startMs = Date.now();
    const raw = await readJsonOrNull<unknown>(this.cachePath(host));
    if (!isHashCacheFileV3(raw) || raw.host !== host) {
      // Either no file, already v4, or some other version. The
      // default validator handles those — nothing to migrate.
      return { migrated: 0, needsRehash: 0 };
    }
    const v3Entries = raw.entries;
    const paths = Object.keys(v3Entries);
    if (paths.length === 0) {
      // Empty v3 file: rewrite as empty v4 so the validator accepts
      // it on next load. Cheap.
      this.memCache.set(host, {});
      await this.writeEntries(host, {});
      diagLog('info', 'meta', '·', 'v4-migration', {
        host,
        ms: Date.now() - startMs,
        migrated: 0,
        reHashRequired: 0,
        empty: 1,
      });
      return { migrated: 0, needsRehash: 0 };
    }
    // Batch the SSH stat in DEFAULT_BATCH_SIZE chunks so a 600-path
    // mame cache doesn't argv-overflow busybox. Each chunk is one
    // SSH round trip; 6 chunks for 600 paths is well inside the
    // connect-time budget.
    const stats: Record<string, SizeAndMtime> = {};
    for (let i = 0; i < paths.length; i += this.batchSize) {
      const chunk = paths.slice(i, i + this.batchSize);
      let chunkStats: Record<string, SizeAndMtime>;
      try {
        chunkStats = await client.statPathsWithSize(chunk);
      } catch (err) {
        // SSH dropped mid-migration — bail without persisting.
        // The strict v4 validator rejects the v3 file on next load,
        // so the existing rehash path takes over. We're no worse
        // off than before the migration.
        diagLog('error', 'meta', '✗', 'v4-migration-stat-failed', {
          host,
          ms: Date.now() - startMs,
          chunk: chunk.length,
          err: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      for (const [p, s] of Object.entries(chunkStats)) {
        stats[p] = s;
      }
    }
    const next: Record<string, HashEntry> = {};
    let migrated = 0;
    let needsRehash = 0;
    let migratedExact = 0;
    let migratedTolerance = 0;
    for (const [path, v3] of Object.entries(v3Entries)) {
      const s = stats[path];
      if (s !== undefined && s.size > 0 && mtimesMatch(s.mtime, v3.mtime)) {
        next[path] = {
          md5: v3.md5,
          sha1: v3.sha1,
          size: v3.size,
          // For non-archive files this equals `size` exactly. For
          // .zip wrappers it's the compressed wrapper bytes — what
          // the FS says, distinct from the extracted-content size.
          diskSizeBytes: s.size,
          mtime: v3.mtime,
          hashedAt: v3.hashedAt,
        };
        migrated += 1;
        if (s.mtime === v3.mtime) {
          migratedExact += 1;
        } else {
          migratedTolerance += 1;
        }
      } else {
        // Either path is gone, or mtime drifted — entry gets
        // dropped. The next access fires the existing
        // computeHash path which produces a fresh v4 entry.
        needsRehash += 1;
      }
    }
    this.memCache.set(host, next);
    await this.writeEntries(host, next);
    diagLog('info', 'meta', '·', 'v4-migration', {
      host,
      ms: Date.now() - startMs,
      migrated,
      migratedExact,
      migratedTolerance,
      reHashRequired: needsRehash,
      total: paths.length,
    });
    return { migrated, needsRehash };
  }

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
    // recovery pass below has an mtime for each uncached path.
    // Skip the stat for uncached paths when the cache is empty —
    // there's nothing to migrate them onto, and the empty-cache
    // first-run path was the previous behavior (kept fast).
    const cacheIsEmpty = Object.keys(entries).length === 0;
    const statTargets = cacheIsEmpty
      ? cachedPaths
      : [...cachedPaths, ...uncachedPaths];
    const mtimes = statTargets.length > 0
      ? await client.statWitnesses(statTargets)
      : ({} as Record<string, number>);

    // feat/sample-based-hashing — collect mtime-drift candidates
    // with cached sampleMd5 for the batched fast-path validation
    // below. Setting `result` for these is deferred until after the
    // sample call resolves.
    interface GetSampleCandidate {
      readonly path: string;
      readonly entry: HashEntry;
      readonly currentMtime: number;
    }
    const sampleCandidates: GetSampleCandidate[] = [];
    for (const p of cachedPaths) {
      const entry = entries[p];
      const current = mtimes[p];
      if (
        entry !== undefined &&
        current !== undefined &&
        mtimesMatch(current, entry.mtime)
      ) {
        const exact = current === entry.mtime;
        diagLog('info', 'meta', '·', 'hash-decision', {
          path: pathBasename(p),
          action: 'use-cache',
          reason: exact ? 'mtime-match' : 'mtime-match-tolerance',
          mtime: current,
          cachedMtime: exact ? undefined : entry.mtime,
          deltaSec: exact ? undefined : Math.abs(current - entry.mtime),
        });
        result.set(p, entry);
      } else if (
        entry !== undefined &&
        entry.sampleMd5 !== undefined &&
        current !== undefined &&
        current !== 0
      ) {
        sampleCandidates.push({ path: p, entry, currentMtime: current });
      } else {
        // Missing-on-device, or cached entry pre-dates the sample
        // PR — re-hash. The hashPaths step below will populate
        // sampleMd5 for this path so a future mtime drift takes
        // the fast path instead of returning here.
        diagLog('info', 'meta', '·', 'hash-decision', {
          path: pathBasename(p),
          action: 'stale-revalidate',
          reason:
            current === undefined || current === 0
              ? 'missing-on-device'
              : entry?.sampleMd5 === undefined
                ? 'mtime-drift-no-sample'
                : 'mtime-drift',
          cachedMtime: entry?.mtime,
          currentMtime: current,
        });
        needsHash.push(p);
      }
    }
    // Batched sample compute for drifted-but-fingerprinted paths.
    // A single SSH op for the whole batch.
    const sampleRefreshes: { path: string; entry: HashEntry }[] = [];
    if (sampleCandidates.length > 0) {
      let samples: Record<string, string> = {};
      try {
        samples = await client.computeSampleMd5s(
          sampleCandidates.map((c) => c.path),
        );
      } catch {
        // Sample compute failed wholesale — push every candidate
        // into the re-hash queue. The fallback matches today's
        // pre-sample behaviour exactly.
        for (const c of sampleCandidates) needsHash.push(c.path);
      }
      for (const c of sampleCandidates) {
        const sample = samples[c.path];
        if (sample !== undefined && sample === c.entry.sampleMd5) {
          const refreshed: HashEntry = {
            ...c.entry,
            mtime: c.currentMtime,
          };
          result.set(c.path, refreshed);
          sampleRefreshes.push({ path: c.path, entry: refreshed });
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(c.path),
            action: 'use-cache',
            reason: 'mtime-drift-sample-match',
            mtime: c.currentMtime,
            cachedMtime: c.entry.mtime,
          });
        } else {
          needsHash.push(c.path);
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(c.path),
            action: 'stale-revalidate',
            reason:
              sample === undefined
                ? 'mtime-drift-sample-missing'
                : 'mtime-drift-sample-mismatch',
            cachedMtime: c.entry.mtime,
            currentMtime: c.currentMtime,
          });
        }
      }
    }

    // Rename recovery: for each uncached path, see if its current
    // mtime uniquely identifies an existing cache entry under a
    // different (old) key. If so, rewrite the key — the file just
    // moved. Track `claimed` keys so a 2+ collision (multiple
    // renamed-to paths trying to claim the same old key) refuses
    // ambiguous migrations rather than aliasing two paths to one
    // hash entry.
    const migrated: { from: string; to: string; entry: HashEntry }[] = [];
    const claimed = new Set<string>();
    for (const p of uncachedPaths) {
      const current = mtimes[p];
      if (current === undefined || current === 0) continue;
      const oldKey = findCacheKeyByMtime(entries, current, claimed);
      if (oldKey === null || oldKey === p) continue;
      const entry = entries[oldKey]!;
      claimed.add(oldKey);
      migrated.push({ from: oldKey, to: p, entry });
      result.set(p, entry);
      diagLog('info', 'meta', '·', 'hash-decision', {
        path: pathBasename(p),
        action: 'use-cache',
        reason: 'rename-migrated',
        mtime: current,
        oldKey: pathBasename(oldKey),
      });
    }
    if (migrated.length > 0 || sampleRefreshes.length > 0) {
      const next: Record<string, HashEntry> = { ...entries };
      for (const m of migrated) {
        delete next[m.from];
        next[m.to] = m.entry;
      }
      for (const r of sampleRefreshes) {
        next[r.path] = r.entry;
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
    //
    // feat/sample-based-hashing — every fresh full-hash chunk is
    // paired with a sample-md5 chunk so the resulting entry carries
    // the fingerprint that lets a later mtime drift take the fast
    // path. One extra SSH round-trip per chunk; the sample script
    // reads at most 128KB per file (vs the full hash's whole-file
    // streaming), so the marginal cost is ~ms compared to the
    // already-slow full hash.
    const next: Record<string, HashEntry> = { ...entries };
    let dirty = false;
    const nowIso = this.now().toISOString();
    for (let i = 0; i < needsHash.length; i += this.batchSize) {
      const chunk = needsHash.slice(i, i + this.batchSize);
      const records = await client.hashPaths(chunk);
      let samples: Record<string, string> = {};
      try {
        samples = await client.computeSampleMd5s(
          records.map((r) => r.path),
        );
      } catch {
        // Sample compute on fresh hashes failed — write entries
        // without sampleMd5. They'll re-hash on the next mtime
        // drift (today's pre-PR behaviour). No data loss.
      }
      for (const r of records) {
        const sampleMd5 = samples[r.path];
        const entry: HashEntry = {
          md5: r.md5,
          sha1: r.sha1,
          size: r.size,
          diskSizeBytes: r.diskSize,
          mtime: r.mtime,
          hashedAt: nowIso,
          ...(sampleMd5 !== undefined ? { sampleMd5 } : {}),
        };
        result.set(r.path, entry);
        next[r.path] = entry;
        dirty = true;
        diagLog('info', 'meta', '·', 'hash-computed', {
          path: pathBasename(r.path),
          md5: r.md5,
          size: r.size,
          diskSize: r.diskSize,
          sampleMd5,
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
  ): Promise<CheckCachedMtimesResult> {
    const entries = await this.loadEntries(host);
    const failedEntries = await this.loadFailedEntries(host);
    const result = new Map<string, HashEntry | null>();
    const failedPaths = new Set<string>();
    // Lazy clone of `entries` shared by the sample-refresh and the
    // rename-recovery paths. Declared up top so both code paths
    // can call `ensureMutable` without tripping the TDZ on a later
    // `let mutatedEntries`. A `null` value here is the "no
    // mutations yet" sentinel; we only persist when it's non-null.
    let mutatedEntries: Record<string, HashEntry> | null = null;
    const ensureMutable = (): Record<string, HashEntry> => {
      if (mutatedEntries === null) mutatedEntries = { ...entries };
      return mutatedEntries;
    };
    // feat/hash-failure-sentinel — lazy clone of `failedEntries`.
    // Modified when we drop a stale sentinel (stat drift) or keep
    // one as validated. Persisted alongside `mutatedEntries` at the
    // end of the method via `writeAll`.
    let mutatedFailed: Record<string, HashFailureEntry> | null = null;
    const ensureFailedMutable = (): Record<string, HashFailureEntry> => {
      if (mutatedFailed === null) mutatedFailed = { ...failedEntries };
      return mutatedFailed;
    };
    if (paths.length === 0) {
      return {
        entries: result,
        exactCount: 0,
        toleranceCount: 0,
        sampleCount: 0,
        failedPaths,
      };
    }
    // feat/hash-failure-sentinel — validate cached sentinels FIRST so
    // they're resolved regardless of whether the rest of the flow
    // has work to do (a cache with ONLY sentinels would otherwise
    // short-circuit at the statTargets-empty early return below and
    // skip sentinel detection entirely). `statPathsWithSize` runs
    // only if there ARE sentinels for the input paths — for users
    // with no failures this is free.
    const sentinelCandidates = paths.filter((p) => failedEntries[p] !== undefined);
    if (sentinelCandidates.length > 0) {
      let sizes: Record<string, SizeAndMtime> = {};
      let sizesOk = true;
      try {
        sizes = await client.statPathsWithSize(sentinelCandidates);
      } catch {
        // Best-effort — keep all sentinels as-is so we don't retry
        // hashes that would just time out again. Falling back to
        // "drop and retry" on a transient SSH glitch would defeat
        // the whole sentinel purpose.
        sizesOk = false;
      }
      for (const p of sentinelCandidates) {
        const sentinel = failedEntries[p]!;
        const fresh = sizesOk ? sizes[p] : undefined;
        const stillFailing =
          fresh !== undefined &&
          fresh.mtime > 0 &&
          fresh.size === sentinel.size &&
          mtimesMatch(fresh.mtime, sentinel.mtime);
        if (stillFailing) {
          // Witness matches — keep the sentinel, mark the path as
          // skip-hash. The orchestrator's per-path branch sees this
          // path's null entry AND checks `failedPaths` to skip the
          // SSH op entirely.
          failedPaths.add(p);
          result.set(p, null);
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(p),
            action: 'skip-hash',
            reason: 'cached-hash-failed',
            size: sentinel.size,
            mtime: sentinel.mtime,
          });
        } else if (sizesOk) {
          // Stat drifted (size differs, mtime past tolerance, or
          // file vanished). Drop the sentinel so the next attempt
          // re-hashes. A vanished file (`fresh.mtime === 0`) re-
          // hashes cleanly because the device-side script omits
          // missing paths from its output — the orchestrator sees
          // `entry === undefined` and emits `unmatched`.
          delete ensureFailedMutable()[p];
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(p),
            action: 'retry-hash',
            reason: 'sentinel-stat-drift',
            cachedSize: sentinel.size,
            cachedMtime: sentinel.mtime,
            currentSize: fresh?.size ?? 0,
            currentMtime: fresh?.mtime ?? 0,
          });
        }
      }
    }
    // feat/rename-aware-hash-cache: stat ALL paths so the rename
    // recovery (uncached paths whose mtime uniquely identifies an
    // existing cache entry) can run alongside the normal cached-path
    // mtime validation. Skip the stat for uncached paths when the
    // cache is empty — there's nothing to migrate them onto. Skip
    // sentinel-resolved paths too — they don't need re-validation,
    // we already decided they're skipping.
    const cacheIsEmpty = Object.keys(entries).length === 0;
    // `cachedPaths` / `uncachedPaths` exclude sentinel-resolved paths
    // because those have already produced a `failedPaths` decision
    // above — re-checking them here would just override the result.
    const remainingPaths = failedPaths.size === 0
      ? paths
      : paths.filter((p) => !failedPaths.has(p));
    const cachedPaths = remainingPaths.filter(
      (p) => entries[p] !== undefined,
    );
    const uncachedPaths = remainingPaths.filter(
      (p) => entries[p] === undefined,
    );
    const statTargets = cacheIsEmpty ? cachedPaths : remainingPaths;
    if (statTargets.length === 0) {
      for (const p of paths) {
        if (!result.has(p)) result.set(p, null);
      }
      if (mutatedFailed !== null) {
        this.memFailedEntries.set(host, mutatedFailed);
        await this.writeAll(host, entries, mutatedFailed);
      }
      return {
        entries: result,
        exactCount: 0,
        toleranceCount: 0,
        sampleCount: 0,
        failedPaths,
      };
    }
    let mtimes: Awaited<ReturnType<HashClient['statWitnesses']>>;
    try {
      mtimes = await client.statWitnesses(statTargets);
    } catch {
      // Stat batch failed (transport error, etc.) — return all paths
      // as null so the caller falls through to computeHash for each.
      // Don't overwrite sentinel-resolved paths' `null` (which they
      // already have); the failedPaths set tells the orchestrator
      // to skip them regardless.
      for (const p of paths) {
        if (!result.has(p)) result.set(p, null);
      }
      if (mutatedFailed !== null) {
        this.memFailedEntries.set(host, mutatedFailed);
        await this.writeAll(host, entries, mutatedFailed);
      }
      return {
        entries: result,
        exactCount: 0,
        toleranceCount: 0,
        sampleCount: 0,
        failedPaths,
      };
    }
    let exactCount = 0;
    let toleranceCount = 0;
    let sampleCount = 0;
    // feat/sample-based-hashing — paths whose mtime drifted but
    // whose cached entry carries a sampleMd5 fingerprint. Defer
    // their final result until after the batched sample check.
    interface SampleCandidate {
      readonly path: string;
      readonly entry: HashEntry;
      readonly currentMtime: number;
    }
    const sampleCandidates: SampleCandidate[] = [];
    for (const p of cachedPaths) {
      const entry = entries[p];
      const current = mtimes[p];
      if (
        entry !== undefined &&
        current !== undefined &&
        mtimesMatch(current, entry.mtime)
      ) {
        result.set(p, entry);
        if (current === entry.mtime) exactCount += 1;
        else toleranceCount += 1;
      } else if (
        entry !== undefined &&
        entry.sampleMd5 !== undefined &&
        current !== undefined &&
        current !== 0
      ) {
        // mtime drifted past the ±2s tolerance, but the cached
        // entry has a sample fingerprint — defer the verdict to
        // the batched sample-compute below. Setting `null` now
        // would force a full re-hash; the sample path is the V1
        // optimisation that avoids that on the typical ROM
        // redeploy.
        sampleCandidates.push({ path: p, entry, currentMtime: current });
      } else {
        // Missing-on-device, or cached entry lacks sampleMd5
        // (legacy entry pre-sample-PR). Caller re-hashes (or
        // skips if vanished). The full-rehash path will populate
        // sampleMd5 on the resulting record, so this entry's
        // next mtime drift will take the fast path.
        result.set(p, null);
        diagLog('info', 'meta', '·', 'hash-decision', {
          path: pathBasename(p),
          action: 'stale-revalidate',
          reason:
            current === undefined || current === 0
              ? 'missing-on-device'
              : entry?.sampleMd5 === undefined
                ? 'mtime-drift-no-sample'
                : 'mtime-drift',
          cachedMtime: entry?.mtime,
          currentMtime: current,
        });
      }
    }
    if (sampleCandidates.length > 0) {
      // One SSH round-trip for the whole drift batch. The
      // device-side script reads at most 128KB per path; for
      // ~666 mame zips this completes in seconds compared to the
      // 10-40 minute full re-hash the old behavior incurred.
      let samples: Record<string, string> = {};
      try {
        samples = await client.computeSampleMd5s(
          sampleCandidates.map((c) => c.path),
        );
      } catch {
        // Sample compute itself failed — treat every candidate
        // as null and let the caller re-hash. Same posture as the
        // earlier statWitnesses catch arm above.
        for (const c of sampleCandidates) result.set(c.path, null);
      }
      for (const c of sampleCandidates) {
        const sample = samples[c.path];
        if (sample !== undefined && sample === c.entry.sampleMd5) {
          // Sample match — file is byte-stable. Accept the cached
          // full md5 and refresh the entry's mtime (+ sample, in
          // case the busybox loop produced a fingerprint the
          // pure-JS path would, eg. for a small file whose
          // boundary aliases). The fingerprint stays the same
          // value either way.
          const refreshed: HashEntry = {
            ...c.entry,
            mtime: c.currentMtime,
          };
          result.set(c.path, refreshed);
          sampleCount += 1;
          ensureMutable()[c.path] = refreshed;
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(c.path),
            action: 'use-cache',
            reason: 'mtime-drift-sample-match',
            mtime: c.currentMtime,
            cachedMtime: c.entry.mtime,
          });
        } else {
          result.set(c.path, null);
          diagLog('info', 'meta', '·', 'hash-decision', {
            path: pathBasename(c.path),
            action: 'stale-revalidate',
            reason:
              sample === undefined
                ? 'mtime-drift-sample-missing'
                : 'mtime-drift-sample-mismatch',
            cachedMtime: c.entry.mtime,
            currentMtime: c.currentMtime,
          });
        }
      }
    }
    // Rename recovery — same shape as `doGetHash`. See the comment
    // there for the full rationale.
    const migrated: { from: string; to: string; entry: HashEntry }[] = [];
    const claimed = new Set<string>();
    for (const p of uncachedPaths) {
      const current = mtimes[p];
      if (current === undefined || current === 0) {
        result.set(p, null);
        continue;
      }
      const oldKey = findCacheKeyByMtime(entries, current, claimed);
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
      const next = ensureMutable();
      for (const m of migrated) {
        delete next[m.from];
        next[m.to] = m.entry;
      }
    }
    if (mutatedEntries !== null || mutatedFailed !== null) {
      const nextEntries = mutatedEntries ?? entries;
      const nextFailed = mutatedFailed ?? failedEntries;
      if (mutatedEntries !== null) this.memCache.set(host, nextEntries);
      if (mutatedFailed !== null) this.memFailedEntries.set(host, nextFailed);
      await this.writeAll(host, nextEntries, nextFailed);
    }
    return {
      entries: result,
      exactCount,
      toleranceCount,
      sampleCount,
      failedPaths,
    };
  }

  private async doComputeHash(
    client: HashClient,
    host: string,
    path: string,
  ): Promise<HashEntry | undefined> {
    let records: readonly HashRecord[];
    try {
      records = await client.hashPaths([path]);
    } catch (err) {
      // feat/hash-failure-sentinel — persist a sentinel keyed by the
      // file's CURRENT stat so future connects can skip the retry.
      // Stat-after-the-fact is a separate, cheap SSH op; failing
      // that too just means we don't record a sentinel this round
      // and the path will retry on the next connect (today's pre-
      // PR behaviour). Re-throws the original error so the
      // orchestrator's existing `[prefetch] ✗ hash failed` log line
      // still fires.
      await this.recordHashFailure(client, host, path, err).catch(() => {
        /* swallow — sentinel recording is best-effort. */
      });
      throw err;
    }
    if (records.length === 0) return undefined;
    // hashPaths can return multiple records on one input only when
    // the script aliases (it doesn't); take the first / only one.
    const r = records[0]!;
    // feat/sample-based-hashing — fetch the sample fingerprint
    // alongside the freshly-computed full hash so the resulting
    // entry can short-circuit a future mtime drift. Best-effort —
    // a missing sample just means the next drift will re-hash
    // (today's pre-PR behaviour).
    let sampleMd5: string | undefined;
    try {
      const samples = await client.computeSampleMd5s([r.path]);
      sampleMd5 = samples[r.path];
    } catch {
      sampleMd5 = undefined;
    }
    const entry: HashEntry = {
      md5: r.md5,
      sha1: r.sha1,
      size: r.size,
      diskSizeBytes: r.diskSize,
      mtime: r.mtime,
      hashedAt: this.now().toISOString(),
      ...(sampleMd5 !== undefined ? { sampleMd5 } : {}),
    };
    diagLog('info', 'meta', '·', 'hash-computed', {
      path: pathBasename(r.path),
      md5: r.md5,
      size: r.size,
      diskSize: r.diskSize,
      sampleMd5,
    });
    const entries = await this.loadEntries(host);
    const failedEntries = await this.loadFailedEntries(host);
    const next = { ...entries, [r.path]: entry };
    // Successful hash clears any sentinel for this path — the file
    // is no longer the "perma-failing" kind. Skip the clone when
    // there's nothing to clear (the common case for fresh paths).
    let nextFailed = failedEntries;
    if (r.path in failedEntries) {
      const cleared: Record<string, HashFailureEntry> = { ...failedEntries };
      delete cleared[r.path];
      nextFailed = cleared;
      this.memFailedEntries.set(host, nextFailed);
      diagLog('info', 'meta', '·', 'hash-sentinel-cleared', {
        path: pathBasename(r.path),
        reason: 'hash-succeeded',
      });
    }
    this.memCache.set(host, next);
    await this.writeAll(host, next, nextFailed);
    return entry;
  }

  /**
   * feat/hash-failure-sentinel — capture the file's current stat and
   * write a sentinel into the persisted cache. The witness validates
   * on the next connect via `doCheckCachedMtimes`: matching stat →
   * skip the hash attempt; drifted stat → drop the sentinel and
   * retry. A stat failure here (e.g. device dropped mid-flight)
   * silently no-ops; the next connect retries the hash like today.
   */
  private async recordHashFailure(
    client: HashClient,
    host: string,
    path: string,
    err: unknown,
  ): Promise<void> {
    const stats = await client.statPathsWithSize([path]);
    const fresh = stats[path];
    // mtime === 0 from busybox means "stat couldn't open the file"
    // (vanished, permission denied, etc.). Recording a `{size: 0,
    // mtime: 0}` sentinel would never validate against any real
    // future stat — pointless. Skip and let the next connect retry.
    if (fresh === undefined || fresh.mtime === 0) return;
    const failedEntries = await this.loadFailedEntries(host);
    const next: Record<string, HashFailureEntry> = {
      ...failedEntries,
      [path]: {
        size: fresh.size,
        mtime: fresh.mtime,
        failedAt: this.now().toISOString(),
        error: err instanceof Error ? err.message : String(err),
      },
    };
    this.memFailedEntries.set(host, next);
    const entries = await this.loadEntries(host);
    await this.writeAll(host, entries, next);
    diagLog('info', 'meta', '·', 'hash-sentinel-recorded', {
      path: pathBasename(path),
      size: fresh.size,
      mtime: fresh.mtime,
      err: err instanceof Error ? err.message : String(err),
    });
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
    await this.loadFromDisk(host);
    return this.memCache.get(host)!;
  }

  /**
   * feat/hash-failure-sentinel — sibling of `loadEntries`. Both load
   * from the same `hashes.json` via `loadFromDisk` so the two maps
   * stay paired in memory.
   */
  private async loadFailedEntries(
    host: string,
  ): Promise<Record<string, HashFailureEntry>> {
    await this.loadFromDisk(host);
    return this.memFailedEntries.get(host)!;
  }

  /**
   * Read `hashes.json` once per host and populate BOTH memCaches.
   * Idempotent on subsequent calls (returns from memCache directly).
   */
  private async loadFromDisk(host: string): Promise<void> {
    if (this.memCache.has(host) && this.memFailedEntries.has(host)) return;
    const file = await readJsonOrNull<unknown>(this.cachePath(host));
    if (file === null || !isHashCacheFile(file) || file.host !== host) {
      this.memCache.set(host, {});
      this.memFailedEntries.set(host, {});
      return;
    }
    this.memCache.set(host, { ...file.entries });
    this.memFailedEntries.set(host, { ...(file.failedEntries ?? {}) });
  }

  /**
   * Persist `entries` to disk. `failedEntries` (the hash-failure
   * sentinel map) is preserved from memCache — callers updating only
   * one half don't lose the other.
   */
  private async writeEntries(
    host: string,
    entries: Record<string, HashEntry>,
  ): Promise<void> {
    const failedEntries = await this.loadFailedEntries(host);
    await this.writeAll(host, entries, failedEntries);
  }

  /**
   * feat/hash-failure-sentinel — sibling of `writeEntries`. Persists
   * both maps at once so a sentinel-add or sentinel-clear is atomic
   * with the underlying entries snapshot.
   */
  private async writeAll(
    host: string,
    entries: Record<string, HashEntry>,
    failedEntries: Record<string, HashFailureEntry>,
  ): Promise<void> {
    const data: HashCacheFile = {
      version: HASH_CACHE_SCHEMA_VERSION,
      hashStrategyVersion: HASH_STRATEGY_VERSION,
      host,
      entries,
      // Omit the field entirely when empty to keep older app versions
      // (which use `!isHashCacheFile` to reject unknown shapes) from
      // tripping on a `failedEntries: {}` they don't understand.
      ...(Object.keys(failedEntries).length > 0 ? { failedEntries } : {}),
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
  // feat/hash-failure-sentinel — `failedEntries` is optional. An
  // older pre-sentinel file with the field absent passes; a sentinel
  // map with malformed entries invalidates the whole file (safer
  // than silently dropping bad sentinels, which would re-enter the
  // retry-forever loop).
  if (o.failedEntries !== undefined) {
    if (o.failedEntries === null || typeof o.failedEntries !== 'object') {
      return false;
    }
    for (const entry of Object.values(
      o.failedEntries as Record<string, unknown>,
    )) {
      if (!isHashFailureEntry(entry)) return false;
    }
  }
  return true;
}

function isHashFailureEntry(v: unknown): v is HashFailureEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    !(
      typeof o.size === 'number' &&
      typeof o.mtime === 'number' &&
      typeof o.failedAt === 'string'
    )
  ) {
    return false;
  }
  if (o.error !== undefined && typeof o.error !== 'string') return false;
  return true;
}

function isHashEntry(v: unknown): v is HashEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    !(
      typeof o.md5 === 'string' &&
      typeof o.sha1 === 'string' &&
      typeof o.size === 'number' &&
      typeof o.diskSizeBytes === 'number' &&
      typeof o.mtime === 'number' &&
      typeof o.hashedAt === 'string'
    )
  ) {
    return false;
  }
  // feat/sample-based-hashing — optional field. Strict-type-check
  // when present so a malformed value (number, object) doesn't slip
  // into the cache and confuse the sample-validation path later.
  if (o.sampleMd5 !== undefined && typeof o.sampleMd5 !== 'string') {
    return false;
  }
  return true;
}

/**
 * fix/count-and-status-indicator commit 4 — v3 entry shape.
 * Identical to v4 except `diskSizeBytes` is missing (the field
 * commit 1 of PR #42 added). Used only by the lazy migration —
 * normal `loadEntries` rejects v3 entries via the strict v4
 * `isHashEntry` check above.
 */
interface HashEntryV3 {
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
  readonly mtime: number;
  readonly hashedAt: string;
}

interface HashCacheFileV3 {
  readonly version: typeof HASH_CACHE_SCHEMA_VERSION;
  readonly hashStrategyVersion: typeof HASH_STRATEGY_VERSION_V3;
  readonly host: string;
  readonly entries: Readonly<Record<string, HashEntryV3>>;
}

function isHashEntryV3(v: unknown): v is HashEntryV3 {
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

function isHashCacheFileV3(v: unknown): v is HashCacheFileV3 {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== HASH_CACHE_SCHEMA_VERSION) return false;
  if (o.hashStrategyVersion !== HASH_STRATEGY_VERSION_V3) return false;
  if (typeof o.host !== 'string') return false;
  if (o.entries === null || typeof o.entries !== 'object') return false;
  for (const entry of Object.values(o.entries as Record<string, unknown>)) {
    if (!isHashEntryV3(entry)) return false;
  }
  return true;
}

/** Last path segment, used in diag logs to keep lines readable. */
function pathBasename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * feat/rename-aware-hash-cache: scan cache entries for one whose
 * `mtime` uniquely matches `target`. Returns the key (path) of that
 * entry, or `null` when zero or two-or-more entries match.
 *
 * Mtime-only matching is sufficient for the typical use case: a
 * Unix `mv` (the hide / unhide rename op) preserves mtime exactly,
 * so the renamed file's current mtime equals the cached entry's
 * recorded mtime. Two distinct files coincidentally sharing a
 * mtime is rare but possible — refusing the migration in that case
 * costs at most a re-hash, which is exactly the pre-fix behavior.
 *
 * `claimed` excludes keys already migrated in the current pass so
 * a 2+ collision (two renamed-to paths both targeting the same old
 * key) refuses ambiguous migrations rather than aliasing both to
 * one hash entry.
 *
 * Future: extend to (mtime, size) for stricter matching when SS
 * itself starts indexing per-disk in some core.
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
    if (match !== null) return null; // 2+ matches → ambiguous
    match = key;
  }
  return match;
}
