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
import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';
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
    // feat/arcade-noromsneeded-overrides — parallel mra-keyed store
    // for TTL/discrete-logic arcade games. Tests override per-call;
    // the fixture default returns null (no override on file).
    readCachedArcadeMraMetadata: vi.fn(
      async (): Promise<RomMetadata | null> => null,
    ),
    bindArcadeMraOverride: vi.fn(async () => opts.meta ?? null),
    writeArcadeMraUserOverride: vi.fn(
      async (): Promise<RomMetadata | null> => opts.meta ?? null,
    ),
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

    it('bindArcadeManualMetadataOverride: resolves mra → primary zip → md5 and binds under the zip md5', async () => {
      // feat/arcade-manual-ss-search — the arcade variant maps the
      // .mra to its primary zip server-side (the renderer doesn't
      // carry that mapping). Pin that the bind writes under the
      // PRIMARY ZIP's md5, not under any mra-derived key, so every
      // .mra sharing the same primary zip surfaces the override on
      // the next batched cache read.
      const ZIP_BASENAME = 'dkong.zip';
      const ZIP_PATH = `/media/fat/games/mame/${ZIP_BASENAME}`;
      const ZIP_HASH = 'a'.repeat(32);
      const MRA_REL_PATH = 'Donkey Kong.mra';
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[ZIP_PATH, buildHashEntry(ZIP_HASH)]]),
      });
      const bindSpy = vi.fn(
        async (key: string, _game: unknown) => buildMeta(key, 'Donkey Kong'),
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;

      const snapshot = {
        entries: [
          {
            relativePath: MRA_REL_PATH,
            requiredZips: [[ZIP_BASENAME]],
            displayName: 'Donkey Kong',
            hidden: false,
            rbf: 'jtdkong',
            setname: 'dkong',
          },
        ],
        zipBasenames: new Set([ZIP_BASENAME]),
        byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
      };
      const result = await orchestrator.bindArcadeManualMetadataOverride(
        snapshot,
        MRA_REL_PATH,
        buildSsGame(1234, 'Donkey Kong'),
      );

      expect(result).not.toBeNull();
      expect(bindSpy).toHaveBeenCalledTimes(1);
      const [key, gameArg] = bindSpy.mock.calls[0] ?? ['', undefined];
      // The key is the PRIMARY ZIP's md5 — fanning out to every .mra
      // sharing that zip happens for free at read time.
      expect(key).toBe(ZIP_HASH);
      expect(gameArg).toMatchObject({ id: 1234, name: 'Donkey Kong' });
    });

    it('bindArcadeManualMetadataOverride: returns null when the mra is not in the snapshot', async () => {
      const { orchestrator, metadataService } = makeOrchestrator();
      const bindSpy = vi.fn(async () => buildMeta('x', 'x'));
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;
      const result = await orchestrator.bindArcadeManualMetadataOverride(
        { entries: [], zipBasenames: new Set(), byPath: new Map() },
        'Unknown.mra',
        buildSsGame(),
      );
      expect(result).toBeNull();
      expect(bindSpy).not.toHaveBeenCalled();
    });

    it('bindArcadeManualMetadataOverride: falls back to synthetic key when primary zip cannot be hashed after on-demand retry', async () => {
      // fix/#54 — both candidate paths miss the hash cache AND
      // on-demand `computeHash` returns undefined (file doesn't
      // exist on disk). Previously returned null (toast). Now falls
      // back to a synthetic key so the user's chosen match is
      // persisted and readable on reconnect.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(),
      });
      const bindSpy = vi.fn(
        async (key: string, _game: unknown) => buildMeta(key, 'Foo'),
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;
      const result = await orchestrator.bindArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: 'Foo.mra',
              requiredZips: [['foo.zip']],
              displayName: 'Foo',
              hidden: false,
              rbf: 'jtfoo',
              setname: 'foo',
            },
          ],
          zipBasenames: new Set(['foo.zip']),
          byPath: new Map([['Foo.mra', 'playable' as const]]),
        },
        'Foo.mra',
        buildSsGame(),
      );
      expect(result).not.toBeNull();
      expect(bindSpy).toHaveBeenCalledTimes(1);
      const [key] = bindSpy.mock.calls[0] ?? [''];
      // Key must be a synthetic noss- hash, NOT a zip md5.
      expect(key).toMatch(SYNTHETIC_KEY_RE);
    });

    it('bindArcadeManualMetadataOverride: hashes the primary zip on-demand when the cache misses (Devil Zone case)', async () => {
      // The auto-scrape never reached Devil Zone, so the primary
      // zip's md5 isn't in the hash cache. Pre-fix this returned
      // null; now we call computeHash directly on the candidate
      // path. The fixture's computeHash returns the entry when the
      // path is in `hashEntries` — that simulates "the zip exists
      // on disk and hashing succeeded".
      const ZIP_BASENAME = 'devilz.zip';
      const ZIP_PATH = `/media/fat/games/mame/${ZIP_BASENAME}`;
      const ZIP_HASH = 'd'.repeat(32);
      const MRA_REL_PATH = 'Devil Zone.mra';
      // `hashEntries` map drives BOTH cached lookups AND the on-
      // demand computeHash result in the fixture. We want the
      // cached lookup to MISS (no entry under the normalised cache
      // key path) but computeHash to RESOLVE. The fixture's
      // readCachedEntries uses the same `hashEntries` map, so to
      // simulate "cached miss but computeHash succeeds" we wire the
      // entries differently for each spy.
      const { orchestrator, hashService, metadataService } = makeOrchestrator({
        hashEntries: new Map(),
      });
      (hashService.computeHash as ReturnType<typeof vi.fn>).mockImplementation(
        async (_client: unknown, _host: string, path: string) => {
          if (path === ZIP_PATH) return buildHashEntry(ZIP_HASH);
          return undefined;
        },
      );
      const bindSpy = vi.fn(
        async (key: string) => buildMeta(key, 'Devil Zone'),
      );
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;

      const result = await orchestrator.bindArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: MRA_REL_PATH,
              requiredZips: [[ZIP_BASENAME]],
              displayName: 'Devil Zone',
              hidden: false,
              rbf: 'jtdevilz',
              setname: 'devilz',
            },
          ],
          zipBasenames: new Set([ZIP_BASENAME]),
          byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
        },
        MRA_REL_PATH,
        buildSsGame(9999, 'Devil Zone'),
      );

      expect(result).not.toBeNull();
      // computeHash was called for the mame/ candidate (and would
      // fall through to hbmame/ only if mame/ returned undefined).
      expect(hashService.computeHash).toHaveBeenCalled();
      // The bind uses the on-demand md5, not the synthetic key.
      const [key] = bindSpy.mock.calls[0] ?? [''];
      expect(key).toBe(ZIP_HASH);
    });

    it('setArcadeManualMetadataOverride: writes user override under the primary-zip md5', async () => {
      // Mirror of the bind test but for the edit-metadata path:
      // setArcadeManualMetadataOverride resolves the same
      // mra → primary-zip → md5 chain and routes to
      // MetadataService.writeUserOverride.
      const ZIP_BASENAME = 'dkong.zip';
      const ZIP_PATH = `/media/fat/games/mame/${ZIP_BASENAME}`;
      const ZIP_HASH = 'a'.repeat(32);
      const MRA_REL_PATH = 'Donkey Kong.mra';
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[ZIP_PATH, buildHashEntry(ZIP_HASH)]]),
      });
      const writeSpy = vi.fn(
        async (key: string) => buildMeta(key, 'Donkey Kong'),
      );
      (metadataService as unknown as {
        writeUserOverride: typeof writeSpy;
      }).writeUserOverride = writeSpy;
      const result = await orchestrator.setArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: MRA_REL_PATH,
              requiredZips: [[ZIP_BASENAME]],
              displayName: 'Donkey Kong',
              hidden: false,
              rbf: 'jtdkong',
              setname: 'dkong',
            },
          ],
          zipBasenames: new Set([ZIP_BASENAME]),
          byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
        },
        MRA_REL_PATH,
        { name: 'DK', tags: ['fave'] },
      );
      expect(result).not.toBeNull();
      const [key, override] = writeSpy.mock.calls[0] ?? ['', undefined];
      expect(key).toBe(ZIP_HASH);
      expect(override).toEqual({ name: 'DK', tags: ['fave'] });
    });

    it('bindArcadeManualMetadataOverride: routes no-roms-needed entries to the mra-keyed override store (Pong / Breakout TTL)', async () => {
      // feat/arcade-noromsneeded-overrides — TTL / discrete-logic
      // arcade games have no primary zip; the bind shouldn't try to
      // resolve a zip md5 (there's nothing to resolve). It calls
      // MetadataService.bindArcadeMraOverride keyed on the mra
      // relativePath directly.
      const MRA_REL_PATH = 'Pong.mra';
      const { orchestrator, metadataService, hashService } = makeOrchestrator({
        hashEntries: new Map(),
      });
      const bindArcadeSpy = vi.fn(
        async (relPath: string) => buildMeta(`arcade-mra:${relPath}`, 'Pong'),
      );
      (
        metadataService as unknown as {
          bindArcadeMraOverride: typeof bindArcadeSpy;
        }
      ).bindArcadeMraOverride = bindArcadeSpy;
      const bindHashSpy = vi.fn(async () => buildMeta('x', 'x'));
      (
        metadataService as unknown as {
          bindManualOverride: typeof bindHashSpy;
        }
      ).bindManualOverride = bindHashSpy;

      const result = await orchestrator.bindArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: MRA_REL_PATH,
              // TTL game — empty requiredZips, classified as
              // no-roms-needed by computePlayability.
              requiredZips: [],
              displayName: 'Pong',
              hidden: false,
              rbf: 'jtpong',
            },
          ],
          zipBasenames: new Set(),
          byPath: new Map([[MRA_REL_PATH, 'no-roms-needed' as const]]),
        },
        MRA_REL_PATH,
        buildSsGame(1111, 'Pong'),
      );

      expect(result).not.toBeNull();
      expect(bindArcadeSpy).toHaveBeenCalledTimes(1);
      const [relArg, gameArg] = bindArcadeSpy.mock.calls[0] ?? ['', undefined];
      expect(relArg).toBe(MRA_REL_PATH);
      expect(gameArg).toMatchObject({ id: 1111, name: 'Pong' });
      // Zero zip-md5 resolution attempts — bind path short-circuits.
      expect(bindHashSpy).not.toHaveBeenCalled();
      expect(hashService.computeHash).not.toHaveBeenCalled();
    });

    it('setArcadeManualMetadataOverride: routes no-roms-needed entries to the mra-keyed user-override store', async () => {
      const MRA_REL_PATH = 'Breakout TTL.mra';
      const { orchestrator, metadataService } = makeOrchestrator();
      const writeArcadeSpy = vi.fn(
        async (relPath: string) =>
          buildMeta(`arcade-mra:${relPath}`, 'Breakout TTL'),
      );
      (
        metadataService as unknown as {
          writeArcadeMraUserOverride: typeof writeArcadeSpy;
        }
      ).writeArcadeMraUserOverride = writeArcadeSpy;
      const writeHashSpy = vi.fn(async () => buildMeta('x', 'x'));
      (
        metadataService as unknown as {
          writeUserOverride: typeof writeHashSpy;
        }
      ).writeUserOverride = writeHashSpy;

      const result = await orchestrator.setArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: MRA_REL_PATH,
              requiredZips: [],
              displayName: 'Breakout TTL',
              hidden: false,
              rbf: 'jtbreakout',
            },
          ],
          zipBasenames: new Set(),
          byPath: new Map([[MRA_REL_PATH, 'no-roms-needed' as const]]),
        },
        MRA_REL_PATH,
        { name: 'Breakout', tags: ['classic'] },
      );

      expect(result).not.toBeNull();
      const [relArg, overrideArg] = writeArcadeSpy.mock.calls[0] ?? [
        '',
        undefined,
      ];
      expect(relArg).toBe(MRA_REL_PATH);
      expect(overrideArg).toEqual({ name: 'Breakout', tags: ['classic'] });
      expect(writeHashSpy).not.toHaveBeenCalled();
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

    it('readCachedRomsMetadata: synthetic-keyed manual-override wins over hash-keyed auto-scraped record', async () => {
      // fix/#55 — mirroring getCachedArcadeMetadataBatch, synthetic
      // records now take precedence over hash-keyed records so a
      // manual bind made before hashing isn't silently overridden by
      // a later auto-scrape. Both keys are read; synthetic wins when
      // non-null.
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

      // Manual override wins.
      expect(result[PATH]?.name).toBe('ManuallyBound');
      // Both the hash key and the synthetic key are probed.
      expect(readSpy).toHaveBeenCalledTimes(2);
      const keys = readSpy.mock.calls.map((c) => c[0] as string);
      expect(keys).toContain(HASH);
      expect(keys.some((k) => SYNTHETIC_KEY_RE.test(k))).toBe(true);
    });

    it('readCachedRomsMetadata: source=none sentinel under synthetic key does not shadow hash-keyed scraped record', async () => {
      // Creator B (unmappable-core short-circuit in getRomsMetadata)
      // writes source='none' sentinels under synthetic keys. Those
      // sentinels must remain transparent: readCachedMetadata filters
      // them to null, so hash-keyed scraped records still win.
      const hashMeta = buildMeta(HASH, 'ScrapedResult');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[PATH, buildHashEntry(HASH)]]),
      });
      // readCachedMetadata returns null for sentinel (mirrors real
      // MetadataService behaviour at line ~971).
      const readSpy = vi.fn(async (key: string) => {
        if (key === HASH) return hashMeta;
        return null; // synthetic key returns null (sentinel filtered)
      });
      (metadataService as unknown as {
        readCachedMetadata: typeof readSpy;
      }).readCachedMetadata = readSpy;

      const result = await orchestrator.readCachedRomsMetadata(CORE_ID, [
        PATH,
      ]);

      expect(result[PATH]?.name).toBe('ScrapedResult');
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

    it('bindManualMetadataOverride: invalidates synthetic key when binding under real md5', async () => {
      // fix/#55 staleness mitigation — when a hash entry exists the
      // bind must call metadataService.invalidate(syntheticKey) to
      // evict any stale pre-hash manual override, so the new md5-
      // keyed record wins on the next read.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[PATH, buildHashEntry(HASH)]]),
      });
      const invalidateSpy = vi.fn(async () => undefined);
      (metadataService as unknown as {
        invalidate: typeof invalidateSpy;
      }).invalidate = invalidateSpy;
      (metadataService as unknown as {
        bindManualOverride: ReturnType<typeof vi.fn>;
      }).bindManualOverride = vi.fn(async () => buildMeta(HASH, 'x'));

      await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        buildSsGame(),
      );

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      const [romInvalidateKey] =
        (invalidateSpy.mock.calls[0] as [string] | undefined) ?? [''];
      expect(romInvalidateKey).toMatch(SYNTHETIC_KEY_RE);
    });

    it('bindManualMetadataOverride: does NOT invalidate when binding under synthetic key (no hash)', async () => {
      // When no hash is available the bind writes under the synthetic
      // key itself — nothing to evict.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(), // no hash
      });
      const invalidateSpy = vi.fn(async () => undefined);
      (metadataService as unknown as {
        invalidate: typeof invalidateSpy;
      }).invalidate = invalidateSpy;
      (metadataService as unknown as {
        bindManualOverride: ReturnType<typeof vi.fn>;
      }).bindManualOverride = vi.fn(async (k: string) => buildMeta(k, 'x'));

      await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        buildSsGame(),
      );

      expect(invalidateSpy).not.toHaveBeenCalled();
    });

    it('readCachedRomsMetadata: re-bind under real md5 wins after staleness mitigation clears synthetic', async () => {
      // End-to-end: first bind writes under synthetic (no hash).
      // Second bind fires when hash IS available, which clears the
      // synthetic via invalidate. Post-mitigation read returns the
      // new hash-keyed record rather than the stale synthetic.
      //
      // Simulated by: bind with hash → metadataService.invalidate
      // is called with the synthetic key → on next read, synthetic
      // lookup returns null (file evicted) → hash-keyed record wins.
      const newBindMeta = buildMeta(HASH, 'NewChoice');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[PATH, buildHashEntry(HASH)]]),
      });
      // Bind under real md5; bind spy returns newBindMeta.
      const bindSpy = vi.fn(async () => newBindMeta);
      (metadataService as unknown as {
        bindManualOverride: typeof bindSpy;
      }).bindManualOverride = bindSpy;
      // After invalidate fires, synthetic lookup returns null.
      const readSpy = vi.fn(async (key: string) => {
        if (key === HASH) return newBindMeta;
        return null; // synthetic evicted
      });
      (metadataService as unknown as {
        readCachedMetadata: typeof readSpy;
      }).readCachedMetadata = readSpy;

      await orchestrator.bindManualMetadataOverride(
        CORE_ID,
        PATH,
        buildSsGame(),
      );
      const result = await orchestrator.readCachedRomsMetadata(CORE_ID, [
        PATH,
      ]);

      expect(result[PATH]?.name).toBe('NewChoice');
    });

    it('bindArcadeManualMetadataOverride: invalidates synthetic key when binding under real md5', async () => {
      // fix/#55 — same staleness mitigation as the ROM bind path.
      // When the primary ZIP hash IS resolved, the old synthetic
      // record (from a pre-hash bind) must be evicted so the new
      // md5-keyed record wins in getCachedArcadeMetadataBatch.
      const ZIP_BASENAME = 'dkong.zip';
      const ZIP_PATH = `/media/fat/games/mame/${ZIP_BASENAME}`;
      const ZIP_HASH = 'a'.repeat(32);
      const MRA_REL_PATH = 'Donkey Kong.mra';
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[ZIP_PATH, buildHashEntry(ZIP_HASH)]]),
      });
      const invalidateSpy = vi.fn(async () => undefined);
      (metadataService as unknown as {
        invalidate: typeof invalidateSpy;
      }).invalidate = invalidateSpy;
      (metadataService as unknown as {
        bindManualOverride: ReturnType<typeof vi.fn>;
      }).bindManualOverride = vi.fn(async () => buildMeta(ZIP_HASH, 'Donkey Kong'));

      await orchestrator.bindArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: MRA_REL_PATH,
              requiredZips: [[ZIP_BASENAME]],
              displayName: 'Donkey Kong',
              hidden: false,
              rbf: 'jtdkong',
              setname: 'dkong',
            },
          ],
          zipBasenames: new Set([ZIP_BASENAME]),
          byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
        },
        MRA_REL_PATH,
        buildSsGame(1234, 'Donkey Kong'),
      );

      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      const [arcadeInvalidateKey] =
        (invalidateSpy.mock.calls[0] as [string] | undefined) ?? [''];
      expect(arcadeInvalidateKey).toMatch(SYNTHETIC_KEY_RE);
    });

    it('bindArcadeManualMetadataOverride: does NOT invalidate when binding under synthetic key (no zip hash)', async () => {
      // When the zip hash is unavailable, the bind writes under the
      // synthetic key itself — nothing to evict.
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(), // no zip hash
      });
      const invalidateSpy = vi.fn(async () => undefined);
      (metadataService as unknown as {
        invalidate: typeof invalidateSpy;
      }).invalidate = invalidateSpy;
      (metadataService as unknown as {
        bindManualOverride: ReturnType<typeof vi.fn>;
      }).bindManualOverride = vi.fn(async (k: string) => buildMeta(k, 'Foo'));

      await orchestrator.bindArcadeManualMetadataOverride(
        {
          entries: [
            {
              relativePath: 'Foo.mra',
              requiredZips: [['foo.zip']],
              displayName: 'Foo',
              hidden: false,
              rbf: 'jtfoo',
              setname: 'foo',
            },
          ],
          zipBasenames: new Set(['foo.zip']),
          byPath: new Map([['Foo.mra', 'playable' as const]]),
        },
        'Foo.mra',
        buildSsGame(),
      );

      expect(invalidateSpy).not.toHaveBeenCalled();
    });
  });

  // feat/arcade-parity-2-metadata — the arcade prefetch pass and the
  // adapter-side cached read. Three properties pinned here:
  //   (i)   dedupe at the orchestrator level (one MetadataService
  //         call per UNIQUE zip, even when N .mras share it)
  //   (ii)  the SS hint passed to MetadataService carries systemId=75
  //         AND the .mra-derived filename (NOT the zip's basename)
  //   (iii) the cached-read path returns the same metadata record for
  //         every .mra that shares a zip
  describe('getArcadeMetadata / getCachedArcadeMetadataBatch (feat/arcade-parity-2-metadata)', () => {
    function mra(
      relativePath: string,
      requiredZips: readonly (readonly string[])[],
      setname?: string,
    ): import('@shared/arcade-mra-parse').ArcadeMraMeta {
      return {
        relativePath,
        displayName: relativePath.split('/').pop()!,
        hidden: false,
        requiredZips,
        rbf: 'r',
        setname,
      };
    }

    it('dedupes by primary zip — two .mras sharing dkong.zip → one MetadataService.getMetadata call', async () => {
      const parent = mra('Donkey Kong.mra', [['dkong.zip']]);
      const clone = mra('Donkey Kong (US).mra', [
        ['dkongus.zip', 'dkong.zip'],
      ]);
      const meta = buildMeta(HASH, 'Donkey Kong');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/media/fat/games/mame/dkong.zip', buildHashEntry(HASH, 2048, 100)],
        ]),
        meta,
      });
      // Override statPathsWithSize on the mocked client so the
      // arcade resolution step finds dkong.zip in mame/.
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) {
            out[p] =
              p === '/media/fat/games/mame/dkong.zip'
                ? { size: 2048, mtime: 100 }
                : { size: 0, mtime: 0 };
          }
          return out;
        });

      const events: RomMetadataResolvedEvent[] = [];
      await orchestrator.getArcadeMetadata(
        [parent, clone],
        new Set(['dkong.zip']),
        (event) => events.push(event),
      );

      // Exactly ONE SS lookup despite two .mras. The dedupe is the
      // load-bearing optimisation here — on a real MiSTer ~300 unique
      // zips back ~600 .mras.
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
      // Exactly ONE event emitted (one per unique zip, NOT per .mra).
      // The adapter-side IPC fans out metadata to all .mras sharing a
      // zip via `getCachedArcadeMetadataBatch`.
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata?.name).toBe('Donkey Kong');
    });

    it('passes systemId=75 + .mra-derived filename hint to MetadataService.getMetadata', async () => {
      // The .mra's setname (`dkong`) is folded into the synthesised
      // filename `'Donkey Kong (dkong).mra'` so extractNameHints emits
      // BOTH a paren-shortname and a filename-stem hint to the SS
      // name-search fallback. Path-derived hints would give us
      // `'dkong.zip'` → terrible search term.
      const entry = mra('Donkey Kong.mra', [['dkong.zip']], 'dkong');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/media/fat/games/mame/dkong.zip', buildHashEntry(HASH)],
        ]),
        meta: buildMeta(HASH, 'Donkey Kong'),
      });
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) {
            out[p] =
              p === '/media/fat/games/mame/dkong.zip'
                ? { size: 1024, mtime: 100 }
                : { size: 0, mtime: 0 };
          }
          return out;
        });

      await orchestrator.getArcadeMetadata(
        [entry],
        new Set(['dkong.zip']),
      );

      expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
      const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      // arg[0]: hash (md5 of the resolved zip).
      expect(call?.[0]).toBe(HASH);
      // arg[1]: MetadataHint — filename is the synthesised .mra name,
      // NOT the zip's basename. parentFolder is `_Arcade`.
      expect(call?.[1]).toEqual({
        filename: 'Donkey Kong (dkong).mra',
        parentFolder: '_Arcade',
        parentFolderIsAtomic: false,
      });
      // arg[2]: ScreenScraperHint — systemId is 75 (MAME / arcade) AND
      // romName carries the .mra displayName (the human-readable form).
      expect(call?.[2]).toMatchObject({
        systemId: 75,
        md5: HASH,
        romName: 'Donkey Kong.mra',
      });
    });

    it('falls back to displayName-only filename when the .mra has no setname', async () => {
      const entry = mra('Galaga.mra', [['galaga.zip']]); // no setname
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/media/fat/games/mame/galaga.zip', buildHashEntry(HASH)],
        ]),
        meta: buildMeta(HASH, 'Galaga'),
      });
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) {
            out[p] =
              p === '/media/fat/games/mame/galaga.zip'
                ? { size: 1024, mtime: 100 }
                : { size: 0, mtime: 0 };
          }
          return out;
        });
      await orchestrator.getArcadeMetadata([entry], new Set(['galaga.zip']));
      const call = (metadataService.getMetadata as ReturnType<typeof vi.fn>)
        .mock.calls[0];
      // No `(setname)` paren in the synthesised filename — falls back
      // to the displayName as-is.
      expect((call?.[1] as { filename: string }).filename).toBe('Galaga.mra');
    });

    it('reuses the existing MetadataService cache (hash already populated by ROM prefetch)', async () => {
      // The MetadataService cache is keyed by md5 (32-char hex) and is
      // NOT partitioned by system. A hash a ROM prefetch wrote (e.g.
      // a previous browse of the MAME core's dkong.zip) is reused as-is
      // when arcade's getArcadeMetadata calls getMetadata with the
      // same md5 — getMetadata returns the cached record without
      // re-querying SS. The orchestrator can't observe that directly
      // (the cache lookup is inside MetadataService); we instead pin
      // the orchestrator-level contract: same md5 input → same record
      // returned, no extra hash compute.
      const entry = mra('Donkey Kong.mra', [['dkong.zip']]);
      const meta = buildMeta(HASH, 'Donkey Kong');
      const { orchestrator, hashService, metadataService } = makeOrchestrator(
        {
          hashEntries: new Map([
            ['/media/fat/games/mame/dkong.zip', buildHashEntry(HASH)],
          ]),
          meta,
        },
      );
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) {
            out[p] =
              p === '/media/fat/games/mame/dkong.zip'
                ? { size: 1024, mtime: 100 }
                : { size: 0, mtime: 0 };
          }
          return out;
        });
      await orchestrator.getArcadeMetadata([entry], new Set(['dkong.zip']));
      // Hash compute did NOT fire — `checkCachedMtimes` returned the
      // cached entry → cache hit path. This is the cross-pipeline
      // reuse property: ROM prefetch warmed the cache; arcade picks it
      // up for free.
      expect(hashService.computeHash).not.toHaveBeenCalled();
      expect(metadataService.getMetadata).toHaveBeenCalledTimes(1);
    });

    it('chunks the primary-zip stat at 100 paths per SSH op (ARG_MAX overflow fix)', async () => {
      // PR-62 live trace fired `Argument list too long` on a 706-path
      // single statPathsWithSize call (353 unique zips × 2 candidate
      // dirs). Same class of bug PR #53 and PR #56 solved for witness
      // and sample-md5; the orchestrator now reuses the shared
      // `chunked` helper at the 100-path window.
      //
      // 150 .mras sharing nothing → 150 unique zips → 300 candidate
      // paths → expect 3 SSH chunks of 100 / 100 / 100.
      const N_MRAS = 150;
      const entries: ArcadeMraMeta[] = [];
      const zipBasenameSet = new Set<string>();
      const hashEntries = new Map<string, HashEntry>();
      for (let i = 0; i < N_MRAS; i += 1) {
        const basename = `arcade-${String(i).padStart(3, '0')}.zip`;
        entries.push({
          relativePath: `Game ${String(i)}.mra`,
          displayName: `Game ${String(i)}.mra`,
          hidden: false,
          requiredZips: [[basename]],
          rbf: 'r',
        });
        zipBasenameSet.add(basename);
        hashEntries.set(`/media/fat/games/mame/${basename}`, buildHashEntry(HASH));
      }
      const meta = buildMeta(HASH, 'Synthetic');
      const { orchestrator } = makeOrchestrator({ hashEntries, meta });
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      // Record one entry per call so we can assert chunk sizes after.
      const statCallSizes: number[] = [];
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          statCallSizes.push(paths.length);
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) {
            out[p] = p.startsWith('/media/fat/games/mame/')
              ? { size: 1024, mtime: 100 }
              : { size: 0, mtime: 0 };
          }
          return out;
        });

      await orchestrator.getArcadeMetadata(entries, zipBasenameSet);

      // 300 candidate paths / 100 = exactly 3 chunks of 100. No
      // single call exceeds the limit — that's the ARG_MAX fix.
      expect(statCallSizes).toEqual([100, 100, 100]);
      // The aggregate Object.assign merge must yield all 150 unique
      // zip resolutions — one .mra-per-zip → one getMetadata per
      // zip → 150 SS lookups total. If the chunked aggregation
      // dropped any chunk's results, we'd see < 150 here.
      expect(
        (
          (orchestrator as unknown as {
            metadataService: { getMetadata: ReturnType<typeof vi.fn> };
          }).metadataService.getMetadata as ReturnType<typeof vi.fn>
        ).mock.calls.length,
      ).toBe(N_MRAS);
    });

    it('emits a null-metadata event when a snapshot-listed zip stat-resolves to size=0 (race with removal)', async () => {
      // The snapshot may say `dkong.zip` is in zipBasenames, but
      // between snapshot capture and prefetch the user removes the
      // zip. Stat returns size=0. The orchestrator emits one event
      // with metadata=null so the engine's done/total ticking stays
      // accurate (one event per listRomPaths entry).
      const entry = mra('Donkey Kong.mra', [['dkong.zip']]);
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map(),
        meta: null,
      });
      const session = (orchestrator as unknown as {
        getActiveSession: () => ActiveSession | null;
      }).getActiveSession();
      if (session === null) throw new Error('test setup: session null');
      (session.client.statPathsWithSize as ReturnType<typeof vi.fn>)
        .mockImplementation(async (paths: readonly string[]) => {
          const out: Record<string, { size: number; mtime: number }> = {};
          for (const p of paths) out[p] = { size: 0, mtime: 0 };
          return out;
        });
      const events: RomMetadataResolvedEvent[] = [];
      await orchestrator.getArcadeMetadata(
        [entry],
        new Set(['dkong.zip']),
        (event) => events.push(event),
      );
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toBeNull();
      expect(events[0]?.error).toBe(false);
    });

    it('getCachedArcadeMetadataBatch: fans the same SS record across all .mras sharing a zip', async () => {
      // Two .mras → same primary zip → same md5 → same RomMetadata.
      // The adapter-side IPC must paint identical metadata on every
      // row that maps to a shared zip.
      const parent = mra('Donkey Kong.mra', [['dkong.zip']]);
      const clone = mra('Donkey Kong (US).mra', [['dkong.zip']]);
      const meta = buildMeta(HASH, 'Donkey Kong');
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map([
          ['/media/fat/games/mame/dkong.zip', buildHashEntry(HASH)],
        ]),
        meta,
      });
      const result = await orchestrator.getCachedArcadeMetadataBatch(
        'host-1',
        {
          entries: [parent, clone],
          zipBasenames: new Set(['dkong.zip']),
          byPath: new Map([
            ['Donkey Kong.mra', 'playable' as const],
            ['Donkey Kong (US).mra', 'playable' as const],
          ]),
        },
      );
      expect(result['Donkey Kong.mra']?.name).toBe('Donkey Kong');
      expect(result['Donkey Kong (US).mra']?.name).toBe('Donkey Kong');
      // Same record reference — the metadata cache is shared, not
      // copied per .mra.
      expect(result['Donkey Kong.mra']).toBe(result['Donkey Kong (US).mra']);
    });

    it('getCachedArcadeMetadataBatch: returns null for a playable .mra whose zip is not in the hash cache yet', async () => {
      // Prefetch hasn't run yet for this zip → hashCache empty →
      // can't look up metadata → null. The adapter shape sees null
      // and (in PR C) renders the row without metadata cells.
      const entry = mra('Donkey Kong.mra', [['dkong.zip']]);
      const { orchestrator } = makeOrchestrator({
        hashEntries: new Map(), // empty — no zip hashed yet
        meta: null,
      });
      const result = await orchestrator.getCachedArcadeMetadataBatch(
        'host-1',
        {
          entries: [entry],
          zipBasenames: new Set(['dkong.zip']),
          byPath: new Map([['Donkey Kong.mra', 'playable' as const]]),
        },
      );
      expect(result['Donkey Kong.mra']).toBeNull();
    });

    it('getCachedArcadeMetadataBatch: returns synthetic-keyed record for a .mra whose zip is not yet hashed', async () => {
      // fix/#54 — when the zip hash is absent from the cache, fall
      // back to the per-mra synthetic key rather than returning null.
      // This ensures a manual bind made before hashing is visible on
      // reconnect.
      const MRA_REL_PATH = 'Devil Zone.mra';
      const syntheticMeta = buildMeta('noss-synthetic', 'Devil Zone');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map(), // no zip hashed
      });
      (
        metadataService as unknown as {
          readCachedMetadata: ReturnType<typeof vi.fn>;
        }
      ).readCachedMetadata.mockImplementation(async (key: string) =>
        key.startsWith('noss-') ? syntheticMeta : null,
      );

      const result = await orchestrator.getCachedArcadeMetadataBatch(
        'host-1',
        {
          entries: [mra(MRA_REL_PATH, [['devilz.zip']])],
          zipBasenames: new Set(['devilz.zip']),
          byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
        },
      );

      expect(result[MRA_REL_PATH]?.name).toBe('Devil Zone');
    });

    it('getCachedArcadeMetadataBatch: synthetic-keyed override wins over auto-scraped hash-keyed record', async () => {
      // fix/#54 — manual overrides written under a synthetic key must
      // survive a subsequent auto-scrape that populates the real zip
      // md5. The per-mra synthetic check is consulted first; if a
      // synthetic record exists it is returned regardless of whether
      // a hash-keyed record is also present.
      //
      // NOTE: the ROM read path (`readCachedRomsMetadata`) has the
      // inverse priority (hash wins). The asymmetry is intentional
      // and documented in getCachedArcadeMetadataBatch's comment.
      const MRA_REL_PATH = 'Donkey Kong.mra';
      const ZIP_PATH = '/media/fat/games/mame/dkong.zip';
      const autoScrapedMeta = buildMeta(HASH, 'Donkey Kong (auto)');
      const manualMeta = buildMeta('noss-bound', 'Donkey Kong (my pick)');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([[ZIP_PATH, buildHashEntry(HASH)]]),
      });
      (
        metadataService as unknown as {
          readCachedMetadata: ReturnType<typeof vi.fn>;
        }
      ).readCachedMetadata.mockImplementation(async (key: string) => {
        if (key === HASH) return autoScrapedMeta;
        if (key.startsWith('noss-')) return manualMeta;
        return null;
      });

      const result = await orchestrator.getCachedArcadeMetadataBatch(
        'host-1',
        {
          entries: [mra(MRA_REL_PATH, [['dkong.zip']])],
          zipBasenames: new Set(['dkong.zip']),
          byPath: new Map([[MRA_REL_PATH, 'playable' as const]]),
        },
      );

      // Manual override (synthetic key) beats the auto-scraped record.
      expect(result[MRA_REL_PATH]?.name).toBe('Donkey Kong (my pick)');
    });

    it('getCachedArcadeMetadataBatch: skips missing .mras; surfaces no-roms-needed via the parallel override store', async () => {
      // feat/arcade-noromsneeded-overrides — TTL / discrete-logic
      // .mras have no zip to hash and route through the
      // arcade-mra-overrides store. The batch read now consults that
      // store for each no-roms-needed entry (returning null when no
      // override exists, populated when one does).
      const playableMra = mra('Playable.mra', [['dkong.zip']]);
      const missingMra = mra('Missing.mra', [['lost.zip']]);
      const noRomsNeededWithOverride = mra('TTL Bound.mra', []);
      const noRomsNeededFresh = mra('TTL Fresh.mra', []);
      const meta = buildMeta(HASH, 'Playable');
      const overrideMeta = buildMeta('arcade-mra:ttl-bound', 'TTL Bound');
      const { orchestrator, metadataService } = makeOrchestrator({
        hashEntries: new Map([
          ['/media/fat/games/mame/dkong.zip', buildHashEntry(HASH)],
        ]),
        meta,
      });
      (
        metadataService as unknown as {
          readCachedArcadeMraMetadata: ReturnType<typeof vi.fn>;
        }
      ).readCachedArcadeMraMetadata.mockImplementation(
        async (mraRel: string) =>
          mraRel === 'TTL Bound.mra' ? overrideMeta : null,
      );
      const result = await orchestrator.getCachedArcadeMetadataBatch(
        'host-1',
        {
          entries: [
            playableMra,
            missingMra,
            noRomsNeededWithOverride,
            noRomsNeededFresh,
          ],
          zipBasenames: new Set(['dkong.zip']),
          byPath: new Map<
            string,
            'playable' | 'missing' | 'no-roms-needed'
          >([
            ['Playable.mra', 'playable'],
            ['Missing.mra', 'missing'],
            ['TTL Bound.mra', 'no-roms-needed'],
            ['TTL Fresh.mra', 'no-roms-needed'],
          ]),
        },
      );
      // Missing.mra stays out — no zip on disk, no path to anywhere.
      expect(result['Missing.mra']).toBeUndefined();
      // Playable.mra resolved through the zip-md5 chain.
      expect(result['Playable.mra']?.name).toBe('Playable');
      // TTL Bound has an override on file → returns it.
      expect(result['TTL Bound.mra']?.name).toBe('TTL Bound');
      // TTL Fresh has no override yet → null (renderer paints
      // "no metadata yet" with a Find on ScreenScraper button).
      expect(result['TTL Fresh.mra']).toBeNull();
    });
  });
});
