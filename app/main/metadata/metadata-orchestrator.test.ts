import { describe, expect, it, vi } from 'vitest';

import type { HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import {
  MetadataOrchestrator,
  type ActiveSession,
} from '@app/main/metadata/metadata-orchestrator';
import type { MetadataService } from '@app/main/metadata/metadata-service';
import type { RomMetadata } from '@shared/metadata-types';

const HASH = 'a'.repeat(32);

function buildMeta(hash: string, name: string): RomMetadata {
  return {
    version: 1,
    hash,
    name,
    year: null,
    publisher: null,
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

function makeOrchestrator(opts: {
  hashEntries?: Map<string, string>;
  meta?: RomMetadata | null;
  session?: ActiveSession | null;
} = {}): {
  orchestrator: MetadataOrchestrator;
  hashService: HashService;
  metadataService: MetadataService;
  imageCache: ImageCache;
} {
  const hashCalls: { paths: readonly string[] }[] = [];
  const hashService = {
    getHash: vi.fn(
      async (
        _client: unknown,
        _host: string,
        paths: readonly string[],
      ): Promise<Map<string, string>> => {
        hashCalls.push({ paths });
        const out = new Map<string, string>();
        for (const p of paths) {
          const h = opts.hashEntries?.get(p);
          if (h !== undefined) out.set(p, h);
        }
        return out;
      },
    ),
    invalidate: vi.fn(async () => undefined),
    clearForHost: vi.fn(async () => undefined),
  } as unknown as HashService;

  const metadataService = {
    getMetadata: vi.fn(async () => opts.meta ?? null),
    clearAll: vi.fn(async () => undefined),
    invalidate: vi.fn(async () => undefined),
  } as unknown as MetadataService;

  const imageCache = {
    fetch: vi.fn(async (url: string) => `/cache/${url}`),
    clearAll: vi.fn(async () => undefined),
    getLocal: vi.fn(async () => null),
  } as unknown as ImageCache;

  const session: ActiveSession | null =
    opts.session === undefined
      ? {
          client: {
            statWitnesses: vi.fn(async () => ({})),
            md5sumPaths: vi.fn(async () => []),
          },
          host: 'host-1',
        }
      : opts.session;

  const orchestrator = new MetadataOrchestrator(
    hashService,
    metadataService,
    imageCache,
    () => session,
  );
  return { orchestrator, hashService, metadataService, imageCache };
}

describe('MetadataOrchestrator', () => {
  it('getRomMetadata: hashes the path then calls metadata.getMetadata', async () => {
    const meta = buildMeta(HASH, 'X');
    const { orchestrator, hashService, metadataService } = makeOrchestrator({
      hashEntries: new Map([['/p/x.sfc', HASH]]),
      meta,
    });
    const result = await orchestrator.getRomMetadata('SNES', '/p/x.sfc');
    expect(result?.name).toBe('X');
    expect(hashService.getHash).toHaveBeenCalledTimes(1);
    expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
    expect(metadataService.getMetadata).toHaveBeenCalledWith(HASH, {});
  });

  it('getRomMetadata: returns null when no session is active', async () => {
    const { orchestrator, hashService, metadataService } = makeOrchestrator({
      session: null,
    });
    expect(
      await orchestrator.getRomMetadata('SNES', '/p/x.sfc'),
    ).toBeNull();
    expect(hashService.getHash).not.toHaveBeenCalled();
    expect(metadataService.getMetadata).not.toHaveBeenCalled();
  });

  it('getRomMetadata: returns null when the file has no hash (missing on device)', async () => {
    const { orchestrator, hashService, metadataService } = makeOrchestrator({
      hashEntries: new Map(), // empty
    });
    expect(
      await orchestrator.getRomMetadata('SNES', '/p/x.sfc'),
    ).toBeNull();
    expect(hashService.getHash).toHaveBeenCalledTimes(1);
    expect(metadataService.getMetadata).not.toHaveBeenCalled();
  });

  it('getRomMetadata: passes the hint through to the metadata service', async () => {
    const meta = buildMeta(HASH, 'X');
    const { orchestrator, metadataService } = makeOrchestrator({
      hashEntries: new Map([['/p/x.sfc', HASH]]),
      meta,
    });
    await orchestrator.getRomMetadata('SNES', '/p/x.sfc', {
      name: 'Super',
      system: 'snes',
    });
    expect(metadataService.getMetadata).toHaveBeenCalledWith(HASH, {
      name: 'Super',
      system: 'snes',
    });
  });

  it('prefetchHashes: chunks paths into HashService calls and emits progress', async () => {
    const hashEntries = new Map<string, string>();
    const paths: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const p = `/p/file-${String(i)}`;
      paths.push(p);
      hashEntries.set(p, 'a'.repeat(32));
    }
    const { orchestrator, hashService } = makeOrchestrator({ hashEntries });
    const events: { done: number; total: number }[] = [];
    await orchestrator.prefetchHashes(paths, (e) => events.push(e));
    // 250 / 100 = 3 chunks.
    expect(hashService.getHash).toHaveBeenCalledTimes(3);
    expect(events).toEqual([
      { done: 100, total: 250, currentPath: paths[99] },
      { done: 200, total: 250, currentPath: paths[199] },
      { done: 250, total: 250, currentPath: paths[249] },
    ]);
  });

  it('prefetchHashes: no-op when no session', async () => {
    const { orchestrator, hashService } = makeOrchestrator({ session: null });
    await orchestrator.prefetchHashes(['/p/a']);
    expect(hashService.getHash).not.toHaveBeenCalled();
  });

  it('prefetchHashes: no-op for empty input', async () => {
    const { orchestrator, hashService } = makeOrchestrator();
    await orchestrator.prefetchHashes([]);
    expect(hashService.getHash).not.toHaveBeenCalled();
  });

  it('prefetchMetadata: walks every hash and emits progress per call', async () => {
    const meta = buildMeta(HASH, 'X');
    const { orchestrator, metadataService } = makeOrchestrator({ meta });
    const events: { done: number; total: number }[] = [];
    await orchestrator.prefetchMetadata(
      [HASH, 'b'.repeat(32), 'c'.repeat(32)],
      (e) => events.push(e),
    );
    expect(metadataService.getMetadata).toHaveBeenCalledTimes(3);
    expect(events.map((e) => e.done)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
  });

  it('getBoxArtLocal: delegates to ImageCache.fetch', async () => {
    const { orchestrator, imageCache } = makeOrchestrator();
    const path = await orchestrator.getBoxArtLocal('https://cdn/box.png');
    expect(imageCache.fetch).toHaveBeenCalledWith('https://cdn/box.png');
    expect(path).toBe('/cache/https://cdn/box.png');
  });

  it('getBoxArtLocal: returns null for empty URL without calling ImageCache', async () => {
    const { orchestrator, imageCache } = makeOrchestrator();
    expect(await orchestrator.getBoxArtLocal('')).toBeNull();
    expect(imageCache.fetch).not.toHaveBeenCalled();
  });

  it('clearMetadataCache: wipes both metadata and image caches', async () => {
    const { orchestrator, metadataService, imageCache } = makeOrchestrator();
    await orchestrator.clearMetadataCache();
    expect(metadataService.clearAll).toHaveBeenCalledTimes(1);
    expect(imageCache.clearAll).toHaveBeenCalledTimes(1);
  });
});
