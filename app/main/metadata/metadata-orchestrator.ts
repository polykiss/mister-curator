import type { HashClient, HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import type { MetadataService } from '@app/main/metadata/metadata-service';
import type {
  OpenVGDBProgressEvent,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
import type {
  MetadataHint,
  PrefetchProgress,
  RomMetadata,
} from '@shared/metadata-types';

/**
 * Maps a MiSTer core id (and the path it came from) to two facts:
 *   - `ssSystemId`: the ScreenScraper `systemeid` required by jeuInfos.
 *   - `systemName`: the OpenVGDB-shaped display name (e.g. "Super
 *     Nintendo Entertainment System") used for `RomMetadata.system`.
 *
 * Round 3 of PR #16 added `systemName` so SS-sourced records carry a
 * meaningful system label (the SS jeuInfos response doesn't include
 * one). The orchestrator doesn't own the map — `app/main/index.ts`
 * builds it from a static table and injects it via the constructor.
 * Tests pass a tiny inline mapper.
 */
export type SystemResolver = (params: {
  /** Filename basename (e.g. "Sonic.md") — extension may hint at the system. */
  readonly romPath: string;
  /** Core id from the cores list (e.g. "Genesis"). */
  readonly coreId?: string;
}) => { readonly ssSystemId: number; readonly systemName: string } | null;

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
    private readonly resolveSystem: SystemResolver,
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

    const resolved = this.resolveSystem({ romPath, coreId });
    const ssHint =
      resolved === null
        ? undefined
        : {
            systemId: resolved.ssSystemId,
            systemName: resolved.systemName,
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
