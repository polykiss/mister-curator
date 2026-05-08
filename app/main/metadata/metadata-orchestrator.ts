import type { HashClient, HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import type { MetadataService } from '@app/main/metadata/metadata-service';
import type {
  MetadataHint,
  PrefetchProgress,
  RomMetadata,
} from '@shared/metadata-types';

export interface ActiveSession {
  /** SSH-shaped subset the HashService consumes. */
  readonly client: HashClient;
  /** Host string used as the per-MiSTer cache partition key. */
  readonly host: string;
}

/**
 * Top-level metadata coordinator. The IPC handlers (PR #15 part 7)
 * call this; the orchestrator threads `(client, host)` from the
 * active connection through to HashService and the metadata pipeline.
 *
 * No state of its own — all caching lives in the underlying services.
 *
 * Public API matches the PR #15 spec:
 *   - getRomMetadata(coreId, romPath, hint)
 *   - prefetchHashes(allPaths, onProgress)
 *   - prefetchMetadata(hashes, onProgress)
 *   - clearMetadataCache (also clears the image cache)
 *
 * The image cache is surfaced via `getOrFetchBoxArt` so the UI in
 * PR #16/#17 can render a local file path instead of forcing every
 * <img> to hit the network on first paint.
 */
export class MetadataOrchestrator {
  constructor(
    private readonly hashService: HashService,
    private readonly metadataService: MetadataService,
    private readonly imageCache: ImageCache,
    private readonly getActiveSession: () => ActiveSession | null,
  ) {}

  /**
   * Compute (or recall) the hash for one ROM file and look up its
   * metadata. Returns null when:
   *   - no active connection
   *   - the file isn't a regular file on the device (md5sumPaths
   *     drops it silently)
   *   - both metadata services miss
   *
   * `coreId` is unused in v0 but threaded through so the IPC contract
   * matches the spec; PR #16 may use it for analytics or to scope
   * cache policies per-core.
   */
  async getRomMetadata(
    coreId: string,
    romPath: string,
    hint?: MetadataHint,
  ): Promise<RomMetadata | null> {
    void coreId; // unused in v0; reserved for per-core scoping later
    const session = this.getActiveSession();
    if (session === null) return null;

    const hashes = await this.hashService.getHash(
      session.client,
      session.host,
      [romPath],
    );
    const hash = hashes.get(romPath);
    if (hash === undefined) return null;

    return this.metadataService.getMetadata(hash, hint ?? {});
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
   * second pass that talks to ScreenScraper / TheGamesDB.
   *
   * We don't parallelize: ScreenScraper's anonymous tier rate-limits
   * to ~1 req/sec, and the queue inside the client already serializes
   * calls. Issuing all hashes in parallel just queues them all up at
   * once; doing it in a sequential loop is no slower and gives us
   * monotonic progress events.
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
