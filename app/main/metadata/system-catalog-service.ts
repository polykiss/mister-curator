import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { diagLog } from '@shared/diag-log';
import type { SystemCatalogRescrapeResult } from '@shared/preload-api';

import type { ImageCache } from '@app/main/metadata/image-cache';
import { SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID } from '@app/main/metadata/screenscraper-system-map';
import type {
  ScreenScraperService,
  SystemCatalog,
  SystemCatalogEntry,
} from '@app/main/metadata/screenscraper-service';

/** Wire shape sent to the renderer over IPC. */
export interface SystemCatalogWireEntry {
  readonly id: number;
  readonly displayName: string;
  readonly logoUrl: string | null;
}

/** Disk-cache envelope written to `metadata/system-catalog.json`. */
interface CatalogDiskRecord {
  readonly fetchedAt: string;
  readonly systems: ReadonlyArray<{
    readonly id: number;
    readonly displayName: string;
    readonly logoUrl: string | null;
  }>;
}

export class SystemCatalogService {
  private catalog: SystemCatalog | null = null;

  constructor(
    private readonly scraper: ScreenScraperService,
    private readonly logoCache: ImageCache,
    private readonly catalogPath: string,
  ) {}

  /**
   * Load the catalog from the on-disk JSON cache (if present) or
   * fetch it from SS. Called on connect so the first render already
   * has display names available. Non-blocking on failure — a missing
   * catalog degrades to coreId fallback names.
   */
  async ensureCatalog(): Promise<void> {
    if (this.catalog !== null) return;
    const fromDisk = await this.loadFromDisk();
    if (fromDisk !== null) {
      this.catalog = fromDisk;
      diagLog('info', 'meta', '·', 'system-catalog-loaded-from-disk', {
        count: this.catalog.size,
      });
      return;
    }
    await this.fetchAndStore();
  }

  /**
   * Returns the catalog as a coreId-keyed map for the renderer.
   * Only the coreIds present in SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID
   * are included. Returns null when no catalog has been loaded yet.
   */
  getWireCatalog(): Record<string, SystemCatalogWireEntry> | null {
    if (this.catalog === null) return null;
    const result: Record<string, SystemCatalogWireEntry> = {};
    for (const [coreId, ssId] of SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID) {
      const entry = this.catalog.get(ssId);
      if (entry !== undefined) {
        result[coreId] = { id: entry.id, displayName: entry.displayName, logoUrl: entry.logoUrl };
      }
    }
    return result;
  }

  /**
   * fix/system-catalog-visibility-and-latch (#64) — force re-fetch.
   * Calls `resetAuthState()` first so a previous 403 / rate-limit on
   * the dedicated scraper instance doesn't block the retry.
   */
  async rescrapeSystemCatalog(): Promise<SystemCatalogRescrapeResult> {
    this.scraper.resetAuthState();
    return this.fetchAndStore();
  }

  /**
   * Return the bytes of a cached system logo. Fetches from the URL
   * and writes to the logo cache on first call. Returns null on
   * failure or when `url` is null/empty.
   */
  async getSystemLogoBytes(url: string | null): Promise<Uint8Array | null> {
    if (!url) return null;
    const path = await this.logoCache.fetch(url);
    if (path === null) return null;
    try {
      const buf = await fs.readFile(path);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch {
      return null;
    }
  }

  /**
   * Force re-fetch a single logo by clearing its cache entry and
   * re-fetching. Returns the new bytes, or null on failure.
   */
  async rescrapeSystemLogo(url: string | null): Promise<Uint8Array | null> {
    if (!url) return null;
    // Clear the stale file so logoCache.fetch goes to the network.
    const local = await this.logoCache.getLocal(url);
    if (local !== null) {
      await fs.unlink(local).catch(() => { /* already gone */ });
    }
    return this.getSystemLogoBytes(url);
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async fetchAndStore(): Promise<SystemCatalogRescrapeResult> {
    const fresh = await this.scraper.fetchSystemCatalog();
    if (fresh === null) {
      const serviceStatus = this.scraper.getStatus();
      diagLog('warn', 'meta', '✗', 'system-catalog-fetch-failed', { serviceStatus });
      return { success: false, status: serviceStatus };
    }
    this.catalog = fresh;
    diagLog('info', 'meta', '·', 'system-catalog-fetched', { count: fresh.size });
    await this.writeToDisk(fresh);
    return { success: true, status: 'ok' };
  }

  private async loadFromDisk(): Promise<SystemCatalog | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.catalogPath, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        !Array.isArray((parsed as CatalogDiskRecord).systems)
      ) {
        return null;
      }
      const record = parsed as CatalogDiskRecord;
      const map = new Map<number, SystemCatalogEntry>();
      for (const s of record.systems) {
        if (typeof s.id === 'number' && typeof s.displayName === 'string') {
          map.set(s.id, { id: s.id, displayName: s.displayName, logoUrl: s.logoUrl ?? null });
        }
      }
      return map.size > 0 ? map : null;
    } catch {
      return null;
    }
  }

  private async writeToDisk(catalog: SystemCatalog): Promise<void> {
    const record: CatalogDiskRecord = {
      fetchedAt: new Date().toISOString(),
      systems: [...catalog.values()].map((e) => ({
        id: e.id,
        displayName: e.displayName,
        logoUrl: e.logoUrl,
      })),
    };
    const json = JSON.stringify(record, null, 2);
    try {
      await fs.mkdir(dirname(this.catalogPath), { recursive: true });
      const tmp = `${this.catalogPath}.tmp`;
      await fs.writeFile(tmp, json, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.catalogPath);
    } catch (err) {
      diagLog('warn', 'meta', '✗', 'system-catalog-write-failed', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
