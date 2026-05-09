import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type {
  HashClient,
  HashEntry,
  HashService,
} from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import type { MetadataService } from '@app/main/metadata/metadata-service';
import type {
  OpenVGDBProgressEvent,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
import type { ScreenScraperGame } from '@app/main/metadata/screenscraper-service';
import { diagLog } from '@shared/diag-log';
import type {
  MetadataHint,
  PrefetchProgress,
  RomMetadata,
  UserMetadataOverride,
} from '@shared/metadata-types';

/**
 * Maps a MiSTer core id (and the path it came from) to a ScreenScraper
 * `systemeid`. Required by SS's jeuInfos hash query.
 *
 * Round 4 reverted this to id-only — round 3 had widened it to also
 * carry a display system name, but the canonical name comes from the
 * SS response itself (`response.jeu.systeme.nom`), so the local map
 * doesn't need to track it.
 *
 * The orchestrator doesn't own the map — `app/main/index.ts` builds
 * it from a static table and injects it via the constructor. Tests
 * pass a tiny inline mapper.
 */
export type SystemIdResolver = (params: {
  /** Filename basename (e.g. "Sonic.md") — extension may hint at the system. */
  readonly romPath: string;
  /** Core id from the cores list (e.g. "Genesis"). */
  readonly coreId?: string;
}) => number | null;

export interface ActiveSession {
  /** SSH-shaped subset the HashService consumes. */
  readonly client: HashClient;
  /** Host string used as the per-MiSTer cache partition key. */
  readonly host: string;
}

/** Snapshot of the OpenVGDB download/open state. */
export interface MetadataDatabaseState {
  readonly ready: boolean;
  readonly downloadInProgress: boolean;
}

/**
 * One per-path event emitted by `getRomsMetadata` as each ROM
 * settles. `error: true` distinguishes a fetch failure (e.g., SSH
 * disconnect) from a clean no-match (`metadata: null, error: false`).
 */
export interface RomMetadataResolvedEvent {
  readonly path: string;
  readonly metadata: RomMetadata | null;
  readonly error: boolean;
}

/**
 * Top-level metadata coordinator. The IPC handlers call this; the
 * orchestrator threads `(client, host)` from the active connection
 * through to HashService and the metadata pipeline.
 *
 * Round 3 pivot: the upstream is OpenVGDB (local SQLite) + libretro
 * thumbnails. There are no auth errors to latch around any more —
 * the database is either downloaded or it isn't. `ensureMetadataDatabase`
 * exposes that state to the renderer + a streaming progress channel
 * so PR #16 can drive a "download metadata DB?" prompt.
 */
export class MetadataOrchestrator {
  /** Tracks whether `ensureMetadataDatabase` is currently downloading. */
  private downloadInProgress = false;

  /**
   * PR-D1 round 2 (PR #27 round 2): per-coreId in-flight gate for
   * `getRomsMetadata`. The auto-scrape engine and RomsPane's
   * per-pane prefetch both hit the same orchestrator method when
   * the user clicks the focused core. Without this gate, both
   * outer loops ran independently — same paths processed twice,
   * same `prefetch.lookup` log lines emitted twice, ~2× the work.
   *
   * When a second call arrives for a coreId already in flight, the
   * second caller's `onResolved` is added to the in-flight call's
   * subscriber set; the second caller awaits the in-flight promise
   * and returns when it resolves. Only one underlying scrape loop
   * runs per coreId at a time. Path-set differences (engine =
   * recursive, RomsPane = visible subset) are accepted: the
   * second caller gets events for ALL paths in the in-flight set,
   * including any it didn't explicitly request — RomsPane filters
   * those out by visible-set on the renderer side, so the only
   * cost is wasted event dispatch (microseconds).
   */
  private inflightByCoreId = new Map<
    string,
    {
      readonly promise: Promise<void>;
      readonly callbacks: Set<(event: RomMetadataResolvedEvent) => void>;
    }
  >();

  constructor(
    private readonly hashService: HashService,
    private readonly metadataService: MetadataService,
    private readonly imageCache: ImageCache,
    private readonly openVgdb: OpenVGDBService,
    private readonly resolveSystemId: SystemIdResolver,
    private readonly getActiveSession: () => ActiveSession | null,
  ) {}

  /**
   * Compute (or recall) the hash for one ROM file and look up its
   * metadata. Returns null when:
   *   - no active connection
   *   - the file isn't a regular file on the device (hashPaths drops
   *     it silently)
   *   - the OpenVGDB database hasn't been downloaded AND SS is
   *     unavailable / out of quota / hits no match
   *   - all sources miss
   *
   * Round 2 (PR #16): threads the multi-hash output (md5 + sha1 +
   * size) through to MetadataService along with a resolved SS
   * systemId, so SS gets a proper hash-search query when it's
   * available. Falls back to OpenVGDB+libretro when SS misses or is
   * unavailable.
   */
  async getRomMetadata(
    coreId: string,
    romPath: string,
    hint?: MetadataHint,
  ): Promise<RomMetadata | null> {
    const session = this.getActiveSession();
    if (session === null) return null;

    const hashes = await this.hashService.getHash(
      session.client,
      session.host,
      [romPath],
    );
    const entry = hashes.get(romPath);
    if (entry === undefined) return null;

    const systemId = this.resolveSystemId({ romPath, coreId });
    const ssHint =
      systemId === null
        ? undefined
        : {
            systemId,
            md5: entry.md5,
            sha1: entry.sha1,
            crc32: undefined,
            romName: basename(romPath),
            romSize: entry.size,
          };
    return this.metadataService.getMetadata(entry.md5, hint ?? {}, ssHint);
  }

  /**
   * Hash every ROM path on the device. Drives the first-connect
   * prefetch (UI surface deferred to PR #16). `onProgress` fires
   * after each chunk completes so the renderer can advance a
   * progress bar without flooding IPC.
   */
  async prefetchHashes(
    allPaths: readonly string[],
    onProgress?: (event: PrefetchProgress) => void,
  ): Promise<void> {
    const session = this.getActiveSession();
    if (session === null || allPaths.length === 0) return;

    // Chunk JS-side at the same boundary HashService uses internally
    // so the progress callback fires per-shell-call. The HashService
    // itself also batches at 100 paths; matching here keeps the
    // progress events lined up with actual SSH round-trips.
    const CHUNK = 100;
    let done = 0;
    const total = allPaths.length;
    for (let i = 0; i < total; i += CHUNK) {
      const slice = allPaths.slice(i, i + CHUNK);
      await this.hashService.getHash(session.client, session.host, slice);
      done += slice.length;
      onProgress?.({ done, total, currentPath: slice[slice.length - 1] });
    }
  }

  /**
   * Walk a list of hashes and run each through the metadata pipeline.
   * Hash cache populates first (via prefetchHashes); this is the
   * second pass that queries OpenVGDB + composes thumbnails.
   *
   * Sequential rather than parallel: OpenVGDB lookups are cheap
   * locally but a sequential loop yields monotonic progress events
   * the renderer can drive a single bar against.
   */
  async prefetchMetadata(
    hashes: readonly string[],
    onProgress?: (event: PrefetchProgress) => void,
  ): Promise<void> {
    let done = 0;
    const total = hashes.length;
    for (const hash of hashes) {
      await this.metadataService.getMetadata(hash);
      done += 1;
      onProgress?.({ done, total });
    }
  }

  /**
   * PR #20 round 2 — list-view streaming prefetch. Hashes ALL paths in
   * one SSH round-trip via the existing batched `hashService.getHash`,
   * then iterates per-path metadata sequentially, emitting one
   * `onResolved` event as each path settles.
   *
   * The shape replaces the round-1 per-row IPC pattern that fired
   * N parallel `getRomMetadata(coreId, romPath)` calls. Each of those
   * called `hashService.getHash([single])` which serialized through
   * the per-host gate but still issued one SSH `statWitnesses`
   * round-trip per row — 32 sequential SSH commands for a 32-row pane,
   * which overwhelmed WiFi-attached MiSTers and tripped the 10s op
   * deadline.
   *
   * Now: one batched `statWitnesses(allPaths)` (and at most one
   * `hashPaths(allPaths)` for cold paths) + N local-cache metadata
   * lookups. The SS rate-limit (1 req/sec) still gates cold metadata
   * fetches, so a cohort of 30 unmatched ROMs takes ~30s to fully
   * resolve — but every row that hits warm cache (the common case
   * after first scan) emits its event within milliseconds, and
   * cold-path SS rate-limiting is a property of the upstream API
   * rather than something we should fight here.
   *
   * Failure modes:
   *   - No active session → emit `{ metadata: null, error: false }`
   *     for every path. Treat the whole batch as unmatched.
   *   - Hash batch throws (e.g., SSH dropped mid-flight) → emit
   *     `{ metadata: null, error: true }` for every path so the
   *     renderer can show a per-row error indicator instead of
   *     perpetual skeletons.
   *   - Per-path metadata throws → emit `{ ..., error: true }` for
   *     just that path; subsequent paths still get a chance.
   */
  /**
   * PR-D1 round 2 (PR #27 round 2): pure-disk cache snapshot for the
   * optimistic-render path. Reads the hash service's path → hash
   * cache (no SSH stat) and the metadata cache (no SS / OpenVGDB
   * fetch). Returns whatever's already on disk so the renderer can
   * paint rows immediately on click — the normal `getRomsMetadata`
   * follow-up validates mtimes and refetches anything stale.
   *
   * Returns a record keyed by path. A `null` value means either:
   *   • the hash for this path isn't cached locally (cold), OR
   *   • the metadata for the cached hash is a sentinel
   *     (`source: 'none'` — no useful render data).
   * Either way the renderer should show a loading state for that
   * row until the validation pass populates it.
   */
  /**
   * PR-D2 (PR #29) — write a user-defined field-override block onto
   * the cache record for `path`. Resolves path → hash via the disk
   * hash cache (no SSH), routes to `MetadataService.writeUserOverride`.
   * Returns the updated record so the renderer can update its
   * `metadataByPath` immediately. Returns `null` when no hash / no
   * cache record exists.
   */
  async setUserMetadataOverride(
    path: string,
    override: UserMetadataOverride | undefined,
  ): Promise<RomMetadata | null> {
    const session = this.getActiveSession();
    if (session === null) return null;
    const hashEntries = await this.hashService.readCachedEntries(
      session.host,
      [path],
    );
    const entry = hashEntries.get(path);
    if (entry === undefined || entry === null) return null;
    return this.metadataService.writeUserOverride(entry.md5, override);
  }

  /**
   * PR-D2 (PR #29) — write a manual-bind cache record from a SS
   * `jeu` the user picked in the search modal. Same path-resolution
   * shape as `setUserMetadataOverride`; routes to
   * `MetadataService.bindManualOverride`.
   */
  async bindManualMetadataOverride(
    path: string,
    game: ScreenScraperGame,
  ): Promise<RomMetadata | null> {
    const session = this.getActiveSession();
    if (session === null) return null;
    const hashEntries = await this.hashService.readCachedEntries(
      session.host,
      [path],
    );
    const entry = hashEntries.get(path);
    if (entry === undefined || entry === null) return null;
    return this.metadataService.bindManualOverride(entry.md5, game);
  }

  async readCachedRomsMetadata(
    coreId: string,
    romPaths: readonly string[],
  ): Promise<Record<string, RomMetadata | null>> {
    void coreId; // present for diag-log symmetry; not used yet
    const out: Record<string, RomMetadata | null> = {};
    if (romPaths.length === 0) return out;
    const session = this.getActiveSession();
    if (session === null) {
      for (const p of romPaths) out[p] = null;
      return out;
    }
    const hashEntries = await this.hashService.readCachedEntries(
      session.host,
      romPaths,
    );
    for (const p of romPaths) {
      const entry = hashEntries.get(p);
      if (entry === null || entry === undefined) {
        out[p] = null;
        continue;
      }
      out[p] = await this.metadataService.readCachedMetadata(entry.md5);
    }
    return out;
  }

  async getRomsMetadata(
    coreId: string,
    romPaths: readonly string[],
    onResolved?: (event: RomMetadataResolvedEvent) => void,
    shouldAbort?: () => boolean,
    atomicFolderPaths?: ReadonlySet<string>,
  ): Promise<void> {
    // PR-D1 round 2 (PR #27 round 2): per-coreId in-flight gate.
    // If a scrape is already running for this coreId, subscribe
    // this call's onResolved to the in-flight call's fan-out and
    // await its promise — only ONE underlying scrape loop runs per
    // coreId. Eliminates duplicate `prefetch.lookup` log lines
    // when the auto-scrape engine and RomsPane's per-pane prefetch
    // both target the focused core.
    const inflight = this.inflightByCoreId.get(coreId);
    if (inflight !== undefined) {
      diagLog('info', 'prefetch', '·', 'gate-coalesce', {
        coreId,
        paths: romPaths.length,
      });
      if (onResolved !== undefined) inflight.callbacks.add(onResolved);
      try {
        await inflight.promise;
      } finally {
        if (onResolved !== undefined) inflight.callbacks.delete(onResolved);
      }
      return;
    }

    const callbacks = new Set<(event: RomMetadataResolvedEvent) => void>();
    if (onResolved !== undefined) callbacks.add(onResolved);
    const fanOut = (event: RomMetadataResolvedEvent): void => {
      for (const cb of callbacks) cb(event);
    };
    const promise = this.runScrapeLoop(
      coreId,
      romPaths,
      fanOut,
      shouldAbort,
      atomicFolderPaths,
    ).finally(() => {
      this.inflightByCoreId.delete(coreId);
    });
    this.inflightByCoreId.set(coreId, { promise, callbacks });
    return promise;
  }

  /**
   * PR-D1 round 2 (PR #27 round 2): the actual scrape loop. Was
   * `getRomsMetadata`'s body before round 2 added the
   * coreId-keyed in-flight gate. Now invoked by the public
   * `getRomsMetadata` which handles dedup; this private method
   * runs the work itself.
   */
  private async runScrapeLoop(
    coreId: string,
    romPaths: readonly string[],
    onResolved: (event: RomMetadataResolvedEvent) => void,
    shouldAbort?: () => boolean,
    atomicFolderPaths?: ReadonlySet<string>,
  ): Promise<void> {
    if (romPaths.length === 0) return;
    diagLog('info', 'prefetch', '→', 'start', {
      coreId,
      paths: romPaths.length,
    });
    const startWall = Date.now();
    let resolved = 0;
    let errors = 0;
    let hashSkipped = 0;
    const session = this.getActiveSession();
    if (session === null) {
      diagLog('warn', 'prefetch', '·', 'no-session', { coreId });
      for (const path of romPaths) {
        onResolved({ path, metadata: null, error: false });
      }
      return;
    }

    // Round 11 (PR #20): probe whether THIS coreId resolves to any
    // metadata source. If not (mame, hbmame, AO486, etc.) the hash
    // buys us nothing — SS won't be queried (no systemeid) and
    // OpenVGDB is hash-keyed but only covers cartridge consoles
    // we already map to SS. Skip BOTH the mtime batch AND the
    // per-path hash compute; emit synthetic-keyed sentinels via
    // the existing MetadataService cache machinery so we don't
    // re-decide on every prefetch. For mame's 650 paths this
    // collapses ~5 minutes of cold hash compute to a single SSH
    // skip + 650 cache reads/writes (~600 ms total).
    const wholeCoreUnmappable =
      this.resolveSystemId({ romPath: romPaths[0]!, coreId }) === null;

    // Round 9 (PR #20): batched mtime check + per-path compute.
    // Round 5 collapsed the hash phase to per-ROM `getHash([single])`
    // because a batched hash exec containing a multi-GB ROM would
    // push the whole batch past the 120s hash timeout. That fix
    // worked, but EVERY per-ROM call still cost a per-path SSH
    // `statWitnesses` round-trip (32 paths × ~470 ms = 15 s wall on
    // a fully-cached SNES core).
    //
    // Round 9 splits the cheap-and-batchable (mtime stat) from the
    // expensive-and-isolatable (hash compute):
    //   1. ONE batched `checkCachedMtimes` for all paths — single
    //      SSH `statWitnesses` exec.
    //   2. Per-path `computeHash` only for the residue (uncached
    //      paths or ones whose mtime drifted).
    // Cached cores collapse to ~200 ms wall; cold cores keep the
    // round-5 per-ROM isolation (so the multi-GB Collection still
    // only fails its own row).
    let mtimeMap: Map<string, HashEntry | null>;
    if (wholeCoreUnmappable) {
      diagLog('info', 'prefetch', '·', 'skip-hash-batch', {
        coreId,
        reason: 'no-coverage',
        paths: romPaths.length,
      });
      mtimeMap = new Map(romPaths.map((p) => [p, null]));
    } else {
      const mtimeCheckStart = Date.now();
      try {
        mtimeMap = await this.hashService.checkCachedMtimes(
          session.client,
          session.host,
          romPaths,
        );
        diagLog('info', 'prefetch', '·', 'mtime-batch done', {
          coreId,
          ms: Date.now() - mtimeCheckStart,
          validated: [...mtimeMap.values()].filter((v) => v !== null).length,
          needsHash: [...mtimeMap.values()].filter((v) => v === null).length,
        });
      } catch (err) {
        // Batched stat failed — fall back to per-ROM compute (same
        // shape as round 5). Mark all paths as "needs hash" so the
        // loop below treats each individually.
        diagLog('error', 'prefetch', '✗', 'mtime-batch failed', {
          coreId,
          ms: Date.now() - mtimeCheckStart,
          err: err instanceof Error ? err.message : String(err),
        });
        mtimeMap = new Map(romPaths.map((p) => [p, null]));
      }
    }

    for (const path of romPaths) {
      // PR-C (PR #26): cooperative cancellation point. The check
      // sits at the very top of each iteration so the engine's
      // setFocus pivot lands within one path's wall time. Partial
      // work stays in the cache; the next time this core scrapes
      // (engine queue resume OR user-driven RomsPane prefetch),
      // the warm-cache fast path picks up where we left off.
      if (shouldAbort?.()) {
        diagLog('info', 'prefetch', '·', 'aborted', {
          coreId,
          remaining: romPaths.length - resolved - errors,
        });
        break;
      }
      const perRomStart = Date.now();
      diagLog('info', 'meta', '·', 'path-start', {
        coreId,
        path: basename(path),
      });

      // Round 11 short-circuit: no metadata source can use a hash
      // for this core, so skip the compute and let the
      // synthetic-key sentinel write/read via the existing cache.
      // The synthetic key is `noss-<sha1(coreId:path)>` — clearly
      // distinguishable from a real md5 (which is 32 hex chars
      // with no prefix), so cache files can be greppe'd to find
      // synthetic-only entries.
      const systemId = this.resolveSystemId({ romPath: path, coreId });
      if (systemId === null) {
        diagLog('info', 'meta', '·', 'system-map-miss', {
          coreId,
          path: basename(path),
        });
        diagLog('info', 'prefetch', '·', 'skip-hash', {
          coreId,
          path: basename(path),
          reason: 'no-coverage',
        });
        const syntheticKey = makeSyntheticCacheKey(coreId, path);
        let metadata: RomMetadata | null;
        try {
          metadata = await this.metadataService.getMetadata(
            syntheticKey,
            {},
            undefined,
          );
        } catch (err) {
          diagLog('error', 'prefetch', '✗', 'synthetic-lookup failed', {
            coreId,
            path: basename(path),
            ms: Date.now() - perRomStart,
            err: err instanceof Error ? err.message : String(err),
          });
          diagLog('info', 'meta', '·', 'path-end', {
            coreId,
            path: basename(path),
            source: 'error',
            ms: Date.now() - perRomStart,
          });
          onResolved({ path, metadata: null, error: true });
          errors += 1;
          continue;
        }
        diagLog('info', 'meta', '·', 'path-end', {
          coreId,
          path: basename(path),
          source: 'synthetic-sentinel',
          ms: Date.now() - perRomStart,
        });
        onResolved({ path, metadata, error: false });
        resolved += 1;
        hashSkipped += 1;
        continue;
      }

      let entry: HashEntry | undefined;
      const cachedEntry = mtimeMap.get(path);
      if (cachedEntry !== null && cachedEntry !== undefined) {
        // Mtime-validated cache hit — no SSH for this path.
        entry = cachedEntry;
      } else {
        try {
          entry = await this.hashService.computeHash(
            session.client,
            session.host,
            path,
          );
        } catch (err) {
          diagLog('error', 'prefetch', '✗', 'hash failed', {
            coreId,
            path: basename(path),
            ms: Date.now() - perRomStart,
            err: err instanceof Error ? err.message : String(err),
          });
          diagLog('info', 'meta', '·', 'path-end', {
            coreId,
            path: basename(path),
            source: 'error',
            ms: Date.now() - perRomStart,
          });
          onResolved({ path, metadata: null, error: true });
          errors += 1;
          continue;
        }
      }
      if (entry === undefined) {
        diagLog('info', 'prefetch', '·', 'unmatched', {
          coreId,
          path: basename(path),
          reason: 'no-hash',
        });
        diagLog('info', 'meta', '·', 'path-end', {
          coreId,
          path: basename(path),
          source: 'unmatched',
          ms: Date.now() - perRomStart,
        });
        onResolved({ path, metadata: null, error: false });
        resolved += 1;
        continue;
      }
      const ssHint = {
        systemId,
        md5: entry.md5,
        sha1: entry.sha1,
        crc32: undefined,
        romName: basename(path),
        romSize: entry.size,
      };
      const lookupStart = Date.now();
      // PR-D1 (PR #27): pass filename + parentFolder so MetadataService
      // can run the name-search fallback (jeuRecherche) when the hash
      // misses both SS and OpenVGDB. Parent folder is the basename of
      // the directory above the file — for atomic-folder ROMs
      // (`Metal Slug 2 (USA)/mslug2.neo`) this is the strongest
      // recovery signal.
      const filename = basename(path);
      const parentFolder = parentBasename(path);
      // PR-D1 round 2 (PR #27 round 2): only forward `parentFolderIsAtomic=true`
      // for paths the caller marked atomic. Default false so
      // organizational folders don't waste API budget.
      const parentFolderIsAtomic = atomicFolderPaths?.has(path) === true;
      try {
        const metadata = await this.metadataService.getMetadata(
          entry.md5,
          { filename, parentFolder, parentFolderIsAtomic },
          ssHint,
        );
        diagLog('info', 'prefetch', '·', 'lookup', {
          coreId,
          path: basename(path),
          source: metadata?.source ?? 'none',
          ms: Date.now() - lookupStart,
          totalMs: Date.now() - perRomStart,
        });
        diagLog('info', 'meta', '·', 'path-end', {
          coreId,
          path: basename(path),
          source: metadata?.source ?? 'none',
          ms: Date.now() - perRomStart,
        });
        onResolved({ path, metadata, error: false });
        resolved += 1;
      } catch (err) {
        diagLog('error', 'prefetch', '✗', 'lookup failed', {
          coreId,
          path: basename(path),
          ms: Date.now() - lookupStart,
          err: err instanceof Error ? err.message : String(err),
        });
        diagLog('info', 'meta', '·', 'path-end', {
          coreId,
          path: basename(path),
          source: 'error',
          ms: Date.now() - perRomStart,
        });
        onResolved({ path, metadata: null, error: true });
        errors += 1;
      }
    }

    diagLog('info', 'prefetch', '←', 'complete', {
      coreId,
      ms: Date.now() - startWall,
      resolved,
      errors,
      hashSkipped,
      total: romPaths.length,
    });
  }

  /**
   * Make the OpenVGDB database available. Returns the current state
   * synchronously after kicking off a download (if needed) — the
   * renderer subscribes to `onProgress` for streaming updates rather
   * than awaiting completion.
   *
   * If a download is already in progress, this is a no-op (returns
   * the in-progress state).
   */
  async ensureMetadataDatabase(
    onProgress?: (event: OpenVGDBProgressEvent) => void,
  ): Promise<MetadataDatabaseState> {
    if (this.openVgdb.isReady()) {
      return { ready: true, downloadInProgress: false };
    }
    if (this.downloadInProgress) {
      return { ready: false, downloadInProgress: true };
    }
    this.downloadInProgress = true;
    // Kick off the download in the background. The promise's
    // settlement updates `downloadInProgress`; the caller can poll
    // again for the final state.
    void this.openVgdb
      .ensureDatabase(onProgress)
      .catch(() => undefined)
      .finally(() => {
        this.downloadInProgress = false;
      });
    return {
      ready: this.openVgdb.isReady(),
      downloadInProgress: !this.openVgdb.isReady(),
    };
  }

  /** Convenience for the renderer: download box art lazily on first display. */
  async getBoxArtLocal(url: string): Promise<string | null> {
    if (url.length === 0) return null;
    return this.imageCache.fetch(url);
  }

  /**
   * Same as `getBoxArtLocal` but returns the file bytes so a sandboxed
   * renderer (where `file://` is blocked) can wrap them in a Blob /
   * objectURL for `<img src>`. Lazy-downloads on first call via the
   * shared image cache. Returns null on fetch failure or when the URL
   * is empty.
   */
  async getBoxArtBytes(url: string): Promise<Uint8Array | null> {
    const path = await this.getBoxArtLocal(url);
    if (path === null) {
      diagLog('warn', 'boxart', '✗', 'no-cached-path', {
        // url goes through the redactor at the cache layer; here we
        // just note that the resolution path returned null.
      });
      return null;
    }
    try {
      const bytes = await readFile(path);
      diagLog('info', 'boxart', '·', 'bytes-read', {
        path,
        bytes: bytes.byteLength,
      });
      return bytes;
    } catch (err) {
      diagLog('error', 'boxart', '✗', 'bytes-read-failed', {
        path,
        err: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Wipe the metadata cache + image cache. Hash cache is independent. */
  async clearMetadataCache(): Promise<void> {
    await Promise.all([
      this.metadataService.clearAll(),
      this.imageCache.clearAll(),
    ]);
  }
}

/**
 * Round 11 — deterministic synthetic cache key for paths whose
 * coreId has no metadata source. The `noss-` prefix marks the key
 * as synthetic (a real md5 is 32 hex chars with no prefix), so cache
 * files can be `grep`'d for synthetic-only entries. The hash input
 * is `<coreId>:<path>` so two distinct paths under the same core
 * produce distinct keys, and re-clicking the same core is
 * idempotent.
 *
 * Mtime is intentionally NOT included: if the user replaces the
 * file's bytes the metadata answer doesn't change (still no
 * coverage), and including mtime would orphan the previous
 * synthetic record on every file modification with no benefit.
 */
function makeSyntheticCacheKey(coreId: string, path: string): string {
  return (
    'noss-' +
    createHash('sha1').update(`${coreId}:${path}`).digest('hex')
  );
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}

/**
 * PR-D1 (PR #27): basename of the IMMEDIATE parent dir, or undefined
 * when there's no parent (root-level files). Used to feed the
 * name-search fallback's parentFolder hint — atomic-folder ROMs
 * (`/games/NEOGEO/Metal Slug 2 (USA)/mslug2.neo`) yield "Metal Slug
 * 2 (USA)", which `filename-hint.ts` cleans to "Metal Slug 2" before
 * running it as the search term.
 *
 * Returns undefined for paths with 0 or 1 segments (no meaningful
 * parent) so the hint is omitted rather than passed as the empty
 * string.
 */
function parentBasename(path: string): string | undefined {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash <= 0) return undefined;
  const parentPath = path.slice(0, lastSlash);
  const prevSlash = parentPath.lastIndexOf('/');
  const parent = prevSlash < 0 ? parentPath : parentPath.slice(prevSlash + 1);
  return parent === '' ? undefined : parent;
}
