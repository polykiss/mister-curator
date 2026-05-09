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
    ensureMetadataDatabase: ReturnType<typeof vi.fn>;
  };
  let emitProgress: ReturnType<typeof vi.fn>;
  let emitDbProgress: ReturnType<typeof vi.fn>;

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

    registerIpcHandlers(
      stubManager as never,
      { list: () => [] } as never,
      stubOrchestrator as never,
      emitProgress as never,
      emitDbProgress as never,
    );
  });

  it('registers every documented metadata channel', () => {
    expect(handlers.has(IPC_CHANNELS.getRomMetadata)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.prefetchHashes)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.prefetchMetadata)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.clearMetadataCache)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.getBoxArtLocal)).toBe(true);
    expect(handlers.has(IPC_CHANNELS.getBoxArtBytes)).toBe(true);
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
    );
    const h = handlers.get(IPC_CHANNELS.ensureMetadataDatabase);
    await h!.handler({});
    const readyEvent = emitDbProgress.mock.calls
      .map((c) => c[0] as { kind: string; path?: string })
      .find((e) => e.kind === 'ready');
    expect(readyEvent?.path).toBeUndefined();
  });
});
