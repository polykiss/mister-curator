import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from '@shared/preload-api';
import type { RomMetadata } from '@shared/metadata-types';

/**
 * PR #15 requires "one stub renderer-side test that calls each
 * channel against a fake client and asserts the response shape."
 * This file is that test.
 *
 * The renderer talks to main through `ipcRenderer.invoke(channel, ...)`
 * which lands in `ipcMain.handle(channel, ...)`. We mock the latter
 * to record handlers, then drive each handler with the same args the
 * preload bridge would send.
 */

interface RegisteredHandler {
  readonly handler: (
    event: unknown,
    ...args: readonly unknown[]
  ) => Promise<unknown> | unknown;
}

const handlers = new Map<string, RegisteredHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: RegisteredHandler['handler']) => {
      handlers.set(channel, { handler });
    }),
  },
  // Stubs for the parts of `electron` register.ts touches indirectly.
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
}));

const { registerIpcHandlers } = await import('@app/main/ipc/register');

const SAMPLE_META: RomMetadata = {
  version: 4,
  hash: 'a'.repeat(32),
  name: 'Super Mario World',
  system: 'Super Nintendo Entertainment System',
  year: 1991,
  publisher: 'Nintendo',
  developer: 'Nintendo EAD',
  genre: 'Platform',
  description: 'Mario rescues the princess.',
  players: null,
  rating: null,
  releaseDate: null,
  boxArtUrl: 'https://cdn/box.png',
  titleScreenUrl: null,
  screenshotUrl: null,
  source: 'openvgdb',
  fetchedAt: '2025-01-01T00:00:00.000Z',
};

describe('IPC bridge — metadata pipeline (PR #15)', () => {
  let stubManager: Record<string, unknown>;
  let stubOrchestrator: {
    getRomMetadata: ReturnType<typeof vi.fn>;
    prefetchHashes: ReturnType<typeof vi.fn>;
    prefetchMetadata: ReturnType<typeof vi.fn>;
    clearMetadataCache: ReturnType<typeof vi.fn>;
    getBoxArtLocal: ReturnType<typeof vi.fn>;
    getBoxArtBytes: ReturnType<typeof vi.fn>;
    getRomsMetadata: ReturnType<typeof vi.fn>;
    ensureMetadataDatabase: ReturnType<typeof vi.fn>;
  };
  let emitProgress: ReturnType<typeof vi.fn>;
  let emitDbProgress: ReturnType<typeof vi.fn>;
  let emitRomMetadataResolved: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handlers.clear();

    stubManager = {
      // Only the methods touched by the PR-#15 channel set need to
      // exist. Anything else stays undefined; the handlers we exercise
      // never reach those.
      listAllCoresWithFiles: vi.fn(),
      listRoms: vi.fn(),
    };
    stubOrchestrator = {
      getRomMetadata: vi.fn(async () => SAMPLE_META),
      prefetchHashes: vi.fn(async (_paths: readonly string[], onProgress?: (e: unknown) => void) => {
        onProgress?.({ done: 1, total: 1 });
      }),
      prefetchMetadata: vi.fn(async (hashes: readonly string[], onProgress?: (e: unknown) => void) => {
        for (let i = 0; i < hashes.length; i += 1) {
          onProgress?.({ done: i + 1, total: hashes.length });
        }
      }),
      clearMetadataCache: vi.fn(async () => undefined),
      getBoxArtLocal: vi.fn(async (url: string) => `/cache/${url}`),
      getBoxArtBytes: vi.fn(async () => new Uint8Array([1, 2, 3])),
      getRomsMetadata: vi.fn(
        async (
          _coreId: string,
          paths: readonly string[],
          onResolved?: (e: {
            path: string;
            metadata: RomMetadata | null;
            error: boolean;
          }) => void,
        ) => {
          for (const p of paths) {
            onResolved?.({ path: p, metadata: SAMPLE_META, error: false });
          }
        },
      ),
      ensureMetadataDatabase: vi.fn(
        async (cb?: (e: { kind: string }) => void) => {
          cb?.({ kind: 'started' });
          cb?.({ kind: 'ready' });
          return { ready: true, downloadInProgress: false };
        },
      ),
    };
    emitProgress = vi.fn();
    emitDbProgress = vi.fn();
    emitRomMetadataResolved = vi.fn();

    registerIpcHandlers(
      stubManager as never,
      { list: () => [] } as never,
      stubOrchestrator as never,
      emitProgress as never,
      emitDbProgress as never,
      emitRomMetadataResolved as never,
      // PR-C (PR #26): metadata-ipc tests don't exercise the
      // auto-scrape engine path; pass a stub that never gets called.
      { setFocus: () => undefined } as never,
      // PR-D2 (PR #29): search-by-name path not exercised here;
      // pass null for the SS service.
      null,
      () => undefined,
    );
  });

  it('registers every documented metadata channel', () => {
    expect(handlers.has(IPC_CHANNELS.getRomMetadata)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.prefetchHashes)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.prefetchMetadata)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.clearMetadataCache)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.getBoxArtLocal)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.getBoxArtBytes)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.prefetchRomsMetadata)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.ensureMetadataDatabase)).toBe(true);
  });

  it('mister:getRomMetadata returns the orchestrator\'s payload shape', async () => {
    const h = handlers.get(IPC_CHANNELS.getRomMetadata);
    expect(h).toBeDefined();
    const result = (await h!.handler({}, 'SNES', '/p/x.sfc', { name: 'X' })) as RomMetadata;
    expect(result.hash).toBe(SAMPLE_META.hash);
    expect(result.source).toBe('openvgdb');
    expect(result.system).toBe('Super Nintendo Entertainment System');
    expect(stubOrchestrator.getRomMetadata).toHaveBeenCalledWith(
      'SNES',
      '/p/x.sfc',
      { name: 'X' },
    );
  });

  it('mister:getRomMetadata defaults hint to {} when undefined', async () => {
    const h = handlers.get(IPC_CHANNELS.getRomMetadata);
    await h!.handler({}, 'SNES', '/p/x.sfc', undefined);
    expect(stubOrchestrator.getRomMetadata).toHaveBeenCalledWith(
      'SNES',
      '/p/x.sfc',
      {},
    );
  });

  it('mister:prefetchHashes synthesises an operationId and emits progress', async () => {
    const h = handlers.get(IPC_CHANNELS.prefetchHashes);
    await h!.handler({}, ['/p/a', '/p/b'], undefined);
    expect(stubOrchestrator.prefetchHashes).toHaveBeenCalledTimes(1);
    expect(emitProgress).toHaveBeenCalledTimes(1);
    const event = emitProgress.mock.calls[0]?.[0] as {
      operationId: string;
      kind: string;
      done: number;
      total: number;
    };
    expect(event.kind).toBe('hash');
    expect(typeof event.operationId).toBe('string');
    expect(event.operationId.length).toBeGreaterThan(0);
    expect(event.done).toBe(1);
    expect(event.total).toBe(1);
  });

  it('mister:prefetchHashes honours a caller-supplied operationId', async () => {
    const h = handlers.get(IPC_CHANNELS.prefetchHashes);
    await h!.handler({}, ['/p/a'], { operationId: 'custom-1' });
    const event = emitProgress.mock.calls[0]?.[0] as { operationId: string };
    expect(event.operationId).toBe('custom-1');
  });

  it('mister:prefetchMetadata emits one progress event per hash', async () => {
    const h = handlers.get(IPC_CHANNELS.prefetchMetadata);
    const hashes = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32)];
    await h!.handler({}, hashes, { operationId: 'meta-1' });
    expect(emitProgress).toHaveBeenCalledTimes(3);
    const last = emitProgress.mock.calls[2]?.[0] as {
      operationId: string;
      kind: string;
      done: number;
      total: number;
    };
    expect(last).toEqual({ operationId: 'meta-1', kind: 'metadata', done: 3, total: 3 });
  });

  it('mister:clearMetadataCache delegates without arguments', async () => {
    const h = handlers.get(IPC_CHANNELS.clearMetadataCache);
    await h!.handler({});
    expect(stubOrchestrator.clearMetadataCache).toHaveBeenCalledTimes(1);
  });

  it('mister:getBoxArtLocal returns a string or null', async () => {
    const h = handlers.get(IPC_CHANNELS.getBoxArtLocal);
    const result = await h!.handler({}, 'https://cdn/box.png');
    expect(result).toBe('/cache/https://cdn/box.png');
    expect(stubOrchestrator.getBoxArtLocal).toHaveBeenCalledWith(
      'https://cdn/box.png',
    );
  });

  it('mister:getBoxArtBytes returns Uint8Array bytes for the renderer Blob path (PR #20)', async () => {
    const h = handlers.get(IPC_CHANNELS.getBoxArtBytes);
    const result = (await h!.handler({}, 'https://cdn/box.png')) as Uint8Array;
    expect(result).toBeInstanceOf(Uint8Array);
    expect(Array.from(result)).toEqual([1, 2, 3]);
    expect(stubOrchestrator.getBoxArtBytes).toHaveBeenCalledWith(
      'https://cdn/box.png',
    );
  });

  it('mister:prefetchRomsMetadata streams one resolved event per path (PR #20 round 2)', async () => {
    const h = handlers.get(IPC_CHANNELS.prefetchRomsMetadata);
    await h!.handler({}, 'SNES', ['/p/a', '/p/b'], { operationId: 'op-1' });
    expect(stubOrchestrator.getRomsMetadata).toHaveBeenCalledTimes(1);
    expect(emitRomMetadataResolved).toHaveBeenCalledTimes(2);
    const events = emitRomMetadataResolved.mock.calls.map(
      (c) => c[0] as {
        operationId: string;
        path: string;
        metadata: RomMetadata | null;
        error: boolean;
      },
    );
    expect(events.map((e) => e.path)).toEqual(['/p/a', '/p/b']);
    expect(events.every((e) => e.operationId === 'op-1')).toBe(true);
    expect(events.every((e) => !e.error)).toBe(true);
  });

  it('mister:prefetchRomsMetadata synthesises an operationId when caller omits one', async () => {
    const h = handlers.get(IPC_CHANNELS.prefetchRomsMetadata);
    await h!.handler({}, 'SNES', ['/p/a'], undefined);
    const event = emitRomMetadataResolved.mock.calls[0]?.[0] as {
      operationId: string;
    };
    expect(typeof event.operationId).toBe('string');
    expect(event.operationId.length).toBeGreaterThan(0);
  });

  it('mister:ensureMetadataDatabase returns the state and forwards progress', async () => {
    const h = handlers.get(IPC_CHANNELS.ensureMetadataDatabase);
    const result = (await h!.handler({})) as {
      ready: boolean;
      downloadInProgress: boolean;
    };
    expect(result).toEqual({ ready: true, downloadInProgress: false });
    expect(stubOrchestrator.ensureMetadataDatabase).toHaveBeenCalledTimes(1);
    expect(emitDbProgress).toHaveBeenCalled();
    const kinds = emitDbProgress.mock.calls.map(
      (c) => (c[0] as { kind: string }).kind,
    );
    expect(kinds).toContain('started');
    expect(kinds).toContain('ready');
  });

  it('strips the `path` field from the underlying ready event', async () => {
    // The OpenVGDBService emits `{ kind: 'ready', path }` — the
    // renderer doesn't need that path, so the IPC handler trims it.
    stubOrchestrator.ensureMetadataDatabase = vi.fn(
      async (cb?: (e: { kind: string; path?: string }) => void) => {
        cb?.({ kind: 'ready', path: '/local/path/to/openvgdb.sqlite' });
        return { ready: true, downloadInProgress: false };
      },
    );
    handlers.clear();
    registerIpcHandlers(
      stubManager as never,
      { list: () => [] } as never,
      stubOrchestrator as never,
      emitProgress as never,
      emitDbProgress as never,
      emitRomMetadataResolved as never,
      // PR-C (PR #26): metadata-ipc tests don't exercise the
      // auto-scrape engine path; pass a stub that never gets called.
      { setFocus: () => undefined } as never,
      // PR-D2 (PR #29): search-by-name path not exercised here;
      // pass null for the SS service.
      null,
      () => undefined,
    );
    const h = handlers.get(IPC_CHANNELS.ensureMetadataDatabase);
    await h!.handler({});
    const readyEvent = emitDbProgress.mock.calls
      .map((c) => c[0] as { kind: string; path?: string })
      .find((e) => e.kind === 'ready');
    expect(readyEvent?.path).toBeUndefined();
  });
});

/**
 * feat/manual-search-observability — IPC-handler coverage for the
 * search-by-name channel. Two early-return paths (`service-null`,
 * `no-system-mapping`) fire in `register.ts` before the service is
 * touched; the call-through path threads to the service stub. Per
 * the spec each branch needs an `ss-manual-search-attempt` and
 * `ss-manual-search-result` diag pair.
 */
describe('IPC bridge — searchScreenScraperByName diag logs', () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;
  let stubScreenScraper: {
    getStatus: ReturnType<typeof vi.fn>;
    isConfigured: boolean;
    searchByName: ReturnType<typeof vi.fn>;
  };

  function diagLines(): readonly string[] {
    return consoleLogSpy.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter((l) => l.startsWith('[meta] · ss-manual-search-'));
  }

  beforeEach(() => {
    handlers.clear();
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      /* swallow noise from the handler-attempt/result log lines */
    });
    stubScreenScraper = {
      getStatus: vi.fn(() => 'available'),
      isConfigured: true,
      searchByName: vi.fn(),
    };
  });

  function register(opts: { readonly withSS?: boolean } = {}): void {
    registerIpcHandlers(
      { listAllCoresWithFiles: vi.fn(), listRoms: vi.fn() } as never,
      { list: () => [] } as never,
      {
        getRomMetadata: vi.fn(),
        prefetchHashes: vi.fn(),
        prefetchMetadata: vi.fn(),
        clearMetadataCache: vi.fn(),
        getBoxArtLocal: vi.fn(),
        getBoxArtBytes: vi.fn(),
        getRomsMetadata: vi.fn(),
        ensureMetadataDatabase: vi.fn(),
      } as never,
      vi.fn() as never,
      vi.fn() as never,
      vi.fn() as never,
      { setFocus: () => undefined } as never,
      (opts.withSS ?? true ? stubScreenScraper : null) as never,
      () => undefined,
    );
  }

  it('emits attempt + result(service-null) when screenScraper is null', async () => {
    register({ withSS: false });
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    const result = (await h!.handler({}, 'PSX', 'policenauts')) as readonly unknown[];
    expect(result).toEqual([]);
    const lines = diagLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('ss-manual-search-attempt');
    expect(lines[0]).toContain('coreId=PSX');
    expect(lines[0]).toContain('searchTerm=policenauts');
    expect(lines[1]).toContain('ss-manual-search-result');
    expect(lines[1]).toContain('outcome=empty');
    expect(lines[1]).toContain('reason=service-null');
  });

  it('emits attempt + result(no-system-mapping) for an unmapped coreId', async () => {
    register();
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    const result = (await h!.handler({}, 'hbmame', 'mslug2')) as readonly unknown[];
    expect(result).toEqual([]);
    const lines = diagLines();
    expect(lines[1]).toContain('outcome=empty');
    expect(lines[1]).toContain('reason=no-system-mapping');
    expect(stubScreenScraper.searchByName).not.toHaveBeenCalled();
  });

  it('threads through service.searchByName for a mapped core, logging outcome=results', async () => {
    register();
    stubScreenScraper.searchByName.mockResolvedValueOnce({
      kind: 'ok',
      results: [
        {
          id: 1,
          name: 'Policenauts',
          system: 'Sony - PlayStation',
          description: null,
          year: 1994,
          publisher: null,
          developer: null,
          genres: [],
          players: null,
          rating: null,
          releaseDate: null,
          boxArtUrl: null,
          extra: { titleScreenUrl: null, snapUrl: null },
        },
      ],
    });
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    const result = (await h!.handler({}, 'PSX', 'policenauts')) as readonly unknown[];
    expect(result).toHaveLength(1);
    expect(stubScreenScraper.searchByName).toHaveBeenCalledWith({
      systemId: 57,
      searchTerm: 'policenauts',
    });
    const lines = diagLines();
    expect(lines[1]).toContain('outcome=results');
    expect(lines[1]).toContain('count=1');
  });

  it('logs the service-layer reason verbatim on outcome=empty', async () => {
    // Every service-layer empty branch hits the same logging path —
    // pin the no-credentials case as a representative; the other
    // service-layer reasons (service-unavailable, fetch-failed,
    // parser-empty, all-parsed-dropped) are covered separately in
    // screenscraper-service.test.ts. This test ensures the IPC
    // handler echoes whatever `reason` the service returns.
    register();
    stubScreenScraper.searchByName.mockResolvedValueOnce({
      kind: 'empty',
      reason: 'no-credentials',
    });
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    await h!.handler({}, 'PSX', 'policenauts');
    const lines = diagLines();
    expect(lines[1]).toContain('outcome=empty');
    expect(lines[1]).toContain('reason=no-credentials');
  });

  it('surfaces httpStatus when the service returns reason=fetch-failed', async () => {
    register();
    stubScreenScraper.searchByName.mockResolvedValueOnce({
      kind: 'empty',
      reason: 'fetch-failed',
      httpStatus: 429,
    });
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    await h!.handler({}, 'PSX', 'policenauts');
    const lines = diagLines();
    expect(lines[1]).toContain('reason=fetch-failed');
    expect(lines[1]).toContain('httpStatus=429');
  });

  it('surfaces status when the service returns reason=service-unavailable', async () => {
    register();
    stubScreenScraper.searchByName.mockResolvedValueOnce({
      kind: 'empty',
      reason: 'service-unavailable',
      status: 'rate-limited',
    });
    const h = handlers.get(IPC_CHANNELS.searchScreenScraperByName);
    await h!.handler({}, 'PSX', 'policenauts');
    const lines = diagLines();
    expect(lines[1]).toContain('reason=service-unavailable');
    expect(lines[1]).toContain('status=rate-limited');
  });
});

// feat/arcade-parity-2-metadata — the setAutoScrapeFocus IPC used to
// early-return on `ARCADE_VIRTUAL_CORE_ID` (the synthetic Arcade
// row predated PR #62's actual arcade pass). PR #62 wired up
// `getArcadeMetadata`, so the engine handles the sentinel coreId via
// the deps `scrape` dispatch — the guard at the IPC boundary is now
// stale and was blocking the user from clicking the Arcade row to
// pivot the queue. Guard removed; this test pins that focus events
// for arcade reach `engine.setFocus` like any other coreId.
describe('IPC bridge — setAutoScrapeFocus passes ARCADE_VIRTUAL_CORE_ID through', () => {
  let stubEngine: { setFocus: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    handlers.clear();
    stubEngine = { setFocus: vi.fn() };
    registerIpcHandlers(
      {
        listAllCoresWithFiles: vi.fn(),
        listRoms: vi.fn(),
      } as never,
      { list: () => [] } as never,
      {
        getRomMetadata: vi.fn(),
        prefetchHashes: vi.fn(),
        prefetchMetadata: vi.fn(),
        clearMetadataCache: vi.fn(),
        getBoxArtLocal: vi.fn(),
        getBoxArtBytes: vi.fn(),
        getRomsMetadata: vi.fn(),
        ensureMetadataDatabase: vi.fn(),
      } as never,
      vi.fn(),
      vi.fn(),
      vi.fn(),
      stubEngine as never,
      null,
      () => undefined,
    );
  });

  it('forwards a regular-core focus to engine.setFocus', async () => {
    const h = handlers.get(IPC_CHANNELS.setAutoScrapeFocus);
    expect(h).toBeDefined();
    await h!.handler({}, 'NEOGEO');
    expect(stubEngine.setFocus).toHaveBeenCalledWith('NEOGEO');
  });

  it('forwards ARCADE_VIRTUAL_CORE_ID to engine.setFocus (previously blocked by stale PR-1.5 guard)', async () => {
    const h = handlers.get(IPC_CHANNELS.setAutoScrapeFocus);
    expect(h).toBeDefined();
    await h!.handler({}, '__arcade__');
    // The previous guard early-returned without invoking the engine.
    // After PR-62 wired up `getArcadeMetadata`, the engine handles the
    // sentinel just like any other coreId — pivoting it to the head of
    // the queue and routing the scrape through `deps.scrape`.
    expect(stubEngine.setFocus).toHaveBeenCalledWith('__arcade__');
  });
});
