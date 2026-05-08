import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { createRequire } from 'node:module';

import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

/**
 * Round 3 of PR #15: hash → metadata via the OpenVGDB SQLite snapshot
 * (https://github.com/OpenVGDB/OpenVGDB). One ~50 MB file, downloaded
 * once on first use, queried locally with sql.js. No credentials, no
 * rate limit, no per-request network cost.
 *
 * The download is direct to a `.sqlite` file from a community mirror.
 * GitHub releases ship the database inside a zip; supporting that
 * mirror needs a zip-extraction dep we haven't added yet — the URL
 * list below has a `requiresUnzip` flag for entries that would need
 * one, and the service skips them for now.
 *
 * sql.js loads via WebAssembly. We pass `wasmBinary` directly (read
 * from node_modules) instead of relying on Emscripten's default
 * locate-file behavior — that pattern doesn't survive Electron's
 * asar packaging cleanly.
 */

const DEFAULT_DOWNLOAD_URLS: readonly DownloadCandidate[] = [
  {
    url: 'https://inds.nerd.net/editor/openvgdb.sqlite',
    requiresUnzip: false,
  },
  // Future: GitHub release ships a zip — needs an unzip dep we
  // haven't added. Track in PR #16+ if this mirror starts to lag.
  // {
  //   url: 'https://github.com/OpenVGDB/OpenVGDB/releases/download/v29/openvgdb.zip',
  //   requiresUnzip: true,
  // },
];

interface DownloadCandidate {
  readonly url: string;
  readonly requiresUnzip: boolean;
}

/** Streaming progress events emitted during `ensureDatabase`. */
export type OpenVGDBProgressEvent =
  | { readonly kind: 'started' }
  | {
      readonly kind: 'downloading';
      readonly bytesReceived: number;
      readonly bytesTotal: number | null;
    }
  | { readonly kind: 'ready'; readonly path: string }
  | { readonly kind: 'error'; readonly message: string };

export interface OpenVGDBMetadata {
  readonly md5: string;
  readonly name: string;
  readonly system: string;
  readonly year: number | null;
  readonly genre: string | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly description: string | null;
  readonly region: string | null;
  readonly source: 'openvgdb';
  readonly fetchedAt: string;
}

export interface OpenVGDBServiceOptions {
  /** Test seam — defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam — wall-clock source for `fetchedAt`. */
  readonly now?: () => number;
  /** Override the candidate URLs (used by tests). */
  readonly downloadUrls?: readonly DownloadCandidate[];
  /**
   * Override the path to the sql.js WASM binary. If unset, the
   * service resolves it via `require.resolve('sql.js/dist/sql-wasm.wasm')`.
   */
  readonly wasmBinaryPath?: string;
  /** Default 100. Test override. */
  readonly lruCapacity?: number;
}

const DB_FILENAME = 'openvgdb.sqlite';
const DEFAULT_LRU_CAPACITY = 100;

/**
 * The single SELECT we issue. LEFT JOINs keep the row even if RELEASES
 * or SYSTEMS is missing — OpenVGDB sometimes has ROMs without a
 * release record. COLLATE NOCASE shields against md5 hex case drift
 * (busybox emits lower; the table contains upper).
 */
const QUERY_BY_MD5 = `
  SELECT
    r.romHashMD5    AS md5,
    rel.releaseTitleName AS name,
    s.systemName    AS system,
    rel.releaseDate AS date,
    rel.releaseGenre AS genre,
    rel.releasePublisher AS publisher,
    rel.releaseDeveloper AS developer,
    rel.releaseDescription AS description,
    rel.releaseRegion AS region
  FROM ROMs r
  LEFT JOIN RELEASES rel ON r.romID = rel.romID
  LEFT JOIN SYSTEMS s    ON r.systemID = s.systemID
  WHERE r.romHashMD5 = ? COLLATE NOCASE
  LIMIT 1
`;

/**
 * Schema sniff: the three tables we read against. If the .sqlite file
 * downloaded into place is missing any of them we treat it as
 * corrupt, delete, and let the next call redownload.
 */
const REQUIRED_TABLES = ['ROMs', 'RELEASES', 'SYSTEMS'] as const;

export class OpenVGDBService {
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly downloadUrls: readonly DownloadCandidate[];
  private readonly wasmBinaryPath: string | null;
  private readonly lruCapacity: number;

  /** Lazily-loaded sql.js engine. Shared across all DB instances. */
  private sqlJsPromise: Promise<SqlJsStatic> | null = null;
  /** Open DB handle once the file is ready and validated. */
  private db: Database | null = null;
  /** In-flight `ensureDatabase` so concurrent callers share work. */
  private ensurePromise: Promise<void> | null = null;
  /** Recent-lookup cache so the same hash isn't re-queried per session. */
  private readonly lru = new Map<string, OpenVGDBMetadata | null>();
  /** Latched true after the first ready signal — short-circuits `ensure`. */
  private ready = false;

  constructor(
    private readonly rootDir: string,
    options: OpenVGDBServiceOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.nowImpl = options.now ?? Date.now;
    this.downloadUrls = options.downloadUrls ?? DEFAULT_DOWNLOAD_URLS;
    this.wasmBinaryPath = options.wasmBinaryPath ?? null;
    this.lruCapacity = options.lruCapacity ?? DEFAULT_LRU_CAPACITY;
  }

  /** Convenience: true once the DB has been opened successfully. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Make the DB usable. If a valid file already exists at the cache
   * path, just opens it. Otherwise downloads from the first usable
   * mirror, validates the schema, and opens. Concurrent callers
   * coalesce onto the same promise; failures clear the gate so the
   * next call retries.
   *
   * `onProgress` (when supplied) sees `started` once, then either:
   *   - 0+ `downloading` events as bytes accumulate
   *   - one `ready` event on success
   *   - one `error` event on failure
   *
   * Returns when the DB is open (or throws on error). Does not throw
   * on download failure — a failed download leaves `ready=false` and
   * subsequent `getMetadataByHash` calls return null.
   */
  async ensureDatabase(
    onProgress?: (event: OpenVGDBProgressEvent) => void,
  ): Promise<void> {
    if (this.ready) return;
    const inflight = this.ensurePromise;
    if (inflight !== null) return inflight;
    const promise = this.doEnsure(onProgress).finally(() => {
      this.ensurePromise = null;
    });
    this.ensurePromise = promise;
    return promise;
  }

  /**
   * Look up one ROM by md5. Returns null when the hash isn't in the
   * DB OR when the DB hasn't been ensured yet — the caller should
   * call `ensureDatabase` once before relying on this.
   */
  async getMetadataByHash(md5: string): Promise<OpenVGDBMetadata | null> {
    if (!this.ready || this.db === null) return null;
    const key = md5.toLowerCase();
    if (this.lru.has(key)) {
      // Re-insert to bump LRU recency.
      const cached = this.lru.get(key) ?? null;
      this.lru.delete(key);
      this.lru.set(key, cached);
      return cached;
    }
    const result = this.queryOne(this.db, key);
    this.recordInLru(key, result);
    return result;
  }

  /**
   * Wipe the on-disk DB and any in-memory state. Next `ensureDatabase`
   * will redownload. Used by the "Clear cache" command.
   */
  async clearDatabase(): Promise<void> {
    this.lru.clear();
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        /* swallow */
      }
      this.db = null;
    }
    this.ready = false;
    try {
      await fs.unlink(this.dbPath());
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return;
      throw err;
    }
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async doEnsure(
    onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  ): Promise<void> {
    const path = this.dbPath();
    onProgress?.({ kind: 'started' });

    // Fast path: file exists, sniff the schema, open. If schema check
    // fails, drop the file and redownload.
    let needsDownload = false;
    try {
      await fs.access(path);
    } catch {
      needsDownload = true;
    }

    if (!needsDownload) {
      const opened = await this.tryOpen(path);
      if (opened) {
        this.ready = true;
        onProgress?.({ kind: 'ready', path });
        return;
      }
      // Schema mismatch — discard and redownload.
      await fs
        .unlink(path)
        .catch(() => undefined);
      needsDownload = true;
    }

    if (needsDownload) {
      const downloaded = await this.download(path, onProgress);
      if (!downloaded) {
        onProgress?.({
          kind: 'error',
          message: 'All OpenVGDB mirrors failed; metadata lookup will return null.',
        });
        return;
      }
      const opened = await this.tryOpen(path);
      if (!opened) {
        onProgress?.({
          kind: 'error',
          message: 'Downloaded OpenVGDB file did not match the expected schema.',
        });
        await fs.unlink(path).catch(() => undefined);
        return;
      }
      this.ready = true;
      onProgress?.({ kind: 'ready', path });
    }
  }

  /**
   * Open the DB at `path`, sniff the schema, and stash the handle.
   * Returns true on success, false on schema mismatch (caller drops
   * the file and redownloads).
   */
  private async tryOpen(path: string): Promise<boolean> {
    const sql = await this.getSqlJs();
    const buffer = await fs.readFile(path);
    let db: Database;
    try {
      db = new sql.Database(new Uint8Array(buffer));
    } catch {
      return false;
    }
    if (!validateSchema(db)) {
      try {
        db.close();
      } catch {
        /* swallow */
      }
      return false;
    }
    if (this.db !== null) {
      try {
        this.db.close();
      } catch {
        /* swallow */
      }
    }
    this.db = db;
    return true;
  }

  /**
   * Walk the candidate URL list. The first one that yields a non-empty
   * 200 body wins; the bytes get atomically written to `path`. Skips
   * any candidate that needs unzipping (we don't ship a zip dep).
   */
  private async download(
    path: string,
    onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  ): Promise<boolean> {
    await fs.mkdir(dirname(path), { recursive: true });
    for (const candidate of this.downloadUrls) {
      if (candidate.requiresUnzip) continue;
      const ok = await this.downloadOne(candidate.url, path, onProgress);
      if (ok) return true;
    }
    return false;
  }

  private async downloadOne(
    url: string,
    path: string,
    onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  ): Promise<boolean> {
    let res: Response;
    try {
      res = await this.fetchImpl(url);
    } catch {
      return false;
    }
    if (!res.ok || res.body === null) return false;

    const totalHeader = res.headers.get('content-length');
    const total =
      totalHeader === null ? null : Number.parseInt(totalHeader, 10);
    const totalBytes = total !== null && Number.isFinite(total) ? total : null;

    const tmp = `${path}.tmp`;
    const handle = await fs.open(tmp, 'w', 0o600);
    let bytesReceived = 0;
    try {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value !== undefined) {
          await handle.write(value);
          bytesReceived += value.length;
          onProgress?.({
            kind: 'downloading',
            bytesReceived,
            bytesTotal: totalBytes,
          });
        }
      }
    } catch {
      await handle.close().catch(() => undefined);
      await fs.unlink(tmp).catch(() => undefined);
      return false;
    }
    await handle.close();
    if (bytesReceived === 0) {
      await fs.unlink(tmp).catch(() => undefined);
      return false;
    }
    await fs.rename(tmp, path);
    return true;
  }

  private queryOne(db: Database, md5: string): OpenVGDBMetadata | null {
    const stmt = db.prepare(QUERY_BY_MD5);
    try {
      stmt.bind([md5]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      const name = readString(row.name);
      const system = readString(row.system);
      if (name === null || system === null) return null;
      return {
        md5: readString(row.md5) ?? md5,
        name,
        system,
        year: parseYear(readString(row.date)),
        genre: readString(row.genre),
        publisher: readString(row.publisher),
        developer: readString(row.developer),
        description: readString(row.description),
        region: readString(row.region),
        source: 'openvgdb',
        fetchedAt: new Date(this.nowImpl()).toISOString(),
      };
    } finally {
      stmt.free();
    }
  }

  private recordInLru(key: string, value: OpenVGDBMetadata | null): void {
    if (this.lru.has(key)) this.lru.delete(key);
    this.lru.set(key, value);
    while (this.lru.size > this.lruCapacity) {
      const oldest = this.lru.keys().next().value;
      if (oldest === undefined) break;
      this.lru.delete(oldest);
    }
  }

  private async getSqlJs(): Promise<SqlJsStatic> {
    if (this.sqlJsPromise === null) {
      this.sqlJsPromise = this.loadSqlJs();
    }
    return this.sqlJsPromise;
  }

  private async loadSqlJs(): Promise<SqlJsStatic> {
    const wasmBinary = await this.loadWasmBinary();
    return initSqlJs({ wasmBinary });
  }

  private async loadWasmBinary(): Promise<ArrayBuffer> {
    const path = this.wasmBinaryPath ?? defaultWasmBinaryPath();
    const buf = await fs.readFile(path);
    // Buffer extends Uint8Array but its `buffer` may belong to Node's
    // pooled allocator and be larger than `byteLength`. Slice into a
    // fresh ArrayBuffer so the WASM init sees a clean view (and so
    // sql.js's `wasmBinary` type accepts it).
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }

  private dbPath(): string {
    return join(this.rootDir, DB_FILENAME);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

function defaultWasmBinaryPath(): string {
  // `createRequire` lets us `require.resolve('sql.js/dist/sql-wasm.wasm')`
  // even though this file is loaded via the bundler. Using
  // `import.meta.resolve` would be cleaner but isn't yet supported
  // in our Electron/Node baseline.
  const req = createRequire(__filename);
  return req.resolve('sql.js/dist/sql-wasm.wasm');
}

function validateSchema(db: Database): boolean {
  try {
    const stmt = db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    );
    try {
      for (const table of REQUIRED_TABLES) {
        stmt.reset();
        stmt.bind([table]);
        if (!stmt.step()) return false;
      }
      return true;
    } finally {
      stmt.free();
    }
  } catch {
    return false;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function parseYear(text: string | null): number | null {
  if (text === null) return null;
  const match = /\b(\d{4})\b/.exec(text);
  if (!match) return null;
  const y = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(y)) return null;
  if (y < 1970 || y > 2100) return null;
  return y;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
