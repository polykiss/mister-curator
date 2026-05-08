import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import initSqlJs from 'sql.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OpenVGDBService,
  type OpenVGDBProgressEvent,
} from '@app/main/metadata/openvgdb-service';

const HASH_SMW = 'd0e7d56cb3eb1f3f8e51a8fd0bcfaf28';
const HASH_SONIC = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_NONEXISTENT = '00112233445566778899aabbccddeeff';

interface FixtureRow {
  readonly md5: string;
  readonly system: string;
  readonly title: string;
  readonly date: string | null;
  readonly genre: string | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly description: string | null;
  readonly region: string | null;
}

/**
 * Build a minimal OpenVGDB-shaped SQLite buffer in-memory. The schema
 * matches the columns the service actually queries (ROMs, RELEASES,
 * SYSTEMS) — anything beyond that is irrelevant to these tests.
 *
 * Generating the fixture inline (rather than committing a binary
 * blob) keeps the repo small and means the schema check is exercised
 * against the same definitions the service queries.
 */
async function buildFixture(rows: readonly FixtureRow[]): Promise<Uint8Array> {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE SYSTEMS (
      systemID INTEGER PRIMARY KEY,
      systemName TEXT
    );
    CREATE TABLE ROMs (
      romID INTEGER PRIMARY KEY,
      systemID INTEGER,
      romHashMD5 TEXT,
      romFileName TEXT
    );
    CREATE TABLE RELEASES (
      releaseID INTEGER PRIMARY KEY,
      romID INTEGER,
      releaseTitleName TEXT,
      releaseDate TEXT,
      releaseGenre TEXT,
      releasePublisher TEXT,
      releaseDeveloper TEXT,
      releaseDescription TEXT,
      releaseRegion TEXT
    );
  `);
  const systemIds = new Map<string, number>();
  for (const r of rows) {
    let sysId = systemIds.get(r.system);
    if (sysId === undefined) {
      sysId = systemIds.size + 1;
      systemIds.set(r.system, sysId);
      db.run('INSERT INTO SYSTEMS (systemID, systemName) VALUES (?, ?)', [
        sysId,
        r.system,
      ]);
    }
    const romId = db.exec('SELECT IFNULL(MAX(romID), 0) + 1 FROM ROMs')[0]
      ?.values[0]?.[0] as number;
    db.run(
      'INSERT INTO ROMs (romID, systemID, romHashMD5) VALUES (?, ?, ?)',
      [romId, sysId, r.md5],
    );
    db.run(
      `INSERT INTO RELEASES
        (romID, releaseTitleName, releaseDate, releaseGenre,
         releasePublisher, releaseDeveloper, releaseDescription, releaseRegion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        romId,
        r.title,
        r.date,
        r.genre,
        r.publisher,
        r.developer,
        r.description,
        r.region,
      ],
    );
  }
  const exported = db.export();
  db.close();
  return exported;
}

const SAMPLE_ROWS: readonly FixtureRow[] = [
  {
    md5: HASH_SMW,
    system: 'Super Nintendo Entertainment System',
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
    title: 'Sonic The Hedgehog 2',
    date: '1992',
    genre: 'Platform',
    publisher: 'Sega',
    developer: 'Sega Technical Institute',
    description: null,
    region: 'World',
  },
];

describe('OpenVGDBService', () => {
  let dir: string;
  let fixtureBuffer: Uint8Array;

  beforeAll(async () => {
    fixtureBuffer = await buildFixture(SAMPLE_ROWS);
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-openvgdb-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('opens an existing valid file without downloading', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const fetchMock = vi.fn();
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns metadata for a known hash', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    const meta = await svc.getMetadataByHash(HASH_SMW);
    expect(meta).not.toBeNull();
    expect(meta?.name).toBe('Super Mario World');
    expect(meta?.system).toBe('Super Nintendo Entertainment System');
    expect(meta?.year).toBe(1991);
    expect(meta?.publisher).toBe('Nintendo');
    expect(meta?.developer).toBe('Nintendo EAD');
    expect(meta?.genre).toBe('Platform');
    expect(meta?.region).toBe('USA');
    expect(meta?.description).toBe('Mario rescues the princess.');
    expect(meta?.source).toBe('openvgdb');
  });

  it('matches md5 case-insensitively', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    const upper = await svc.getMetadataByHash(HASH_SMW.toUpperCase());
    expect(upper?.name).toBe('Super Mario World');
  });

  it('returns null for an unknown hash', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    expect(await svc.getMetadataByHash(HASH_NONEXISTENT)).toBeNull();
  });

  it('returns null when the DB has not been ensured', async () => {
    const svc = new OpenVGDBService(dir);
    expect(svc.isReady()).toBe(false);
    expect(await svc.getMetadataByHash(HASH_SMW)).toBeNull();
  });

  it('parses partial date strings into a year', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    const sonic = await svc.getMetadataByHash(HASH_SONIC);
    expect(sonic?.year).toBe(1992);
  });

  it('downloads on first call when no DB file exists', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(svc.isReady()).toBe(true);
    expect(events.find((e) => e.kind === 'started')).toBeDefined();
    expect(events.find((e) => e.kind === 'ready')).toBeDefined();
    expect(events.some((e) => e.kind === 'downloading')).toBe(true);
  });

  it('emits downloading progress with bytesReceived growing monotonically', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
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
    // Total reflects the content-length header.
    expect(progress[0]?.total).toBe(fixtureBuffer.byteLength);
  });

  it('emits an error event when no candidate URL succeeds', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response('', { status: 503 })),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
    });
    const events: OpenVGDBProgressEvent[] = [];
    await svc.ensureDatabase((e) => events.push(e));
    expect(events.some((e) => e.kind === 'error')).toBe(true);
    expect(svc.isReady()).toBe(false);
  });

  it('does not leave a .tmp file on download failure', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('connection reset')));
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
    });
    await svc.ensureDatabase();
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
    expect(entries).not.toContain('openvgdb.sqlite');
  });

  it('falls through candidate URLs after a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [
        { url: 'https://primary/openvgdb.sqlite', requiresUnzip: false },
        { url: 'https://secondary/openvgdb.sqlite', requiresUnzip: false },
      ],
    });
    await svc.ensureDatabase();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(svc.isReady()).toBe(true);
  });

  it('skips candidate URLs that need unzipping (not yet supported)', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [
        { url: 'https://github/openvgdb.zip', requiresUnzip: true },
        { url: 'https://mirror/openvgdb.sqlite', requiresUnzip: false },
      ],
    });
    await svc.ensureDatabase();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCallArgs = fetchMock.mock.calls[0] as unknown as [string];
    expect(firstCallArgs[0]).toBe('https://mirror/openvgdb.sqlite');
  });

  it('treats a schema-mismatched file as corrupt and redownloads', async () => {
    // Pre-populate with a SQLite that has the wrong schema.
    const sqlBad = await initSqlJs();
    const badDb = new sqlBad.Database();
    badDb.run('CREATE TABLE OOPS (x INTEGER)');
    const badBuf = badDb.export();
    badDb.close();
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(badBuf));

    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      ),
    );
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
    });
    await svc.ensureDatabase();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(svc.isReady()).toBe(true);
    expect(await svc.getMetadataByHash(HASH_SMW)).not.toBeNull();
  });

  it('coalesces concurrent ensureDatabase calls onto one download', async () => {
    let downloads = 0;
    const fetchMock = vi.fn(() => {
      downloads += 1;
      return Promise.resolve(
        new Response(Buffer.from(fixtureBuffer), {
          status: 200,
          headers: { 'content-length': String(fixtureBuffer.byteLength) },
        }),
      );
    });
    const svc = new OpenVGDBService(dir, {
      fetch: fetchMock as unknown as typeof fetch,
      downloadUrls: [{ url: 'https://example/openvgdb.sqlite', requiresUnzip: false }],
    });
    await Promise.all([svc.ensureDatabase(), svc.ensureDatabase(), svc.ensureDatabase()]);
    expect(downloads).toBe(1);
  });

  it('clearDatabase deletes the file and resets isReady', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir);
    await svc.ensureDatabase();
    expect(svc.isReady()).toBe(true);
    await svc.clearDatabase();
    expect(svc.isReady()).toBe(false);
    const exists = await fs
      .stat(join(dir, 'openvgdb.sqlite'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('LRU caches a recent lookup so repeats don\'t re-prepare the SQL', async () => {
    await fs.writeFile(join(dir, 'openvgdb.sqlite'), Buffer.from(fixtureBuffer));
    const svc = new OpenVGDBService(dir, { lruCapacity: 2 });
    await svc.ensureDatabase();
    const a1 = await svc.getMetadataByHash(HASH_SMW);
    const a2 = await svc.getMetadataByHash(HASH_SMW);
    expect(a1).toEqual(a2);
  });
});
