import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import JSZip from 'jszip';
import initSqlJs from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenVGDBService,
  type OpenVGDBProgressEvent,
} from '@app/main/metadata/openvgdb-service';

// Real-world OpenVGDB stores hashes as lowercase hex; our fixture
// mirrors that (verified against v29.0 with `SELECT romHashMD5 FROM
// ROMs LIMIT 5`).
const HASH_SMW = 'd0e7d56cb3eb1f3f8e51a8fd0bcfaf28';
const HASH_SONIC = 'b9f8d04a4e2cebf6df3b3c33b9b6a89e';
const HASH_ZELDA_LTTP = '03a63945398191337e896e5771f77173';
const HASH_CHRONO = '6f51a8b3097cd9b9c4ab46f1ad33fdca';
const HASH_TETRIS = '3060ec56e7b5fa68f4ff2f6c8e8c8eed';
const HASH_NONEXISTENT = '00112233445566778899aabbccddeeff';

/** ROMs row that has no RELEASES join — name fallback path. */
const HASH_NO_RELEASE = '0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e';

const FAKE_RELEASES_URL = 'https://api.example.test/releases/latest';
const FAKE_ZIP_URL = 'https://cdn.example.test/openvgdb.zip';
const FAKE_SQLITE_URL = 'https://cdn.example.test/openvgdb.sqlite';
const RELEASE_TAG = 'v29.0';

interface FixtureRow {
  readonly md5: string;
  readonly system: string;
  /** ROM filename including extension, e.g. "Super Mario World (USA).sfc". */
  readonly fileName: string;
  /** Title from the RELEASES row. Set null to omit the release row entirely. */
  readonly title: string | null;
  readonly date: string | null;
  readonly genre: string | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly description: string | null;
  readonly region: string | null;
}

/**
 * Build an OpenVGDB-shaped SQLite buffer in-memory using the v29.0
 * schema. The `ROMs` / `RELEASES` / `SYSTEMS` columns mirror what
 * `app/main/metadata/openvgdb-service.ts` actually reads — only the
 * columns we use are declared, but the names + types match the real
 * archive so the schema sniff is exercised against canonical shape.
 *
 * Building inline (rather than committing a binary fixture) keeps
 * the repo small and means a schema drift in one file forces an
 * update in the other.
 */
async function buildFixture(rows: readonly FixtureRow[]): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE SYSTEMS (
      systemID INTEGER PRIMARY KEY,
      systemName TEXT,
      systemShortName TEXT,
      systemHeaderSizeBytes INTEGER,
      systemHashless INTEGER,
      systemHeader TEXT,
      systemSerial TEXT,
      systemOEID TEXT
    );
    CREATE TABLE ROMs (
      romID INTEGER PRIMARY KEY,
      systemID INTEGER,
      regionID INTEGER,
      romHashCRC TEXT,
      romHashMD5 TEXT,
      romHashSHA1 TEXT,
      romSize INTEGER,
      romFileName TEXT,
      romExtensionlessFileName TEXT,
      romParent TEXT,
      romSerial TEXT,
      romHeader TEXT,
      romLanguage TEXT,
      TEMPromRegion TEXT,
      romDumpSource TEXT
    );
    CREATE TABLE RELEASES (
      releaseID INTEGER PRIMARY KEY,
      romID INTEGER,
      releaseTitleName TEXT,
      regionLocalizedID INTEGER,
      TEMPregionLocalizedName TEXT,
      TEMPsystemShortName TEXT,
      TEMPsystemName TEXT,
      releaseCoverFront TEXT,
      releaseCoverBack TEXT,
      releaseCoverCart TEXT,
      releaseCoverDisc TEXT,
      releaseDescription TEXT,
      releaseDeveloper TEXT,
      releasePublisher TEXT,
      releaseGenre TEXT,
      releaseDate TEXT,
      releaseReferenceURL TEXT,
      releaseReferenceImageURL TEXT
    );
  `);
  const systemIds = new Map<string, number>();
  for (const r of rows) {
    let sysId = systemIds.get(r.system);
    if (sysId === undefined) {
      sysId = systemIds.size + 1;
      systemIds.set(r.system, sysId);
      db.run(
        'INSERT INTO SYSTEMS (systemID, systemName, systemShortName) VALUES (?, ?, ?)',
        [sysId, r.system, r.system.split(/\s/)[0] ?? r.system],
      );
    }
    const romId = db.exec('SELECT IFNULL(MAX(romID), 0) + 1 FROM ROMs')[0]
      ?.values[0]?.[0] as number;
    const extensionless = r.fileName.replace(/\.[^./]+$/, '');
    db.run(
      `INSERT INTO ROMs
        (romID, systemID, romHashMD5, romFileName, romExtensionlessFileName)
       VALUES (?, ?, ?, ?, ?)`,
      [romId, sysId, r.md5, r.fileName, extensionless],
    );
    if (r.title !== null) {
      db.run(
        `INSERT INTO RELEASES
          (romID, releaseTitleName, releaseDate, releaseGenre,
           releasePublisher, releaseDeveloper, releaseDescription,
           TEMPregionLocalizedName, TEMPsystemName)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          romId,
          r.title,
          r.date,
          r.genre,
          r.publisher,
          r.developer,
          r.description,
          r.region,
          r.system,
        ],
      );
    }
  }
  const exported = db.export();
  db.close();
  return exported;
}

const SAMPLE_ROWS: readonly FixtureRow[] = [
  {
    md5: HASH_SMW,
    system: 'Super Nintendo Entertainment System',
    fileName: 'Super Mario World (USA).sfc',
    title: 'Super Mario World',
    date: '1991-08-13',
    genre: 'Platform',
    publisher: 'Nintendo',
    developer: 'Nintendo EAD',
    description: 'Mario rescues the princess.',
    region: 'USA',
  },
  {
    md5: HASH_SONIC,
    system: 'Sega Genesis',
    fileName: 'Sonic The Hedgehog 2 (World).md',
    title: 'Sonic The Hedgehog 2',
    date: '1992',
    genre: 'Platform',
    publisher: 'Sega',
    developer: 'Sega Technical Institute',
    description: null,
    region: 'World',
  },
  {
    md5: HASH_ZELDA_LTTP,
    system: 'Super Nintendo Entertainment System',
    fileName: 'Legend of Zelda, The - A Link to the Past (USA).sfc',
    title: 'The Legend of Zelda: A Link to the Past',
    date: 'Apr 13, 1992',
    genre: 'Action-Adventure',
    publisher: 'Nintendo',
    developer: 'Nintendo EAD',
    description: 'Hyrule needs you.',
    region: 'USA',
  },
  {
    md5: HASH_CHRONO,
    system: 'Super Nintendo Entertainment System',
    fileName: 'Chrono Trigger (USA).sfc',
    title: 'Chrono Trigger',
    date: '1995-08-22',
    genre: 'Role-Playing',
    publisher: 'Square',
    developer: 'Square',
    description: 'Time travel saves the world.',
    region: 'USA',
  },
  {
    md5: HASH_TETRIS,
    system: 'Game Boy',
    fileName: 'Tetris (World).gb',
    title: 'Tetris',
    date: 'Jul 31, 1989',
    genre: 'Puzzle',
    publisher: 'Nintendo',
    developer: 'Nintendo R&D1',
    description: null,
    region: 'World',
  },
];

/** Variant fixture used to exercise the no-RELEASES name fallback path. */
const NO_RELEASE_ROWS: readonly FixtureRow[] = [
  ...SAMPLE_ROWS,
  {
    md5: HASH_NO_RELEASE,
    system: 'Super Nintendo Entertainment System',
    fileName: 'Mystery Cart (Proto).sfc',
    title: null, // → no RELEASES row
    date: null,
    genre: null,
    publisher: null,
    developer: null,
    description: null,
    region: null,
  },
];

/** Wraps a SQLite buffer in a `.zip` archive named the way GitHub ships it. */
async function makeZip(sqlite: Uint8Array): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('openvgdb.sqlite', sqlite);
  return zip.generateAsync({ type: 'uint8array' });
}

interface ReleasesAsset {
  readonly name: string;
  readonly url: string;
}

function releasesJson(assets: readonly ReleasesAsset[], tag = RELEASE_TAG) {
  return {
    tag_name: tag,
    assets: assets.map((a) => ({
      name: a.name,
      browser_download_url: a.url,
    })),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function bytesResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(bytes), {
    status,
    headers: { 'content-length': String(bytes.byteLength) },
  });
}

/**
 * Build a fetch mock that routes by URL. Each entry is consumed once;
 * unmatched URLs reject so a missed routing surfaces as a clear test
 * failure rather than a misleading "got null" downstream.
 */
function routeFetch(
  routes: ReadonlyMap<string, () => Response | Promise<Response>>,
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    const handler = routes.get(url);
    if (handler === undefined) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    return handler();
  }) as unknown as typeof fetch;
}

describe('OpenVGDBService (round 4 — GitHub releases + jszip)', () => {
  let dir: string;
  let fixtureBuffer: Uint8Array;
  let fixtureZip: Uint8Array;

  beforeAll(async () => {
    fixtureBuffer = await buildFixture(SAMPLE_ROWS);
    fixtureZip = await makeZip(fixtureBuffer);
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-openvgdb-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  // ─── happy paths ───────────────────────────────────────────────────

  it('downloads the .zip asset, extracts the .sqlite, and writes the version sidecar', async () => {
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(fixtureZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    expect(svc.isReady()).toBe(true);
    expect(events.find((e) => e.kind === 'started')).toBeDefined();
    expect(events.find((e) => e.kind === 'ready')).toBeDefined();

    // Both the sqlite and the version sidecar exist.
    await expect(fs.stat(join(dir, 'openvgdb.sqlite'))).resolves.toBeDefined();
    const versionRaw = await fs.readFile(
      join(dir, 'openvgdb.version.json'),
      'utf-8',
    );
    expect(JSON.parse(versionRaw)).toMatchObject({
      tag: RELEASE_TAG,
    });

    // The intermediate download .tmp is gone.
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).not.toContain('openvgdb.download.tmp');
  });

  it('returns metadata for a known hash after extraction', async () => {
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(fixtureZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    const meta = await svc.getMetadataByHash(HASH_SMW);
    expect(meta?.name).toBe('Super Mario World');
    expect(meta?.system).toBe('Super Nintendo Entertainment System');
    expect(meta?.year).toBe(1991);
  });

  it('uses a direct .sqlite asset if the release ever ships one (no zip extraction)', async () => {
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([
                  { name: 'openvgdb.sqlite', url: FAKE_SQLITE_URL },
                ]),
              ),
          ],
          [FAKE_SQLITE_URL, (): Response => bytesResponse(fixtureBuffer)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(await svc.getMetadataByHash(HASH_SMW)).not.toBeNull();
  });

  it('prefers the .sqlite asset over .zip when both are present', async () => {
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([
                  { name: 'openvgdb.zip', url: FAKE_ZIP_URL },
                  { name: 'openvgdb.sqlite', url: FAKE_SQLITE_URL },
                ]),
              ),
          ],
          [FAKE_SQLITE_URL, (): Response => bytesResponse(fixtureBuffer)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    // Zip URL was never fetched.
    expect(fetchMock.mock.calls.map((c) => c[0])).not.toContain(FAKE_ZIP_URL);
  });

  it('emits monotonically growing downloading progress events', async () => {
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(fixtureZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const progress: { received: number; total: number | null }[] = [];
    await svc.ensureDatabase((e) => {
      if (e.kind === 'downloading') {
        progress.push({ received: e.bytesReceived, total: e.bytesTotal });
      }
    });
    expect(progress.length).toBeGreaterThan(0);
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]?.received).toBeGreaterThanOrEqual(
        progress[i - 1]?.received ?? 0,
      );
    }
    expect(progress[0]?.total).toBe(fixtureZip.byteLength);
  });

  // ─── cached / no-network paths ─────────────────────────────────────

  it('skips the network entirely when sqlite + version sidecar already exist', async () => {
    // Pre-populate both files.
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(
      join(dir, 'openvgdb.version.json'),
      JSON.stringify({
        tag: RELEASE_TAG,
        downloadedAt: new Date().toISOString(),
      }),
    );
    const fetchMock = vi.fn();
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('redownloads when sqlite exists but the version sidecar is missing', async () => {
    // Only the sqlite — no sidecar. Round 3 users (sqlite without
    // sidecar) get one redownload; that's an acceptable upgrade tax.
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(fixtureZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('redownloads when the sidecar JSON is corrupt', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(join(dir, 'openvgdb.version.json'), '{ not json');
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(fixtureZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('GitHub API request includes a User-Agent header', async () => {
    const headerCalls: Headers[] = [];
    const fetchMock = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      headerCalls.push(new Headers(init?.headers));
      if (url === FAKE_RELEASES_URL) {
        return jsonResponse(
          releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
        );
      }
      if (url === FAKE_ZIP_URL) {
        return bytesResponse(fixtureZip);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(headerCalls[0]?.get('user-agent')).toBeTruthy();
    expect(headerCalls[0]?.get('accept')).toContain('vnd.github');
  });

  // ─── error categorisation ──────────────────────────────────────────

  it('emits a network-category error when the releases endpoint can\'t be reached', async () => {
    const dnsErr = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ENOTFOUND' },
    });
    const fetchMock = vi.fn(() => Promise.reject(dnsErr));
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    expect(svc.isReady()).toBe(false);
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent?.kind).toBe('error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('network');
      expect(errEvent.message).toMatch(/check your internet connection/i);
      expect(errEvent.message).toContain('ENOTFOUND');
    }
  });

  it('emits an http-error for 404 from the releases endpoint', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('Not Found', { status: 404 })),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent?.kind).toBe('error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('http-error');
      expect(errEvent.message).toMatch(/may have moved/i);
    }
  });

  it('emits an http-error for 500 from the releases endpoint', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('boom', { status: 500 })),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('http-error');
      expect(errEvent.message).toMatch(/500/);
    }
  });

  it('emits an asset-missing error when no .zip or .sqlite asset is in the release', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          releasesJson([
            { name: 'README.md', url: 'https://x' },
            { name: 'changelog.txt', url: 'https://y' },
          ]),
        ),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('asset-missing');
      expect(errEvent.message).toMatch(/please report this/i);
    }
    // No partial files left.
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    expect(entries).not.toContain('openvgdb.sqlite');
    expect(entries).not.toContain('openvgdb.download.tmp');
  });

  it('emits an extract error when the downloaded zip is corrupt, no partial files left', async () => {
    const corruptZip = new Uint8Array([1, 2, 3, 4]); // not a real zip
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(corruptZip)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('extract');
      expect(errEvent.message).toMatch(/corrupt/i);
    }
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).not.toContain('openvgdb.sqlite');
    expect(svc.isReady()).toBe(false);
  });

  it('emits an extract error when the zip has no .sqlite entry inside', async () => {
    const innerZip = new JSZip();
    innerZip.file('readme.txt', 'definitely not a database');
    const wrongZipBytes = await innerZip.generateAsync({ type: 'uint8array' });
    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(wrongZipBytes)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    expect(errEvent?.kind).toBe('error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('extract');
    }
  });

  it('emits a schema error when the extracted sqlite has the wrong tables', async () => {
    const SQL = await initSqlJs();
    const badDb = new SQL.Database();
    badDb.run('CREATE TABLE OOPS (x INTEGER)');
    const badBuf = badDb.export();
    badDb.close();
    const wrongZip = new JSZip();
    wrongZip.file('openvgdb.sqlite', badBuf);
    const wrongZipBytes = await wrongZip.generateAsync({ type: 'uint8array' });

    const fetchMock = vi.fn(
      routeFetch(
        new Map([
          [
            FAKE_RELEASES_URL,
            (): Response =>
              jsonResponse(
                releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
              ),
          ],
          [FAKE_ZIP_URL, (): Response => bytesResponse(wrongZipBytes)],
        ]),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      releasesUrl: FAKE_RELEASES_URL,
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    const errEvent = events.find((e) => e.kind === 'error');
    if (errEvent?.kind === 'error') {
      expect(errEvent.category).toBe('schema');
    }
    expect(svc.isReady()).toBe(false);
  });

  // ─── housekeeping ──────────────────────────────────────────────────

  it('coalesces concurrent ensureDatabase calls onto one download', async () => {
    let downloads = 0;
    const fetchMock = vi.fn((async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === FAKE_RELEASES_URL) {
        return jsonResponse(
          releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
        );
      }
      if (url === FAKE_ZIP_URL) {
        downloads += 1;
        return bytesResponse(fixtureZip);
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch);
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock,
      releasesUrl: FAKE_RELEASES_URL,
    });
    await Promise.all([
      svc.ensureDatabase(),
      svc.ensureDatabase(),
      svc.ensureDatabase(),
    ]);
    expect(downloads).toBe(1);
  });

  it('clearDatabase deletes the sqlite and the version sidecar', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(
      join(dir, 'openvgdb.version.json'),
      JSON.stringify({ tag: 'x', downloadedAt: 'y' }),
    );
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    await svc.clearDatabase();
    expect(svc.isReady()).toBe(false);
    for (const file of ['openvgdb.sqlite', 'openvgdb.version.json']) {
      const exists = await fs
        .stat(join(dir, file))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    }
  });

  // ─── lookups (carry-over coverage) ─────────────────────────────────

  it('returns null for an unknown hash', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(
      join(dir, 'openvgdb.version.json'),
      JSON.stringify({ tag: RELEASE_TAG, downloadedAt: new Date().toISOString() }),
    );
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    expect(await svc.getMetadataByHash(HASH_NONEXISTENT)).toBeNull();
  });

  it('returns null when the DB has not been ensured', async () => {
    const svc = new OpenVGDBService(dir);
    expect(svc.isReady()).toBe(false);
    expect(await svc.getMetadataByHash(HASH_SMW)).toBeNull();
  });

  it('matches md5 case-insensitively', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(
      join(dir, 'openvgdb.version.json'),
      JSON.stringify({ tag: RELEASE_TAG, downloadedAt: new Date().toISOString() }),
    );
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    const upper = await svc.getMetadataByHash(HASH_SMW.toUpperCase());
    expect(upper?.name).toBe('Super Mario World');
  });

  it('parses partial date strings into a year', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    await fs.writeFile(
      join(dir, 'openvgdb.version.json'),
      JSON.stringify({ tag: RELEASE_TAG, downloadedAt: new Date().toISOString() }),
    );
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    const sonic = await svc.getMetadataByHash(HASH_SONIC);
    expect(sonic?.year).toBe(1992);
  });

  // ─── round 5: schema-fix coverage ──────────────────────────────────

  describe('round 5 — v29.0 schema', () => {
    async function makeReadyService(rows: readonly FixtureRow[] = SAMPLE_ROWS) {
      const buf = await buildFixture(rows);
      await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(buf));
      await fs.writeFile(
        join(dir, 'openvgdb.version.json'),
        JSON.stringify({
          tag: RELEASE_TAG,
          downloadedAt: new Date().toISOString(),
        }),
      );
      const svc = new OpenVGDBService(dir);
      await svc.ensureDatabase();
      return svc;
    }

    it('returns full RomMetadata fields for each well-known sample row', async () => {
      const svc = await makeReadyService();
      const cases = [
        { hash: HASH_SMW, name: 'Super Mario World', year: 1991, publisher: 'Nintendo' },
        { hash: HASH_SONIC, name: 'Sonic The Hedgehog 2', year: 1992, publisher: 'Sega' },
        {
          hash: HASH_ZELDA_LTTP,
          name: 'The Legend of Zelda: A Link to the Past',
          year: 1992,
          publisher: 'Nintendo',
        },
        { hash: HASH_CHRONO, name: 'Chrono Trigger', year: 1995, publisher: 'Square' },
        { hash: HASH_TETRIS, name: 'Tetris', year: 1989, publisher: 'Nintendo' },
      ];
      for (const c of cases) {
        const meta = await svc.getMetadataByHash(c.hash);
        expect(meta?.name).toBe(c.name);
        expect(meta?.year).toBe(c.year);
        expect(meta?.publisher).toBe(c.publisher);
        expect(meta?.source).toBe('openvgdb');
      }
    });

    it('falls back to romExtensionlessFileName when no RELEASES row joins', async () => {
      const svc = await makeReadyService(NO_RELEASE_ROWS);
      const meta = await svc.getMetadataByHash(HASH_NO_RELEASE);
      expect(meta).not.toBeNull();
      // Filename minus extension; release fields all null since no
      // join landed.
      expect(meta?.name).toBe('Mystery Cart (Proto)');
      expect(meta?.system).toBe('Super Nintendo Entertainment System');
      expect(meta?.year).toBeNull();
      expect(meta?.publisher).toBeNull();
      expect(meta?.developer).toBeNull();
      expect(meta?.genre).toBeNull();
      expect(meta?.description).toBeNull();
    });

    it('returns null when the hash is not in ROMs at all', async () => {
      const svc = await makeReadyService();
      expect(await svc.getMetadataByHash(HASH_NONEXISTENT)).toBeNull();
    });

    it('parses a calendar-style release date ("Apr 13, 1992")', async () => {
      const svc = await makeReadyService();
      const zelda = await svc.getMetadataByHash(HASH_ZELDA_LTTP);
      expect(zelda?.year).toBe(1992);
    });

    it('redownloads when the schema is missing a required column', async () => {
      // Build a fixture where ROMs is missing the
      // `romExtensionlessFileName` column we depend on.
      const SQL = await initSqlJs();
      const badDb = new SQL.Database();
      badDb.run(`
        CREATE TABLE SYSTEMS (systemID INTEGER PRIMARY KEY, systemName TEXT);
        CREATE TABLE ROMs (romID INTEGER PRIMARY KEY, systemID INTEGER, romHashMD5 TEXT, romFileName TEXT);
        CREATE TABLE RELEASES (releaseID INTEGER PRIMARY KEY, romID INTEGER, releaseTitleName TEXT);
      `);
      const badBuf = badDb.export();
      badDb.close();
      await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(badBuf));
      await fs.writeFile(
        join(dir, 'openvgdb.version.json'),
        JSON.stringify({
          tag: RELEASE_TAG,
          downloadedAt: new Date().toISOString(),
        }),
      );
      // The cached path will reject this file as schema-bad; the
      // download path then redownloads the v29.0-shaped fixture.
      const goodBuf = await buildFixture(SAMPLE_ROWS);
      const goodZip = await makeZip(goodBuf);
      const fetchMock = vi.fn(
        routeFetch(
          new Map([
            [
              FAKE_RELEASES_URL,
              (): Response =>
                jsonResponse(
                  releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
                ),
            ],
            [FAKE_ZIP_URL, (): Response => bytesResponse(goodZip)],
          ]),
        ),
      );
      const svc = new OpenVGDBService(dir, {
        fetch: fetchMock as unknown as typeof fetch,
        releasesUrl: FAKE_RELEASES_URL,
      });
      await svc.ensureDatabase();
      expect(svc.isReady()).toBe(true);
      expect(fetchMock).toHaveBeenCalled();
      // Lookup against the post-redownload DB works.
      expect(await svc.getMetadataByHash(HASH_SMW)).not.toBeNull();
    });

    it('emits a schema error when a freshly-downloaded DB is missing required columns', async () => {
      // Bad-schema bytes wrapped in a valid zip — exercises the
      // post-extract validateSchema check.
      const SQL = await initSqlJs();
      const badDb = new SQL.Database();
      badDb.run(
        `CREATE TABLE ROMs (romID INTEGER, romHashMD5 TEXT);
         CREATE TABLE RELEASES (releaseID INTEGER);
         CREATE TABLE SYSTEMS (systemID INTEGER);`,
      );
      const badBuf = badDb.export();
      badDb.close();
      const wrongZip = new JSZip();
      wrongZip.file('openvgdb.sqlite', badBuf);
      const wrongZipBytes = await wrongZip.generateAsync({ type: 'uint8array' });

      const fetchMock = vi.fn(
        routeFetch(
          new Map([
            [
              FAKE_RELEASES_URL,
              (): Response =>
                jsonResponse(
                  releasesJson([{ name: 'openvgdb.zip', url: FAKE_ZIP_URL }]),
                ),
            ],
            [FAKE_ZIP_URL, (): Response => bytesResponse(wrongZipBytes)],
          ]),
        ),
      );
      const svc = new OpenVGDBService(dir, {
        fetch: fetchMock as unknown as typeof fetch,
        releasesUrl: FAKE_RELEASES_URL,
      });
      const events: OpenVGDBProgressEvent[] = [];
      await svc.ensureDatabase((e) => events.push(e));
      const errEvent = events.find((e) => e.kind === 'error');
      if (errEvent?.kind === 'error') {
        expect(errEvent.category).toBe('schema');
      }
      expect(svc.isReady()).toBe(false);
    });
  });

  // parseReleaseYear is private — exercise it end-to-end via a row
  // whose `releaseDate` contains the value of interest. This both
  // pins the parser semantics and verifies that the column threads
  // through to RomMetadata.year correctly.
  describe('round 5 — release-year parsing', () => {
    interface ParseCase {
      readonly date: string | null;
      readonly expected: number | null;
    }

    const cases: readonly ParseCase[] = [
      { date: '1992', expected: 1992 },
      { date: '1992-10-29', expected: 1992 },
      { date: 'Oct 29, 1992', expected: 1992 },
      { date: "released in '92", expected: 1992 },
      { date: "released in '05", expected: 2005 },
      { date: '', expected: null },
      { date: null, expected: null },
      // Plausible-range filter rejects pre-video-game / nonsense years.
      { date: '1492', expected: null },
      { date: '21000', expected: null },
      // Embedded year inside other text still parses.
      { date: 'Re-released 2007 by Nintendo', expected: 2007 },
      // Out-of-range first match falls through to a later in-range one.
      { date: 'rev 1492; released 1991', expected: 1991 },
    ];

    for (const c of cases) {
      it(`releaseDate=${JSON.stringify(c.date)} → year=${String(c.expected)}`, async () => {
        const buf = await buildFixture([
          {
            md5: HASH_SMW,
            system: 'Super Nintendo Entertainment System',
            fileName: 'Test.sfc',
            title: 'Test',
            date: c.date,
            genre: null,
            publisher: null,
            developer: null,
            description: null,
            region: null,
          },
        ]);
        await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(buf));
        await fs.writeFile(
          join(dir, 'openvgdb.version.json'),
          JSON.stringify({
            tag: RELEASE_TAG,
            downloadedAt: new Date().toISOString(),
          }),
        );
        const svc = new OpenVGDBService(dir);
        await svc.ensureDatabase();
        const meta = await svc.getMetadataByHash(HASH_SMW);
        expect(meta?.year).toBe(c.expected);
      });
    }
  });
});
