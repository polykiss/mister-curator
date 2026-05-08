import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ScreenScraperClient } from '@app/main/metadata/clients/screenscraper-client';
import type { TheGamesDBClient } from '@app/main/metadata/clients/thegamesdb-client';
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
}

/**
 * Hash-keyed metadata pipeline. Owns the by-hash on-disk cache; calls
 * out to ScreenScraper first, falls back to TheGamesDB only on miss,
 * and writes a `source: 'none'` sentinel after both fail so we don't
 * re-query the upstreams every time the user opens the same ROM.
 *
 * Cache file layout:
 *   <rootDir>/by-hash/<hash[0:2]>/<hash>.json
 *
 * The 2-char shard mirrors ImageCache and prevents one giant directory
 * once a sizable library is hashed.
 *
 * TTL policy:
 *   - matched metadata (source: screenscraper / thegamesdb) never
 *     expires. The on-disk record is the canonical source of truth
 *     until the user explicitly clears the cache.
 *   - sentinels (source: 'none') expire after `noMatchTtlMs` (30
 *     days by default). Past that, the next call re-tries both
 *     upstreams in case coverage has improved.
 *
 * Concurrency: per-hash in-flight gate so two `getMetadata(h)` calls
 * issued in parallel don't double-hit the upstream.
 */
export class MetadataService {
  private readonly noMatchTtlMs: number;
  private readonly now: () => number;
  /** Per-hash in-flight gate. */
  private readonly inflight = new Map<string, Promise<RomMetadata | null>>();

  constructor(
    private readonly rootDir: string,
    private readonly screenScraper: ScreenScraperClient,
    private readonly theGamesDb: TheGamesDBClient,
    options: MetadataServiceOptions = {},
  ) {
    this.noMatchTtlMs = options.noMatchTtlMs ?? NO_MATCH_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns metadata for a hash. Cache hit → immediate. Sentinel hit
   * (within TTL) → null without re-fetching. Cold miss / stale
   * sentinel → ScreenScraper, then TheGamesDB on no-match. Writes
   * the result (including `source: 'none'` sentinel) to disk.
   */
  async getMetadata(
    hash: string,
    hint: MetadataHint = {},
  ): Promise<RomMetadata | null> {
    const inflight = this.inflight.get(hash);
    if (inflight !== undefined) return inflight;

    const promise = this.doGet(hash, hint).finally(() => {
      this.inflight.delete(hash);
    });
    this.inflight.set(hash, promise);
    return promise;
  }

  /**
   * Drop one hash from the cache. The next `getMetadata` call will
   * re-fetch from the upstream services.
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
    hint: MetadataHint,
  ): Promise<RomMetadata | null> {
    const cached = await this.readCache(hash);
    if (cached !== null && !this.isStaleSentinel(cached)) {
      return cached.source === 'none' ? null : cached;
    }

    const fromScreenScraper = await this.screenScraper.getByMd5(hash, hint);
    if (fromScreenScraper !== null) {
      await this.writeCache(hash, fromScreenScraper);
      return fromScreenScraper;
    }

    const fromTheGamesDb = await this.theGamesDb.getByHint(hash, hint);
    if (fromTheGamesDb !== null) {
      await this.writeCache(hash, fromTheGamesDb);
      return fromTheGamesDb;
    }

    // Both upstreams missed. Write the sentinel so we don't keep
    // re-querying for this hash until the TTL expires.
    const sentinel = this.buildSentinel(hash);
    await this.writeCache(hash, sentinel);
    return null;
  }

  private buildSentinel(hash: string): RomMetadata {
    return {
      version: ROM_METADATA_SCHEMA_VERSION,
      hash,
      name: '(no match)',
      year: null,
      publisher: null,
      developer: null,
      genre: null,
      players: null,
      criticScore: null,
      ageRating: null,
      description: null,
      boxArtUrl: null,
      screenshotUrls: [],
      titleScreenUrl: null,
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

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function isRomMetadata(v: unknown): v is RomMetadata {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    o.version === 1 &&
    typeof o.hash === 'string' &&
    typeof o.name === 'string' &&
    typeof o.fetchedAt === 'string' &&
    (o.source === 'screenscraper' ||
      o.source === 'thegamesdb' ||
      o.source === 'none')
  );
}
