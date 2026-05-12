import { describe, expect, it, vi } from 'vitest';

import type { HashEntry, HashService } from '@app/main/metadata/hash-service';
import type { ImageCache } from '@app/main/metadata/image-cache';
import {
  MetadataOrchestrator,
  type ActiveSession,
  type RomMetadataResolvedEvent,
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
    diskSizeBytes: size,
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
    // Round 9 — `getRomsMetadata` now drives the hash phase via
    // these two methods. The fixture treats `hashEntries` as the
    // mtime-validated cache: any path present is "warm" and gets
    // back its entry from `checkCachedMtimes`; any missing path is
    // "needs hash" and would route to `computeHash` (which the
    // default fixture says drops on the device → returns undefined).
    checkCachedMtimes: vi.fn(
      async (
        _client: unknown,
        _host: string,
        paths: readonly string[],
      ): Promise<{
        entries: Map<string, HashEntry | null>;
        exactCount: number;
        toleranceCount: number;
      }> => {
        // fix/mtime-tolerance — fixture treats every warm cache hit as
        // an exact match. The exact/tolerance split is exercised in
        // hash-service.test.ts directly; orchestrator-level tests
        // don't need to vary it.
        const entries = new Map<string, HashEntry | null>();
        let exactCount = 0;
        for (const p of paths) {
          const entry = opts.hashEntries?.get(p);
          entries.set(p, entry ?? null);
          if (entry !== undefined) exactCount += 1;
        }
        return { entries, exactCount, toleranceCount: 0 };
      },
    ),
    computeHash: vi.fn(
      async (
        _client: unknown,
        _host: string,
        path: string,
      ): Promise<HashEntry | undefined> => opts.hashEntries?.get(path),
    ),
    invalidate: vi.fn(async () => undefined),
    clearForHost: vi.fn(async () => undefined),
    // Round 2 (PR #27 round 2): pure-disk read for the optimistic-
    // render path. Same fixture data as `checkCachedMtimes` but
    // without the SSH stat — every cached entry is returned as-is.
    readCachedEntries: vi.fn(
      async (
        _host: string,
        paths: readonly string[],
      ): Promise<Map<string, HashEntry | null>> => {
        const out = new Map<string, HashEntry | null>();
        for (const p of paths) {
          out.set(p, opts.hashEntries?.get(p) ?? null);
        }
        return out;
      },
    ),
  } as unknown as HashService;

  const metadataService = {
    getMetadata: vi.fn(async () => opts.meta ?? null),
    // Round 2: synchronous-feeling cache read for the optimistic-
    // render path. Returns the same `opts.meta` as `getMetadata`
    // unless the test overrides — sentinel records (source='none')
    // collapse to null here so the renderer doesn't paint a "no
    // match" row eagerly.
    readCachedMetadata: vi.fn(async (): Promise<RomMetadata | null> => {
      const m = opts.meta ?? null;
      if (m === null || m.source === 'none') return null;
      return m;
    }),
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
            statPathsWithSize: vi.fn(async () => ({})),
            computeSampleMd5s: vi.fn(async () => ({})),
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

  describe('getRomsMetadata in-flight gate (PR-D1 round 2 — dedup duplicate prefetch)', () => {
    it('coalesces concurrent calls for the same coreId — one underlying scrape, both callbacks fire', async () => {
      // The duplicate-prefetch bug: auto-scrape engine and
      // RomsPane's per-pane prefetch both target the focused core,
      // each emits prefetch.lookup events for every path, ~2× the
      // log noise (and ~2× the underlying work). Round 2's gate
      // collapses these to ONE underlying scrape; both callbacks
      // get all events.
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, hashService, metadataService } = makeOrchestrator(
        {
          hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
          meta,
        },
      );
      const aEvents: RomMetadataResolvedEvent[] = [];
      const bEvents: RomMetadataResolvedEvent[] = [];
      // Fire two concurrent calls for the same coreId.
      const a = orchestrator.getRomsMetadata('SNES', ['/p/x.sfc'], (e) =>
        aEvents.push(e),
      );
      const b = orchestrator.getRomsMetadata('SNES', ['/p/x.sfc'], (e) =>
        bEvents.push(e),
      );
      await Promise.all([a, b]);
      // Both callbacks received the per-path event.
      expect(aEvents).toHaveLength(1);
      expect(bEvents).toHaveLength(1);
      expect(aEvents[0]?.path).toBe('/p/x.sfc');
      expect(bEvents[0]?.path).toBe('/p/x.sfc');
      // Critical: only ONE underlying call to the metadata service —
      // the gate prevented the duplicate work.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
      // Hash lookups also happened only once (one mtime-batch + one
      // computeHash if needed).
      expect(hashService.checkCachedMtimes).toHaveBeenCalledTimes(1);
    });

    it('separate coreIds run independently — gate is per-coreId', async () => {
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/p/snes.sfc', buildHashEntry(HASH)],
          ['/p/nes.nes', buildHashEntry(HASH)],
        ]),
        meta,
      });
      await Promise.all([
        orchestrator.getRomsMetadata('SNES', ['/p/snes.sfc']),
        orchestrator.getRomsMetadata('NES', ['/p/nes.nes']),
      ]);
      // Two separate underlying scrapes — gate didn't collapse
      // across coreIds.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(2);
    });

    it('after first call resolves, the gate clears for subsequent calls', async () => {
      const meta = buildMeta(HASH, 'X');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
        meta,
      });
      await orchestrator.getRomsMetadata('SNES', ['/p/x.sfc']);
      await orchestrator.getRomsMetadata('SNES', ['/p/x.sfc']);
      // First call ran; second call ran (no in-flight to coalesce
      // with). 2 separate underlying calls.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(2);
    });
  });

  describe('readCachedRomsMetadata (PR-D1 round 2 — optimistic-render path)', () => {
    it('returns metadata for paths whose hash + metadata are both cached', async () => {
      const meta = buildMeta(HASH, 'X');
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map([['/p/x.sfc', buildHashEntry(HASH)]]),
        meta,
      });
      const result = await orchestrator.readCachedRomsMetadata('SNES', [
        '/p/x.sfc',
      ]);
      expect(result['/p/x.sfc']?.name).toBe('X');
    });

    it('returns null for paths whose hash is NOT cached (cold)', async () => {
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map(), // no cached hash for /p/y.sfc
      });
      const result = await orchestrator.readCachedRomsMetadata('SNES', [
        '/p/y.sfc',
      ]);
      expect(result['/p/y.sfc']).toBeNull();
    });

    it('returns null when no active session (defensive — never throws)', async () => {
      const { orchestrator } = makeOrchestrator({ session: null });
      const result = await orchestrator.readCachedRomsMetadata('SNES', [
        '/p/x.sfc',
      ]);
      expect(result['/p/x.sfc']).toBeNull();
    });

    it('returns empty record for empty input — no IO', async () => {
      const { orchestrator, hashService } = makeOrchestrator({});
      const result = await orchestrator.readCachedRomsMetadata('SNES', []);
      expect(result).toEqual({});
      expect(hashService.readCachedEntries).not.toHaveBeenCalled();
    });
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
    it('warm-cache: ONE batched mtime check for all paths, NO per-row computeHash (round 9)', async () => {
      // Round 9 split the hash phase: ONE `checkCachedMtimes` for
      // all paths (single SSH `statWitnesses` exec), then per-path
      // `computeHash` ONLY for the residue. For a fully-cached
      // pane (the common case after first scan), no per-row
      // computeHash fires at all — the wall drops from round-5's
      // 32 × per-row stat (~15 s) to a single batched stat
      // (~200 ms).
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
      // ONE batched mtime call, ZERO per-row compute calls.
      expect(hashService.checkCachedMtimes).toHaveBeenCalledTimes(1);
      const call = (
        hashService.checkCachedMtimes as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call?.[1]).toBe('host-1');
      expect(call?.[2]).toEqual(paths);
      expect(hashService.computeHash).not.toHaveBeenCalled();
      // One event per path, in order.
      expect(events).toHaveLength(32);
      expect(events.map((e) => e.path)).toEqual(paths);
      expect(events.every((e) => !e.error)).toBe(true);
    });

    it('cold-cache residue: batched mtime + per-row computeHash for the uncached subset (round 9)', async () => {
      // Mixed scenario: 3 paths cached + 2 uncached. We want
      // ONE checkCachedMtimes call followed by exactly 2
      // computeHash calls (one per uncached path).
      const paths = [
        '/p/cached-1.sfc',
        '/p/cached-2.sfc',
        '/p/cold-a.sfc',
        '/p/cached-3.sfc',
        '/p/cold-b.sfc',
      ];
      const hashEntries = new Map<string, HashEntry>();
      for (const p of paths) hashEntries.set(p, buildHashEntry(HASH));
      const { orchestrator, hashService } = makeOrchestrator({
        hashEntries: new Map([
          ['/p/cached-1.sfc', buildHashEntry(HASH)],
          ['/p/cached-2.sfc', buildHashEntry(HASH)],
          ['/p/cached-3.sfc', buildHashEntry(HASH)],
        ]),
        meta: buildMeta(HASH, 'X'),
      });
      // Override checkCachedMtimes to leave the cold paths null
      // (the default fixture uses `hashEntries` for both
      // checkCachedMtimes and computeHash, so we need to split).
      (hashService.checkCachedMtimes as ReturnType<typeof vi.fn>).mockReset();
      (
        hashService.checkCachedMtimes as ReturnType<typeof vi.fn>
      ).mockImplementation(async (_c, _h, ps: readonly string[]) => {
        // fix/mtime-tolerance — checkCachedMtimes now returns
        // { entries, exactCount, toleranceCount }. The cold-cache
        // override returns the same entry shape it always did,
        // wrapped in the new envelope. Counts treat every warm hit
        // as exact for this test's purposes.
        const entries = new Map<string, HashEntry | null>();
        let exactCount = 0;
        for (const p of ps) {
          if (p.includes('cached')) {
            entries.set(p, buildHashEntry(HASH));
            exactCount += 1;
          } else {
            entries.set(p, null);
          }
        }
        return { entries, exactCount, toleranceCount: 0 };
      });
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockReset();
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockImplementation(
        async () => buildHashEntry(HASH),
      );

      const events: {
        path: string;
        metadata: unknown;
        error: boolean;
      }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) => events.push(e));

      expect(hashService.checkCachedMtimes).toHaveBeenCalledTimes(1);
      expect(hashService.computeHash).toHaveBeenCalledTimes(2);
      // Compute called only for the cold paths, in order.
      const computeCalls = (
        hashService.computeHash as ReturnType<typeof vi.fn>
      ).mock.calls.map((c) => c[2] as string);
      expect(computeCalls).toEqual(['/p/cold-a.sfc', '/p/cold-b.sfc']);
      expect(events).toHaveLength(5);
      expect(events.every((e) => !e.error)).toBe(true);
    });

    it('mtime-batch failure falls back to per-row computeHash for every path (round 9)', async () => {
      // If statWitnesses throws (e.g. transport hiccup), the batch
      // returns null for every path so the loop transparently
      // routes each to per-row computeHash — same shape as the
      // round-5 worst case.
      const paths = ['/p/a.sfc', '/p/b.sfc', '/p/c.sfc'];
      const { orchestrator, hashService } = makeOrchestrator({
        hashEntries: new Map(paths.map((p) => [p, buildHashEntry(HASH)])),
        meta: buildMeta(HASH, 'X'),
      });
      (hashService.checkCachedMtimes as ReturnType<typeof vi.fn>).mockReset();
      (
        hashService.checkCachedMtimes as ReturnType<typeof vi.fn>
      ).mockRejectedValue(new Error('SSH closed'));
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockReset();
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockImplementation(
        async () => buildHashEntry(HASH),
      );

      const events: { path: string; error: boolean }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) =>
        events.push({ path: e.path, error: e.error }),
      );

      expect(hashService.computeHash).toHaveBeenCalledTimes(3);
      expect(events.map((e) => e.path)).toEqual(paths);
      expect(events.every((e) => !e.error)).toBe(true);
    });

    it('one ROM\'s hash failure is isolated — subsequent ROMs still resolve (round 5)', async () => {
      // The big-collection-ROM scenario: one path's hash throws (e.g.
      // 120s timeout from `runSshOp`), the rest must keep flowing.
      // Pre-round-5, the single batched hash call would emit error for
      // ALL paths on any throw. Round 9 reshaped this: mtime is
      // batched (which would NOT see the per-file hash timeout since
      // it only stats), then per-row computeHash for paths the mtime
      // batch said need re-hashing. The selective throw moves to
      // computeHash.
      const paths = ['/p/small.sfc', '/p/HUGE-collection.zip', '/p/ok.sfc'];
      const { orchestrator, hashService, metadataService } = makeOrchestrator({
        meta: buildMeta(HASH, 'X'),
      });
      // mtime batch: all paths uncached → all need computeHash.
      (hashService.checkCachedMtimes as ReturnType<typeof vi.fn>).mockReset();
      (
        hashService.checkCachedMtimes as ReturnType<typeof vi.fn>
      ).mockImplementation(async (_c, _h, ps: readonly string[]) => {
        const out = new Map<string, HashEntry | null>();
        for (const p of ps) out.set(p, null);
        return out;
      });
      // computeHash throws for the collection path; succeeds otherwise.
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockReset();
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockImplementation(
        async (_c: unknown, _h: string, p: string) => {
          if (p === '/p/HUGE-collection.zip') {
            throw new Error(
              'Command timed out after 120s; SSH session preserved.',
            );
          }
          return buildHashEntry(HASH);
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
      expect(hashService.checkCachedMtimes).not.toHaveBeenCalled();
      expect(hashService.computeHash).not.toHaveBeenCalled();
      expect(events).toHaveLength(2);
      for (const e of events) {
        expect(e.metadata).toBeNull();
        expect(e.error).toBe(false);
      }
    });

    it('emits error=true per-path when computeHash throws after a mtime miss (round 9)', async () => {
      // Round 9: mtime batch returns null for an uncached path,
      // computeHash throws (e.g. the per-ROM 120s timeout fires).
      // That path emits error=true; siblings keep flowing.
      const paths = ['/p/a', '/p/b', '/p/c'];
      const { orchestrator, hashService } = makeOrchestrator({
        meta: buildMeta(HASH, 'X'),
      });
      (hashService.checkCachedMtimes as ReturnType<typeof vi.fn>).mockReset();
      (
        hashService.checkCachedMtimes as ReturnType<typeof vi.fn>
      ).mockImplementation(async (_c, _h, ps: readonly string[]) => {
        const out = new Map<string, HashEntry | null>();
        for (const p of ps) out.set(p, null); // all need compute
        return out;
      });
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockReset();
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockImplementation(
        async (_c: unknown, _h: string, p: string) => {
          if (p === '/p/b') {
            throw new Error('Command timed out after 120s; SSH session preserved.');
          }
          return buildHashEntry(HASH);
        },
      );
      const events: { path: string; error: boolean }[] = [];
      await orchestrator.getRomsMetadata('SNES', paths, (e) =>
        events.push({ path: e.path, error: e.error }),
      );
      expect(events).toEqual([
        { path: '/p/a', error: false },
        { path: '/p/b', error: true },
        { path: '/p/c', error: false },
      ]);
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

  describe('getRomsMetadata — unmappable-coreId short-circuit (round 11)', () => {
    /**
     * For coreIds with no SS systemeid mapping (mame, hbmame,
     * AO486, etc.), round 11 short-circuits the hash phase entirely:
     * no checkCachedMtimes batch, no per-row computeHash, no hash-
     * based metadataService.getMetadata. Synthetic-keyed sentinels
     * via the existing cache machinery handle "we saw this path
     * once" semantics.
     */
    it('mame: no checkCachedMtimes, no computeHash, hashSkipped equals path count', async () => {
      const paths = Array.from({ length: 10 }, (_, i) => `/p/mame/${String(i)}.zip`);
      const { orchestrator, hashService, metadataService } =
        makeOrchestrator({
          systemId: null, // mame is unmapped
          meta: null,
        });
      const events: { path: string; metadata: unknown; error: boolean }[] = [];
      await orchestrator.getRomsMetadata('mame', paths, (e) =>
        events.push(e),
      );
      // The big assertion: no hash work AT ALL.
      expect(hashService.checkCachedMtimes).not.toHaveBeenCalled();
      expect(hashService.computeHash).not.toHaveBeenCalled();
      // Per-path metadataService.getMetadata IS called (with the
      // synthetic key) so the cache machinery records the no-coverage
      // result.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(10);
      // Every getMetadata call uses a synthetic `noss-` key, NOT a
      // real md5 hash. This is the marker that distinguishes the
      // round-11 short-circuit from the regular flow on disk.
      const calls = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls;
      for (const c of calls) {
        expect(c?.[0]).toMatch(/^noss-[0-9a-f]{40}$/);
        expect(c?.[2]).toBeUndefined(); // no ssHint — synthetic flow
      }
      expect(events).toHaveLength(10);
      expect(events.every((e) => !e.error && e.metadata === null)).toBe(true);
    });

    it('synthetic key is deterministic per (coreId, path)', async () => {
      // Same path → same synthetic key. Two prefetches of the same
      // mame core ask getMetadata with the same key, so the cache
      // hit on the second prefetch is a literal cache hit (not a
      // miss + re-write).
      const { orchestrator, metadataService } = makeOrchestrator({
        systemId: null,
      });
      await orchestrator.getRomsMetadata('mame', ['/p/mame/foo.zip']);
      await orchestrator.getRomsMetadata('mame', ['/p/mame/foo.zip']);
      const calls = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0]?.[0]).toBe(calls[1]?.[0]);
    });

    it('different (coreId, path) tuples produce different synthetic keys', async () => {
      const { orchestrator, metadataService } = makeOrchestrator({
        systemId: null,
      });
      await orchestrator.getRomsMetadata('mame', [
        '/p/mame/a.zip',
        '/p/mame/b.zip',
      ]);
      await orchestrator.getRomsMetadata('hbmame', ['/p/hbmame/a.zip']);
      const keys = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls.map((c) => c[0] as string);
      expect(new Set(keys).size).toBe(3); // all distinct
    });

    it('mappable core (SNES) still flows through the hash phase (round 11 doesn\'t regress round 9/10)', async () => {
      const paths = ['/p/snes/sonic.sfc'];
      const hashEntries = new Map<string, HashEntry>();
      hashEntries.set(paths[0]!, buildHashEntry(HASH));
      const { orchestrator, hashService, metadataService } =
        makeOrchestrator({
          systemId: 4, // SNES is mapped
          hashEntries,
          meta: buildMeta(HASH, 'Sonic'),
        });
      await orchestrator.getRomsMetadata('SNES', paths);
      expect(hashService.checkCachedMtimes).toHaveBeenCalledTimes(1);
      // getMetadata receives a real md5 hash (32 hex chars), not the
      // synthetic `noss-` key.
      const call = (
        metadataService.getMetadata as ReturnType<typeof vi.fn>
      ).mock.calls[0];
      expect(call?.[0]).toMatch(/^[0-9a-f]{32}$/);
      // ssHint is supplied (round-2 shape).
      expect(call?.[2]).toBeDefined();
    });

    it('unmappable core with 200 paths completes without any hash SSH calls', async () => {
      // Reproduces the user's mame-650 scenario at unit scale. The
      // perf claim: zero hash SSH cost, only N getMetadata calls
      // (which read/write the local cache file synchronously).
      const paths = Array.from(
        { length: 200 },
        (_, i) => `/p/mame/rom-${String(i)}.zip`,
      );
      const { orchestrator, hashService } = makeOrchestrator({
        systemId: null,
      });
      await orchestrator.getRomsMetadata('mame', paths);
      expect(hashService.checkCachedMtimes).not.toHaveBeenCalled();
      expect(hashService.computeHash).not.toHaveBeenCalled();
    });
  });

  describe('feat/manual-bind-without-hash — synthetic-key fallback', () => {
    /**
     * The bind path used to require a pre-existing md5 entry for
     * the row, which silently broke for any file too large for the
     * SSH hash budget (Policenauts on PSX was the trigger case).
     * The fix is a synthetic `(coreId, path)` key fallback, reusing
     * the round-11 `noss-` scheme. These tests pin the contract:
     *
     *   1. Bind succeeds without a prior hash; the synthetic key
     *      flows to `MetadataService.bindManualOverride`.
     *   2. The optimistic-read path can find the synthetic record.
     *   3. Hash-keyed records win over synthetic records when both
     *      exist — conflict-resolution rule for paths that gain an
     *      md5 *after* a manual bind.
     *   4. The orchestrator delegates to `bindManualOverride`
     *      verbatim under the synthetic key (the merge semantics
     *      themselves live in metadata-service.test.ts).
     */
    const PATH = '/media/fat/games/PSX/Policenauts.chd';
    const CORE_ID = 'PSX';
    const SYNTHETIC_KEY_RE = /^noss-[0-9a-f]{40}$/;

    function buildSsGame(id = 5678, name = 'Policenauts') {
      return {
        id,
        name,
        system: 'PlayStation',
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
      };
    }

    it('bindManualMetadataOverride: writes under synthetic key when no md5 exists', async () => {
      const { orchestrator, metadataService } = makeOrchestrator({
        // No hash entry on file for PATH — mirrors the Policenauts
        // case where computeHash timed out.
        hashEntries: new Map(),
      });
      const bindSpy = vi.fn(
        async (key: string, _game: unknown) => buildMeta(key, 'Policenauts'),
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;

      const result = await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        buildSsGame(),
      );

      expect(result).not.toBeNull();
      expect(bindSpy).toHaveBeenCalledTimes(1);
      const [key, gameArg] = bindSpy.mock.calls[0] ?? ['', undefined];
      expect(key).toMatch(SYNTHETIC_KEY_RE);
      expect(gameArg).toMatchObject({ id: 5678, name: 'Policenauts' });
    });

    it('bindManualMetadataOverride: prefers real md5 over synthetic when a hash entry exists', async () => {
      // Regression case: a path that already has a hash should use
      // its real md5 — the synthetic fallback is strictly the
      // hash-missing branch.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[PATH, buildHashEntry(HASH)]]),
      });
      const bindSpy = vi.fn(
        async (key: string, _game: unknown) => buildMeta(key, 'Policenauts'),
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;

      await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        buildSsGame(),
      );

      const [key] = bindSpy.mock.calls[0] ?? [''];
      expect(key).toBe(HASH);
      expect(key).not.toMatch(/^noss-/);
    });

    it('readCachedRomsMetadata: returns the synthetic-keyed record when no hash exists', async () => {
      const syntheticMeta = buildMeta('noss-xxx', 'Policenauts');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(), // no hash for PATH
      });
      // Per-key dispatch so we can distinguish md5 vs synthetic
      // lookups. Synthetic key returns the bound record; any other
      // key (none in this test) would return null.
      const readSpy = vi.fn(async (key: string) =>
        SYNTHETIC_KEY_RE.test(key) ? syntheticMeta : null,
      );
      (metadataService as unknown as {
        readCachedMetadata: typeof readSpy;
      }).readCachedMetadata = readSpy;

      const result = await orchestrator.readCachedRomsMetadata(CORE_ID, [
        PATH,
      ]);

      expect(result[PATH]?.name).toBe('Policenauts');
      // Only the synthetic key was queried — no wasted md5 lookup
      // since hashEntries returned null up front.
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSpy.mock.calls[0]?.[0]).toMatch(SYNTHETIC_KEY_RE);
    });

    it('readCachedRomsMetadata: hash-keyed record wins when both records exist', async () => {
      // Conflict-resolution policy: if a path gained an md5 after
      // the user manual-bound a synthetic record, the auto-pipeline
      // output supersedes the pre-hash synthetic. The orchestrator
      // should never even try the synthetic key when the hash
      // lookup succeeds.
      const hashMeta = buildMeta(HASH, 'AutoResolved');
      const syntheticMeta = buildMeta('noss-xxx', 'ManuallyBound');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[PATH, buildHashEntry(HASH)]]),
      });
      const readSpy = vi.fn(async (key: string) => {
        if (key === HASH) return hashMeta;
        if (SYNTHETIC_KEY_RE.test(key)) return syntheticMeta;
        return null;
      });
      (metadataService as unknown as {
        readCachedMetadata: typeof readSpy;
      }).readCachedMetadata = readSpy;

      const result = await orchestrator.readCachedRomsMetadata(CORE_ID, [
        PATH,
      ]);

      expect(result[PATH]?.name).toBe('AutoResolved');
      // Synthetic key MUST NOT be probed — short-circuit on the
      // first hit.
      expect(readSpy).toHaveBeenCalledTimes(1);
      expect(readSpy.mock.calls[0]?.[0]).toBe(HASH);
    });

    it('bindManualMetadataOverride: delegates verbatim to bindManualOverride under the synthetic key (merge logic owned by metadata-service)', async () => {
      // The merge of pre-existing free-form override fields lives
      // inside MetadataService.bindManualOverride (covered in
      // metadata-service.test.ts). At the orchestrator layer the
      // contract is just "pass the synthetic key + game through
      // untouched" — pin that no transformation happens between
      // the orchestrator and the service when the synthetic
      // fallback fires.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(),
      });
      const passthrough = buildMeta('noss-out', 'Policenauts');
      const bindSpy = vi.fn(
        async (_key: string, _game: unknown) => passthrough,
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;

      const game = buildSsGame(9999, 'Policenauts');
      const result = await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        game,
      );

      // Return value is the service's response, unwrapped.
      expect(result).toBe(passthrough);
      // Arguments to the service: synthetic key + the same game
      // object reference (no clone, no field rewrite).
      const [, gameArg] = bindSpy.mock.calls[0] ?? ['', undefined];
      expect(gameArg).toBe(game);
    });

    it('readCachedRomsMetadata: synthetic-key fallback also surfaces unmappable-core sentinels in the optimistic read (incidental side-benefit)', async () => {
      // Before this fix, synthetic records (the round-11
      // unmappable-core sentinels) were INVISIBLE to
      // readCachedRomsMetadata — only the full getRomsMetadata
      // path could find them. With the synthetic fallback the
      // optimistic read now picks them up too, so unmappable-core
      // panes paint instantly on second mount. Pin the
      // behavior so a future refactor doesn't accidentally
      // re-hide it.
      const unmappablePath = '/p/mame/foo.zip';
      const sentinel = buildMeta('noss-sentinel', 'mame placeholder');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(), // unmappable cores never have md5s
      });
      const readSpy = vi.fn(async (key: string) =>
        SYNTHETIC_KEY_RE.test(key) ? sentinel : null,
      );
      (metadataService as unknown as {
        readCachedMetadata: typeof readSpy;
      }).readCachedMetadata = readSpy;

      const result = await orchestrator.readCachedRomsMetadata('mame', [
        unmappablePath,
      ]);
      expect(result[unmappablePath]?.name).toBe('mame placeholder');
    });
  });
});
