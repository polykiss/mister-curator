import { describe, expect, it, vi } from 'vitest';

import type { HashEntry, HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import {
  MetadataOrchestrator,
  type ActiveSession,
  type SystemIdResolver,
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

  const systemId = opts.systemId === undefined ? 4 : opts.systemId;
  const resolveSystemIdSpy = vi.fn<SystemIdResolver>(() => systemId);

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

  describe('getRomsMetadata (PR #20 round 2 — list-view streaming prefetch)', () => {
    it('hashes per-ROM through HashService.runGated, emits one event per path in order (round 5)', async () => {
      // Round 5 reverted round 2's "ONE batched hashService call"
      // shape because a single multi-GB ROM in the batch (e.g. a
      // SNES translation collection) blew past the 120s hash timeout
      // and took down ALL N paths. Per-ROM hashing keeps the failure
      // surface to one row at a time, and the existing per-host
      // serialization (`HashService.runGated`) ensures we still issue
      // at most one concurrent SSH command per host. The renderer-
      // side IPC fan-in (one prefetchRomsMetadata call per pane mount)
      // from round 2 stays intact.
      const paths: string[] = [];
      const hashEntries = new Map<string, HashEntry>();
      for (let i = 0; i < 32; i += 1) {
        const p = `/p/snes-${String(i)}.sfc`;
        const md5 = String(i).padStart(32, '0');
        paths.push(p);
        hashEntries.set(p, buildHashEntry(md5));
      }
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, hashService } = makeOrchestrator({
        hashEntries,
        meta,
      });
      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) => events.push(e));
      // One hashService.getHash call per path — each with a single-
      // path argument. NOT one batched call for the whole list.
      expect(hashService.getHash).toHaveBeenCalledTimes(32);
      for (let i = 0; i < paths.length; i += 1) {
        const call = (hashService.getHash as ReturnType<typeof vi.fn>).mock
          .calls[i];
        expect(call?.[1]).toBe('host-1');
        expect(call?.[2]).toEqual([paths[i]]);
      }
      // One event per path, in order.
      expect(events).toHaveLength(32);
      expect(events.map((e) => e.path)).toEqual(paths);
      expect(events.every((e) => !e.error)).toBe(true);
    });

    it('one ROM\'s hash failure is isolated — subsequent ROMs still resolve (round 5)', async () => {
      // The big-collection-ROM scenario: one path's hash throws (e.g.
      // 120s timeout from `runSshOp`), the rest must keep flowing.
      // Pre-round-5, the single batched hash call would emit error for
      // ALL paths on any throw.
      const paths = ['/p/small.sfc', '/p/HUGE-collection.zip', '/p/ok.sfc'];
      const hashEntries = new Map<string, HashEntry>();
      for (const p of paths) hashEntries.set(p, buildHashEntry(HASH));
      const { orchestrator, hashService, metadataService } = makeOrchestrator({
        hashEntries,
        meta: buildMeta(HASH, 'X'),
      });
      // Reset and replace getHash so we can throw selectively.
      (hashService.getHash as ReturnType<typeof vi.fn>).mockReset();
      (hashService.getHash as ReturnType<typeof vi.fn>).mockImplementation(
        async (_client: unknown, _host: string, hashed: readonly string[]) => {
          if (hashed[0] === '/p/HUGE-collection.zip') {
            throw new Error(
              'Command timed out after 120s; SSH session preserved.',
            );
          }
          const out = new Map<string, HashEntry>();
          for (const p of hashed) out.set(p, buildHashEntry(HASH));
          return out;
        },
      );
      const events: { path: string; error: boolean }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) =>
        events.push({ path: e.path, error: e.error }),
      );
      expect(events).toEqual([
        { path: '/p/small.sfc', error: false },
        { path: '/p/HUGE-collection.zip', error: true },
        { path: '/p/ok.sfc', error: false },
      ]);
      // Two metadata lookups happened (the two non-erroring paths) —
      // the third was skipped because hash failed.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(2);
    });

    it('emits unmatched (no error) for every path when no session is active', async () => {
      const { orchestrator, hashService } = makeOrchestrator({
        session: null,
      });
      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata('SNES', ['/p/a', '/p/b'], (e) =>
        events.push(e),
      );
      expect(hashService.getHash).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e.metadata).toBeNull();
        expect(e.error).toBe(false);
      }
    });

    it('emits error=true for every path when the hash batch throws (SSH dropped mid-flight)', async () => {
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map([['/p/a', buildHashEntry(HASH)]]),
      });
      // Override the stub to simulate a mid-flight SSH failure.
      (
        (orchestrator as unknown as {
          hashService: { getHash: ReturnType<typeof vi.fn> };
        }).hashService.getHash
      ).mockReset();
      (
        (orchestrator as unknown as {
          hashService: { getHash: ReturnType<typeof vi.fn> };
        }).hashService.getHash
      ).mockRejectedValue(new Error('RealMisterClient is not connected'));
      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata('SNES', ['/p/a', '/p/b', '/p/c'], (e) =>
        events.push(e),
      );
      expect(events).toHaveLength(3);
      for (const e of events) {
        expect(e.metadata).toBeNull();
        expect(e.error).toBe(true);
      }
    });

    it('per-path metadata failure is isolated — subsequent paths still emit', async () => {
      const paths = ['/p/a', '/p/b', '/p/c'];
      const hashEntries = new Map<string, HashEntry>();
      for (const p of paths) hashEntries.set(p, buildHashEntry(HASH));
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries,
        meta: buildMeta(HASH, 'X'),
      });
      // Throw on the SECOND call only.
      let call = 0;
      (metadataService.getMetadata as ReturnType<typeof vi.fn>).mockReset();
      (metadataService.getMetadata as ReturnType<typeof vi.fn>).mockImplementation(
        async () => {
          call += 1;
          if (call === 2) throw new Error('boom');
          return buildMeta(HASH, 'X');
        },
      );
      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) => events.push(e));
      expect(events).toHaveLength(3);
      expect(events[0]?.error).toBe(false);
      expect(events[1]?.error).toBe(true);
      expect(events[2]?.error).toBe(false);
    });

    it('emits unmatched (no error) for paths not present in the hash result', async () => {
      // E.g., file vanished from the device between scan and hash.
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map([['/p/present', buildHashEntry(HASH)]]),
        meta: buildMeta(HASH, 'X'),
      });
      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata(
        'SNES',
        ['/p/present', '/p/missing'],
        (e) => events.push(e),
      );
      expect(events).toHaveLength(2);
      const missingEvent = events.find((e) => e.path === '/p/missing');
      expect(missingEvent?.metadata).toBeNull();
      expect(missingEvent?.error).toBe(false);
    });

    it('no-op on empty paths', async () => {
      const { orchestrator, hashService } = makeOrchestrator();
      const events: unknown[] = [];
      await orchestrator.getRomsMetadata('SNES', [], (e) => events.push(e));
      expect(hashService.getHash).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    });
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

  describe('getBoxArtBytes (PR #20 round 1)', () => {
    it('reads bytes from the cached file path returned by ImageCache', async () => {
      // Write a known-bytes file, point ImageCache.fetch at it, and
      // assert getBoxArtBytes returns its bytes verbatim.
      const { promises: fs } = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-boxart-'));
      const filePath = path.join(dir, 'art.bin');
      const expected = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]); // PNG-ish
      await fs.writeFile(filePath, expected);
      try {
        const { orchestrator } = makeOrchestrator();
        // Override the imageCache.fetch mock to return our temp path.
        const stub = (orchestrator as unknown as {
          imageCache: { fetch: ReturnType<typeof vi.fn> };
        }).imageCache;
        stub.fetch.mockReset();
        stub.fetch.mockResolvedValue(filePath);
        const bytes = await orchestrator.getBoxArtBytes('https://cdn/box.png');
        expect(bytes).not.toBeNull();
        expect(Array.from(bytes!)).toEqual(Array.from(expected));
      } finally {
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it('returns null when ImageCache reports no cached file', async () => {
      const { orchestrator } = makeOrchestrator();
      const stub = (orchestrator as unknown as {
        imageCache: { fetch: ReturnType<typeof vi.fn> };
      }).imageCache;
      stub.fetch.mockReset();
      stub.fetch.mockResolvedValue(null);
      const bytes = await orchestrator.getBoxArtBytes('https://cdn/box.png');
      expect(bytes).toBeNull();
    });

    it('returns null when the cached file vanished between fetch and read', async () => {
      // ImageCache.fetch resolves with a path, but the file was wiped
      // (e.g., user cleared the cache) before readFile got to it.
      const { orchestrator } = makeOrchestrator();
      const stub = (orchestrator as unknown as {
        imageCache: { fetch: ReturnType<typeof vi.fn> };
      }).imageCache;
      stub.fetch.mockReset();
      stub.fetch.mockResolvedValue('/nonexistent/path/art.bin');
      const bytes = await orchestrator.getBoxArtBytes('https://cdn/box.png');
      expect(bytes).toBeNull();
    });

    it('skips ImageCache entirely for an empty URL', async () => {
      const { orchestrator, imageCache } = makeOrchestrator();
      (imageCache.fetch as ReturnType<typeof vi.fn>).mockReset();
      const bytes = await orchestrator.getBoxArtBytes('');
      expect(bytes).toBeNull();
      expect(imageCache.fetch).not.toHaveBeenCalled();
    });
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
