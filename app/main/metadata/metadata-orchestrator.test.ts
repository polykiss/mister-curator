import { describe, expect, it, vi } from 'vitest';

import type { HashEntry, HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import {
  MetadataOrchestrator,
  type ActiveSession,
  type SystemResolver,
} from '@app/main/metadata/metadata-orchestrator';
import type { MetadataService } from '@app/main/metadata/metadata-service';
import type {
  OpenVGDBProgressEvent,
  OpenVGDBService,
} from '@app/main/metadata/openvgdb-service';
import type { RomMetadata } from '@shared/metadata-types';

const HASH = 'a'.repeat(32);

function buildMeta(hash: string, name: string): RomMetadata {
  return {
    version: 4,
    hash,
    name,
    system: 'Super Nintendo Entertainment System',
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
    source: 'openvgdb',
    fetchedAt: '2025-01-01T00:00:00.000Z',
  };
}

/** Build a HashEntry value for the test mock. */
function buildHashEntry(md5: string, size = 1024, mtime = 100): HashEntry {
  return {
    md5,
    sha1: md5.repeat(2).slice(0, 40),
    size,
    mtime,
    hashedAt: '2025-01-01T00:00:00.000Z',
  };
}

interface OrchestratorBundle {
  readonly orchestrator: MetadataOrchestrator;
  readonly hashService: HashService;
  readonly metadataService: MetadataService;
  readonly imageCache: ImageCache;
  readonly openVgdb: OpenVGDBService;
  readonly resolveSystemIdSpy: ReturnType<typeof vi.fn>;
}

function makeOrchestrator(opts: {
  hashEntries?: Map<string, HashEntry>;
  meta?: RomMetadata | null;
  session?: ActiveSession | null;
  dbReady?: boolean;
  ensureFn?: (
    cb?: (e: OpenVGDBProgressEvent) => void,
  ) => Promise<void>;
  /** SS systemId returned by the resolver. Default 4 (SNES). null disables SS hint construction. */
  readonly systemId?: number | null;
  /** System name returned by the resolver. Default a SNES-shaped name. */
  readonly systemName?: string;
} = {}): OrchestratorBundle {
  const hashService = {
    getHash: vi.fn(
      async (
        _client: unknown,
        _host: string,
        paths: readonly string[],
      ): Promise<Map<string, HashEntry>> => {
        const out = new Map<string, HashEntry>();
        for (const p of paths) {
          const entry = opts.hashEntries?.get(p);
          if (entry !== undefined) out.set(p, entry);
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

  const ensureSpy = vi.fn(opts.ensureFn ?? (async () => undefined));
  const openVgdb = {
    isReady: vi.fn(() => opts.dbReady ?? true),
    ensureDatabase: ensureSpy,
    getMetadataByHash: vi.fn(async () => null),
    clearDatabase: vi.fn(async () => undefined),
  } as unknown as OpenVGDBService;

  const session: ActiveSession | null =
    opts.session === undefined
      ? {
          client: {
            statWitnesses: vi.fn(async () => ({})),
            hashPaths: vi.fn(async () => []),
          },
          host: 'host-1',
        }
      : opts.session;

  const ssSystemId = opts.systemId === undefined ? 4 : opts.systemId;
  const systemName =
    opts.systemName ?? 'Super Nintendo Entertainment System';
  const resolveSystemIdSpy = vi.fn<SystemResolver>(() =>
    ssSystemId === null ? null : { ssSystemId, systemName },
  );

  const orchestrator = new MetadataOrchestrator(
    hashService,
    metadataService,
    imageCache,
    openVgdb,
    resolveSystemIdSpy,
    () => session,
  );
  return {
    orchestrator,
    hashService,
    metadataService,
    imageCache,
    openVgdb,
    resolveSystemIdSpy,
  };
}

describe('MetadataOrchestrator', () => {
  it('getRomMetadata: hashes the path then calls metadata.getMetadata', async () => {
    const meta = buildMeta(HASH, 'X');
    const { orchestrator, hashService, metadataService } = makeOrchestrator({
      hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
      meta,
    });
    const result = await orchestrator.getRomMetadata('SNES', '/p/x.sfc');
    expect(result?.name).toBe('X');
    expect(hashService.getHash).toHaveBeenCalledTimes(1);
    expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
    // Round 2: getMetadata gets (hash, hint, ssHint).
    const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call?.[0]).toBe(HASH);
    expect(call?.[1]).toEqual({});
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
      hashEntries: new Map(),
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
      hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
      meta,
    });
    await orchestrator.getRomMetadata('SNES', '/p/x.sfc', {
      name: 'Super',
      system: 'snes',
    });
    const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call?.[0]).toBe(HASH);
    expect(call?.[1]).toEqual({ name: 'Super', system: 'snes' });
  });

  describe('round 2 — SS hint threading', () => {
    it('threads md5 + sha1 + size + romName + systemId into the SS hint', async () => {
      const entry = buildHashEntry(HASH, 524288, 1700000000);
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, metadataService, resolveSystemIdSpy } =
        makeOrchestrator({
          hashEntries: new Map([
            ['/media/fat/games/SNES/Super Mario World (USA).sfc', entry],
          ]),
          meta,
          systemId: 4,
        });
      await orchestrator.getRomMetadata(
        'SNES',
        '/media/fat/games/SNES/Super Mario World (USA).sfc',
      );
      const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(call?.[2]).toEqual({
        systemId: 4,
        systemName: 'Super Nintendo Entertainment System',
        md5: HASH,
        sha1: entry.sha1,
        crc32: undefined,
        romName: 'Super Mario World (USA).sfc',
        romSize: 524288,
      });
      expect(resolveSystemIdSpy).toHaveBeenCalledWith({
        romPath: '/media/fat/games/SNES/Super Mario World (USA).sfc',
        coreId: 'SNES',
      });
    });

    it('omits the SS hint when the resolver returns null', async () => {
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
        meta,
        systemId: null,
      });
      await orchestrator.getRomMetadata('UnknownSystem', '/p/x.sfc');
      const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(call?.[2]).toBeUndefined();
    });

    it('basenames the romPath into romName (last path segment only)', async () => {
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/deeply/nested/path/with/a/Sonic 2 (World).md', buildHashEntry(HASH)],
        ]),
        meta: buildMeta(HASH, 'X'),
        systemId: 1,
      });
      await orchestrator.getRomMetadata(
        'Genesis',
        '/deeply/nested/path/with/a/Sonic 2 (World).md',
      );
      const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      expect(call?.[2]?.romName).toBe('Sonic 2 (World).md');
    });
  });

  it('prefetchHashes: chunks paths into HashService calls and emits progress', async () => {
    const hashEntries = new Map<string, HashEntry>();
    const paths: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const p = `/p/file-${String(i)}`;
      paths.push(p);
      hashEntries.set(p, buildHashEntry('a'.repeat(32)));
    }
    const { orchestrator, hashService } = makeOrchestrator({ hashEntries });
    const events: { done: number; total: number }[] = [];
    await orchestrator.prefetchHashes(paths, (e) => events.push(e));
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

  describe('ensureMetadataDatabase (round 3)', () => {
    it('returns ready=true immediately when the DB is already loaded', async () => {
      const { orchestrator, openVgdb } = makeOrchestrator({ dbReady: true });
      const state = await orchestrator.ensureMetadataDatabase();
      expect(state).toEqual({ ready: true, downloadInProgress: false });
      expect(openVgdb.ensureDatabase).not.toHaveBeenCalled();
    });

    it('kicks off ensureDatabase when not ready and reports downloadInProgress', async () => {
      let resolveEnsure: () => void = (): void => undefined;
      const { orchestrator, openVgdb } = makeOrchestrator({
        dbReady: false,
        ensureFn: () =>
          new Promise<void>((r) => {
            resolveEnsure = r;
          }),
      });
      const state = await orchestrator.ensureMetadataDatabase();
      expect(state).toEqual({ ready: false, downloadInProgress: true });
      expect(openVgdb.ensureDatabase).toHaveBeenCalledTimes(1);
      resolveEnsure();
    });

    it('coalesces a second call while the first is still downloading', async () => {
      let resolveEnsure: () => void = (): void => undefined;
      const { orchestrator, openVgdb } = makeOrchestrator({
        dbReady: false,
        ensureFn: () =>
          new Promise<void>((r) => {
            resolveEnsure = r;
          }),
      });
      await orchestrator.ensureMetadataDatabase();
      const second = await orchestrator.ensureMetadataDatabase();
      expect(second).toEqual({ ready: false, downloadInProgress: true });
      expect(openVgdb.ensureDatabase).toHaveBeenCalledTimes(1);
      resolveEnsure();
    });

    it('forwards progress events from the underlying service', async () => {
      const events: OpenVGDBProgressEvent[] = [];
      const { orchestrator } = makeOrchestrator({
        dbReady: false,
        ensureFn: async (cb) => {
          cb?.({ kind: 'started' });
          cb?.({ kind: 'downloading', bytesReceived: 1024, bytesTotal: 2048 });
          cb?.({ kind: 'ready', path: '/x' });
        },
      });
      await orchestrator.ensureMetadataDatabase((e) => events.push(e));
      await new Promise<void>((r) => setImmediate(r));
      expect(events.map((e) => e.kind)).toEqual([
        'started',
        'downloading',
        'ready',
      ]);
    });
  });
});
