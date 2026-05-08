import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import type {
  OpenVGDBMetadata,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
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
 * Hash-keyed metadata pipeline (PR #15 round 3 pivot).
 *
 * Composition:
 *   1. OpenVGDBService — local SQLite lookup, hash → name + facts.
 *   2. LibretroThumbnailsFetcher — turns the matched name + system
 *      into PNG URLs (box art / title / snap).
 *
 * Cache file layout (unchanged from rounds 1-2):
 *   <rootDir>/by-hash/<hash[0:2]>/<hash>.json
 *
 * The 2-char shard mirrors ImageCache and prevents one giant directory
 * once a sizable library is hashed.
 *
 * TTL policy:
 *   - matched metadata never expires. The OpenVGDB snapshot is
 *     immutable within a session; if we matched once, we'll match
 *     again. The user clears the cache via `clearAll`.
 *   - `'none'` sentinels expire after `noMatchTtlMs` (30 days). Past
 *     that, the next call re-tries — useful if the user has updated
 *     OpenVGDB to a newer snapshot in the interim.
 *
 * Concurrency: per-hash in-flight gate so two `getMetadata(h)` calls
 * issued in parallel don't double-hit OpenVGDB or double-write the
 * cache file.
 *
 * Schema-version note: cache files with a different
 * `ROM_METADATA_SCHEMA_VERSION` fail the parse guard and are treated
 * as a miss; the next call rewrites them in the current shape. No
 * migration step needed. Round 9 bumped v2 → v3 to evict
 * libretro-URL-encoding bugs cached during rounds 4–8.
 */
export class MetadataService {
  private readonly noMatchTtlMs: number;
  private readonly now: () => number;
  /** Per-hash in-flight gate. */
  private readonly inflight = new Map<string, Promise<RomMetadata | null>>();

  constructor(
    private readonly rootDir: string,
    private readonly openVgdb: OpenVGDBService,
    private readonly thumbnails: LibretroThumbnailsFetcher,
    options: MetadataServiceOptions = {},
  ) {
    this.noMatchTtlMs = options.noMatchTtlMs ?? NO_MATCH_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Returns metadata for a hash. Cache hit → immediate. Sentinel hit
   * (within TTL) → null without re-querying. Cold miss / stale
   * sentinel → OpenVGDB + libretro composition. Writes the result
   * (including `source: 'none'` sentinel) to disk.
   *
   * The `hint` is currently unused — OpenVGDB is hash-keyed so the
   * hash alone uniquely identifies the ROM. Reserved for future
   * name-search fallback.
   */
  async getMetadata(
    hash: string,
    hint: MetadataHint = {},
  ): Promise<RomMetadata | null> {
    void hint;
    const inflight = this.inflight.get(hash);
    if (inflight !== undefined) return inflight;

    const promise = this.doGet(hash).finally(() => {
      this.inflight.delete(hash);
    });
    this.inflight.set(hash, promise);
    return promise;
  }

  /**
   * Drop one hash from the cache. The next `getMetadata` call will
   * re-query the upstream.
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

  private async doGet(hash: string): Promise<RomMetadata | null> {
    const cached = await this.readCache(hash);
    if (cached !== null && !this.isStaleSentinel(cached)) {
      return cached.source === 'none' ? null : cached;
    }

    const fromDb = await this.openVgdb.getMetadataByHash(hash);
    if (fromDb !== null) {
      const composed = this.compose(hash, fromDb);
      await this.writeCache(hash, composed);
      return composed;
    }

    const sentinel = this.buildSentinel(hash);
    await this.writeCache(hash, sentinel);
    return null;
  }

  /**
   * Combine OpenVGDB facts with libretro thumbnail URLs. The
   * thumbnail URLs may be null when the system isn't in the libretro
   * map — that's fine; the renderer falls back to a placeholder.
   *
   * Round 8: thumbnail filenames key on `db.romBaseName` (the
   * No-Intro DAT-style basename, e.g. "Sonic The Hedgehog 2 (World)")
   * rather than `db.name` (the cleaner release title, e.g. "Sonic
   * The Hedgehog 2"). libretro-thumbnails filenames carry the region
   * annotation, so the title alone 404s. We fall back to `db.name`
   * only when OpenVGDB has no `romExtensionlessFileName` for the
   * row — better a probably-missing URL than no URL at all.
   */
  private compose(hash: string, db: OpenVGDBMetadata): RomMetadata {
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
    o.version === ROM_METADATA_SCHEMA_VERSION &&
    typeof o.hash === 'string' &&
    typeof o.name === 'string' &&
    typeof o.system === 'string' &&
    typeof o.fetchedAt === 'string' &&
    (o.source === 'openvgdb' || o.source === 'none')
  );
}
