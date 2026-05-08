import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScreenScraperClient } from '@app/main/metadata/clients/screenscraper-client';
import type { TheGamesDBClient } from '@app/main/metadata/clients/thegamesdb-client';
import { MetadataService } from '@app/main/metadata/metadata-service';
import type { RomMetadata } from '@shared/metadata-types';

const HASH = 'a'.repeat(32);

function buildScraperHit(hash: string, name: string): RomMetadata {
  return {
    version: 1,
    hash,
    name,
    year: 1991,
    publisher: 'Nintendo',
    developer: null,
    genre: null,
    players: null,
    criticScore: null,
    ageRating: null,
    description: null,
    boxArtUrl: null,
    screenshotUrls: [],
    titleScreenUrl: null,
    source: 'screenscraper',
    fetchedAt: '2025-01-01T00:00:00.000Z',
  };
}

function buildTgdbHit(hash: string, name: string): RomMetadata {
  return { ...buildScraperHit(hash, name), source: 'thegamesdb' };
}

interface MockClients {
  readonly screenScraper: ScreenScraperClient;
  readonly theGamesDb: TheGamesDBClient;
  readonly ssCalls: { hash: string; hint: unknown }[];
  readonly tgdbCalls: { hash: string; hint: unknown }[];
}

function makeClients(opts: {
  ssReturns?: RomMetadata | null;
  tgdbReturns?: RomMetadata | null;
}): MockClients {
  const ssCalls: { hash: string; hint: unknown }[] = [];
  const tgdbCalls: { hash: string; hint: unknown }[] = [];
  const screenScraper = {
    getByMd5: vi.fn(async (hash: string, hint: unknown) => {
      ssCalls.push({ hash, hint });
      return opts.ssReturns ?? null;
    }),
  } as unknown as ScreenScraperClient;
  const theGamesDb = {
    isEnabled: vi.fn(() => true),
    getByHint: vi.fn(async (hash: string, hint: unknown) => {
      tgdbCalls.push({ hash, hint });
      return opts.tgdbReturns ?? null;
    }),
  } as unknown as TheGamesDBClient;
  return { screenScraper, theGamesDb, ssCalls, tgdbCalls };
}

describe('MetadataService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-meta-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('calls ScreenScraper first; skips TheGamesDB on a hit', async () => {
    const meta = buildScraperHit(HASH, 'Super Mario World');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    const result = await svc.getMetadata(HASH, { name: 'SMW' });
    expect(result?.name).toBe('Super Mario World');
    expect(clients.ssCalls).toHaveLength(1);
    expect(clients.tgdbCalls).toHaveLength(0);
  });

  it('falls back to TheGamesDB when ScreenScraper misses', async () => {
    const meta = buildTgdbHit(HASH, 'Some Other Game');
    const clients = makeClients({ ssReturns: null, tgdbReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    const result = await svc.getMetadata(HASH, { name: 'Some' });
    expect(result?.source).toBe('thegamesdb');
    expect(clients.ssCalls).toHaveLength(1);
    expect(clients.tgdbCalls).toHaveLength(1);
  });

  it('writes a "none" sentinel when both clients miss', async () => {
    const clients = makeClients({ ssReturns: null, tgdbReturns: null });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    const result = await svc.getMetadata(HASH);
    expect(result).toBeNull();

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const onDisk = JSON.parse(await fs.readFile(path, 'utf-8')) as RomMetadata;
    expect(onDisk.source).toBe('none');
    expect(onDisk.hash).toBe(HASH);
  });

  it('returns immediately on a cache hit, no API calls', async () => {
    const meta = buildScraperHit(HASH, 'Cached');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    // Populate cache.
    await svc.getMetadata(HASH);
    expect(clients.ssCalls).toHaveLength(1);

    // Second call: same MetadataService instance — cache hit.
    const second = await svc.getMetadata(HASH);
    expect(second?.name).toBe('Cached');
    expect(clients.ssCalls).toHaveLength(1); // unchanged
    expect(clients.tgdbCalls).toHaveLength(0);
  });

  it('serves the cache across instances (state lives on disk)', async () => {
    const meta = buildScraperHit(HASH, 'Cached');
    const clientsA = makeClients({ ssReturns: meta });
    const a = new MetadataService(dir, clientsA.screenScraper, clientsA.theGamesDb);
    await a.getMetadata(HASH);

    const clientsB = makeClients({ ssReturns: null, tgdbReturns: null });
    const b = new MetadataService(dir, clientsB.screenScraper, clientsB.theGamesDb);
    const result = await b.getMetadata(HASH);
    expect(result?.name).toBe('Cached');
    // Neither client called — disk hit served the answer.
    expect(clientsB.ssCalls).toHaveLength(0);
    expect(clientsB.tgdbCalls).toHaveLength(0);
  });

  it('returns null on a cached sentinel without re-querying', async () => {
    const clients = makeClients({ ssReturns: null, tgdbReturns: null });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb, {
      now: () => Date.parse('2025-01-15T00:00:00Z'),
    });

    // First call writes the sentinel.
    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(clients.ssCalls).toHaveLength(1);
    expect(clients.tgdbCalls).toHaveLength(1);

    // Second call (still inside TTL): no re-query, still null.
    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(clients.ssCalls).toHaveLength(1);
    expect(clients.tgdbCalls).toHaveLength(1);
  });

  it('re-queries after the 30-day sentinel TTL expires', async () => {
    const clients = makeClients({ ssReturns: null, tgdbReturns: null });
    let now = Date.parse('2025-01-15T00:00:00Z');
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb, {
      now: () => now,
    });

    expect(await svc.getMetadata(HASH)).toBeNull();
    expect(clients.ssCalls).toHaveLength(1);

    // Advance clock 31 days.
    now += 31 * 24 * 60 * 60 * 1000;
    expect(await svc.getMetadata(HASH)).toBeNull();
    // Re-queried because the sentinel went stale.
    expect(clients.ssCalls).toHaveLength(2);
    expect(clients.tgdbCalls).toHaveLength(2);
  });

  it('matched metadata never expires regardless of fetchedAt', async () => {
    const old = buildScraperHit(HASH, 'Vintage');
    // Fetched a year ago.
    const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
    const aged = { ...old, fetchedAt: oneYearAgo };

    // Pre-populate the cache file directly.
    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    await fs.mkdir(join(dir, 'by-hash', HASH.slice(0, 2)), { recursive: true });
    await fs.writeFile(path, JSON.stringify(aged), 'utf-8');

    const clients = makeClients({});
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);
    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Vintage');
    expect(clients.ssCalls).toHaveLength(0);
  });

  it('invalidate removes one entry; next call re-fetches', async () => {
    const meta = buildScraperHit(HASH, 'X');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    await svc.getMetadata(HASH);
    await svc.invalidate(HASH);
    await svc.getMetadata(HASH);
    expect(clients.ssCalls).toHaveLength(2);
  });

  it('clearAll wipes the by-hash directory', async () => {
    const meta = buildScraperHit(HASH, 'X');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);
    await svc.getMetadata(HASH);
    await svc.clearAll();

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    const exists = await fs
      .stat(path)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('shards by-hash files into 2-char prefix subdirs', async () => {
    const meta = buildScraperHit(HASH, 'X');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);
    await svc.getMetadata(HASH);

    const path = join(dir, 'by-hash', HASH.slice(0, 2), `${HASH}.json`);
    await expect(fs.stat(path)).resolves.toBeDefined();
  });

  it('deduplicates concurrent getMetadata calls for the same hash', async () => {
    const meta = buildScraperHit(HASH, 'X');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    const [a, b] = await Promise.all([svc.getMetadata(HASH), svc.getMetadata(HASH)]);
    expect(a?.name).toBe(b?.name);
    expect(clients.ssCalls).toHaveLength(1);
  });

  it('treats a corrupted cache file as a miss and refetches', async () => {
    const dirHash = HASH.slice(0, 2);
    await fs.mkdir(join(dir, 'by-hash', dirHash), { recursive: true });
    await fs.writeFile(
      join(dir, 'by-hash', dirHash, `${HASH}.json`),
      '{ this is not valid json',
    );
    const meta = buildScraperHit(HASH, 'Recovered');
    const clients = makeClients({ ssReturns: meta });
    const svc = new MetadataService(dir, clients.screenScraper, clients.theGamesDb);

    const result = await svc.getMetadata(HASH);
    expect(result?.name).toBe('Recovered');
  });
});
