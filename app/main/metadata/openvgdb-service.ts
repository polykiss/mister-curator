import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import JSZip from 'jszip';
import initSqlJs, { type Database, type SqlJsStatic } from 'sql.js';

/**
 * Round 4 of PR #15: hash → metadata via the OpenVGDB SQLite snapshot
 * (https://github.com/OpenVGDB/OpenVGDB). One ~50 MB file, downloaded
 * once on first use, queried locally with sql.js. No credentials, no
 * rate limit, no per-request network cost.
 *
 * Source of truth: GitHub releases. We fetch the
 * `releases/latest` JSON, locate the `.zip` (or `.sqlite`) asset, and
 * download from its `browser_download_url`. The iNDS mirror that
 * round 3 used has been DNS-deleted; GitHub is now the sole source.
 *
 * Once downloaded, we record the release tag in `openvgdb.version.json`
 * alongside the `.sqlite`. On subsequent calls we treat the pair as
 * cached and skip the network entirely. Manual deletion of either
 * file forces a re-fetch on the next call.
 *
 * sql.js loads via WebAssembly. We pass `wasmBinary` directly (read
 * from node_modules) instead of relying on Emscripten's default
 * locate-file behavior — that pattern doesn't survive Electron's
 * asar packaging cleanly.
 */

const RELEASES_URL =
  'https://api.github.com/repos/OpenVGDB/OpenVGDB/releases/latest';

const USER_AGENT = 'mister-curator (https://github.com/polykiss/mister-curator)';

const DB_FILENAME = 'openvgdb.sqlite';
const VERSION_FILENAME = 'openvgdb.version.json';
const DOWNLOAD_TMP_FILENAME = 'openvgdb.download.tmp';
const DEFAULT_LRU_CAPACITY = 100;

/**
 * Categorical tag on `error` progress events. The renderer (PR #16)
 * uses this to choose the right surfaced copy. Strings are stable.
 */
export type OpenVGDBErrorCategory =
  | 'network'
  | 'http-error'
  | 'asset-missing'
  | 'extract'
  | 'schema';

/** Streaming progress events emitted during `ensureDatabase`. */
export type OpenVGDBProgressEvent =
  | { readonly kind: 'started' }
  | {
      readonly kind: 'downloading';
      readonly bytesReceived: number;
      readonly bytesTotal: number | null;
    }
  | { readonly kind: 'ready'; readonly path: string }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly category: OpenVGDBErrorCategory;
    };

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
  /** Test seam — wall-clock source for `fetchedAt` and download metadata. */
  readonly now?: () => number;
  /** Test seam — overrides the GitHub releases endpoint URL. */
  readonly releasesUrl?: string;
  /**
   * Override the path to the sql.js WASM binary. If unset, the
   * service resolves it via `require.resolve('sql.js/dist/sql-wasm.wasm')`.
   */
  readonly wasmBinaryPath?: string;
  /** Default 100. Test override. */
  readonly lruCapacity?: number;
}

/** Sidecar that records which release tag we have on disk. */
interface VersionFile {
  readonly tag: string;
  readonly downloadedAt: string;
}

/**
 * The single SELECT we issue, written against the OpenVGDB v29.0
 * schema (verified live against the real archive). LEFT JOINs keep
 * the row even if RELEASES or SYSTEMS is missing — OpenVGDB
 * sometimes has ROMs without a release record.
 *
 * `WHERE rom.romHashMD5 = UPPER(?)`: round 6 fix. OpenVGDB stores
 * md5 hashes in UPPERCASE hex; busybox `md5sum` emits lowercase, so
 * a literal `column = ?` comparison would always miss. We uppercase
 * the bind once on the SQLite side, leaving the column comparison
 * BINARY (the index OpenVGDB ships on `romHashMD5` is BINARY-typed,
 * so an `UPPER(column)` wrap would force a scan). `COLLATE NOCASE`
 * would also work but bypasses the BINARY index for the same reason.
 *
 * Why not the `releaseCover*` URL columns: OpenVGDB's bundled art
 * URLs point at TheGamesDB CDN paths that have rotted over the
 * years. We use libretro-thumbnails for art instead, composed by
 * `LibretroThumbnailsFetcher` from `(systemName, releaseTitleName)`.
 *
 * `TEMPsystemName` / `TEMPregionLocalizedName` are OpenVGDB's
 * denormalized human-readable fallbacks; we read them as a backup
 * for the JOIN-derived value (occasionally cleaner than the join).
 */
const QUERY_BY_MD5 = `
  SELECT
    rom.romHashMD5                  AS hash,
    rom.romFileName                 AS romFileName,
    rom.romExtensionlessFileName    AS romExtensionlessFileName,
    rel.releaseTitleName            AS name,
    rel.releaseDate                 AS releaseDate,
    rel.releaseDeveloper            AS developer,
    rel.releasePublisher            AS publisher,
    rel.releaseGenre                AS genre,
    rel.releaseDescription          AS description,
    rel.TEMPregionLocalizedName     AS region,
    sys.systemName                  AS systemName,
    sys.systemShortName             AS systemShortName,
    rel.TEMPsystemName              AS releaseTempSystemName
  FROM ROMs rom
  LEFT JOIN RELEASES rel ON rel.romID = rom.romID
  LEFT JOIN SYSTEMS  sys ON sys.systemID = rom.systemID
  WHERE rom.romHashMD5 = UPPER(?)
  LIMIT 1
`;

/**
 * Schema sniff: tables and the columns each one must expose for our
 * SELECT to compile. PRAGMA `table_info` returns one row per column;
 * we hash the `name` column and require every entry in the inner
 * arrays below to be present.
 *
 * Drift in OpenVGDB's schema (column rename, table split, …) trips
 * this check at open time and triggers a redownload — better than
 * surfacing a `no such column` error from sqlite at query time.
 */
const REQUIRED_SCHEMA: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'ROMs',
    [
      'romID',
      'systemID',
      'romHashMD5',
      'romFileName',
      'romExtensionlessFileName',
    ],
  ],
  [
    'RELEASES',
    ['romID', 'releaseTitleName'],
  ],
  [
    'SYSTEMS',
    ['systemID', 'systemName'],
  ],
]);

/**
 * Plausible video-game release years. Bound is `currentYear + 5` so
 * announced-but-unreleased titles parse OK; bump the upper edge as
 * years pass. Round 5 was written in 2026, so 2031 covers the next
 * five years comfortably.
 */
const MIN_RELEASE_YEAR = 1970;
const MAX_RELEASE_YEAR = 2031;

export class OpenVGDBService {
  private readonly fetchImpl: typeof fetch;
  private readonly nowImpl: () => number;
  private readonly releasesUrl: string;
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
    this.releasesUrl = options.releasesUrl ?? RELEASES_URL;
    this.wasmBinaryPath = options.wasmBinaryPath ?? null;
    this.lruCapacity = options.lruCapacity ?? DEFAULT_LRU_CAPACITY;
  }

  /** Convenience: true once the DB has been opened successfully. */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Make the DB usable. Round 4 contract:
   *   - If both `openvgdb.sqlite` AND `openvgdb.version.json` exist
   *     and the schema is valid, open immediately. No network.
   *   - Otherwise: GET releases/latest, find the .zip (or .sqlite)
   *     asset, download, extract, atomic rename, validate, write
   *     the version sidecar.
   *
   * Concurrent callers coalesce onto the same promise; failures
   * clear the gate so the next call retries.
   *
   * `onProgress` (when supplied) sees `started` once, then either:
   *   - 0+ `downloading` events as bytes accumulate
   *   - one `ready` event on success
   *   - one `error` event on failure (with a `category` tag)
   *
   * Returns when the DB is open or the failure has been surfaced.
   * Does not throw on download failure — a failed download leaves
   * `ready=false` and subsequent `getMetadataByHash` calls return
   * null.
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
   * Wipe the on-disk DB, version sidecar, and any in-memory state.
   * Next `ensureDatabase` will redownload. Used by the "Clear cache"
   * command.
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
    await unlinkIfExists(this.dbPath());
    await unlinkIfExists(this.versionPath());
  }

  // ─── internals ─────────────────────────────────────────────────────

  private async doEnsure(
    onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  ): Promise<void> {
    // Cached path: both files present + schema valid → ready, no
    // network at all.
    if (await this.fileExists(this.dbPath()) && (await this.readVersion()) !== null) {
      const opened = await this.tryOpen(this.dbPath());
      if (opened) {
        this.ready = true;
        onProgress?.({ kind: 'ready', path: this.dbPath() });
        return;
      }
      // Schema mismatch on a previously-cached file. Wipe and treat
      // as cold so the redownload below has a clean slate.
      await unlinkIfExists(this.dbPath());
      await unlinkIfExists(this.versionPath());
    }

    onProgress?.({ kind: 'started' });

    // Step 1: fetch the releases JSON.
    let asset: { name: string; url: string };
    let tag: string;
    try {
      const release = await this.fetchLatestRelease();
      tag = release.tag;
      const picked = pickAsset(release.assets);
      if (picked === null) {
        emitError(
          onProgress,
          'asset-missing',
          'Latest OpenVGDB release has no .sqlite or .zip asset — please report this.',
        );
        return;
      }
      asset = picked;
    } catch (err) {
      if (err instanceof HttpStatusError) {
        if (err.status === 404) {
          emitError(
            onProgress,
            'http-error',
            'OpenVGDB releases not found — the project may have moved.',
          );
        } else {
          emitError(
            onProgress,
            'http-error',
            `GitHub returned status ${String(err.status)} for the OpenVGDB releases endpoint.`,
          );
        }
      } else {
        emitError(
          onProgress,
          'network',
          `Could not reach github.com — check your internet connection. (${describeNetworkError(err)})`,
        );
      }
      return;
    }

    // Step 2: download the asset.
    await fs.mkdir(this.rootDir, { recursive: true });
    const downloadPath = join(this.rootDir, DOWNLOAD_TMP_FILENAME);
    try {
      await this.streamToFile(asset.url, downloadPath, onProgress);
    } catch (err) {
      await unlinkIfExists(downloadPath);
      emitError(
        onProgress,
        'network',
        `OpenVGDB download failed: ${describeNetworkError(err)}`,
      );
      return;
    }

    // Step 3: extract (or just rename, for direct .sqlite assets).
    const isZip = asset.name.toLowerCase().endsWith('.zip');
    if (isZip) {
      try {
        await this.extractSqliteFromZip(downloadPath, this.dbPath());
      } catch (err) {
        await unlinkIfExists(downloadPath);
        await unlinkIfExists(this.dbPath());
        emitError(
          onProgress,
          'extract',
          `Downloaded archive is corrupt — please retry. (${describeNetworkError(err)})`,
        );
        return;
      }
      await unlinkIfExists(downloadPath);
    } else {
      await fs.rename(downloadPath, this.dbPath());
    }

    // Step 4: schema-validate the extracted file.
    const opened = await this.tryOpen(this.dbPath());
    if (!opened) {
      await unlinkIfExists(this.dbPath());
      emitError(
        onProgress,
        'schema',
        'Downloaded OpenVGDB file did not match the expected schema.',
      );
      return;
    }

    // Step 5: record the version sidecar so subsequent calls skip
    // the network entirely.
    await this.writeVersion(tag);

    this.ready = true;
    onProgress?.({ kind: 'ready', path: this.dbPath() });
  }

  /**
   * GET the GitHub releases/latest JSON. Throws `HttpStatusError`
   * for non-2xx responses (the caller maps to a category) and
   * surfaces underlying fetch failures unchanged.
   */
  private async fetchLatestRelease(): Promise<{
    tag: string;
    assets: readonly { name: string; url: string }[];
  }> {
    const res = await this.fetchImpl(this.releasesUrl, {
      headers: {
        'User-Agent': USER_AGENT,
        // GitHub's recommended Accept header; the v3 / vnd type fixes
        // the response shape across API revisions.
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      throw new HttpStatusError(res.status);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new Error(`Releases JSON unparseable: ${describeNetworkError(err)}`);
    }
    if (body === null || typeof body !== 'object') {
      throw new Error('Releases JSON was not an object.');
    }
    const obj = body as Record<string, unknown>;
    const tag = typeof obj.tag_name === 'string' ? obj.tag_name : 'unknown';
    const rawAssets = obj.assets;
    const assets: { name: string; url: string }[] = [];
    if (Array.isArray(rawAssets)) {
      for (const raw of rawAssets) {
        if (raw === null || typeof raw !== 'object') continue;
        const a = raw as Record<string, unknown>;
        if (
          typeof a.name === 'string' &&
          typeof a.browser_download_url === 'string'
        ) {
          assets.push({ name: a.name, url: a.browser_download_url });
        }
      }
    }
    return { tag, assets };
  }

  /**
   * Stream `url` to `path` (atomic rename pending — caller decides
   * what to do with the file afterwards). Emits `downloading`
   * progress as bytes accumulate.
   */
  private async streamToFile(
    url: string,
    path: string,
    onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  ): Promise<void> {
    const res = await this.fetchImpl(url, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!res.ok || res.body === null) {
      throw new Error(`Asset download returned status ${String(res.status)}.`);
    }
    const totalHeader = res.headers.get('content-length');
    const total =
      totalHeader === null ? null : Number.parseInt(totalHeader, 10);
    const totalBytes = total !== null && Number.isFinite(total) ? total : null;

    const handle = await fs.open(path, 'w', 0o600);
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
    } finally {
      await handle.close().catch(() => undefined);
    }
    if (bytesReceived === 0) {
      throw new Error('Asset download was empty.');
    }
  }

  /**
   * Extract the first `.sqlite` entry from a zip archive into `outPath`,
   * atomically (write to .tmp, fsync via close, rename). Throws on:
   *   - zip parse failure
   *   - no .sqlite entry inside
   *   - underlying I/O failure
   */
  private async extractSqliteFromZip(
    zipPath: string,
    outPath: string,
  ): Promise<void> {
    const buf = await fs.readFile(zipPath);
    const zip = await JSZip.loadAsync(buf);
    let chosen: JSZip.JSZipObject | null = null;
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      if (entry.name.toLowerCase().endsWith('.sqlite')) {
        chosen = entry;
        break;
      }
    }
    if (chosen === null) {
      throw new Error('Zip archive contained no .sqlite entry.');
    }
    const sqliteBuf = await chosen.async('uint8array');
    const tmp = `${outPath}.tmp`;
    await fs.writeFile(tmp, sqliteBuf, { mode: 0o600 });
    await fs.rename(tmp, outPath);
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

  private async readVersion(): Promise<VersionFile | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.versionPath(), 'utf-8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null;
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.tag !== 'string' || typeof o.downloadedAt !== 'string') {
      return null;
    }
    return { tag: o.tag, downloadedAt: o.downloadedAt };
  }

  private async writeVersion(tag: string): Promise<void> {
    const data: VersionFile = {
      tag,
      downloadedAt: new Date(this.nowImpl()).toISOString(),
    };
    const tmp = `${this.versionPath()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await fs.rename(tmp, this.versionPath());
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await fs.access(path);
      return true;
    } catch {
      return false;
    }
  }

  private queryOne(db: Database, md5: string): OpenVGDBMetadata | null {
    const stmt = db.prepare(QUERY_BY_MD5);
    try {
      stmt.bind([md5]);
      if (!stmt.step()) return null;
      const row = stmt.getAsObject();
      // Name: prefer the release title; fall back to the ROM filename
      // sans extension when no RELEASES row joined. ROMs without a
      // release record do exist in OpenVGDB — better to surface the
      // filename than drop the row entirely.
      const name =
        readString(row.name) ?? readString(row.romExtensionlessFileName);
      // System: prefer the SYSTEMS join; fall back to the
      // denormalized release-side TEMPsystemName when present.
      const system =
        readString(row.systemName) ??
        readString(row.releaseTempSystemName);
      if (name === null || system === null) return null;
      return {
        md5: readString(row.hash) ?? md5,
        name,
        system,
        year: parseReleaseYear(readString(row.releaseDate)),
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

  private versionPath(): string {
    return join(this.rootDir, VERSION_FILENAME);
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

/**
 * Pick the right release asset. Prefer a direct `.sqlite` if one is
 * ever shipped (cheaper — no extraction step); otherwise fall through
 * to the first `.zip`. Returns null when neither is present.
 */
function pickAsset(
  assets: readonly { name: string; url: string }[],
): { name: string; url: string } | null {
  const direct = assets.find((a) => a.name.toLowerCase().endsWith('.sqlite'));
  if (direct !== undefined) return direct;
  const zipped = assets.find((a) => a.name.toLowerCase().endsWith('.zip'));
  return zipped ?? null;
}

class HttpStatusError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${String(status)}`);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

function emitError(
  onProgress: ((event: OpenVGDBProgressEvent) => void) | undefined,
  category: OpenVGDBErrorCategory,
  message: string,
): void {
  onProgress?.({ kind: 'error', category, message });
}

function describeNetworkError(err: unknown): string {
  if (err instanceof Error) {
    // node-fetch / undici surface DNS failures as `cause: { code: 'ENOTFOUND' }`.
    // Reach through to surface that to the user log.
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === 'object') {
      const code = (cause as Record<string, unknown>).code;
      if (typeof code === 'string') return `${err.message} (${code})`;
    }
    return err.message;
  }
  return String(err);
}

async function unlinkIfExists(path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch (err) {
    if (isNodeError(err) && err.code === 'ENOENT') return;
    // Best-effort — caller may not care about cleanup races.
  }
}

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
    for (const [table, columns] of REQUIRED_SCHEMA) {
      // PRAGMA can't be parameterised — table name needs to splice
      // in directly. The keys come from a hard-coded constant, so
      // the injection surface is nil. Quoting with double-quotes
      // tolerates the case-sensitive table names OpenVGDB uses
      // (e.g. `ROMs`).
      const stmt = db.prepare(`PRAGMA table_info("${table}")`);
      try {
        const present = new Set<string>();
        while (stmt.step()) {
          const row = stmt.getAsObject();
          if (typeof row.name === 'string') present.add(row.name);
        }
        if (present.size === 0) return false; // table missing entirely
        for (const col of columns) {
          if (!present.has(col)) return false;
        }
      } finally {
        stmt.free();
      }
    }
    return true;
  } catch {
    return false;
  }
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a year from a free-form release-date string.
 *
 * OpenVGDB's `releaseDate` is a TEXT column with no consistent
 * format — values like "1992", "1992-10-29", "Oct 29, 1992", and
 * "released in '92" all show up. We:
 *   1. Look for a 4-digit year and accept it if it's in our
 *      plausible range (`MIN_RELEASE_YEAR`..`MAX_RELEASE_YEAR`).
 *      This rejects "1492", "21000", and similar nonsense — both
 *      because the regex won't match (5-digit runs lose the right
 *      `\b`) and because the range filter screens stragglers.
 *   2. Fall back to a 2-digit shorthand prefixed by an apostrophe
 *      ("'92" → 1992, "'05" → 2005). The 70-cutoff splits 1900s
 *      from 2000s — same plausibility window.
 *
 * Returns null on null/empty input or when no plausible year is
 * present.
 */
function parseReleaseYear(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (t.length === 0) return null;

  for (const match of t.matchAll(/\b(\d{4})\b/g)) {
    const y = Number.parseInt(match[1] ?? '', 10);
    if (
      Number.isFinite(y) &&
      y >= MIN_RELEASE_YEAR &&
      y <= MAX_RELEASE_YEAR
    ) {
      return y;
    }
  }

  const short = /'(\d{2})\b/.exec(t);
  if (short !== null) {
    const n = Number.parseInt(short[1] ?? '', 10);
    if (Number.isFinite(n)) {
      return n >= 70 ? 1900 + n : 2000 + n;
    }
  }

  return null;
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
