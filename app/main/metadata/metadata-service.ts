import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { extractNameHints } from '@app/main/metadata/filename-hint';
import type { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import { AUTO_BIND_THRESHOLD, scoreMatch } from '@app/main/metadata/name-match';
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
import { diagLog } from '@shared/diag-log';
import {
  NO_MATCH_TTL_MS,
  ROM_METADATA_SCHEMA_VERSION,
  SENTINEL_AUTHORITATIVE_TTL_MS,
  type MetadataHint,
  type RomMetadata,
} from '@shared/metadata-types';

/**
 * Round 9 (PR #20) — within-session SS-attempt dedup window. After
 * a SS lookup fires for a given hash, subsequent lookups for the
 * same hash within this window skip the SS network call and serve
 * from disk. Defends against tight prefetch loops where the cache
 * priority logic correctly says "refetch from SS" but the user
 * triggers many prefetches in succession (folder-classification
 * toggle, rapid core-switching). 60s is short enough to retry on
 * any meaningful state change but long enough to break the loop.
 */
const SS_ATTEMPT_DEDUP_MS = 60_000;

export interface MetadataServiceOptions {
  /** Test seam — defaults to `Date.now`. */
  readonly now?: () => number;
  /** Backstop expiry for `source: 'none'` sentinels (default 30 days). */
  readonly noMatchTtlMs?: number;
  /**
   * Authoritative TTL for sentinels written when SS was available
   * (default 7 days — see `SENTINEL_AUTHORITATIVE_TTL_MS`).
   */
  readonly authoritativeSentinelTtlMs?: number;
  /**
   * SS-attempt session dedup window (default 60s). Test seam.
   */
  readonly ssAttemptDedupMs?: number;
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
 * systemeid). Round 4 dropped `systemName` from this hint — the SS
 * response itself carries the canonical system name via
 * `response.jeu.systeme.nom`, so we read it there instead of
 * threading a coreId-derived value.
 */
export interface ScreenScraperHint {
  readonly systemId: number;
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
  private readonly authoritativeSentinelTtlMs: number;
  private readonly ssAttemptDedupMs: number;
  private readonly now: () => number;
  private readonly logger: (message: string) => void;
  /** Per-hash in-flight gate. */
  private readonly inflight = new Map<string, Promise<RomMetadata | null>>();
  /**
   * Round 9 — within-process SS-attempt timestamps. Defends against
   * the prefetch-loop scenario where a hash's authoritative-miss
   * cache could in theory be re-asked of SS within seconds (e.g.
   * legacy v4 records, or future logic changes). Reset on process
   * restart; not persisted to disk.
   */
  private readonly lastSsAttemptByHash = new Map<string, number>();

  constructor(
    private readonly rootDir: string,
    private readonly openVgdb: OpenVGDBService,
    private readonly thumbnails: LibretroThumbnailsFetcher,
    private readonly screenScraper: ScreenScraperService | null,
    options: MetadataServiceOptions = {},
  ) {
    this.noMatchTtlMs = options.noMatchTtlMs ?? NO_MATCH_TTL_MS;
    this.authoritativeSentinelTtlMs =
      options.authoritativeSentinelTtlMs ?? SENTINEL_AUTHORITATIVE_TTL_MS;
    this.ssAttemptDedupMs = options.ssAttemptDedupMs ?? SS_ATTEMPT_DEDUP_MS;
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
    const inflight = this.inflight.get(hash);
    if (inflight !== undefined) return inflight;

    const promise = this.doGet(hash, screenScraperHint, hint).finally(() => {
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
    hint: MetadataHint,
  ): Promise<RomMetadata | null> {
    const ssAvailable = this.canQueryScreenScraper(ssHint);
    const cached = await this.readCache(hash);
    diagLog('info', 'meta', '·', 'metadata-cache', {
      hash: hash.slice(0, 12),
      hit: cached !== null ? 1 : 0,
      source: cached?.source,
    });
    const decision =
      cached !== null
        ? this.decideForCached(cached, ssAvailable)
        : null;
    if (cached !== null && decision !== null && !decision.refetch) {
      diagLog('info', 'meta', '·', 'metadata-decision', {
        hash: hash.slice(0, 12),
        action: 'use-cache',
        source: cached.source,
        reason: decision.reason,
      });
      return cached.source === 'none' ? null : cached;
    }
    if (cached !== null && decision !== null) {
      diagLog('info', 'meta', '·', 'metadata-decision', {
        hash: hash.slice(0, 12),
        action: 'refetch',
        reason: decision.reason,
        cachedSource: cached.source,
      });
    } else {
      diagLog('info', 'meta', '·', 'metadata-decision', {
        hash: hash.slice(0, 12),
        action: 'fetch',
        reason: 'cold-cache',
        ssAvailable: ssAvailable ? 1 : 0,
      });
    }

    // Source priority 1: ScreenScraper.
    if (this.screenScraper !== null && ssHint !== undefined) {
      const status = this.screenScraper.getStatus();
      diagLog('info', 'meta', '·', 'ss-attempt', {
        hash: hash.slice(0, 12),
        status,
      });
      if (status === 'available') {
        const ssResult = await this.tryScreenScraper(hash, ssHint);
        if (ssResult !== null) {
          diagLog('info', 'meta', '·', 'ss-result', {
            hash: hash.slice(0, 12),
            outcome: 'hit',
          });
          await this.writeCache(hash, ssResult);
          return ssResult;
        }
        diagLog('info', 'meta', '·', 'ss-result', {
          hash: hash.slice(0, 12),
          outcome: 'miss-or-fail',
        });
        // SS returned null (legitimate no-match OR a transient
        // failure that latched the service). Fall through to
        // OpenVGDB — same outcome path as the SS-unavailable case.
      }
      // status is 'unavailable' / 'rate-limited' / 'quota-exceeded' →
      // skip SS silently and let OpenVGDB try.
    } else {
      diagLog('info', 'meta', '·', 'ss-skip', {
        hash: hash.slice(0, 12),
        reason:
          this.screenScraper === null
            ? 'no-service'
            : 'no-hint',
      });
    }

    // Source priority 2: OpenVGDB + libretro thumbnails.
    const fromDb = await this.openVgdb.getMetadataByHash(hash);
    diagLog('info', 'meta', '·', 'openvgdb-result', {
      hash: hash.slice(0, 12),
      outcome: fromDb !== null ? 'hit' : 'miss',
    });
    if (fromDb !== null) {
      const composed = this.composeFromOpenVgdb(hash, fromDb);
      await this.writeCache(hash, composed);
      return composed;
    }

    // PR-D1 (PR #27) — Source priority 3: ScreenScraper name-search
    // fallback. Both hash sources missed; if we have name hints
    // (filename / parentFolder) AND a system id, try jeuRecherche
    // for each hint in priority order. Bind the first high-
    // confidence (≥ AUTO_BIND_THRESHOLD) match. Saves an SS call
    // per remaining hint when one hits.
    if (
      this.screenScraper !== null &&
      ssHint !== undefined &&
      this.screenScraper.getStatus() === 'available' &&
      hint.filename !== undefined
    ) {
      const nameSearchHit = await this.tryNameSearch(
        hash,
        ssHint.systemId,
        hint,
      );
      if (nameSearchHit !== null) {
        await this.writeCache(hash, nameSearchHit);
        return nameSearchHit;
      }
    }

    // All sources missed — sentinel. Round 9 records the ssAvailable
    // bit at write-time so the next read can distinguish "definitive
    // SS no-match" (authoritative TTL) from "we couldn't even ask SS"
    // (refetch on next opportunity).
    diagLog('info', 'meta', '·', 'metadata-decision', {
      hash: hash.slice(0, 12),
      action: 'write-sentinel',
      reason: 'all-sources-miss',
      ssAvailableAtWrite: ssAvailable ? 1 : 0,
    });
    const sentinel = this.buildSentinel(hash, ssAvailable);
    await this.writeCache(hash, sentinel);
    return null;
  }

  /**
   * PR-D1 (PR #27) — name-search fallback executor. Extract hints
   * from filename + parentFolder, try each in priority order, score
   * the top candidate, bind if confidence ≥ AUTO_BIND_THRESHOLD.
   *
   * Short-circuits on the first high-confidence match so we don't
   * burn rate-limit budget on a stem hint when the parent-folder
   * already won. Below-threshold candidates are logged for diag
   * coverage but ignored — better to leave the row blank than to
   * bind to the wrong game (PR-D2 will surface manual-override).
   */
  private async tryNameSearch(
    hash: string,
    systemId: number,
    hint: MetadataHint,
  ): Promise<RomMetadata | null> {
    if (this.screenScraper === null) return null;
    if (hint.filename === undefined) return null;
    const hints = extractNameHints({
      filename: hint.filename,
      parentFolder: hint.parentFolder,
    });
    if (hints.length === 0) return null;
    for (const h of hints) {
      let candidates: readonly ScreenScraperGame[];
      try {
        candidates = await this.screenScraper.searchByName({
          systemId,
          searchTerm: h.value,
        });
      } catch (err) {
        if (err instanceof ScreenScraperAuthError) {
          // Auth latched mid-search; SS won't recover this session.
          // Stop trying further hints and let the sentinel write.
          this.logger(
            `[MetadataService] ScreenScraper auth failed during name-search; aborting fallback.`,
          );
          return null;
        }
        throw err;
      }
      if (candidates.length === 0) {
        diagLog('info', 'meta', '·', 'ss-name-search', {
          hash: hash.slice(0, 12),
          source: h.source,
          term: h.value,
          outcome: 'no-candidates',
        });
        continue;
      }
      const top = candidates[0]!;
      const score = scoreMatch(h.value, top.name);
      diagLog('info', 'meta', '·', 'ss-name-search', {
        hash: hash.slice(0, 12),
        source: h.source,
        term: h.value,
        topName: top.name,
        score,
        outcome: score >= AUTO_BIND_THRESHOLD ? 'bind' : 'low-confidence',
      });
      if (score >= AUTO_BIND_THRESHOLD) {
        return this.composeFromScreenScraperNameSearch(hash, top);
      }
      // Below threshold — try the next hint. The candidate IS in
      // SS's database, but the rank-1 result didn't match the search
      // term well enough to auto-bind; continue rather than commit.
    }
    return null;
  }

  /**
   * PR-D1 (PR #27) — compose a RomMetadata record from a name-search
   * hit. Same field shape as `composeFromScreenScraper`, but the
   * `source` field flips to `'screenscraper-name-search'` so the
   * cache audit + future UI can distinguish hash-confirmed records
   * from inferred ones.
   */
  private composeFromScreenScraperNameSearch(
    hash: string,
    game: ScreenScraperGame,
  ): RomMetadata {
    const base = this.composeFromScreenScraper(hash, game);
    return { ...base, source: 'screenscraper-name-search' };
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
    // Round 9 — within-session SS-attempt dedup. If we asked SS
    // about this hash within the dedup window already, skip the
    // network call and return null (caller falls through to
    // OpenVGDB or the cached sentinel). Defends against tight
    // prefetch loops that bypass the disk cache layer.
    const lastAttempt = this.lastSsAttemptByHash.get(hash);
    if (
      lastAttempt !== undefined &&
      this.now() - lastAttempt < this.ssAttemptDedupMs
    ) {
      diagLog('info', 'meta', '·', 'ss-attempt-deduped', {
        hash: hash.slice(0, 12),
        ageMs: this.now() - lastAttempt,
        windowMs: this.ssAttemptDedupMs,
      });
      return null;
    }
    this.lastSsAttemptByHash.set(hash, this.now());
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
    return this.composeFromScreenScraper(hash, game);
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
  ): RomMetadata {
    return {
      version: ROM_METADATA_SCHEMA_VERSION,
      hash,
      name: game.name,
      // Round 4: SS's canonical system label comes straight from
      // `response.jeu.systeme.nom` (parsed into `game.system`). Empty
      // string only when SS omits the field — the renderer treats
      // that like any other empty field.
      system: game.system ?? '',
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

  private buildSentinel(hash: string, ssAvailableAtWrite: boolean): RomMetadata {
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
      ssAvailableAtWrite,
    };
  }

  /**
   * Age of a sentinel in ms, or `null` for non-sentinel records or
   * unparseable timestamps. `null` is treated as "infinitely old"
   * by the callers (refetch).
   */
  private sentinelAgeMs(meta: RomMetadata): number | null {
    if (meta.source !== 'none') return null;
    const fetchedAt = Date.parse(meta.fetchedAt);
    if (!Number.isFinite(fetchedAt)) return null;
    return this.now() - fetchedAt;
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
   * Cache-priority decision. Round 9 inverted the sentinel handling
   * from rounds 3–8.
   *
   * Non-sentinel sources:
   *   - cached SS         → never refetch (highest priority).
   *   - cached OpenVGDB   → refetch iff SS is currently queryable
   *                         (upgrade path).
   *
   * Sentinels (`source === 'none'`) split on
   * `ssAvailableAtWrite`:
   *   - `true` (authoritative — SS was queried, returned no match)
   *     → use cache for `authoritativeSentinelTtlMs` (default 7
   *     days), then refetch once. Prevents the round-9 "boot.rom
   *     loop" where every prefetch re-asked SS for a hash SS had
   *     definitively said it didn't know.
   *   - `false` (poisoned — SS was unavailable at write) → refetch
   *     iff SS is currently queryable. With no SS, fall through to
   *     the `noMatchTtlMs` backstop (default 30 days) so a
   *     forever-credless setup doesn't pile up forever-stale
   *     sentinels.
   *   - `undefined` (legacy v4 record, pre-round-9) → treated as
   *     poisoned. First-read after upgrade will refetch when SS is
   *     available, and the rewrite carries the new bit forward.
   *
   * Returns `{ refetch, reason }` so the caller can log the
   * decision without re-evaluating it.
   */
  private decideForCached(
    cached: RomMetadata,
    ssAvailable: boolean,
  ): { readonly refetch: boolean; readonly reason: string } {
    if (cached.source === 'screenscraper') {
      return { refetch: false, reason: 'cached-screenscraper' };
    }
    if (cached.source === 'screenscraper-name-search') {
      // PR-D1 (PR #27): name-search hits are cached the same as
      // hash hits. Re-asking SS for the same hash is wasteful when
      // we already have a high-confidence binding. PR-D2's manual
      // override path is the documented way to revisit a binding.
      return { refetch: false, reason: 'cached-screenscraper-name-search' };
    }
    if (cached.source === 'openvgdb') {
      return ssAvailable
        ? { refetch: true, reason: 'cache-upgrade-ss-available' }
        : { refetch: false, reason: 'cached-openvgdb-no-ss' };
    }
    // cached.source === 'none' — sentinel.
    const age = this.sentinelAgeMs(cached);
    const authoritative = cached.ssAvailableAtWrite === true;
    if (authoritative) {
      if (age === null || age > this.authoritativeSentinelTtlMs) {
        return { refetch: true, reason: 'sentinel-authoritative-stale' };
      }
      return { refetch: false, reason: 'cached-ss-miss-authoritative' };
    }
    // Poisoned (false) or legacy (undefined) — refetch when SS
    // becomes available, otherwise keep until the 30-day backstop.
    if (ssAvailable) {
      return { refetch: true, reason: 'sentinel-poisoned-refetch' };
    }
    if (age === null || age > this.noMatchTtlMs) {
      return { refetch: true, reason: 'sentinel-poisoned-stale-30d' };
    }
    return { refetch: false, reason: 'sentinel-poisoned-no-ss' };
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
      // PR-D1 (PR #27): name-search hits are valid cache entries.
      o.source === 'screenscraper-name-search' ||
      o.source === 'openvgdb' ||
      o.source === 'none')
  );
}
