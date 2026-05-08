import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import type {
  OpenVGDBMetadata,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
import {
  ScreenScraperAuthError,
  type ScreenScraperGame,
  type ScreenScraperLookupQuery,
  type ScreenScraperService,
} from '@app/main/metadata/screenscraper-service';
import {
  NO_MATCH_TTL_MS,
  ROM_METADATA_SCHEMA_VERSION,
  type MetadataHint,
  type RomMetadata,
} from '@shared/metadata-types';

export interface MetadataServiceOptions {
  /** Test seam — defaults to `Date.now`. */
  readonly now?: () => number;
  /** Expiry for `source: 'none'` sentinels. */
  readonly noMatchTtlMs?: number;
  /**
   * Single-line warning sink for ScreenScraper auth failures and
   * other diagnostics. Default: no log.
   */
  readonly logger?: (message: string) => void;
}

/**
 * Optional ScreenScraper query parameters threaded through from the
 * orchestrator. Most are populated when the caller has hash data
 * cached; `systemId` is resolved by an external mapper (coreId → SS
 * systemeid). Round 3 also threads `systemName` so SS-sourced records
 * can populate `RomMetadata.system` — SS's jeuInfos response doesn't
 * include a system name, but the resolver knows it from the coreId.
 */
export interface ScreenScraperHint {
  readonly systemId: number;
  readonly systemName?: string;
  readonly md5?: string;
  readonly sha1?: string;
  readonly crc32?: string;
  readonly romName?: string;
  readonly romSize?: number;
}

/**
 * Hash-keyed metadata pipeline.
 *
 * Source-priority chain (PR #16 round 2):
 *   1. ScreenScraper if `available` AND a `screenScraperHint` was
 *      threaded through (multi-hash query: md5 + sha1, optionally
 *      romName / romSize / systemeid).
 *   2. OpenVGDB + libretro thumbnails (existing PR #15 chain).
 *   3. `'none'` sentinel cached for 30 days.
 *
 * SS match wins outright — its name, art, and SS-only fields are
 * the cached record; OpenVGDB isn't consulted. SS legitimate
 * no-match (or unavailable / rate-limited / quota-exceeded) falls
 * through to OpenVGDB. SS auth failure latches the SS service for
 * the session (the service handles that internally) and we fall
 * through here.
 *
 * Cache file layout:
 *   <rootDir>/by-hash/<hash[0:2]>/<hash>.json
 *
 * Schema-version note: cache files with a different
 * `ROM_METADATA_SCHEMA_VERSION` fail the parse guard and are treated
 * as a miss; the next call rewrites them in the current shape.
 * Round 9 bumped v2 → v3 for libretro-URL fixes; round 2 of PR #16
 * bumps v3 → v4 to evict OpenVGDB-only records when SS becomes
 * available, so users upgrading get the richer SS-sourced data.
 */
export class MetadataService {
  private readonly noMatchTtlMs: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  /** Per-hash in-flight gate. */
  private readonly inflight = new Map<string, Promise<RomMetadata | null>>();

  constructor(
    private readonly rootDir: string,
    private readonly openVgdb: OpenVGDBService,
    private readonly thumbnails: LibretroThumbnailsFetcher,
    private readonly screenScraper: ScreenScraperService | null,
    options: MetadataServiceOptions = {},
  ) {
    this.noMatchTtlMs = options.noMatchTtlMs ?? NO_MATCH_TTL_MS;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? ((): void => {
      /* default: no log */
    });
  }

  /**
   * Returns metadata for a hash, querying the source-priority chain.
   *
   * Cache hit → immediate return. Sentinel hit (within TTL) → null
   * without re-querying. Cold miss / stale sentinel → SS first
   * (when hint supplied + service available), OpenVGDB fallback,
   * sentinel write on neither.
   *
   * `hint` is reserved for future name-search; ignored today.
   * `screenScraperHint` carries the multi-hash query data; supply
   * it when SS access is desired (the orchestrator threads it in
   * from HashService output).
   */
  async getMetadata(
    hash: string,
    hint: MetadataHint = {},
    screenScraperHint?: ScreenScraperHint,
  ): Promise<RomMetadata | null> {
    void hint;
    const inflight = this.inflight.get(hash);
    if (inflight !== undefined) return inflight;

    const promise = this.doGet(hash, screenScraperHint).finally(() => {
      this.inflight.delete(hash);
    });
    this.inflight.set(hash, promise);
    return promise;
  }

  /**
   * Drop one hash from the cache. The next `getMetadata` call will
   * re-query the upstream chain.
   */
  async invalidate(hash: string): Promise<void> {
    const path = this.cachePath(hash);
    try {
      await fs.unlink(path);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  /** Wipe all metadata cache. Image cache is owned separately. */
  async clearAll(): Promise<void> {
    try {
      await fs.rm(join(this.rootDir, 'by-hash'), {
        recursive: true,
        force: true,
      });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async doGet(
    hash: string,
    ssHint: ScreenScraperHint | undefined,
  ): Promise<RomMetadata | null> {
    const ssAvailable = this.canQueryScreenScraper(ssHint);
    const cached = await this.readCache(hash);
    if (cached !== null && !this.shouldRefetchCached(cached, ssAvailable)) {
      return cached.source === 'none' ? null : cached;
    }

    // Source priority 1: ScreenScraper.
    if (this.screenScraper !== null && ssHint !== undefined) {
      const status = this.screenScraper.getStatus();
      if (status === 'available') {
        const ssResult = await this.tryScreenScraper(hash, ssHint);
        if (ssResult !== null) {
          await this.writeCache(hash, ssResult);
          return ssResult;
        }
        // SS returned null (legitimate no-match OR a transient
        // failure that latched the service). Fall through to
        // OpenVGDB — same outcome path as the SS-unavailable case.
      }
      // status is 'unavailable' / 'rate-limited' / 'quota-exceeded' →
      // skip SS silently and let OpenVGDB try.
    }

    // Source priority 2: OpenVGDB + libretro thumbnails.
    const fromDb = await this.openVgdb.getMetadataByHash(hash);
    if (fromDb !== null) {
      const composed = this.composeFromOpenVgdb(hash, fromDb);
      await this.writeCache(hash, composed);
      return composed;
    }

    // Both sources missed — sentinel.
    const sentinel = this.buildSentinel(hash);
    await this.writeCache(hash, sentinel);
    return null;
  }

  /**
   * Run a ScreenScraper lookup and map the result to RomMetadata.
   * Catches `ScreenScraperAuthError` so the orchestrator's path
   * doesn't throw — SS marks itself unavailable internally; we just
   * log once and fall through.
   */
  private async tryScreenScraper(
    hash: string,
    ssHint: ScreenScraperHint,
  ): Promise<RomMetadata | null> {
    if (this.screenScraper === null) return null;
    const query: ScreenScraperLookupQuery = {
      systemId: ssHint.systemId,
      md5: ssHint.md5,
      sha1: ssHint.sha1,
      crc32: ssHint.crc32,
      romName: ssHint.romName,
      romSize: ssHint.romSize,
    };
    let game: ScreenScraperGame | null;
    try {
      game = await this.screenScraper.lookup(query);
    } catch (err) {
      if (err instanceof ScreenScraperAuthError) {
        this.logger(
          `[MetadataService] ScreenScraper auth failed (HTTP ${String(err.status)}); falling through to OpenVGDB for the rest of the session.`,
        );
        return null;
      }
      throw err;
    }
    if (game === null) return null;
    return this.composeFromScreenScraper(hash, game, ssHint.systemName ?? '');
  }

  /**
   * Compose RomMetadata from a ScreenScraper hit. SS provides the
   * fullest set of fields — we use them directly for name, art, and
   * the SS-only extras (`players`, `rating`, `releaseDate`).
   *
   * SS art is hosted on the SS CDN; the renderer will hit it through
   * the existing ImageCache so the file ends up local same as
   * libretro-sourced art does.
   */
  private composeFromScreenScraper(
    hash: string,
    game: ScreenScraperGame,
    systemName: string,
  ): RomMetadata {
    return {
      version: ROM_METADATA_SCHEMA_VERSION,
      hash,
      name: game.name,
      // Round 3: SS's jeuInfos response omits a system name, so we
      // use the OpenVGDB-shaped name the SystemResolver supplied (the
      // same string `composeFromOpenVgdb` writes for that core). Empty
      // string when no resolver hint reached us — the renderer treats
      // it like any other empty field.
      system: systemName,
      year: parseYearFromDate(game.releaseDate),
      publisher: game.publisher,
      developer: game.developer,
      genre: game.genres.length > 0 ? game.genres.join(', ') : null,
      description: game.description,
      players: game.players,
      rating: game.rating,
      releaseDate: game.releaseDate,
      boxArtUrl: game.boxArtUrl,
      titleScreenUrl: game.extra.titleScreenUrl,
      screenshotUrl: game.extra.snapUrl,
      source: 'screenscraper',
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  /**
   * Compose RomMetadata from an OpenVGDB hit + libretro thumbnail
   * URLs. Same shape PR #15 round 9 produced; the SS-only fields
   * (`players`, `rating`, `releaseDate`) stay null.
   */
  private composeFromOpenVgdb(
    hash: string,
    db: OpenVGDBMetadata,
  ): RomMetadata {
    const fileBase = db.romBaseName ?? db.name;
    const boxArt = this.thumbnails.getBoxArtUrl(db.system, fileBase);
    const title = this.thumbnails.getTitleScreenUrl(db.system, fileBase);
    const snap = this.thumbnails.getScreenshotUrl(db.system, fileBase);
    return {
      version: ROM_METADATA_SCHEMA_VERSION,
      hash,
      name: db.name,
      system: db.system,
      year: db.year,
      publisher: db.publisher,
      developer: db.developer,
      genre: db.genre,
      description: db.description,
      players: null,
      rating: null,
      releaseDate: null,
      boxArtUrl: boxArt,
      titleScreenUrl: title,
      screenshotUrl: snap,
      source: 'openvgdb',
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private buildSentinel(hash: string): RomMetadata {
    return {
      version: ROM_METADATA_SCHEMA_VERSION,
      hash,
      name: '(no match)',
      system: '',
      year: null,
      publisher: null,
      developer: null,
      genre: null,
      description: null,
      players: null,
      rating: null,
      releaseDate: null,
      boxArtUrl: null,
      titleScreenUrl: null,
      screenshotUrl: null,
      source: 'none',
      fetchedAt: new Date(this.now()).toISOString(),
    };
  }

  private isStaleSentinel(meta: RomMetadata): boolean {
    if (meta.source !== 'none') return false;
    const fetchedAt = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(fetchedAt)) return true;
    return this.now() - fetchedAt > this.noMatchTtlMs;
  }

  /**
   * True iff a ScreenScraper query would actually run right now —
   * service exists, status is `available`, AND the caller supplied
   * the hint data we need. No hint = no cred-bearing data to send,
   * even if the service is healthy.
   */
  private canQueryScreenScraper(
    ssHint: ScreenScraperHint | undefined,
  ): boolean {
    if (this.screenScraper === null) return false;
    if (ssHint === undefined) return false;
    return this.screenScraper.getStatus() === 'available';
  }

  /**
   * Round 3: a cached record from a lower-priority source should be
   * treated as a miss when a higher-priority source is currently
   * reachable. Priority: `'screenscraper' > 'openvgdb' > 'none'`.
   *
   * The four cases:
   *   - cached SS  → always a hit (highest priority — never downgrade
   *     to OpenVGDB even when SS becomes unavailable; we'd rather
   *     serve stable SS data than degrade with later libretro art).
   *   - cached OpenVGDB → re-fetch when SS is currently queryable,
   *     because we'd prefer SS's richer data on this call.
   *   - cached `'none'` sentinel → re-fetch when stale (existing 30-
   *     day TTL) OR when SS just became queryable (lets the user's
   *     newly-configured creds reach a previously-unmatched ROM
   *     without manually clearing the cache).
   *   - cached SS but service now unavailable → still hit (the
   *     screenscraper-first arm above guards on availability before
   *     issuing a request; with no SS available we'd fall through to
   *     OpenVGDB anyway, and degrading from SS data to OpenVGDB
   *     data on every read is worse than serving the SS data we have).
   */
  private shouldRefetchCached(
    cached: RomMetadata,
    ssAvailable: boolean,
  ): boolean {
    if (cached.source === 'screenscraper') return false;
    if (cached.source === 'openvgdb') {
      return ssAvailable;
    }
    // cached.source === 'none' (sentinel)
    if (this.isStaleSentinel(cached)) return true;
    return ssAvailable;
  }

  private async readCache(hash: string): Promise<RomMetadata | null> {
    const path = this.cachePath(hash);
    let raw: string;
    try {
      raw = await fs.readFile(path, 'utf-8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!isRomMetadata(parsed)) return null;
    return parsed;
  }

  private async writeCache(hash: string, meta: RomMetadata): Promise<void> {
    const path = this.cachePath(hash);
    await fs.mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmp, path);
  }

  private cachePath(hash: string): string {
    const shard = hash.slice(0, 2);
    return join(this.rootDir, 'by-hash', shard, `${hash}.json`);
  }
}

// ─── helpers ────────────────────────────────────────────────────────

function parseYearFromDate(text: string | null): number | null {
  if (text === null) return null;
  const m = /\b(\d{4})\b/.exec(text);
  if (m === null) return null;
  const y = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(y)) return null;
  if (y < 1970 || y > 2100) return null;
  return y;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isRomMetadata(v: unknown): v is RomMetadata {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === ROM_METADATA_SCHEMA_VERSION &&
    typeof o.hash === 'string' &&
    typeof o.name === 'string' &&
    typeof o.system === 'string' &&
    typeof o.fetchedAt === 'string' &&
    (o.source === 'screenscraper' ||
      o.source === 'openvgdb' ||
      o.source === 'none')
  );
}
