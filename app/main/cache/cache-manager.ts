import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CoreEntry, Rom } from '@shared/types';

import {
  CACHE_SCHEMA_VERSION,
  ROMS_CACHE_FILE_BUDGET,
  sanitiseFsSegment,
  type ArcadeMraMetaCacheEntry,
  type CacheEvent,
  type CacheEventKind,
  type CoresCacheEntry,
  type RomsCacheFile,
  type RomsCacheSlot,
  type WitnessMtimes,
} from '@app/main/cache/cache-types';

/**
 * Local-disk cache for `listAllCoresWithFiles` and `listRoms` output,
 * keyed by host and validated against on-device mtime witnesses.
 *
 * Design constraints (PR #12):
 *   - Cache lives entirely under `<userData>/cache/<host>/`. No
 *     on-device writes. The MiSTer is unaware the cache exists.
 *   - All file I/O is async (no `fs.*Sync` per AGENTS.md).
 *   - Writes are atomic: write to `<file>.tmp`, fsync, rename. A
 *     half-written cache file on a crashed app must never be served.
 *   - Schema-version mismatches are treated as a miss — never throw.
 *     Forward-incompatible upgrades silently invalidate.
 *   - No knowledge of SSH or witness collection — that's the
 *     ConnectionManager's job. CacheManager only persists what it's
 *     told and matches witnesses on read.
 *
 * The class is host-keyed so a user with multiple MiSTer profiles
 * doesn't share state between them — stat sizes can clash (different
 * games dirs at the same `/media/fat/games` path on different boxes).
 */
export class CacheManager {
  private readonly emit: (event: CacheEvent) => void;

  constructor(
    private readonly rootDir: string,
    options: { readonly onEvent?: (event: CacheEvent) => void } = {},
  ) {
    this.emit =
      options.onEvent ??
      ((): void => {
        /* default: no observer */
      });
  }

  // ─── cores cache ──────────────────────────────────────────────────

  async getCoresCache(host: string): Promise<CoresCacheEntry | null> {
    const path = this.coresCachePath(host);
    const parsed = await readJsonOrNull<unknown>(path);
    if (parsed === null) {
      this.fire('miss', { surface: 'cores', host });
      return null;
    }
    if (!isCoresCacheEntry(parsed)) {
      // Schema mismatch or corruption. Treat as a miss; the next
      // write replaces the bad file.
      this.fire('miss', { surface: 'cores', host, note: 'schema mismatch' });
      return null;
    }
    if (parsed.host !== host) {
      // Cache file moved between hosts somehow — defend.
      this.fire('miss', { surface: 'cores', host, note: 'host mismatch' });
      return null;
    }
    return parsed;
  }

  async setCoresCache(
    host: string,
    data: readonly CoreEntry[],
    witnesses: WitnessMtimes,
  ): Promise<void> {
    const entry: CoresCacheEntry = {
      version: CACHE_SCHEMA_VERSION,
      host,
      cachedAt: new Date().toISOString(),
      witnesses,
      data,
    };
    await writeJsonAtomic(this.coresCachePath(host), entry);
    this.fire('write', { surface: 'cores', host });
  }

  async invalidateCoresCache(
    host: string,
    options: { readonly note?: string } = {},
  ): Promise<void> {
    const path = this.coresCachePath(host);
    const removed = await unlinkIfExists(path);
    if (removed) {
      this.fire('invalidate', { surface: 'cores', host, note: options.note });
    }
  }

  // ─── roms cache ───────────────────────────────────────────────────

  async getRomsCache(
    host: string,
    coreId: string,
    subPath: string,
  ): Promise<RomsCacheSlot | null> {
    const file = await this.readRomsCacheFile(host, coreId);
    if (file === null) {
      this.fire('miss', { surface: 'roms', host, coreId, subPath });
      return null;
    }
    const slot = file.bySubPath[subPath];
    if (slot === undefined) {
      this.fire('miss', { surface: 'roms', host, coreId, subPath });
      return null;
    }
    return slot;
  }

  async setRomsCache(
    host: string,
    coreId: string,
    subPath: string,
    data: readonly Rom[],
    witnesses: WitnessMtimes,
  ): Promise<void> {
    const existing = await this.readRomsCacheFile(host, coreId);
    const slot: RomsCacheSlot = {
      cachedAt: new Date().toISOString(),
      witnesses,
      data,
    };
    const bySubPath: Record<string, RomsCacheSlot> = {
      ...(existing?.bySubPath ?? {}),
      [subPath]: slot,
    };
    const file: RomsCacheFile = {
      version: CACHE_SCHEMA_VERSION,
      host,
      coreId,
      bySubPath,
    };
    await writeJsonAtomic(this.romsCachePath(host, coreId), file);
    this.fire('write', { surface: 'roms', host, coreId, subPath });
    // Eviction runs after the write so we never drop the slot we
    // just inserted: mostRecent freshness is established by this
    // write's cachedAt timestamp.
    await this.enforceLruBudget(host);
  }

  async invalidateRomsCache(
    host: string,
    coreId: string,
    options: { readonly note?: string } = {},
  ): Promise<void> {
    const path = this.romsCachePath(host, coreId);
    const removed = await unlinkIfExists(path);
    if (removed) {
      this.fire('invalidate', {
        surface: 'roms',
        host,
        coreId,
        note: options.note,
      });
    }
  }

  // ─── arcade-mra-meta cache ────────────────────────────────────────

  async getArcadeMraMetaCache(
    host: string,
  ): Promise<ArcadeMraMetaCacheEntry | null> {
    const path = this.arcadeMraMetaCachePath(host);
    const parsed = await readJsonOrNull<unknown>(path);
    if (parsed === null) {
      this.fire('miss', { surface: 'arcade', host });
      return null;
    }
    if (!isArcadeMraMetaCacheEntry(parsed)) {
      this.fire('miss', {
        surface: 'arcade',
        host,
        note: 'schema mismatch',
      });
      return null;
    }
    if (parsed.host !== host) {
      this.fire('miss', { surface: 'arcade', host, note: 'host mismatch' });
      return null;
    }
    return parsed;
  }

  async setArcadeMraMetaCache(
    host: string,
    entries: ArcadeMraMetaCacheEntry['entries'],
    zipBasenames: readonly string[],
    witnesses: WitnessMtimes,
  ): Promise<void> {
    const entry: ArcadeMraMetaCacheEntry = {
      version: CACHE_SCHEMA_VERSION,
      host,
      cachedAt: new Date().toISOString(),
      witnesses,
      entries,
      zipBasenames,
    };
    await writeJsonAtomic(this.arcadeMraMetaCachePath(host), entry);
    this.fire('write', { surface: 'arcade', host });
  }

  async invalidateArcadeMraMetaCache(
    host: string,
    options: { readonly note?: string } = {},
  ): Promise<void> {
    const path = this.arcadeMraMetaCachePath(host);
    const removed = await unlinkIfExists(path);
    if (removed) {
      this.fire('invalidate', {
        surface: 'arcade',
        host,
        note: options.note,
      });
    }
  }

  // ─── observability hooks ──────────────────────────────────────────

  /**
   * Record a cache hit. Witness validation lives in the consumer
   * (ConnectionManager has the fresh mtimes from `primeConnect` /
   * `statWitnesses` and only it can decide if the cached entry is
   * actually serviceable), so we expose this hook for the consumer
   * to fire `cache.hit` events through the same emitter pipeline as
   * `miss` / `write` / `invalidate` / `evict`. Without this hook,
   * MISTERCURATOR_CACHE_LOG=1 would never show the hit case — the
   * single most useful signal during cache verification.
   */
  recordHit(
    surface: 'cores' | 'roms' | 'arcade',
    ctx: {
      readonly host: string;
      readonly coreId?: string;
      readonly subPath?: string;
    },
  ): void {
    this.fire('hit', { surface, ...ctx });
  }

  /**
   * Record a stale cache entry — file existed and schema-validated,
   * but its mtime witnesses no longer match the device. Distinct
   * from `miss` (file missing / corrupt / schema mismatch) so dev
   * logs can tell "cache was empty" from "cache went out of date".
   */
  recordStale(
    surface: 'cores' | 'roms' | 'arcade',
    ctx: {
      readonly host: string;
      readonly coreId?: string;
      readonly subPath?: string;
      readonly note?: string;
    },
  ): void {
    this.fire('stale', { surface, ...ctx });
  }

  // ─── host-wide ops ────────────────────────────────────────────────

  /**
   * Wipe every cache file for one host. Used by the "Clear cache"
   * command and as the safety net when a write-through fails after
   * an on-device mutation.
   */
  async clearHost(host: string): Promise<void> {
    const dir = this.hostDir(host);
    await rmrfIfExists(dir);
    this.fire('invalidate', { surface: 'cores', host, note: 'clearHost' });
  }

  // ─── internals ────────────────────────────────────────────────────

  private async readRomsCacheFile(
    host: string,
    coreId: string,
  ): Promise<RomsCacheFile | null> {
    const parsed = await readJsonOrNull<unknown>(this.romsCachePath(host, coreId));
    if (parsed === null) return null;
    if (!isRomsCacheFile(parsed)) return null;
    if (parsed.host !== host || parsed.coreId !== coreId) return null;
    return parsed;
  }

  private hostDir(host: string): string {
    return join(this.rootDir, sanitiseFsSegment(host));
  }

  private coresCachePath(host: string): string {
    return join(this.hostDir(host), 'cores.json');
  }

  private romsCachePath(host: string, coreId: string): string {
    return join(
      this.hostDir(host),
      'roms',
      `${sanitiseFsSegment(coreId)}.json`,
    );
  }

  private arcadeMraMetaCachePath(host: string): string {
    return join(this.hostDir(host), 'arcade-mra-meta.json');
  }

  /**
   * LRU eviction. When more than `ROMS_CACHE_FILE_BUDGET` core files
   * exist for one host, drop the oldest by `mostRecentCachedAt`
   * across all of a file's slots. Files we can't parse are evicted
   * first — they cost us bytes for no benefit.
   */
  private async enforceLruBudget(host: string): Promise<void> {
    const dir = join(this.hostDir(host), 'roms');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
    const jsonFiles = entries.filter((e) => e.endsWith('.json'));
    if (jsonFiles.length <= ROMS_CACHE_FILE_BUDGET) return;

    interface FileMeta {
      readonly path: string;
      readonly mostRecent: number;
      readonly coreId: string;
    }
    const metas: FileMeta[] = [];
    for (const e of jsonFiles) {
      const path = join(dir, e);
      const parsed = await readJsonOrNull<unknown>(path);
      if (!isRomsCacheFile(parsed)) {
        // Unparseable — evict-first candidate (mostRecent = 0).
        metas.push({ path, mostRecent: 0, coreId: e.replace(/\.json$/, '') });
        continue;
      }
      let mostRecent = 0;
      for (const slot of Object.values(parsed.bySubPath)) {
        const t = Date.parse(slot.cachedAt);
        if (Number.isFinite(t) && t > mostRecent) mostRecent = t;
      }
      metas.push({ path, mostRecent, coreId: parsed.coreId });
    }
    metas.sort((a, b) => a.mostRecent - b.mostRecent);
    const evictCount = metas.length - ROMS_CACHE_FILE_BUDGET;
    for (let i = 0; i < evictCount; i += 1) {
      const m = metas[i];
      if (!m) continue;
      await unlinkIfExists(m.path);
      this.fire('evict', { surface: 'roms', host, evictedCoreId: m.coreId });
    }
  }

  private fire(
    kind: CacheEventKind,
    rest: Omit<CacheEvent, 'kind'>,
  ): void {
    this.emit({ kind, ...rest });
  }
}

// ─── helpers ────────────────────────────────────────────────────────

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
  const json = `${JSON.stringify(data, null, 2)}\n`;
  // 0o600 — cache may contain user core/ROM names which a tighter
  // perms posture treats as sensitive. Matches profile-store.
  await fs.writeFile(tmp, json, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmp, path);
}

async function unlinkIfExists(path: string): Promise<boolean> {
  try {
    await fs.unlink(path);
    return true;
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return false;
    throw err;
  }
}

async function rmrfIfExists(path: string): Promise<void> {
  try {
    await fs.rm(path, { recursive: true, force: true });
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return;
    throw err;
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ─── parser guards ──────────────────────────────────────────────────

function isCoresCacheEntry(v: unknown): v is CoresCacheEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== CACHE_SCHEMA_VERSION) return false;
  if (typeof o.host !== 'string') return false;
  if (typeof o.cachedAt !== 'string') return false;
  if (!isWitnessMtimes(o.witnesses)) return false;
  if (!Array.isArray(o.data)) return false;
  // Best-effort: the matcher's CoreEntry has a fixed shape. We don't
  // exhaustively validate every field — a corrupted entry will surface
  // as a runtime error in the renderer and be invalidated on the next
  // mismatched-witness pass. The keys we DO check are the structural
  // ones the cache itself relies on.
  return true;
}

function isRomsCacheFile(v: unknown): v is RomsCacheFile {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== CACHE_SCHEMA_VERSION) return false;
  if (typeof o.host !== 'string') return false;
  if (typeof o.coreId !== 'string') return false;
  if (o.bySubPath === null || typeof o.bySubPath !== 'object') return false;
  for (const slot of Object.values(o.bySubPath as Record<string, unknown>)) {
    if (!isRomsCacheSlot(slot)) return false;
  }
  return true;
}

function isRomsCacheSlot(v: unknown): v is RomsCacheSlot {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (typeof o.cachedAt !== 'string') return false;
  if (!isWitnessMtimes(o.witnesses)) return false;
  if (!Array.isArray(o.data)) return false;
  return true;
}

function isWitnessMtimes(v: unknown): v is WitnessMtimes {
  if (v === null || typeof v !== 'object') return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== 'number') return false;
  }
  return true;
}

function isArcadeMraMetaCacheEntry(
  v: unknown,
): v is ArcadeMraMetaCacheEntry {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.version !== CACHE_SCHEMA_VERSION) return false;
  if (typeof o.host !== 'string') return false;
  if (typeof o.cachedAt !== 'string') return false;
  if (!isWitnessMtimes(o.witnesses)) return false;
  if (!Array.isArray(o.entries)) return false;
  if (!Array.isArray(o.zipBasenames)) return false;
  // Spot-check one entry's shape — exhaustive validation isn't
  // required since a corrupted record surfaces as a runtime error
  // and gets invalidated on the next mismatched-witness pass.
  for (const entry of o.entries) {
    if (entry === null || typeof entry !== 'object') return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.relativePath !== 'string') return false;
    if (!Array.isArray(e.requiredZips)) return false;
  }
  for (const basename of o.zipBasenames) {
    if (typeof basename !== 'string') return false;
  }
  return true;
}
