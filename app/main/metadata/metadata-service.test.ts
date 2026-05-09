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
import {
  ScreenScraperAuthError,
  type ScreenScraperGame,
  type ScreenScraperLookupQuery,
  type ScreenScraperService,
} from '@app/main/metadata/screenscraper-service';
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result?.boxArtUrl).toContain('Some%20Game.png');
  });

  it('writes a cache file in v4 shape', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    await svc.getMetadata(HASH);

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const onDisk = JSON.parse(await fs.readFile(path, 'utf-8')) as RomMetadata;
    expect(onDisk.version).toBe(4);
    expect(onDisk.source).toBe('openvgdb');
    expect(onDisk.system).toBe('Super Nintendo Entertainment System');
  });

  it('writes a "none" sentinel when the DB has no match', async () => {
    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result).toBeNull();

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const onDisk = JSON.parse(await fs.readFile(path, 'utf-8')) as RomMetadata;
    expect(onDisk.source).toBe('none');
    expect(onDisk.version).toBe(4);
  });

  it('hit on a system not in the libretro map → null thumbnail URLs but full metadata', async () => {
    const m = makeMocks({
      dbReturns: buildDbHit({
        system: 'Sharp X68000',
        name: 'Some Disk Game',
      }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result).not.toBeNull();
    expect(result?.name).toBe('Some Disk Game');
    expect(result?.boxArtUrl).toBeNull();
    expect(result?.titleScreenUrl).toBeNull();
    expect(result?.screenshotUrl).toBeNull();
  });

  it('cache hit: second call returns the same payload without hitting the DB', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    await svc.getMetadata(HASH);
    expect(m.dbCalls).toHaveLength(1);

    const second = await svc.getMetadata(HASH);
    expect(second?.name).toBe('Super Mario World');
    expect(m.dbCalls).toHaveLength(1); // unchanged
  });

  it('cache survives across MetadataService instances (state lives on disk)', async () => {
    const m1 = makeMocks({ dbReturns: buildDbHit() });
    const a = new MetadataService(dir, m1.openVgdb, m1.thumbnails, null);
    await a.getMetadata(HASH);

    const m2 = makeMocks({ dbReturns: null });
    const b = new MetadataService(dir, m2.openVgdb, m2.thumbnails, null);
    const result = await b.getMetadata(HASH);
    expect(result?.name).toBe('Super Mario World');
    expect(m2.dbCalls).toHaveLength(0);
  });

  it('returns null on a cached sentinel without re-querying', async () => {
    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null, {
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null, {
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
      version: 4,
      hash: HASH,
      name: 'Vintage Game',
      system: 'NES',
      year: 1985,
      publisher: null,
      developer: null,
      genre: null,
      description: null,
      players: null,
      rating: null,
      releaseDate: null,
      boxArtUrl: null,
      titleScreenUrl: null,
      screenshotUrl: null,
      source: 'openvgdb',
      fetchedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    };
    await fs.writeFile(path, JSON.stringify(aged), 'utf-8');

    const m = makeMocks({ dbReturns: null });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Super Mario World');
    expect(result?.source).toBe('openvgdb');
  });

  it('evicts old-version cache files (v2/v3) so PR #16 round 2 records replace them', async () => {
    // Rounds 4–8 wrote v2 with libretro URLs that pointed at the
    // underscored host path (which 404s). Round 9 bumped to v3 to
    // evict those. Round 2 of PR #16 bumps to v4 to make room for
    // the SS-only fields and let users upgrading get richer data.
    // The parser rejects anything that isn't the current version.
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
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
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Recovered');
  });

  it('invalidate removes one entry; next call re-fetches', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    await svc.getMetadata(HASH);
    await svc.invalidate(HASH);
    await svc.getMetadata(HASH);
    expect(m.dbCalls).toHaveLength(2);
  });

  it('clearAll wipes the by-hash directory', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    await svc.getMetadata(HASH);
    await svc.clearAll();
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const exists = await fs.stat(path).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('shards by-hash files into 2-char prefix subdirs', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    await svc.getMetadata(HASH);
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    await expect(fs.stat(path)).resolves.toBeDefined();
  });

  it('deduplicates concurrent getMetadata calls for the same hash', async () => {
    const m = makeMocks({ dbReturns: buildDbHit() });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const [a, b] = await Promise.all([svc.getMetadata(HASH), svc.getMetadata(HASH)]);
    expect(a?.name).toBe(b?.name);
    expect(m.dbCalls).toHaveLength(1);
  });

  it('handles an OpenVGDB row missing a year (date is null)', async () => {
    const m = makeMocks({
      dbReturns: buildDbHit({ year: null }),
    });
    const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, null);
    const result = await svc.getMetadata(HASH);
    expect(result?.year).toBeNull();
    expect(result?.name).toBe('Super Mario World');
  });

  describe('round 2 — source priority chain (SS → OpenVGDB → none)', () => {
    /** Stub a ScreenScraperService with a chosen status / response. */
    function makeSS(opts: {
      status?: 'available' | 'unavailable' | 'rate-limited' | 'quota-exceeded';
      result?: ScreenScraperGame | null;
      throws?: Error;
    } = {}): {
      svc: ScreenScraperService;
      lookupCalls: ScreenScraperLookupQuery[];
    } {
      const lookupCalls: ScreenScraperLookupQuery[] = [];
      const stub = {
        getStatus: vi.fn(() => opts.status ?? 'available'),
        lookup: vi.fn(async (q: ScreenScraperLookupQuery) => {
          lookupCalls.push(q);
          if (opts.throws !== undefined) throw opts.throws;
          return opts.result ?? null;
        }),
      } as unknown as ScreenScraperService;
      return { svc: stub, lookupCalls };
    }

    function buildSsHit(
      overrides: Partial<ScreenScraperGame> = {},
    ): ScreenScraperGame {
      return {
        id: 1234,
        name: 'Super Mario World',
        system: 'Super Nintendo Entertainment System',
        description: 'Mario rescues the princess.',
        developer: 'Nintendo EAD',
        publisher: 'Nintendo',
        genres: ['Platform', 'Action'],
        releaseDate: '1991-08-13',
        rating: 9.5,
        players: '1-2',
        boxArtUrl: 'https://ss-cdn/box.png',
        extra: {
          box3DUrl: null,
          marqueeUrl: null,
          titleScreenUrl: 'https://ss-cdn/title.png',
          snapUrl: 'https://ss-cdn/snap.png',
          clearLogoUrl: null,
          screenshots: [],
        },
        ...overrides,
      };
    }

    const SS_HINT = {
      systemId: 4,
      md5: HASH,
      sha1: 'b'.repeat(40),
      crc32: 'deadbeef',
      romName: 'Super Mario World (USA).sfc',
      romSize: 524288,
    };

    it('SS match wins outright; OpenVGDB never queried', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(result?.name).toBe('Super Mario World');
      expect(result?.boxArtUrl).toBe('https://ss-cdn/box.png');
      expect(result?.players).toBe('1-2');
      expect(result?.rating).toBe(9.5);
      expect(result?.releaseDate).toBe('1991-08-13');
      expect(result?.description).toBe('Mario rescues the princess.');
      expect(m.dbCalls).toHaveLength(0);
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('SS query carries every hash + romName + romSize from the hint', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      await svc.getMetadata(HASH, {}, SS_HINT);
      expect(ss.lookupCalls[0]).toEqual({
        systemId: 4,
        md5: HASH,
        sha1: 'b'.repeat(40),
        crc32: 'deadbeef',
        romName: 'Super Mario World (USA).sfc',
        romSize: 524288,
      });
    });

    it('SS no-match → fall through to OpenVGDB', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      expect(m.dbCalls).toHaveLength(1);
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('SS unavailable → silently skip; OpenVGDB queried', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ status: 'unavailable' });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      // Crucially, SS.lookup wasn't called — getStatus gated it.
      expect(ss.lookupCalls).toHaveLength(0);
      expect(m.dbCalls).toHaveLength(1);
    });

    it('SS rate-limited → silently skip; OpenVGDB queried', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ status: 'rate-limited' });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      expect(ss.lookupCalls).toHaveLength(0);
    });

    it('SS quota-exceeded → silently skip; OpenVGDB queried', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ status: 'quota-exceeded' });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      expect(ss.lookupCalls).toHaveLength(0);
    });

    it('SS auth error caught and logged; falls through to OpenVGDB', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ throws: new ScreenScraperAuthError(403) });
      const log = vi.fn();
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
        { logger: log },
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/auth failed/i),
      );
    });

    it('without ssHint, SS is bypassed entirely (OpenVGDB-only path)', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      // No SS hint passed → service stays in OpenVGDB-first mode.
      const result = await svc.getMetadata(HASH);
      expect(result?.source).toBe('openvgdb');
      expect(ss.lookupCalls).toHaveLength(0);
    });

    it('with screenScraper=null, SS hint is ignored', async () => {
      const m = makeMocks({ dbReturns: buildDbHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        null,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
    });

    it('SS-sourced cache survives a follow-up call (no re-query)', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      await svc.getMetadata(HASH, {}, SS_HINT);
      const second = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(second?.source).toBe('screenscraper');
      // SS lookup ran once, then cache served the second call.
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('SS-sourced metadata exposes genres as comma-joined string', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({
        result: buildSsHit({ genres: ['Platform', 'Action', 'Adventure'] }),
      });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.genre).toBe('Platform, Action, Adventure');
    });

    it('SS-sourced metadata derives year from releaseDate', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({
        result: buildSsHit({ releaseDate: '1991-08-13' }),
      });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.year).toBe(1991);
      expect(result?.releaseDate).toBe('1991-08-13');
    });

    it('SS-sourced metadata populates system from the SS response (round 4)', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({
        result: buildSsHit({ system: 'Sega Mega Drive' }),
      });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      // Comes straight from `game.system` (parsed from
      // `response.jeu.systeme.nom`) — independent of any local map.
      expect(result?.system).toBe('Sega Mega Drive');
    });

    it('SS-sourced metadata falls back to empty system when SS response omits systeme.nom', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit({ system: null }) });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(result?.system).toBe('');
    });
  });

  describe('round 3 — cache priority on source upgrade', () => {
    /** Stub helpers — same shape as the round-2 SS describe block. */
    function makeSS(opts: {
      status?: 'available' | 'unavailable' | 'rate-limited' | 'quota-exceeded';
      result?: ScreenScraperGame | null;
    } = {}): {
      svc: ScreenScraperService;
      lookupCalls: ScreenScraperLookupQuery[];
    } {
      const lookupCalls: ScreenScraperLookupQuery[] = [];
      const stub = {
        getStatus: vi.fn(() => opts.status ?? 'available'),
        lookup: vi.fn(async (q: ScreenScraperLookupQuery) => {
          lookupCalls.push(q);
          return opts.result ?? null;
        }),
      } as unknown as ScreenScraperService;
      return { svc: stub, lookupCalls };
    }

    function buildSsHit(
      overrides: Partial<ScreenScraperGame> = {},
    ): ScreenScraperGame {
      return {
        id: 1234,
        name: 'Super Mario World',
        system: 'Super Nintendo Entertainment System',
        description: null,
        developer: null,
        publisher: null,
        genres: [],
        releaseDate: null,
        rating: null,
        players: null,
        boxArtUrl: null,
        extra: {
          box3DUrl: null,
          marqueeUrl: null,
          titleScreenUrl: null,
          snapUrl: null,
          clearLogoUrl: null,
          screenshots: [],
        },
        ...overrides,
      };
    }

    const SS_HINT = {
      systemId: 4,
      md5: HASH,
      sha1: 'b'.repeat(40),
      crc32: undefined,
      romName: 'Super Mario World (USA).sfc',
      romSize: 524288,
    };

    /** Pre-populate a cache file with the given record. */
    async function seedCache(meta: RomMetadata): Promise<void> {
      const dirHash = HASH.slice(0, 2);
      await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
      await fs.writeFile(
        join(dir, 'by-hash', dirHash, `${HASH}.json`),
        JSON.stringify(meta),
      );
    }

    function ssCachedMeta(): RomMetadata {
      return {
        version: 4,
        hash: HASH,
        name: 'Super Mario World (cached SS)',
        system: 'Super Nintendo Entertainment System',
        year: 1991,
        publisher: 'Nintendo',
        developer: 'Nintendo EAD',
        genre: 'Platform',
        description: null,
        players: '1',
        rating: 9.5,
        releaseDate: '1991-08-13',
        boxArtUrl: 'https://ss-cdn/box.png',
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'screenscraper',
        fetchedAt: new Date().toISOString(),
      };
    }

    function openVgdbCachedMeta(): RomMetadata {
      return {
        version: 4,
        hash: HASH,
        name: 'Super Mario World (cached OpenVGDB)',
        system: 'Super Nintendo Entertainment System',
        year: 1991,
        publisher: 'Nintendo',
        developer: 'Nintendo EAD',
        genre: 'Platform',
        description: null,
        players: null,
        rating: null,
        releaseDate: null,
        boxArtUrl: 'https://thumbnails.libretro/box.png',
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'openvgdb',
        fetchedAt: new Date().toISOString(),
      };
    }

    function noneCachedMeta(fetchedAt = new Date().toISOString()): RomMetadata {
      return {
        version: 4,
        hash: HASH,
        name: '(no match)',
        system: '',
        year: null,
        publisher: null,
        developer: null,
        genre: null,
        description: null,
        players: null,
        rating: null,
        releaseDate: null,
        boxArtUrl: null,
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'none',
        fetchedAt,
      };
    }

    it('cached as openvgdb, SS becomes available → re-fetches and stores as screenscraper', async () => {
      await seedCache(openVgdbCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({
        result: buildSsHit({ name: 'Super Mario World (fresh SS)' }),
      });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(result?.name).toBe('Super Mario World (fresh SS)');
      expect(ss.lookupCalls).toHaveLength(1);
      // The on-disk record has been replaced.
      const onDisk = JSON.parse(
        await fs.readFile(
          join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`),
          'utf-8',
        ),
      ) as RomMetadata;
      expect(onDisk.source).toBe('screenscraper');
      expect(onDisk.name).toBe('Super Mario World (fresh SS)');
    });

    it('cached as screenscraper, SS still available → cache hit, no re-fetch', async () => {
      await seedCache(ssCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(result?.name).toBe('Super Mario World (cached SS)');
      expect(ss.lookupCalls).toHaveLength(0);
    });

    it('cached as screenscraper, SS now unavailable → cache hit (no downgrade to OpenVGDB)', async () => {
      // User had SS configured before; now removed creds. Cached
      // SS-sourced data should keep serving — we'd rather show stable
      // SS data than degrade to a fresh OpenVGDB record on every read.
      await seedCache(ssCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ status: 'unavailable' });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(result?.name).toBe('Super Mario World (cached SS)');
      expect(ss.lookupCalls).toHaveLength(0);
      expect(m.dbCalls).toHaveLength(0);
    });

    it('cached as none (sentinel), SS becomes available → re-fetches even within TTL', async () => {
      // Sentinel was fresh — TTL hasn't elapsed — but a higher-priority
      // source becoming available is its own re-fetch trigger. Lets a
      // user who configures SS creds AFTER a cold OpenVGDB run pick up
      // matches without manually clearing the cache.
      await seedCache(noneCachedMeta()); // freshly written
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('screenscraper');
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('cached as none (sentinel), SS still unavailable → null without re-fetch (existing TTL behavior)', async () => {
      await seedCache(noneCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ status: 'unavailable' });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result).toBeNull();
      expect(ss.lookupCalls).toHaveLength(0);
      expect(m.dbCalls).toHaveLength(0);
    });

    it('cached as openvgdb, no ssHint supplied → cache hit (orchestrator can\'t upgrade)', async () => {
      // SS may be configured but we can't query without the
      // hash + systemId payload. Don't pretend we can upgrade.
      await seedCache(openVgdbCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: buildSsHit() });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
      );
      const result = await svc.getMetadata(HASH, {} /* no ssHint */);
      expect(result?.source).toBe('openvgdb');
      expect(result?.name).toBe('Super Mario World (cached OpenVGDB)');
      expect(ss.lookupCalls).toHaveLength(0);
    });

    it('cached as openvgdb, screenScraper=null on construction → cache hit (no upgrade path)', async () => {
      await seedCache(openVgdbCachedMeta());
      const m = makeMocks({ dbReturns: null });
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        null,
      );
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result?.source).toBe('openvgdb');
      expect(result?.name).toBe('Super Mario World (cached OpenVGDB)');
    });
  });

  describe('round 9 — sentinel ssAvailableAtWrite split', () => {
    /**
     * Helpers reused by every round-9 test. SS_HINT carries the
     * shape an SS-eligible call would supply; the SS service stub's
     * `lookup` is how we observe whether SS was queried.
     */
    function makeSS(opts: {
      status?: 'available' | 'unavailable' | 'rate-limited' | 'quota-exceeded';
      result?: ScreenScraperGame | null;
    } = {}): {
      svc: ScreenScraperService;
      lookupCalls: ScreenScraperLookupQuery[];
    } {
      const lookupCalls: ScreenScraperLookupQuery[] = [];
      const stub = {
        getStatus: vi.fn(() => opts.status ?? 'available'),
        lookup: vi.fn(async (q: ScreenScraperLookupQuery) => {
          lookupCalls.push(q);
          return opts.result ?? null;
        }),
      } as unknown as ScreenScraperService;
      return { svc: stub, lookupCalls };
    }

    const SS_HINT_R9 = {
      systemId: 4,
      md5: HASH,
      sha1: 'b'.repeat(40),
      crc32: undefined,
      romName: 'Some ROM.sfc',
      romSize: 1024,
    };

    async function seedCache(meta: RomMetadata): Promise<void> {
      const dirHash = HASH.slice(0, 2);
      await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
      await fs.writeFile(
        join(dir, 'by-hash', dirHash, `${HASH}.json`),
        JSON.stringify(meta),
      );
    }

    function buildSentinel(
      ssAvailableAtWrite: boolean | undefined,
      fetchedAt = new Date().toISOString(),
      // Round 2 (PR #27 round 2): default true so existing round-9
      // tests model "post-D1 sentinel" semantics. The pre-D1 retry
      // path is exercised by separate tests that explicitly pass
      // false / undefined.
      triedNameSearch: boolean | undefined = true,
    ): RomMetadata {
      const base: RomMetadata = {
        version: 4,
        hash: HASH,
        name: '(no match)',
        system: '',
        year: null,
        publisher: null,
        developer: null,
        genre: null,
        description: null,
        players: null,
        rating: null,
        releaseDate: null,
        boxArtUrl: null,
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'none',
        fetchedAt,
      };
      const withSs =
        ssAvailableAtWrite === undefined
          ? base
          : { ...base, ssAvailableAtWrite };
      return triedNameSearch === undefined
        ? withSs
        : { ...withSs, triedNameSearch };
    }

    it('authoritative sentinel (ssAvailableAtWrite=true) within TTL → use cache, no SS call', async () => {
      // The boot.rom-loop fix: a sentinel written when SS was
      // available is a definitive no-match. Within 7 days we serve
      // the cached null without re-asking SS.
      await seedCache(buildSentinel(true));
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(result).toBeNull();
      expect(ss.lookupCalls).toHaveLength(0);
      expect(m.dbCalls).toHaveLength(0);
    });

    it('authoritative sentinel past TTL → refetch (retry once)', async () => {
      // Past 7 days, give SS another chance — the upstream might
      // have indexed the ROM in the meantime.
      const oldFetchedAt = new Date(
        Date.now() - 8 * 24 * 60 * 60 * 1000,
      ).toISOString();
      await seedCache(buildSentinel(true, oldFetchedAt));
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('poisoned sentinel (ssAvailableAtWrite=false), SS now available → refetch', async () => {
      // The "user added SS creds after a credless run" recovery
      // path. Sentinels written without SS get the next available
      // SS call.
      await seedCache(buildSentinel(false));
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('legacy sentinel (ssAvailableAtWrite=undefined) treated as poisoned', async () => {
      // Pre-round-9 v4 records lack the bit. Treat them as poisoned
      // so first-read after upgrade gets an opportunistic SS call.
      await seedCache(buildSentinel(undefined));
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(ss.lookupCalls).toHaveLength(1);
    });

    it('poisoned sentinel, SS still unavailable → use cache (no upgrade path)', async () => {
      await seedCache(buildSentinel(false));
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ status: 'unavailable' });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(result).toBeNull();
      expect(ss.lookupCalls).toHaveLength(0);
      expect(m.dbCalls).toHaveLength(0);
    });

    it('newly-written sentinel records ssAvailableAtWrite=true when SS was available and missed', async () => {
      // Cold path: cache empty, SS available + misses, OpenVGDB
      // empty. The written sentinel must carry true so the next
      // read uses the authoritative TTL path.
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ result: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      const cachePath = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
      const written = JSON.parse(
        await fs.readFile(cachePath, 'utf-8'),
      ) as RomMetadata;
      expect(written.source).toBe('none');
      expect(written.ssAvailableAtWrite).toBe(true);
    });

    it('newly-written sentinel records ssAvailableAtWrite=false when SS was unavailable', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS({ status: 'unavailable' });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      const cachePath = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
      const written = JSON.parse(
        await fs.readFile(cachePath, 'utf-8'),
      ) as RomMetadata;
      expect(written.source).toBe('none');
      expect(written.ssAvailableAtWrite).toBe(false);
    });
  });

  describe('round 9 — within-session SS-attempt dedup', () => {
    function makeSS(): {
      svc: ScreenScraperService;
      lookupCalls: number;
    } {
      const state = { calls: 0 };
      const stub = {
        getStatus: vi.fn(() => 'available' as const),
        lookup: vi.fn(async () => {
          state.calls += 1;
          return null;
        }),
      } as unknown as ScreenScraperService;
      return {
        svc: stub,
        get lookupCalls() {
          return state.calls;
        },
      };
    }

    const SS_HINT_R9 = {
      systemId: 4,
      md5: HASH,
      sha1: 'b'.repeat(40),
      crc32: undefined,
      romName: 'Some ROM.sfc',
      romSize: 1024,
    };

    it('two consecutive getMetadata calls within window → only one SS network call', async () => {
      // Test seam: time stays put across both calls so the second is
      // unambiguously inside the dedup window.
      const fixedNow = 1_700_000_000_000;
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS();
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
        { now: () => fixedNow, ssAttemptDedupMs: 60_000 },
      );
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      // Wipe the disk cache so the second call would otherwise
      // re-enter the SS path.
      await fs.rm(join(dir, 'by-hash'), { recursive: true, force: true });
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(ss.lookupCalls).toBe(1);
    });

    it('past the dedup window → next call hits SS again', async () => {
      let now = 1_700_000_000_000;
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS();
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
        { now: () => now, ssAttemptDedupMs: 60_000 },
      );
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      await fs.rm(join(dir, 'by-hash'), { recursive: true, force: true });
      now += 60_001; // step just past the window
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      expect(ss.lookupCalls).toBe(2);
    });

    it('different hashes are deduped independently', async () => {
      const otherHash = 'c'.repeat(32);
      const fixedNow = 1_700_000_000_000;
      const m = makeMocks({ dbReturns: null });
      const ss = makeSS();
      const svc = new MetadataService(
        dir,
        m.openVgdb,
        m.thumbnails,
        ss.svc,
        { now: () => fixedNow, ssAttemptDedupMs: 60_000 },
      );
      await svc.getMetadata(HASH, {}, SS_HINT_R9);
      await svc.getMetadata(otherHash, {}, { ...SS_HINT_R9, md5: otherHash });
      expect(ss.lookupCalls).toBe(2);
    });
  });

  describe('PR-D1 (PR #27) — name-search fallback', () => {
    /**
     * Stub a ScreenScraper service that supports BOTH `lookup` (hash)
     * and `searchByName`. Returns lookup result first; if lookup is
     * null, searchByName fires per-hint and the test fixture controls
     * the candidate list per search term.
     */
    function makeSearchSS(opts: {
      readonly lookupResult?: ScreenScraperGame | null;
      readonly searchResults?: Record<string, readonly ScreenScraperGame[]>;
    } = {}): {
      readonly svc: ScreenScraperService;
      readonly searchCalls: { systemId: number; searchTerm: string }[];
    } {
      const searchCalls: { systemId: number; searchTerm: string }[] = [];
      const stub = {
        getStatus: vi.fn(() => 'available'),
        lookup: vi.fn(async () => opts.lookupResult ?? null),
        searchByName: vi.fn(
          async (args: { systemId: number; searchTerm: string }) => {
            searchCalls.push(args);
            return opts.searchResults?.[args.searchTerm] ?? [];
          },
        ),
      } as unknown as ScreenScraperService;
      return { svc: stub, searchCalls };
    }

    function buildSsHit(
      overrides: Partial<ScreenScraperGame> = {},
    ): ScreenScraperGame {
      return {
        id: 1234,
        name: 'Metal Slug 2',
        system: 'Arcade',
        description: 'Run-and-gun.',
        developer: 'SNK',
        publisher: 'SNK',
        genres: ['Action', 'Run and Gun'],
        releaseDate: '1998-04-02',
        rating: 9,
        players: '1-2',
        boxArtUrl: 'https://ss-cdn/box.png',
        extra: {
          box3DUrl: null,
          marqueeUrl: null,
          titleScreenUrl: null,
          snapUrl: null,
          clearLogoUrl: null,
          screenshots: [],
        },
        ...overrides,
      };
    }

    const SS_HINT = {
      systemId: 75,
      md5: HASH,
      sha1: 'b'.repeat(40),
      crc32: 'deadbeef',
      romName: 'mslug2.neo',
      romSize: 1024,
    };

    it('hash miss + name-search high-confidence hit → binds with source=screenscraper-name-search', async () => {
      // Hash misses both SS + OpenVGDB. The paren-shortname hint
      // `mslug2` returns a candidate scoring exact (1.0) → bind.
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        searchResults: { mslug2: [buildSsHit({ name: 'mslug2' })] },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(
        HASH,
        { filename: 'Metal Slug 2 (mslug2).neo' },
        SS_HINT,
      );
      expect(result?.source).toBe('screenscraper-name-search');
      expect(result?.name).toBe('mslug2');
    });

    it('cache the name-search result so re-fetches use it without re-querying', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        searchResults: {
          'Metal Slug 2': [buildSsHit({ name: 'Metal Slug 2' })],
        },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      // Round 2 (PR #27 round 2): mark parent atomic so the folder
      // hint actually emits — round 1's tests assumed unconditional
      // emission; round 2 gates it on parentFolderIsAtomic.
      const hint = {
        filename: 'mslug2.neo',
        parentFolder: 'Metal Slug 2',
        parentFolderIsAtomic: true,
      };
      const first = await svc.getMetadata(HASH, hint, SS_HINT);
      expect(first?.source).toBe('screenscraper-name-search');
      const before = ss.searchCalls.length;
      const second = await svc.getMetadata(HASH, hint, SS_HINT);
      expect(second?.source).toBe('screenscraper-name-search');
      // Cache hit on the second call — no additional searchByName.
      expect(ss.searchCalls.length).toBe(before);
    });

    it('low-confidence top result → sentinel write, NO bind', async () => {
      // Search returns a candidate, but the score is below the
      // auto-bind threshold (0.9). Better to leave the row blank.
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        // Search term "mslug2"; top candidate "Completely Unrelated Game".
        // Score: distance > 2, no token overlap → 0.
        searchResults: {
          mslug2: [buildSsHit({ name: 'Completely Unrelated Game' })],
        },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(
        HASH,
        { filename: 'Metal Slug 2 (mslug2).neo' },
        SS_HINT,
      );
      expect(result).toBeNull();
    });

    it('parent-folder hint wins over paren-shortname when both score equally (atomic)', async () => {
      // Engine fires hints in priority order. Parent-folder is
      // first; if it gets a high-confidence match, paren-shortname
      // is never queried (saves an API call).
      // Round 2: must mark parentFolderIsAtomic so the folder hint
      // actually fires.
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        searchResults: {
          // Parent folder "Metal Slug 2" hits exact.
          'Metal Slug 2': [buildSsHit({ name: 'Metal Slug 2' })],
          // Would also hit but never asked because folder won first.
          mslug2: [buildSsHit({ name: 'mslug2' })],
        },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(
        HASH,
        {
          filename: 'Metal Slug 2 (mslug2).neo',
          parentFolder: 'Metal Slug 2',
          parentFolderIsAtomic: true,
        },
        SS_HINT,
      );
      // Only the parent-folder search fired.
      expect(ss.searchCalls.map((c) => c.searchTerm)).toEqual([
        'Metal Slug 2',
      ]);
    });

    it('falls through to next hint when first returns no candidates (atomic)', () => {
      // Atomic-folder shape: parent folder doesn't search-hit, but
      // paren-shortname does.
      // Round 2: must mark parentFolderIsAtomic for folder hint to
      // fire at all.
      return (async () => {
        const m = makeMocks({ dbReturns: null });
        const ss = makeSearchSS({
          lookupResult: null,
          searchResults: {
            // Parent-folder search returns nothing.
            'Cleaned Folder Name': [],
            // paren-shortname `mslug2` hits.
            mslug2: [buildSsHit({ name: 'mslug2' })],
          },
        });
        const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
        const result = await svc.getMetadata(
          HASH,
          {
            filename: 'Metal Slug 2 (mslug2).neo',
            parentFolder: 'Cleaned Folder Name',
            parentFolderIsAtomic: true,
          },
          SS_HINT,
        );
        expect(result?.source).toBe('screenscraper-name-search');
        expect(ss.searchCalls.map((c) => c.searchTerm)).toEqual([
          'Cleaned Folder Name',
          'mslug2',
        ]);
      })();
    });

    it('round 2: parent folder NOT atomic → folder hint suppressed (avoids 1 World A-Z waste)', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        searchResults: {
          // Even if the org-folder name happened to match a real game,
          // we don't query for it.
          '1 World A-Z': [buildSsHit({ name: '1 World A-Z' })],
          mslug2: [buildSsHit({ name: 'mslug2' })],
        },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(
        HASH,
        {
          filename: 'Metal Slug 2 (mslug2).neo',
          parentFolder: '1 World A-Z',
          parentFolderIsAtomic: false,
        },
        SS_HINT,
      );
      // Only paren-shortname searched — folder hint suppressed.
      expect(ss.searchCalls.map((c) => c.searchTerm)).toEqual(['mslug2']);
    });

    it('skips name-search when filename hint is missing', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({ lookupResult: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      // No filename in hint — name-search should not fire.
      const result = await svc.getMetadata(HASH, {}, SS_HINT);
      expect(result).toBeNull();
      expect(ss.searchCalls).toEqual([]);
    });

    it('skips name-search when ssHint is missing (no system id to scope search)', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({ lookupResult: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      // No ssHint passed — name-search needs the systemId; skipped.
      const result = await svc.getMetadata(HASH, {
        filename: 'Game.nes',
      });
      expect(result).toBeNull();
      expect(ss.searchCalls).toEqual([]);
    });

    it('round 2: pre-D1 sentinel (triedNameSearch=undefined) retries when SS is available', async () => {
      // The "user upgraded to PR-D1 with existing cache" recovery
      // path. Pre-D1 sentinels lack the triedNameSearch flag → the
      // cache decision treats them as "needs retry once" so legacy
      // misses get a chance at the new pipeline.
      const m = makeMocks({ dbReturns: null });
      // Seed with a pre-D1 sentinel: source=none, ssAvailableAtWrite=true,
      // NO triedNameSearch field.
      const oldSentinel: RomMetadata = {
        version: 4,
        hash: HASH,
        name: '(no match)',
        system: '',
        year: null,
        publisher: null,
        developer: null,
        genre: null,
        description: null,
        players: null,
        rating: null,
        releaseDate: null,
        boxArtUrl: null,
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'none',
        fetchedAt: new Date().toISOString(),
        ssAvailableAtWrite: true,
        // triedNameSearch intentionally absent — pre-D1 record
      };
      const cachePath = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
      await fs.mkdir(join(dir, 'by-hash', HASH.slice(0, 2)), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(oldSentinel));
      // SS available; name-search returns a candidate that scores high.
      const ss = makeSearchSS({
        lookupResult: null,
        searchResults: { mslug2: [buildSsHit({ name: 'mslug2' })] },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(
        HASH,
        { filename: 'Metal Slug 2 (mslug2).neo' },
        SS_HINT,
      );
      // Pre-D1 sentinel was retried, name-search bound the result.
      expect(result?.source).toBe('screenscraper-name-search');
      expect(ss.searchCalls.length).toBeGreaterThan(0);
    });

    it('round 2: post-D1 sentinel (triedNameSearch=true) is honored within TTL — no retry', async () => {
      // After PR-D1 wrote the sentinel with triedNameSearch=true,
      // subsequent reads honor the authoritative TTL — no infinite
      // retry loop, no API budget waste.
      const m = makeMocks({ dbReturns: null });
      const post: RomMetadata = {
        version: 4,
        hash: HASH,
        name: '(no match)',
        system: '',
        year: null,
        publisher: null,
        developer: null,
        genre: null,
        description: null,
        players: null,
        rating: null,
        releaseDate: null,
        boxArtUrl: null,
        titleScreenUrl: null,
        screenshotUrl: null,
        source: 'none',
        fetchedAt: new Date().toISOString(),
        ssAvailableAtWrite: true,
        triedNameSearch: true,
      };
      const cachePath = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
      await fs.mkdir(join(dir, 'by-hash', HASH.slice(0, 2)), { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(post));
      const ss = makeSearchSS({ lookupResult: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(
        HASH,
        { filename: 'mslug2.neo' },
        SS_HINT,
      );
      expect(result).toBeNull();
      // No SS calls — sentinel honored as authoritative.
      expect(ss.searchCalls).toEqual([]);
    });

    it('round 2: name-search miss writes a sentinel with triedNameSearch=true (don\'t loop)', async () => {
      const m = makeMocks({ dbReturns: null });
      const ss = makeSearchSS({
        lookupResult: null,
        // No candidates for the search term → name-search ran but
        // produced no bind. Sentinel write should still mark
        // triedNameSearch=true so we don't retry forever.
        searchResults: { mslug2: [] },
      });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      await svc.getMetadata(
        HASH,
        { filename: 'Metal Slug 2 (mslug2).neo' },
        SS_HINT,
      );
      // Read the sentinel back from disk and confirm the flag.
      const cachePath = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
      const raw = await fs.readFile(cachePath, 'utf-8');
      const written = JSON.parse(raw) as RomMetadata;
      expect(written.source).toBe('none');
      expect(written.triedNameSearch).toBe(true);
    });

    it('OpenVGDB hit short-circuits before name-search runs', async () => {
      const m = makeMocks({ dbReturns: buildDbHit({ name: 'From DB' }) });
      const ss = makeSearchSS({ lookupResult: null });
      const svc = new MetadataService(dir, m.openVgdb, m.thumbnails, ss.svc);
      const result = await svc.getMetadata(
        HASH,
        { filename: 'mslug2.neo' },
        SS_HINT,
      );
      // OpenVGDB-sourced — name-search never fired.
      expect(result?.source).toBe('openvgdb');
      expect(ss.searchCalls).toEqual([]);
    });
  });
});
