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
import { diagLog } from '@shared/diag-log';
import type {
  MetadataHint,
  PrefetchProgress,
  RomMetadata,
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
  async getRomsMetadata(
    coreId: string,
    romPaths: readonly string[],
    onResolved?: (event: RomMetadataResolvedEvent) => void,
  ): Promise<void> {
    if (romPaths.length === 0) return;
    diagLog('info', 'prefetch', '→', 'start', {
      coreId,
      paths: romPaths.length,
    });
    const startWall = Date.now();
    let resolved = 0;
    let errors = 0;
    const session = this.getActiveSession();
    if (session === null) {
      diagLog('warn', 'prefetch', '·', 'no-session', { coreId });
      for (const path of romPaths) {
        onResolved?.({ path, metadata: null, error: false });
      }
      return;
    }

    // Round 5: per-ROM hash + lookup, end-to-end per path. Round 4
    // batched the hash into one big SSH exec for all N paths; a
    // single multi-GB ROM (e.g. a Super Famicom translation
    // collection) would push that batch past the 120s hash timeout
    // and take down ALL N paths' metadata. Now: one ROM at a time
    // through the per-host serialized HashService, with ssh2's
    // `disposeOnTimeout: false` (set in `hashPaths`) so a single
    // bad ROM only fails its own row instead of the SSH session.
    // Trade-off: ~100-200ms of SSH channel-setup overhead per ROM.
    // Cheap price for the resilience win and the progressive UI
    // updates (rows populate one by one as they resolve).
    for (const path of romPaths) {
      const perRomStart = Date.now();
      diagLog('info', 'meta', '·', 'path-start', {
        coreId,
        path: basename(path),
      });
      let entry: HashEntry | undefined;
      try {
        const hashes = await this.hashService.getHash(
          session.client,
          session.host,
          [path],
        );
        entry = hashes.get(path);
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
        onResolved?.({ path, metadata: null, error: true });
        errors += 1;
        continue;
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
        onResolved?.({ path, metadata: null, error: false });
        resolved += 1;
        continue;
      }
      const systemId = this.resolveSystemId({ romPath: path, coreId });
      const ssHint =
        systemId === null
          ? undefined
          : {
              systemId,
              md5: entry.md5,
              sha1: entry.sha1,
              crc32: undefined,
              romName: basename(path),
              romSize: entry.size,
            };
      const lookupStart = Date.now();
      try {
        const metadata = await this.metadataService.getMetadata(
          entry.md5,
          {},
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
        onResolved?.({ path, metadata, error: false });
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
        onResolved?.({ path, metadata: null, error: true });
        errors += 1;
      }
    }

    diagLog('info', 'prefetch', '←', 'complete', {
      coreId,
      ms: Date.now() - startWall,
      resolved,
      errors,
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
    if (path === null) return null;
    try {
      return await readFile(path);
    } catch {
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

function basename(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? path : path.slice(slash + 1);
}
