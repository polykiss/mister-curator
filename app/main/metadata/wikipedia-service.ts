import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { diagLog } from '@shared/diag-log';
import type { WikipediaSummary } from '@shared/preload-api';

const TTL_FRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TTL_NULL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days for cached nulls (404s)

/** Display-name overrides for systems whose Wikipedia title differs from the SS name. */
const TITLE_OVERRIDES: Record<string, string> = {
  'NES': 'Nintendo Entertainment System',
  'Nintendo Entertainment System': 'Nintendo Entertainment System',
  'Super Nintendo': 'Super Nintendo Entertainment System',
  'Super Nintendo Entertainment System': 'Super Nintendo Entertainment System',
  'Genesis': 'Sega Genesis',
  'Mega Drive': 'Sega Genesis',
  'Master System': 'Sega Master System',
  'Saturn': 'Sega Saturn',
  'Game Gear': 'Sega Game Gear',
  'Dreamcast': 'Dreamcast',
  'Game Boy': 'Game Boy',
  'Game Boy Advance': 'Game Boy Advance',
  'Nintendo 64': 'Nintendo 64',
  'GameCube': 'GameCube',
  'PlayStation': 'PlayStation (console)',
  'PlayStation 2': 'PlayStation 2',
  'PlayStation Portable': 'PlayStation Portable',
  'TurboGrafx-16': 'TurboGrafx-16',
  'PC Engine': 'TurboGrafx-16',
  'Neo Geo': 'Neo Geo (system)',
  'Atari 2600': 'Atari 2600',
  'Atari 7800': 'Atari 7800',
  'Atari Lynx': 'Atari Lynx',
  'Intellivision': 'Intellivision',
  'ColecoVision': 'ColecoVision',
  'Vectrex': 'Vectrex',
  'Sega 32X': 'Sega 32X',
};

interface DiskRecord {
  readonly fetchedAt: string;
  readonly summary: WikipediaSummary | null;
}

export class WikipediaService {
  private readonly cacheDir: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    rootDir: string;
    userAgent: string;
    fetch?: typeof fetch;
  }) {
    this.cacheDir = join(opts.rootDir, 'wikipedia');
    this.userAgent = opts.userAgent;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async ensureSummary(ssId: number, displayName: string): Promise<WikipediaSummary | null> {
    const cached = await this.readFromDisk(ssId);
    if (cached !== undefined) return cached;
    // fetchFromApi returns undefined for transient errors (network failure,
    // bad JSON, non-404 HTTP) — those must NOT be cached so the next request
    // retries. null means "404 / no article" and IS cached (short TTL).
    const fetched = await this.fetchFromApi(displayName);
    if (fetched !== undefined) await this.writeToDisk(ssId, fetched);
    return fetched ?? null;
  }

  // ─── internals ──────────────────────────────────────────────────────

  private cachePath(ssId: number): string {
    return join(this.cacheDir, `${String(ssId)}.json`);
  }

  private async readFromDisk(ssId: number): Promise<WikipediaSummary | null | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(this.cachePath(ssId), 'utf8');
    } catch {
      return undefined; // not cached
    }
    try {
      const record = JSON.parse(raw) as DiskRecord;
      const age = Date.now() - new Date(record.fetchedAt).getTime();
      const ttl = record.summary === null ? TTL_NULL_MS : TTL_FRESH_MS;
      if (age > ttl) return undefined; // stale
      return record.summary;
    } catch {
      return undefined;
    }
  }

  private async writeToDisk(ssId: number, summary: WikipediaSummary | null): Promise<void> {
    const record: DiskRecord = { fetchedAt: new Date().toISOString(), summary };
    const json = JSON.stringify(record, null, 2);
    const path = this.cachePath(ssId);
    const tmp = `${path}.tmp`;
    try {
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(tmp, json, 'utf8');
      await fs.rename(tmp, path);
    } catch (err) {
      diagLog('warn', 'meta', '✗', 'wikipedia-cache-write-failed', { ssId, err: String(err) });
      await fs.unlink(tmp).catch(() => { /* ignore */ });
    }
  }

  // Returns undefined for transient failures (network error, non-404 HTTP, bad JSON)
  // so the caller knows NOT to cache. Returns null for 404 (cache with short TTL).
  private async fetchFromApi(displayName: string): Promise<WikipediaSummary | null | undefined> {
    const title = TITLE_OVERRIDES[displayName] ?? displayName;
    const encoded = encodeURIComponent(title.replace(/ /g, '_'));
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encoded}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.userAgent },
      });
    } catch (err) {
      diagLog('warn', 'meta', '✗', 'wikipedia-fetch-error', { title, err: String(err) });
      return undefined; // transient — do not cache
    }
    if (res.status === 404) {
      diagLog('info', 'meta', '·', 'wikipedia-not-found', { title });
      return null; // definitive "no article" — cache with short TTL
    }
    if (!res.ok) {
      diagLog('warn', 'meta', '✗', 'wikipedia-http-error', { title, status: res.status });
      return undefined; // transient — do not cache
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      diagLog('warn', 'meta', '✗', 'wikipedia-parse-error', { title });
      return undefined; // transient — do not cache
    }
    if (body === null || typeof body !== 'object') return undefined;
    const b = body as Record<string, unknown>;
    const extract = typeof b['extract'] === 'string' ? b['extract'] : null;
    if (extract === null || extract.length === 0) return null;
    const thumb = b['thumbnail'];
    const thumbnailUrl =
      thumb !== null && typeof thumb === 'object' &&
      typeof (thumb as Record<string, unknown>)['source'] === 'string'
        ? String((thumb as Record<string, unknown>)['source'])
        : null;
    return { extract, thumbnailUrl };
  }
}
