import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import type {
  OpenVGDBMetadata,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
import { MetadataService } from '@app/main/metadata/metadata-service';
import type { RomMetadata } from '@shared/metadata-types';

const HASH = 'a'.repeat(32);

function buildDbHit(overrides: Partial<OpenVGDBMetadata> = {}): OpenVGDBMetadata {
  return {
    md5: HASH,
    name: 'Super Mario World',
    // Round 8: the No-Intro filename basename is what libretro keys
    // on. Default to the region-tagged form so test URL assertions
    // exercise the realistic path, not the title-only fallback.
    romBaseName: 'Super Mario World (USA)',
    system: 'Super Nintendo Entertainment System',
    year: 1991,
    genre: 'Platform',
    publisher: 'Nintendo',
    developer: 'Nintendo EAD',
    description: 'Mario rescues the princess.',
    region: 'USA',
    source: 'openvgdb',
    fetchedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Mocks {
  readonly openVgdb: OpenVGDBService;
  readonly thumbnails: LibretroThumbnailsFetcher;
  readonly dbCalls: string[];
}

function makeMocks(opts: { dbReturns?: OpenVGDBMetadata | null } = {}): Mocks {
  const dbCalls: string[] = [];
  const openVgdb = {
    getMetadataByHash: vi.fn(async (md5: string) => {
      dbCalls.push(md5);
      return opts.dbReturns ?? null;
    }),
    isReady: vi.fn(() => true),
    ensureDatabase: vi.fn(async () => undefined),
    clearDatabase: vi.fn(async () => undefined),
  } as unknown as OpenVGDBService;
  // Use the real LibretroThumbnailsFetcher — its URL builder is pure
  // and well-tested elsewhere.
  const thumbnails = new LibretroThumbnailsFetcher();
  return { openVgdb, thumbnails, dbCalls };
}

describe('MetadataService (round 3 — OpenVGDB + libretro)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-meta-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('composes OpenVGDB facts with libretro thumbnail URLs on a hit', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result).not.toBeNull();
    expect(result?.source).toBe('openvgdb');
    expect(result?.name).toBe('Super Mario World');
    expect(result?.system).toBe('Super Nintendo Entertainment System');
    expect(result?.year).toBe(1991);
    expect(result?.publisher).toBe('Nintendo');
    expect(result?.developer).toBe('Nintendo EAD');
    expect(result?.genre).toBe('Platform');
    // Box art / title / snap URLs come straight from the libretro
    // builder. Round 9: the CDN serves the spaced (`%20`) folder form.
    expect(result?.boxArtUrl).toContain(
      'Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/',
    );
    expect(result?.titleScreenUrl).toContain('/Named_Titles/');
    expect(result?.screenshotUrl).toContain('/Named_Snaps/');
  });

  it('uses romBaseName (No-Intro filename) for libretro URLs, not the release title — round 8', async () => {
    // libretro-thumbnails files use No-Intro DAT names that include
    // region tags; the release title strips them. Pre-round-8 we
    // built URLs from `name` and 404'd on every match. The filename
    // path is the "(USA)"-tagged form; the display name (`name`)
    // stays clean.
    const m = makeMocks({
      dbReturns: buildDbHit({
        name: 'Super Mario World',
        romBaseName: 'Super Mario World (USA)',
      }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Super Mario World');
    expect(result?.boxArtUrl).toContain('Super%20Mario%20World%20(USA).png');
    // The release title alone — i.e. without the "(USA)" annotation —
    // would 404 in the live archive. Pin that we're NOT using it.
    expect(result?.boxArtUrl).not.toContain('Super%20Mario%20World.png');
  });

  it('falls back to release title for the URL when romBaseName is null', async () => {
    // OpenVGDB sometimes has rows without a usable
    // romExtensionlessFileName. We still construct *some* URL from
    // the display name — it'll probably 404 in libretro but that's
    // a clean null downstream.
    const m = makeMocks({
      dbReturns: buildDbHit({
        name: 'Some Game',
        romBaseName: null,
      }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.boxArtUrl).toContain('Some%20Game.png');
  });

  it('writes a cache file in v3 shape', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    await svc.getMetadata(HASH);

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const onDisk = JSON.parse(await fs.readFile(path, 'utf-8')) as RomMetadata;
    expect(onDisk.version).toBe(3);
    expect(onDisk.source).toBe('openvgdb');
    expect(onDisk.system).toBe('Super Nintendo Entertainment System');
  });

  it('writes a "none" sentinel when the DB has no match', async () => {
    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result).toBeNull();

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const onDisk = JSON.parse(await fs.readFile(path, 'utf-8')) as RomMetadata;
    expect(onDisk.source).toBe('none');
    expect(onDisk.version).toBe(3);
  });

  it('hit on a system not in the libretro map → null thumbnail URLs but full metadata', async () => {
    const m = makeMocks({
      dbReturns: buildDbHit({
        system: 'Sharp X68000',
        name: 'Some Disk Game',
      }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Some Disk Game');
    expect(result?.boxArtUrl).toBeNull();
    expect(result?.titleScreenUrl).toBeNull();
    expect(result?.screenshotUrl).toBeNull();
  });

  it('cache hit: second call returns the same payload without hitting the DB', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    await svc.getMetadata(HASH);
    expect(m.dbCalls).toHaveLength(1);

    const second = await svc.getMetadata(HASH);
    expect(second?.name).toBe('Super Mario World');
    expect(m.dbCalls).toHaveLength(1); // unchanged
  });

  it('cache survives across MetadataService instances (state lives on disk)', async () => {
    const m1 = makeMocks({ dbReturns: buildDbHit() });
    const a = new MetadataService(dir, m1.openVgdb, m1.thumbnails);
    await a.getMetadata(HASH);

    const m2 = makeMocks({ dbReturns: null });
    const b = new MetadataService(dir, m2.openVgdb, m2.thumbnails);
    const result = await b.getMetadata(HASH);
    expect(result?.name).toBe('Super Mario World');
    expect(m2.dbCalls).toHaveLength(0);
  });

  it('returns null on a cached sentinel without re-querying', async () => {
    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, {
      now: () => Date.parse('2025-01-15T00:00:00Z'),
    });

    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(m.dbCalls).toHaveLength(1);

    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(m.dbCalls).toHaveLength(1); // sentinel still fresh
  });

  it('re-queries after the 30-day sentinel TTL expires', async () => {
    const m = makeMocks({ dbReturns: null });
    let now = Date.parse('2025-01-15T00:00:00Z');
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, {
      now: () => now,
    });

    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(m.dbCalls).toHaveLength(1);

    now += 31 * 24 * 60 * 60 * 1000;
    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(m.dbCalls).toHaveLength(2);
  });

  it('matched metadata never expires regardless of fetchedAt', async () => {
    // Pre-populate a current-version cache file with an old timestamp.
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    await fs.mkdir(join(dir, 'by-hash', HASH.slice(0, 2)), { recursive: true });
    const aged: RomMetadata = {
      version: 3,
      hash: HASH,
      name: 'Vintage Game',
      system: 'NES',
      year: 1985,
      publisher: null,
      developer: null,
      genre: null,
      description: null,
      boxArtUrl: null,
      titleScreenUrl: null,
      screenshotUrl: null,
      source: 'openvgdb',
      fetchedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await fs.writeFile(path, JSON.stringify(aged), 'utf-8');

    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Vintage Game');
    expect(m.dbCalls).toHaveLength(0);
  });

  it('treats a v1-shape cache file as a miss and refetches', async () => {
    // Round 1/2 cache files have version: 1. Schema bump means we
    // throw them away on read.
    const dirHash = HASH.slice(0, 2);
    await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
    await fs.writeFile(
      join(dir, 'by-hash', dirHash, `${HASH}.json`),
      JSON.stringify({ version: 1, hash: HASH, name: 'old shape', source: 'screenscraper' }),
    );
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Super Mario World');
    expect(result?.source).toBe('openvgdb');
  });

  it('evicts v2 cache files on read so round-9 URLs replace round-4–8 ones', async () => {
    // Rounds 4–8 wrote v2 with libretro URLs that pointed at the
    // underscored host path (which 404s). Round 9 bumped to v3; the
    // parser now rejects v2 entries the same way it rejects v1.
    const dirHash = HASH.slice(0, 2);
    await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
    const stale = {
      version: 2,
      hash: HASH,
      name: 'Sonic The Hedgehog 2',
      system: 'Sega Genesis/Mega Drive',
      year: 1992,
      publisher: 'Sega',
      developer: 'Sega Technical Institute',
      genre: 'Platform',
      description: null,
      // The bug: underscored folder, would 404 if served.
      boxArtUrl:
        'https://thumbnails.libretro.com/Sega_-_Mega_Drive_-_Genesis/Named_Boxarts/Sonic%20The%20Hedgehog%202%20(World).png',
      titleScreenUrl: null,
      screenshotUrl: null,
      source: 'openvgdb',
      fetchedAt: new Date().toISOString(),
    };
    await fs.writeFile(
      join(dir, 'by-hash', dirHash, `${HASH}.json`),
      JSON.stringify(stale),
    );
    const m = makeMocks({
      dbReturns: buildDbHit({
        name: 'Sonic The Hedgehog 2',
        romBaseName: 'Sonic The Hedgehog 2 (World)',
        system: 'Sega Genesis/Mega Drive',
      }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    // The replacement URL uses the spaced form.
    expect(result?.boxArtUrl).toContain(
      'Sega%20-%20Mega%20Drive%20-%20Genesis',
    );
    expect(result?.boxArtUrl).not.toContain('Sega_-_Mega_Drive_-_Genesis');
  });

  it('treats a corrupted cache file as a miss and refetches', async () => {
    const dirHash = HASH.slice(0, 2);
    await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
    await fs.writeFile(
      join(dir, 'by-hash', dirHash, `${HASH}.json`),
      '{ this is not valid json',
    );
    const m = makeMocks({ dbReturns: buildDbHit({ name: 'Recovered' }) });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Recovered');
  });

  it('invalidate removes one entry; next call re-fetches', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    await svc.getMetadata(HASH);
    await svc.invalidate(HASH);
    await svc.getMetadata(HASH);
    expect(m.dbCalls).toHaveLength(2);
  });

  it('clearAll wipes the by-hash directory', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    await svc.getMetadata(HASH);
    await svc.clearAll();
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const exists = await fs.stat(path).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('shards by-hash files into 2-char prefix subdirs', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    await svc.getMetadata(HASH);
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    await expect(fs.stat(path)).resolves.toBeDefined();
  });

  it('deduplicates concurrent getMetadata calls for the same hash', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const [a, b] = await Promise.all([svc.getMetadata(HASH), svc.getMetadata(HASH)]);
    expect(a?.name).toBe(b?.name);
    expect(m.dbCalls).toHaveLength(1);
  });

  it('handles an OpenVGDB row missing a year (date is null)', async () => {
    const m = makeMocks({
      dbReturns: buildDbHit({ year: null }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails);
    const result = await svc.getMetadata(HASH);
    expect(result?.year).toBeNull();
    expect(result?.name).toBe('Super Mario World');
  });
});
