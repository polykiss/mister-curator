import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { ARCADE_VIRTUAL_CORE_ID } from '@shared/arcade-mra';
import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';

import {
  groupByPrimaryZipBasename,
  resolvePrimaryZipBasename,
} from '@app/main/services/arcade-prefetch-paths';
import { chunked } from '@shared/chunk';
import { MISTER_ARCADE_ZIP_DIRS } from '@shared/constants';
import type { SizeAndMtime } from '@shared/prime-parse';

/**
 * feat/arcade-parity-2-metadata — arcade primary-zip stat chunk size.
 * Matches the WITNESS_CHUNK_SIZE constant in `real-mister-client.ts`
 * — every SSH-exec-argv-bounded call uses the same 100-path window
 * (witness stat, sample-md5, content-hash). 100 paths × ~70-byte
 * shell-quoted lines stays well under busybox's argv cap (~26 KB
 * script) AND under the bash kernel `ARG_MAX` ceiling that bit a
 * 706-path arcade stat in the live PR-62 verify trace.
 */
const ARCADE_STAT_CHUNK_SIZE = 100;
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
 * feat/arcade-noromsneeded-overrides — input shape the arcade manual-
 * write paths consume. Subset of `ArcadePlayabilitySnapshot` that the
 * orchestrator actually reads: entries (for the primary-zip
 * resolution), zipBasenames (for `resolvePrimaryZipBasename`), and
 * the per-path playability classification (so the bind/edit can
 * branch noRomsNeeded → by-mra-path vs playable → by-hash).
 */
export interface ArcadeBindSnapshot {
  readonly entries: readonly ArcadeMraMeta[];
  readonly zipBasenames: ReadonlySet<string>;
  readonly byPath: ReadonlyMap<
    string,
    'playable' | 'missing' | 'no-roms-needed'
  >;
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
   * `jeu` the user picked in the search modal. Routes to
   * `MetadataService.bindManualOverride`.
   *
   * feat/manual-bind-without-hash: when no md5 is on file for the
   * path (compute failed, was never attempted, the core is
   * unmappable), fall back to the synthetic `(coreId, path)` key
   * instead of returning null. The metadata cache layer is key-
   * agnostic — `bindManualOverride` works with any string. The
   * renderer's optimistic-read path has a matching synthetic-key
   * fallback so the bound record paints without a refresh.
   */
  async bindManualMetadataOverride(
    coreId: string,
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
    const cacheKey =
      entry !== undefined && entry !== null
        ? entry.md5
        : makeSyntheticCacheKey(coreId, path);
    // fix/#55 staleness mitigation: if we're binding under the real
    // md5 (hash was available), drop any stale synthetic record for
    // the same (coreId, path). Without this, a prior pre-hash bind
    // under the synthetic key would shadow this newer md5-keyed bind
    // in readCachedRomsMetadata's synthetic-wins read path.
    if (entry !== undefined && entry !== null) {
      await this.metadataService.invalidate(
        makeSyntheticCacheKey(coreId, path),
      );
    }
    return this.metadataService.bindManualOverride(cacheKey, game);
  }

  /**
   * feat/arcade-manual-ss-search — arcade analogue of
   * `bindManualMetadataOverride`. The renderer doesn't carry the
   * mra → primary-zip mapping, so the resolution lives here:
   *
   *   1. Look up the .mra in the supplied playability snapshot.
   *   2. Resolve its primary zip basename via the shared
   *      `resolvePrimaryZipBasename` helper (same logic the auto-
   *      scrape pass uses).
   *   3. Probe `games/mame/<basename>` then `games/hbmame/<basename>`
   *      against the cached hash table; whichever has an md5 wins.
   *   4. feat/arcade-bind-density-edit — if the zip is present on
   *      disk but isn't in the hash cache yet (auto-scrape didn't
   *      reach it, or hashing failed silently), hash it on-demand.
   *      One extra SSH op per bind, run only when the cache miss
   *      forces it. The Devil Zone case: obscure arcade title that
   *      the auto-scrape never matched, so the user reaches for
   *      "Find on ScreenScraper" while the zip is unhashed — pre-
   *      this-fix, the bind silently returned null.
   *   5. fix/screenscraper-bind-arcade-synthetic-key (#54) — if the
   *      on-demand hash also fails (zip missing from disk, SSH error),
   *      fall back to a synthetic `(ARCADE_VIRTUAL_CORE_ID, mraPath)`
   *      key rather than returning null. Mirrors the ROM bind path's
   *      `makeSyntheticCacheKey` fallback. The batch reader
   *      (`getCachedArcadeMetadataBatch`) checks the synthetic key
   *      per-mra so the record survives reconnect. Manual overrides
   *      take precedence over hash-keyed auto-scrape records at read
   *      time — see step 5b there.
   *   6. Call `MetadataService.bindManualOverride` keyed on the
   *      resolved md5 (or synthetic key) so the record is readable
   *      by the batch reader on reconnect.
   *
   * Returns null only when the mra isn't in the snapshot or its
   * primary zip can't be resolved (no requiredZips, or none of the
   * alternatives are in zipBasenames). Hash failures fall through to
   * the synthetic key path rather than surfacing a toast.
   */
  async bindArcadeManualMetadataOverride(
    snapshot: ArcadeBindSnapshot,
    mraRelativePath: string,
    game: ScreenScraperGame,
  ): Promise<RomMetadata | null> {
    // feat/arcade-noromsneeded-overrides — TTL / discrete-logic
    // games (Breakout TTL, Pong) have no primary zip; the by-hash
    // store can't key them. Route those to the parallel
    // arcade-mra-overrides path so the user can still bind manual
    // metadata. Playable + missing entries continue through the
    // by-hash + zip-md5 chain (unchanged).
    if (snapshot.byPath.get(mraRelativePath) === 'no-roms-needed') {
      return this.metadataService.bindArcadeMraOverride(
        mraRelativePath,
        game,
      );
    }
    // Hard-bail when the mra isn't in the snapshot or has no
    // resolvable primary zip — a synthetic key for an unknown mra
    // would be unreadable by the batch reader and mislead the user.
    const mraEntry = snapshot.entries.find(
      (e) => e.relativePath === mraRelativePath,
    );
    if (mraEntry === undefined) return null;
    if (resolvePrimaryZipBasename(mraEntry, snapshot.zipBasenames) === null) {
      return null;
    }
    const md5 = await this.resolveOrComputeArcadePrimaryZipMd5(
      snapshot,
      mraRelativePath,
    );
    // fix/#54 — mirror the ROM bind path: fall back to a synthetic key
    // when the zip hash is unavailable instead of returning null.
    const key =
      md5 ?? makeSyntheticCacheKey(ARCADE_VIRTUAL_CORE_ID, mraRelativePath);
    if (md5 === null) {
      diagLog('info', 'arcade', '·', 'synthetic-key-fallback', {
        mraRelativePath,
        syntheticKey: key,
      });
    } else {
      // fix/#55 staleness mitigation: binding under real md5 — drop
      // any stale synthetic record so it doesn't shadow this bind in
      // getCachedArcadeMetadataBatch's synthetic-wins read path.
      const staleKey = makeSyntheticCacheKey(
        ARCADE_VIRTUAL_CORE_ID,
        mraRelativePath,
      );
      await this.metadataService.invalidate(staleKey);
      diagLog('info', 'arcade', '·', 'invalidating-synthetic-after-real-bind', {
        mraRelativePath,
        staleSyntheticKey: staleKey,
      });
    }
    return this.metadataService.bindManualOverride(key, game);
  }

  /**
   * feat/arcade-bind-density-edit — sibling of
   * `bindArcadeManualMetadataOverride` for the edit-metadata dialog.
   * Same primary-zip → md5 resolution (including on-demand hashing
   * if the zip is unhashed), but composes a writeUserOverride call
   * instead of a bind-from-search.
   *
   * feat/arcade-noromsneeded-overrides — same branch as the bind
   * variant: noRomsNeeded entries route to the mra-keyed override
   * store. Edit requires an existing record either way (the dialog
   * gates on `metadata` being non-null).
   *
   * Returns null on the same paths as the bind variant — no snapshot
   * entry, unresolvable primary zip, or hash failure. The renderer
   * surfaces a toast and leaves the edit dialog open for retry.
   */
  async setArcadeManualMetadataOverride(
    snapshot: ArcadeBindSnapshot,
    mraRelativePath: string,
    override: UserMetadataOverride | undefined,
  ): Promise<RomMetadata | null> {
    if (snapshot.byPath.get(mraRelativePath) === 'no-roms-needed') {
      return this.metadataService.writeArcadeMraUserOverride(
        mraRelativePath,
        override,
      );
    }
    const md5 = await this.resolveOrComputeArcadePrimaryZipMd5(
      snapshot,
      mraRelativePath,
    );
    if (md5 === null) return null;
    return this.metadataService.writeUserOverride(md5, override);
  }

  /**
   * Shared resolution path for the two arcade manual-write IPCs.
   * Walks: snapshot lookup → primary zip basename → cached md5 →
   * on-demand hash (if cache miss but zip exists on-disk). Returns
   * the resolved md5, or null on any unrecoverable failure.
   */
  private async resolveOrComputeArcadePrimaryZipMd5(
    snapshot: ArcadeBindSnapshot,
    mraRelativePath: string,
  ): Promise<string | null> {
    const session = this.getActiveSession();
    if (session === null) return null;
    const mra = snapshot.entries.find(
      (e) => e.relativePath === mraRelativePath,
    );
    if (mra === undefined) return null;
    const zipBasename = resolvePrimaryZipBasename(mra, snapshot.zipBasenames);
    if (zipBasename === null) return null;
    const candidatePaths = MISTER_ARCADE_ZIP_DIRS.map(
      (dir) => `${dir}/${zipBasename}`,
    );
    const hashByPath = await this.hashService.readCachedEntries(
      session.host,
      candidatePaths,
    );
    for (const path of candidatePaths) {
      const entry = hashByPath.get(path);
      if (entry !== null && entry !== undefined) {
        return entry.md5;
      }
    }
    // Cache miss on both candidates — hash on demand. Try each
    // candidate path; the first that resolves wins. computeHash
    // returns undefined when the path doesn't exist on disk, so we
    // probe mame/ first then fall through to hbmame/.
    for (const path of candidatePaths) {
      try {
        const computed = await this.hashService.computeHash(
          session.client,
          session.host,
          path,
        );
        if (computed !== undefined) return computed.md5;
      } catch {
        /* try the other candidate */
      }
    }
    return null;
  }

  async readCachedRomsMetadata(
    coreId: string,
    romPaths: readonly string[],
  ): Promise<Record<string, RomMetadata | null>> {
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
    // fix/#55 — mirror getCachedArcadeMetadataBatch's synthetic-wins
    // pattern. Per-path synthetic key check runs alongside the hash
    // lookup; if a synthetic record exists it wins (manual bind takes
    // precedence over auto-scraped). Source='none' unmappable-core
    // sentinels are also stored under synthetic keys but are filtered
    // to null by readCachedMetadata (line ~971), so they remain
    // transparent and never suppress a hash-keyed scraped result.
    for (const p of romPaths) {
      const entry = hashEntries.get(p);
      const hashKeyedRecord =
        entry !== null && entry !== undefined
          ? await this.metadataService.readCachedMetadata(entry.md5)
          : null;
      const syntheticKey = makeSyntheticCacheKey(coreId, p);
      const synthRecord =
        await this.metadataService.readCachedMetadata(syntheticKey);
      out[p] = synthRecord ?? hashKeyedRecord;
    }
    return out;
  }

  /**
   * feat/arcade-parity-2-metadata — cache-only batched read of
   * arcade ScreenScraper metadata, keyed by `.mra` relativePath.
   * Pure disk reads — no SSH, no SS network calls. The
   * auto-scrape engine populates the cache in the background via
   * `getArcadeMetadata`; this method reads back whatever's there.
   *
   * Resolution chain per `.mra`:
   *   1. Compute primary zip basename via `groupByPrimaryZipBasename`.
   *   2. Check `<userData>/mister-cache/<host>/hashes.json` for both
   *      candidate paths (mame/ then hbmame/). Whichever has a
   *      cached HashEntry wins.
   *   3. Read `<userData>/metadata/by-hash/<md5>.json` for the
   *      resolved md5.
   *
   * Any step yielding nothing → `null` in the result map (the row
   * shows pre-metadata state). Multiple `.mras` sharing a zip all
   * map to the same `RomMetadata` record — the shared
   * `MetadataService` cache is keyed by md5, not by .mra.
   */
  async getCachedArcadeMetadataBatch(
    host: string,
    snapshot: {
      readonly entries: readonly ArcadeMraMeta[];
      readonly zipBasenames: ReadonlySet<string>;
      readonly byPath: ReadonlyMap<
        string,
        'playable' | 'missing' | 'no-roms-needed'
      >;
    },
  ): Promise<Record<string, RomMetadata | null>> {
    const out: Record<string, RomMetadata | null> = {};

    // feat/arcade-noromsneeded-overrides — TTL / discrete-logic games
    // have no primary zip to hash; manual overrides land in the
    // parallel arcade-mra-overrides store. Surface those reads first
    // (pure-disk, no SSH) so noRomsNeeded rows paint immediately even
    // when the playable cohort is empty.
    const noRomsNeeded = snapshot.entries.filter(
      (e) => snapshot.byPath.get(e.relativePath) === 'no-roms-needed',
    );
    for (const mra of noRomsNeeded) {
      out[mra.relativePath] =
        await this.metadataService.readCachedArcadeMraMetadata(
          mra.relativePath,
        );
    }

    const playable = snapshot.entries.filter(
      (e) => snapshot.byPath.get(e.relativePath) === 'playable',
    );
    if (playable.length === 0) return out;
    const groups = groupByPrimaryZipBasename(playable, snapshot.zipBasenames);

    // Batch-read every candidate path's HashEntry in one disk pass
    // (HashService.readCachedEntries opens hashes.json once and
    // looks up each path). Two candidates per group (mame/ +
    // hbmame/) — most won't exist but the lookup is fast.
    const candidatePaths: string[] = [];
    for (const g of groups) {
      for (const dir of MISTER_ARCADE_ZIP_DIRS) {
        candidatePaths.push(`${dir}/${g.zipBasename}`);
      }
    }
    const hashByPath = await this.hashService.readCachedEntries(
      host,
      candidatePaths,
    );

    // For each group: find the candidate path with a cached HashEntry,
    // read metadata by its md5, fan out to every .mra in the group.
    //
    // fix/#54 / step 5b — per-mra synthetic key check: manual binds
    // written before the zip was hashed land under a synthetic
    // `(ARCADE_VIRTUAL_CORE_ID, mraRelativePath)` key. Check that key
    // first so user-chosen overrides are always surfaced, even if the
    // auto-scrape later writes a different record under the real md5.
    //
    // NOTE: the ROM read path (`readCachedRomsMetadata`) has the
    // inverse priority (hash wins over synthetic). That inconsistency
    // is a latent issue to revisit — for arcade, sticky manual binds
    // are the deliberately chosen semantic.
    for (const group of groups) {
      let md5: string | null = null;
      for (const dir of MISTER_ARCADE_ZIP_DIRS) {
        const entry = hashByPath.get(`${dir}/${group.zipBasename}`);
        if (entry !== null && entry !== undefined) {
          md5 = entry.md5;
          break;
        }
      }
      const hashKeyedMetadata =
        md5 !== null
          ? await this.metadataService.readCachedMetadata(md5)
          : null;
      // Fan out across every .mra in the group — they share the
      // same SS record by virtue of sharing a zip md5, but each mra
      // may carry its own synthetic-keyed manual override.
      for (const mra of group.mras) {
        const syntheticKey = makeSyntheticCacheKey(
          ARCADE_VIRTUAL_CORE_ID,
          mra.relativePath,
        );
        const synthRecord =
          await this.metadataService.readCachedMetadata(syntheticKey);
        out[mra.relativePath] = synthRecord ?? hashKeyedMetadata;
      }
    }
    // Playable .mras whose primary zip couldn't be grouped (e.g.
    // requiredZips empty after the playability filter — shouldn't
    // happen but defensive) appear in `out` as undefined; coerce to
    // null so the wire shape stays consistent.
    for (const mra of playable) {
      if (!(mra.relativePath in out)) out[mra.relativePath] = null;
    }
    return out;
  }

  /**
   * feat/arcade-parity-2-metadata — arcade prefetch pass. Like
   * `getRomsMetadata` but with two structural differences:
   *
   * 1. Each "path" is a primary zip (`/media/fat/games/mame/<zip>`
   *    or `/media/fat/games/hbmame/<zip>`). Multiple `.mras` can
   *    share a primary zip; the deduper (`groupByPrimaryZipBasename`)
   *    collapses them so we hash + look up SS once per unique zip.
   * 2. SS hints come from the `.mra` context, NOT the zip path.
   *    The zip path's basename is `'dkong.zip'` — SS's name-search
   *    on the setname matches poorly; the `.mra`'s displayName
   *    (`'Donkey Kong'`) and setname (`'dkong'`) are the right
   *    inputs to `jeuRecherche.php`. We synthesize a filename
   *    `'Donkey Kong (dkong).mra'` so the existing `extractNameHints`
   *    yields both the filename-stem AND the paren-shortname hints
   *    without touching `MetadataService`'s shape.
   *
   * Events fire with `path = zipPath` (the unique zip), shape-
   * compatible with `RomMetadataResolvedEvent` so the same engine
   * progress UI ticks through arcade and ROM prefetches uniformly.
   * The renderer / adapter reads cached metadata by zip md5 later
   * (via `getArcadeMetadataBatch` IPC) — N `.mras` sharing one zip
   * all resolve to the same `RomMetadata` record on disk.
   *
   * Hard-codes `systemId = 75` (ScreenScraper's mame / arcade
   * system id) — the wiring layer's `SystemIdResolver` is bypassed
   * for arcade entries because the resolver is keyed on coreId, and
   * the arcade pass uses `ARCADE_VIRTUAL_CORE_ID` which doesn't map
   * to a core file the resolver would recognise.
   */
  async getArcadeMetadata(
    playableEntries: readonly ArcadeMraMeta[],
    zipBasenames: ReadonlySet<string>,
    onResolved?: (event: RomMetadataResolvedEvent) => void,
    shouldAbort?: () => boolean,
  ): Promise<void> {
    // Reuse the in-flight gate keyed on the arcade virtual coreId so a
    // duplicate call (e.g. engine retry + manual refresh) coalesces
    // into a single scrape loop. Same shape as `getRomsMetadata`'s
    // gate at line ~371 below.
    const inflight = this.inflightByCoreId.get(ARCADE_VIRTUAL_CORE_ID);
    if (inflight !== undefined) {
      diagLog('info', 'prefetch', '·', 'gate-coalesce', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
        playable: playableEntries.length,
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
    const promise = this.runArcadeScrapeLoop(
      playableEntries,
      zipBasenames,
      fanOut,
      shouldAbort,
    ).finally(() => {
      this.inflightByCoreId.delete(ARCADE_VIRTUAL_CORE_ID);
    });
    this.inflightByCoreId.set(ARCADE_VIRTUAL_CORE_ID, { promise, callbacks });
    return promise;
  }

  private async runArcadeScrapeLoop(
    playableEntries: readonly ArcadeMraMeta[],
    zipBasenames: ReadonlySet<string>,
    onResolved: (event: RomMetadataResolvedEvent) => void,
    shouldAbort?: () => boolean,
  ): Promise<void> {
    const groups = groupByPrimaryZipBasename(playableEntries, zipBasenames);
    if (groups.length === 0) return;
    const startWall = Date.now();
    diagLog('info', 'prefetch', '→', 'start', {
      coreId: ARCADE_VIRTUAL_CORE_ID,
      mras: playableEntries.length,
      uniqueZips: groups.length,
    });
    const session = this.getActiveSession();
    if (session === null) {
      diagLog('warn', 'prefetch', '·', 'no-session', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
      });
      return;
    }

    // Step 1: resolve each zip basename to a real path. The snapshot
    // doesn't preserve per-dir membership (it unions mame/ + hbmame/),
    // so we stat both candidate paths and pick the one with size > 0.
    // Chunked at ARCADE_STAT_CHUNK_SIZE — a single 706-path stat call
    // overflowed bash's ARG_MAX on the real MiSTer (PR-62 live trace:
    // 353 unique zips × 2 dirs = 706 paths, kernel returned E2BIG /
    // "Argument list too long"). Same class of bug PRs #53 and #56
    // solved for witness + sample-md5; reuses the same `chunked`
    // helper and 100-path window. 706 paths → 8 sequential SSH ops.
    const candidatePaths: string[] = [];
    for (const group of groups) {
      for (const dir of MISTER_ARCADE_ZIP_DIRS) {
        candidatePaths.push(`${dir}/${group.zipBasename}`);
      }
    }
    let stats: Record<string, SizeAndMtime>;
    try {
      stats = await chunked<string, Record<string, SizeAndMtime>>(
        candidatePaths,
        ARCADE_STAT_CHUNK_SIZE,
        (chunk) => session.client.statPathsWithSize(chunk),
        (acc, next) => Object.assign(acc, next),
        {},
      );
    } catch (err) {
      diagLog('error', 'prefetch', '✗', 'arcade-stat failed', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
        candidatePaths: candidatePaths.length,
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    interface ResolvedGroup {
      readonly zipPath: string;
      readonly primaryMra: ArcadeMraMeta;
    }
    const resolved: ResolvedGroup[] = [];
    for (const group of groups) {
      let zipPath: string | null = null;
      for (const dir of MISTER_ARCADE_ZIP_DIRS) {
        const candidate = `${dir}/${group.zipBasename}`;
        const stat = stats[candidate];
        if (stat !== undefined && stat.size > 0 && stat.mtime > 0) {
          zipPath = candidate;
          break;
        }
      }
      if (zipPath === null) {
        // Snapshot said the basename existed in the union, but neither
        // candidate path stat'd. Race with a zip removal between the
        // snapshot build and now. Emit a null event for this group so
        // the engine's progress counter (driven by `onResolved`
        // invocations vs `paths.length` from `listRomPaths`) keeps
        // ticking — the engine sees one event per playable group.
        // Synthesize a path from the first dir for the event payload;
        // the value doesn't have to match a real path since the
        // engine matches by event count, not path identity.
        onResolved({
          path: `${MISTER_ARCADE_ZIP_DIRS[0]}/${group.zipBasename}`,
          metadata: null,
          error: false,
        });
        continue;
      }
      // The first .mra in the bucket (sorted by relativePath) is the
      // canonical name source. All .mras in the bucket share the same
      // zip md5 → same SS metadata; any displayName works for the
      // search, but determinism matters for log + cache reproducibility.
      resolved.push({ zipPath, primaryMra: group.mras[0]! });
    }
    if (resolved.length === 0) {
      diagLog('warn', 'prefetch', '·', 'arcade-no-resolved-zips', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
        snapshotPlayable: playableEntries.length,
      });
      return;
    }

    // Step 2: batched mtime + hash-failure-sentinel check across the
    // deduped zip paths. Same pattern as `runScrapeLoop`'s round-9
    // batched check — one SSH op instead of N per-path stats.
    const zipPaths = resolved.map((r) => r.zipPath);
    let mtimeMap: Map<string, HashEntry | null>;
    let cachedHashFailures: ReadonlySet<string>;
    try {
      const checked = await this.hashService.checkCachedMtimes(
        session.client,
        session.host,
        zipPaths,
      );
      mtimeMap = checked.entries;
      cachedHashFailures = checked.failedPaths ?? new Set();
    } catch (err) {
      diagLog('error', 'prefetch', '✗', 'arcade-mtime-batch failed', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
        err: err instanceof Error ? err.message : String(err),
      });
      mtimeMap = new Map(zipPaths.map((p) => [p, null]));
      cachedHashFailures = new Set();
    }

    // Step 3: per-zip loop. Hash if needed, then call MetadataService
    // with `.mra`-derived hints.
    let resolvedCount = 0;
    let errorCount = 0;
    let hashSkipped = 0;
    for (const group of resolved) {
      if (shouldAbort?.()) {
        diagLog('info', 'prefetch', '·', 'aborted', {
          coreId: ARCADE_VIRTUAL_CORE_ID,
          remaining: resolved.length - resolvedCount - errorCount,
        });
        break;
      }
      const { zipPath, primaryMra } = group;
      const perZipStart = Date.now();
      diagLog('info', 'meta', '·', 'path-start', {
        coreId: ARCADE_VIRTUAL_CORE_ID,
        path: basename(zipPath),
      });
      if (cachedHashFailures.has(zipPath)) {
        diagLog('info', 'prefetch', '·', 'skip-hash', {
          coreId: ARCADE_VIRTUAL_CORE_ID,
          path: basename(zipPath),
          reason: 'cached-hash-failed',
        });
        onResolved({ path: zipPath, metadata: null, error: false });
        hashSkipped += 1;
        resolvedCount += 1;
        continue;
      }
      let entry: HashEntry | undefined;
      const cachedEntry = mtimeMap.get(zipPath);
      if (cachedEntry !== null && cachedEntry !== undefined) {
        entry = cachedEntry;
      } else {
        try {
          entry = await this.hashService.computeHash(
            session.client,
            session.host,
            zipPath,
          );
        } catch (err) {
          diagLog('error', 'prefetch', '✗', 'hash failed', {
            coreId: ARCADE_VIRTUAL_CORE_ID,
            path: basename(zipPath),
            ms: Date.now() - perZipStart,
            err: err instanceof Error ? err.message : String(err),
          });
          onResolved({ path: zipPath, metadata: null, error: true });
          errorCount += 1;
          continue;
        }
      }
      if (entry === undefined) {
        // hashPaths dropped the row (vanished mid-flight).
        onResolved({ path: zipPath, metadata: null, error: false });
        resolvedCount += 1;
        continue;
      }

      // Build the .mra-derived hint. Synthesizing
      // `'<displayName> (<setname>).mra'` makes `extractNameHints`
      // emit BOTH the paren-shortname (setname) and the filename-
      // stem (displayName) — two name-search hints from one
      // call without touching MetadataService.
      const setnameForHint = primaryMra.setname?.trim();
      const baseNameForHint = primaryMra.displayName.endsWith('.mra')
        ? primaryMra.displayName.slice(0, -'.mra'.length)
        : primaryMra.displayName;
      const filenameForHint =
        setnameForHint !== undefined && setnameForHint !== ''
          ? `${baseNameForHint} (${setnameForHint}).mra`
          : primaryMra.displayName;
      const ssHint = {
        systemId: 75,
        md5: entry.md5,
        sha1: entry.sha1,
        crc32: undefined,
        romName: primaryMra.displayName,
        romSize: entry.size,
      };
      const hint: MetadataHint = {
        filename: filenameForHint,
        parentFolder: '_Arcade',
        parentFolderIsAtomic: false,
      };
      try {
        const metadata = await this.metadataService.getMetadata(
          entry.md5,
          hint,
          ssHint,
        );
        diagLog('info', 'meta', '·', 'path-end', {
          coreId: ARCADE_VIRTUAL_CORE_ID,
          path: basename(zipPath),
          source: metadata?.source ?? 'none',
          ms: Date.now() - perZipStart,
        });
        onResolved({ path: zipPath, metadata, error: false });
        resolvedCount += 1;
      } catch (err) {
        diagLog('error', 'prefetch', '✗', 'arcade-lookup failed', {
          coreId: ARCADE_VIRTUAL_CORE_ID,
          path: basename(zipPath),
          ms: Date.now() - perZipStart,
          err: err instanceof Error ? err.message : String(err),
        });
        onResolved({ path: zipPath, metadata: null, error: true });
        errorCount += 1;
      }
    }
    diagLog('info', 'prefetch', '←', 'done', {
      coreId: ARCADE_VIRTUAL_CORE_ID,
      resolved: resolvedCount,
      errors: errorCount,
      hashSkipped,
      uniqueZips: resolved.length,
      ms: Date.now() - startWall,
    });
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
    // feat/hash-failure-sentinel — paths whose cached hash-failure
    // sentinel's witness still matches the device's current stat.
    // The per-path loop below short-circuits these so we never
    // re-attempt a hash that just timed out last time.
    let cachedHashFailures: ReadonlySet<string> = new Set();
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
        // fix/mtime-tolerance — checkCachedMtimes now returns the
        // exact / tolerance breakdown alongside the entry map so the
        // live trace can confirm the tolerance is actually doing work
        // on an SD-rebuilt device (validatedTolerance dominating
        // validatedExact when the rebuild rounded mtimes to even
        // seconds).
        const checked = await this.hashService.checkCachedMtimes(
          session.client,
          session.host,
          romPaths,
        );
        mtimeMap = checked.entries;
        // Defensive default: a test double or older HashService that
        // omits `failedPaths` is treated as "no cached failures."
        cachedHashFailures = checked.failedPaths ?? new Set();
        const validated = [...mtimeMap.values()].filter(
          (v) => v !== null,
        ).length;
        // `needsHash` excludes paths with a valid hash-failure
        // sentinel — those will skip the hash attempt below, so
        // counting them as "needs hash" would over-report the
        // walk cost the user actually pays.
        const needsHash = [...mtimeMap.entries()].filter(
          ([p, v]) => v === null && !cachedHashFailures.has(p),
        ).length;
        diagLog('info', 'prefetch', '·', 'mtime-batch done', {
          coreId,
          ms: Date.now() - mtimeCheckStart,
          validated,
          validatedExact: checked.exactCount,
          validatedTolerance: checked.toleranceCount,
          // feat/sample-based-hashing — paths whose mtime drifted
          // past the ±2s tolerance window but were rescued by a
          // matching sample-md5 fingerprint, avoiding the full
          // file re-hash. On a MAME ROM redeploy this is what
          // turns the 10-40-minute cold path into seconds.
          validatedSample: checked.sampleCount,
          // feat/hash-failure-sentinel — count of paths whose
          // previously-failed hash is still witness-valid this
          // session. The user sees these as `source=none reason=
          // cached-hash-failed` and we skip the SSH op entirely.
          cachedHashFailures: cachedHashFailures.size,
          needsHash,
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

      // feat/hash-failure-sentinel — file's hash attempt failed
      // previously (typically the 120s SSH timeout on a multi-GB
      // wrapper zip) and its current stat still matches the
      // sentinel's witness. Skip the retry; treat as `source=none`
      // with reason `cached-hash-failed`. The sentinel auto-drops
      // on stat drift (see `doCheckCachedMtimes`), so a user
      // replacing the offending file gets a fresh attempt next
      // connect.
      if (cachedHashFailures.has(path)) {
        diagLog('info', 'prefetch', '·', 'skip-hash', {
          coreId,
          path: basename(path),
          reason: 'cached-hash-failed',
        });
        diagLog('info', 'meta', '·', 'path-end', {
          coreId,
          path: basename(path),
          source: 'none',
          reason: 'cached-hash-failed',
          ms: Date.now() - perRomStart,
        });
        onResolved({ path, metadata: null, error: false });
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
        // fix/count-and-status-indicator commit 3 — surface
        // boxArtUrl presence per-row so live trace can confirm
        // whether the user-perceived "no box art" cases are the
        // metadata fetch returning null URLs vs. the hash being
        // missing entirely (commit 4's lazy migration scope) vs.
        // the renderer dropping the URL.
        diagLog('info', 'prefetch', '·', 'lookup', {
          coreId,
          path: basename(path),
          source: metadata?.source ?? 'none',
          hasBoxArt:
            metadata !== null &&
            metadata.boxArtUrl !== null &&
            metadata.boxArtUrl !== ''
              ? 1
              : 0,
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
 * Round 11 — deterministic synthetic cache key for any `(coreId, path)`
 * pair without a usable md5. Two cases produce one of these:
 *
 *   1. Unmappable cores (original use): `resolveSystemId` returns null
 *      so the orchestrator short-circuits the hash compute entirely —
 *      no metadata source can use the bytes anyway.
 *   2. feat/manual-bind-without-hash: a file that *would* normally
 *      hash but doesn't (compute timed out, never attempted, etc.)
 *      and the user reaches the row via the manual-search dialog.
 *      The bind path falls back to this key so the record can be
 *      written + read despite the missing md5.
 *
 * The `noss-` prefix marks the key as synthetic (a real md5 is 32 hex
 * chars with no prefix), so cache files can be `grep`'d for
 * synthetic-only entries. Despite the now-stale "noss" (no-SS) name,
 * a synthetic-keyed record CAN have real SS metadata in it — the
 * prefix only signals "this key didn't come from ROM bytes." Renaming
 * would force a one-shot migration over every existing on-disk record
 * for purely cosmetic gain, so the name stays.
 *
 * The hash input is `<coreId>:<path>` so two distinct paths under the
 * same core produce distinct keys, and re-clicking the same core is
 * idempotent. Mtime is intentionally NOT included: in case 1 the
 * metadata answer doesn't depend on the bytes, and in case 2 the
 * user's manual bind is meant to outlive byte-level edits.
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
