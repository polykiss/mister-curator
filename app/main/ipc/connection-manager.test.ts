import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { CacheManager } from '@app/main/cache/cache-manager';
import type { CacheEvent } from '@app/main/cache/cache-types';
import { FakeMisterClient } from '@app/main/clients/fake-mister-client';
import { ConnectionManager } from '@app/main/ipc/connection-manager';
import type { ProfileStore } from '@app/main/storage/profile-store';
import type { ConnectionEvent } from '@shared/connection';
import type { MisterSecret } from '@shared/mister-client';
import type { CoreEntry, MisterProfile, Rom } from '@shared/types';

const fixturesDir = path.resolve(import.meta.dirname, '../../../fixtures/sample-mister');

const profile: MisterProfile = {
  id: 'p',
  name: 'Test',
  host: '127.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

const secret: MisterSecret = { type: 'password', password: 'pw' };

/**
 * Tiny test double for ProfileStore — just enough surface to drive
 * ConnectionManager without dragging in safeStorage / Electron mocks.
 */
function makeStubStore(): ProfileStore {
  return {
    list: async () => [profile],
    get: async (id: string) => (id === profile.id ? profile : undefined),
    upsert: async () => {
      throw new Error('not used');
    },
    delete: async () => {
      throw new Error('not used');
    },
    getSecret: async (id: string) => {
      if (id !== profile.id) throw new Error('not found');
      return secret;
    },
  } as unknown as ProfileStore;
}

describe('ConnectionManager — PR #12 disk cache', () => {
  let workDir: string;
  let cacheDir: string;
  let perTestCacheDir: string;
  let client: FakeMisterClient;
  let cache: CacheManager;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cache-test-'));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cache-test-cache-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    perTestCacheDir = await fs.mkdtemp(path.join(cacheDir, 'run-'));
    cache = new CacheManager(perTestCacheDir);
    manager = new ConnectionManager(client, makeStubStore(), cache);
  });

  it('cold connect populates the cache; warm reconnect serves it without a network walk', async () => {
    // Cold connect: cache is empty, so the manager performs the
    // listAllCoresWithFiles walk lazily on first call.
    await manager.connect(profile.id);
    const firstList = await manager.listAllCoresWithFiles();
    expect(firstList.length).toBeGreaterThan(0);
    // Cache file now exists at <cacheDir>/<host>/cores.json.
    const cacheFile = path.join(perTestCacheDir, '127.0.0.1', 'cores.json');
    const cached = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    expect(cached.version).toBe(1);
    expect(cached.host).toBe('127.0.0.1');
    expect(cached.data.length).toBe(firstList.length);

    // Warm reconnect: spy on the network walk method. Connecting and
    // calling listAllCoresWithFiles must not trigger it.
    await manager.disconnect();
    const networkSpy = vi.spyOn(client, 'listAllCoresWithFiles');
    await manager.connect(profile.id);
    const warmList = await manager.listAllCoresWithFiles();
    expect(networkSpy).not.toHaveBeenCalled();
    expect(warmList).toEqual(firstList);
    networkSpy.mockRestore();
  });

  it('an out-of-band mutation (mtime change) invalidates the cache and triggers a fresh walk', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles(); // populate cache
    await manager.disconnect();

    // Bump games/ mtime explicitly. Plain fs operations within the
    // same wall-clock second produce identical floor-to-second
    // mtimes, which would falsely look like a cache hit. utimes
    // sidesteps the resolution issue by setting a deterministic
    // future mtime on the parent dir.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games'), future, future);

    const networkSpy = vi.spyOn(client, 'listAllCoresWithFiles');
    await manager.connect(profile.id);
    // A network call IS expected here (cache witnesses don't match).
    await manager.listAllCoresWithFiles();
    expect(networkSpy).toHaveBeenCalled();
    networkSpy.mockRestore();
  });

  it('listAllCoresWithFiles({ forceRefresh: true }) bypasses the cache and rewrites it', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();

    const networkSpy = vi.spyOn(client, 'listAllCoresWithFiles');
    await manager.listAllCoresWithFiles({ forceRefresh: true });
    expect(networkSpy).toHaveBeenCalledTimes(1);
    networkSpy.mockRestore();
  });

  it('hideCore write-through keeps the cache warm on the next connect', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.hideCore('NES');
    await manager.disconnect();

    // Reconnect — the write-through stat'd new witnesses post-hide,
    // so the cache should still be valid and the next read should
    // not hit the network.
    const networkSpy = vi.spyOn(client, 'listAllCoresWithFiles');
    await manager.connect(profile.id);
    const cores = await manager.listAllCoresWithFiles();
    expect(networkSpy).not.toHaveBeenCalled();
    // And the cached row reflects the post-hide state (gamesDirHidden=true).
    expect(cores.find((c) => c.id === 'NES')?.gamesDirHidden).toBe(true);
    networkSpy.mockRestore();
  });

  it('setRomVisibility invalidates the affected core’s roms cache', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.listRoms('NES'); // populate roms cache for NES

    const cacheFile = path.join(perTestCacheDir, '127.0.0.1', 'roms', 'NES.json');
    await fs.access(cacheFile); // exists

    // Find a real ROM filename to flip.
    const roms = await manager.listRoms('NES');
    const target = roms.find((r) => r.kind === 'file' && !r.hidden);
    expect(target).toBeDefined();
    if (!target) return;

    await manager.setRomVisibility('NES', target.filename, true);

    // Cache file for NES should be gone (invalidate-on-mutation).
    await expect(fs.access(cacheFile)).rejects.toThrow();
  });

  it('addSystemFileMark invalidates BOTH cores and that core’s roms cache', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.listRoms('NES');

    const coresCachePath = path.join(perTestCacheDir, '127.0.0.1', 'cores.json');
    const romsCachePath = path.join(perTestCacheDir, '127.0.0.1', 'roms', 'NES.json');
    await fs.access(coresCachePath);
    await fs.access(romsCachePath);

    await manager.addSystemFileMark('NES', 'noise.bios');

    // cores.json gone — counts may have shifted.
    await expect(fs.access(coresCachePath)).rejects.toThrow();
    // NES roms cache gone — system flags may have shifted.
    await expect(fs.access(romsCachePath)).rejects.toThrow();
  });

  it('clearCacheForCurrentHost wipes the entire host cache directory', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.listRoms('NES');

    const hostDir = path.join(perTestCacheDir, '127.0.0.1');
    await fs.access(hostDir); // exists

    await manager.clearCacheForCurrentHost();

    await expect(fs.access(hostDir)).rejects.toThrow();
  });

  it('listRoms cache hit on identical witnesses, miss on changed mtime', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    const first = await manager.listRoms('NES');
    expect(first.length).toBeGreaterThan(0);

    // Second call with no mutation: cache hit. listRoms-on-client
    // should not be called.
    const networkSpy = vi.spyOn(client, 'listRoms');
    const second = await manager.listRoms('NES');
    expect(networkSpy).not.toHaveBeenCalled();
    expect(second).toEqual(first);
    networkSpy.mockRestore();

    // Now bump games/NES mtime via utimes. (Plain rename within
    // the same wall-clock second can leave the second-resolution
    // mtime unchanged.)
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games', 'NES'), future, future);

    // Cache witness for /media/fat/games/NES no longer matches → miss.
    const networkSpy2 = vi.spyOn(client, 'listRoms');
    await manager.listRoms('NES');
    expect(networkSpy2).toHaveBeenCalled();
    networkSpy2.mockRestore();
  });
});

describe('ConnectionManager — cache observability events (PR #12 round 3)', () => {
  let workDir: string;
  let cacheRoot: string;
  let perTestCacheDir: string;
  let events: CacheEvent[];
  let client: FakeMisterClient;
  let cache: CacheManager;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cache-events-fs-'));
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cache-events-cache-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    perTestCacheDir = await fs.mkdtemp(path.join(cacheRoot, 'run-'));
    events = [];
    cache = new CacheManager(perTestCacheDir, {
      onEvent: (e) => events.push(e),
    });
    manager = new ConnectionManager(client, makeStubStore(), cache);
  });

  it('cold connect emits cache.miss + cache.write; warm reconnect emits cache.hit', async () => {
    // Cold connect: file doesn't exist on disk. CacheManager fires
    // miss internally; ConnectionManager doesn't yet know there's
    // anything to validate.
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    const coldEvents = events
      .filter((e) => e.surface === 'cores')
      .map((e) => e.kind);
    expect(coldEvents).toEqual(['miss', 'write']);

    // Warm reconnect: cache file exists, primeConnect's witnesses
    // match. The hit event is the load-bearing assertion of this
    // round — without recordHit it never fires.
    events.length = 0;
    await manager.disconnect();
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    expect(events.find((e) => e.kind === 'hit' && e.surface === 'cores')).toBeDefined();
  });

  it('warm reconnect with mtime drift emits cache.stale + cache.invalidate (no hit)', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.disconnect();
    // Bump games/ mtime out-of-band. Witnesses recorded on the
    // cold connect no longer match.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games'), future, future);

    events.length = 0;
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();

    const kinds = events
      .filter((e) => e.surface === 'cores')
      .map((e) => e.kind);
    // The first miss-or-stale signal MUST be `stale` (file existed
    // and parsed; witnesses moved). Then we invalidate, then
    // listAllCoresWithFiles fires a fresh write.
    expect(kinds).toContain('stale');
    expect(kinds).toContain('invalidate');
    expect(kinds).toContain('write');
    // No hit on this path.
    expect(kinds).not.toContain('hit');
  });

  it('listRoms cache hit emits cache.hit with coreId and subPath; mismatch emits cache.stale', async () => {
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();
    await manager.listRoms('NES'); // populate roms cache

    events.length = 0;
    // Second call: witness stat matches, slot is served from cache.
    const cached = await manager.listRoms('NES');
    expect(cached.length).toBeGreaterThan(0);
    const hit = events.find((e) => e.kind === 'hit' && e.surface === 'roms');
    expect(hit).toBeDefined();
    expect(hit?.coreId).toBe('NES');
    expect(hit?.subPath).toBe('');

    // Bump games/NES mtime → witness mismatch → stale event then
    // re-fetch. Plain rename within the same wall-clock second can
    // produce identical floor-second mtimes; utimes sidesteps that.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games', 'NES'), future, future);
    events.length = 0;
    await manager.listRoms('NES');
    expect(
      events.find((e) => e.kind === 'stale' && e.surface === 'roms'),
    ).toBeDefined();
    expect(
      events.find((e) => e.kind === 'hit' && e.surface === 'roms'),
    ).toBeUndefined();
  });

  it('Refresh button (forceRefresh) does NOT emit cache.hit', async () => {
    // The user explicitly clicked Refresh — the cache must be
    // bypassed. We expect invalidate (the existing file is dropped)
    // followed by write, but never a hit on this path.
    await manager.connect(profile.id);
    await manager.listAllCoresWithFiles();

    events.length = 0;
    await manager.listAllCoresWithFiles({ forceRefresh: true });
    const kinds = events
      .filter((e) => e.surface === 'cores')
      .map((e) => e.kind);
    expect(kinds).not.toContain('hit');
    expect(kinds).toContain('invalidate');
    expect(kinds).toContain('write');
  });
});

describe('ConnectionManager — hide / show + ledger bookkeeping', () => {
  let workDir: string;
  let cacheDir: string;
  let client: FakeMisterClient;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-test-'));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-cache-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(cacheDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    // Fresh cache dir per test so a prior test's cache file can't
    // bleed in and turn a "would have hit the network" assertion
    // into a cache-hit false positive.
    const perTestCacheDir = await fs.mkdtemp(path.join(cacheDir, 'run-'));
    manager = new ConnectionManager(
      client,
      makeStubStore(),
      new CacheManager(perTestCacheDir),
    );
    await manager.connect(profile.id);
  });

  it('returns ledger-tracked core ids via listLedgerCoreIds', async () => {
    expect(await manager.listLedgerCoreIds()).toEqual([]);
    await manager.hideCore('NES');
    expect(await manager.listLedgerCoreIds()).toEqual(['NES']);
    await manager.hideCore('SNES');
    expect([...(await manager.listLedgerCoreIds())].sort()).toEqual(['NES', 'SNES']);
    await manager.showCore('NES');
    expect(await manager.listLedgerCoreIds()).toEqual(['SNES']);
  });

  it('showCore on a non-ledger (externally-hidden) core succeeds', async () => {
    // Round 5: single-core un-hide no longer consults the ledger.
    // The user can reach into firmware-placed dot-folders and reveal
    // them with a single eye-click. Previously this raised
    // "not managed by MiSTerCurator".
    await fs.rename(
      path.join(workDir, 'games', 'AO486'),
      path.join(workDir, 'games', '.AO486'),
    );
    const cores = await manager.listAllCoresWithFiles();
    const ao486 = cores.find((c) => c.id === 'AO486');
    expect(ao486?.gamesDirHidden).toBe(true);

    await expect(manager.showCore('AO486')).resolves.toBeUndefined();
    await fs.access(path.join(workDir, 'games', 'AO486'));
  });

  it('setBulkCoreVisibility unhide does NOT reject non-ledger cores', async () => {
    // Round 5 simplification: the bulk path is now a thin wrapper
    // around the per-core renames. The renderer's "Unhide all"
    // button pre-filters its payload via listLedgerCoreIds, so the
    // gate has moved to the renderer.
    await fs.rename(
      path.join(workDir, 'games', 'AO486'),
      path.join(workDir, 'games', '.AO486'),
    );
    const result = await manager.setBulkCoreVisibility([
      { coreId: 'AO486', hidden: false },
    ]);
    expect(result.succeeded).toEqual(['AO486']);
    expect(result.failed).toEqual([]);
    await fs.access(path.join(workDir, 'games', 'AO486'));
  });

  it('hide / unhide round-trip leaves the ledger in sync', async () => {
    await manager.hideCore('NES');
    expect(await manager.listLedgerCoreIds()).toEqual(['NES']);
    const afterHide = await manager.listAllCoresWithFiles();
    expect(afterHide.find((c) => c.id === 'NES')?.gamesDirHidden).toBe(true);

    await manager.showCore('NES');
    expect(await manager.listLedgerCoreIds()).toEqual([]);
    const afterShow = await manager.listAllCoresWithFiles();
    expect(afterShow.find((c) => c.id === 'NES')?.gamesDirHidden).toBe(false);
  });

  it('setBulkCoreVisibility hide adds to the ledger; unhide removes', async () => {
    const hideResult = await manager.setBulkCoreVisibility([
      { coreId: 'NES', hidden: true },
      { coreId: 'SNES', hidden: true },
    ]);
    expect([...hideResult.succeeded].sort()).toEqual(['NES', 'SNES']);
    expect([...(await manager.listLedgerCoreIds())].sort()).toEqual(['NES', 'SNES']);

    const showResult = await manager.setBulkCoreVisibility([
      { coreId: 'NES', hidden: false },
    ]);
    expect(showResult.succeeded).toEqual(['NES']);
    expect(await manager.listLedgerCoreIds()).toEqual(['SNES']);
  });
});

describe('ConnectionManager — mid-session disconnect + auto-retry', () => {
  let workDir: string;
  let client: FakeMisterClient;
  let manager: ConnectionManager;
  let events: ConnectionEvent[];

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-retry-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Real timers for the connect setup, fake timers for the retry
    // schedule. We swap mid-test in the relevant cases.
    vi.useRealTimers();
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    const perTestCacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-retry-cache-'));
    manager = new ConnectionManager(
      client,
      makeStubStore(),
      new CacheManager(perTestCacheDir),
    );
    events = [];
    manager.onConnectionEvent((e) => events.push(e));
    await manager.connect(profile.id);
    events.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits disconnected-unexpected and flips status when the client signals a drop', async () => {
    let lastStatus = 'connected';
    manager.onStatusChange((s) => {
      lastStatus = s;
    });

    // Fake timers so the auto-retry loop doesn't actually attempt
    // anything during this test — we only care about the immediate
    // transition.
    vi.useFakeTimers();
    client.simulateUnexpectedDisconnect();

    expect(lastStatus).toBe('disconnected');
    expect(events.find((e) => e.type === 'disconnected-unexpected')).toBeDefined();
  });

  it('runs auto-retries on the documented backoff schedule and reconnects on first success', async () => {
    // Real timers here: the retry's connect() chain awaits real
    // fs.readdir / readFile calls that don't play nicely with fake
    // timers, and the 1s backoff is short enough for a single test.
    client.simulateUnexpectedDisconnect();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1500);
    });

    const attempts = events.filter((e) => e.type === 'auto-retry-attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ attempt: 1, totalAttempts: 3 });

    const reconnected = events.find((e) => e.type === 'reconnected');
    expect(reconnected).toBeDefined();
    expect(manager.getStatus()).toBe('connected');
  });

  it('emits auto-retry-failed after all three attempts when the client keeps refusing', async () => {
    // Force every retry to fail by deleting the fixture root mid-test.
    // The fake client checks the games dir during connect; once gone
    // the connect path throws.
    vi.useFakeTimers();

    let connectCalls = 0;
    const stub = vi
      .spyOn(client, 'connect')
      .mockImplementation(async () => {
        connectCalls += 1;
        throw new Error(`mocked failure ${String(connectCalls)}`);
      });

    client.simulateUnexpectedDisconnect();

    // Walk past the cumulative 1s + 3s + 8s schedule.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(3000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(0);

    expect(connectCalls).toBe(3);
    const attempts = events.filter((e) => e.type === 'auto-retry-attempt');
    expect(attempts.map((e) => (e.type === 'auto-retry-attempt' ? e.attempt : 0))).toEqual([
      1, 2, 3,
    ]);
    const failed = events.find((e) => e.type === 'auto-retry-failed');
    expect(failed).toBeDefined();
    if (failed?.type === 'auto-retry-failed') {
      expect(failed.underlyingMessage).toContain('mocked failure 3');
    }
    expect(manager.getStatus()).toBe('disconnected');

    stub.mockRestore();
  });

  it('cancels in-flight auto-retry when the user manually disconnects', async () => {
    vi.useFakeTimers();
    client.simulateUnexpectedDisconnect();

    // Advance partway through the first backoff window, then issue
    // a clean disconnect. The retry attempt should never fire.
    await vi.advanceTimersByTimeAsync(500);
    await manager.disconnect();
    await vi.advanceTimersByTimeAsync(2000);

    const attempts = events.filter((e) => e.type === 'auto-retry-attempt');
    expect(attempts).toHaveLength(0);
    expect(manager.getStatus()).toBe('disconnected');
  });

  it('cancels in-flight auto-retry when the user manually reconnects (connect)', async () => {
    vi.useFakeTimers();
    client.simulateUnexpectedDisconnect();
    await vi.advanceTimersByTimeAsync(200);

    // User clicks "Reconnect" in the banner before the auto-retry
    // fires its first attempt.
    vi.useRealTimers();
    await manager.connect(profile.id);

    expect(manager.getStatus()).toBe('connected');
    // The auto-retry-attempt event should NOT have fired (the manual
    // connect cancelled the cycle before the 1s delay elapsed).
    const attempts = events.filter((e) => e.type === 'auto-retry-attempt');
    expect(attempts).toHaveLength(0);
  });

  it('emits a connecting-elapsed tick at least once during a slow connect', async () => {
    // Stub the client's connect to never resolve until we tell it to,
    // and then to reject (simulating a slow connect that ultimately
    // failed). We just need the connect call to remain in-flight long
    // enough for the manager's 1s setInterval ticker to fire.
    vi.useFakeTimers();
    const elapsedEvents: ConnectionEvent[] = [];
    manager.onConnectionEvent((e) => {
      if (e.type === 'connecting-elapsed') elapsedEvents.push(e);
    });

    const rejectHolder: { current: ((err: Error) => void) | null } = {
      current: null,
    };
    const stub = vi.spyOn(client, 'connect').mockImplementation(
      () =>
        new Promise<void>((_, reject) => {
          rejectHolder.current = reject;
        }),
    );

    const connectPromise = manager.connect(profile.id).catch(() => undefined);

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(elapsedEvents.length).toBeGreaterThanOrEqual(1);
    expect(elapsedEvents[0]?.type).toBe('connecting-elapsed');
    if (elapsedEvents[0]?.type === 'connecting-elapsed') {
      expect(elapsedEvents[0].profileId).toBe(profile.id);
      expect(elapsedEvents[0].elapsedMs).toBeGreaterThanOrEqual(1000);
    }

    // Reject so the manager unwinds the connect path (setStatus('error')
    // + clearInterval). Without this the test would leave a setInterval
    // running into the next test.
    rejectHolder.current?.(new Error('test cancel'));
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;
    stub.mockRestore();
  });
});

describe('ConnectionManager — single-flight gate on listAll / listRoms (PR #14)', () => {
  let workDir: string;
  let cacheRoot: string;
  let perTestCacheDir: string;
  let client: FakeMisterClient;
  let cache: CacheManager;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-inflight-'));
    cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-inflight-cache-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.rm(cacheRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    perTestCacheDir = await fs.mkdtemp(path.join(cacheRoot, 'run-'));
    cache = new CacheManager(perTestCacheDir);
    manager = new ConnectionManager(client, makeStubStore(), cache);
    await manager.connect(profile.id);
  });

  /**
   * Wraps `client.listAllCoresWithFiles` with a held promise — the
   * spy resolves when we explicitly trigger it. The `observed`
   * promise resolves when the manager's fetch path has actually
   * called the spy (after invalidate I/O + microtask flushes), so
   * tests can deterministically wait for the gate to register
   * before asserting on call counts.
   */
  function holdListAllCoresSpy() {
    let resolveHeld: ((cores: CoreEntry[]) => void) | null = null;
    let rejectHeld: ((err: Error) => void) | null = null;
    let signalObserved: (() => void) | null = null;
    const observed = new Promise<void>((resolve) => {
      signalObserved = resolve;
    });
    const spy = vi.spyOn(client, 'listAllCoresWithFiles').mockImplementation(
      // No `async` wrapper — return the held Promise directly so a
      // rejection on it propagates to the awaiter without an extra
      // microtask layer (the wrapped form had a reproducible hang
      // when combined with `await expect.rejects`).
      () =>
        new Promise<CoreEntry[]>((resolve, reject) => {
          resolveHeld = (cores: CoreEntry[]) => resolve(cores);
          rejectHeld = (err: Error) => reject(err);
          signalObserved?.();
        }),
    );
    const release = (cores: CoreEntry[]): void => {
      if (resolveHeld === null) throw new Error('release before observation');
      resolveHeld(cores);
    };
    const fail = (err: Error): void => {
      if (rejectHeld === null) throw new Error('fail before observation');
      rejectHeld(err);
    };
    return { spy, observed, release, fail };
  }

  it('two concurrent listAllCoresWithFiles callers share the same SSH walk', async () => {
    // Force a true network fetch by clearing the in-memory cache. The
    // gate only applies to the SSH-fetch path; in-memory hits
    // short-circuit before it.
    await manager.disconnect();
    await manager.connect(profile.id);
    const { spy, observed, release } = holdListAllCoresSpy();

    // Fire two listAllCoresWithFiles calls in the same microtask.
    // forceRefresh: true skips the in-memory cache too, forcing both
    // to hit the network path and exercise the gate.
    const a = manager.listAllCoresWithFiles({ forceRefresh: true });
    const b = manager.listAllCoresWithFiles({ forceRefresh: true });

    // observed fires when the FIRST caller (a) reaches the spy; b
    // is still paused on its own invalidate I/O at that point. Wait
    // an extra two setImmediate flushes for b's flow to reach the
    // gate (and find a's in-flight promise) before we assert.
    await observed;
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // The underlying client method was called exactly once — the
    // second caller awaits the first's in-flight promise.
    expect(spy).toHaveBeenCalledTimes(1);

    release([{ id: 'NES', name: 'NES' }] as unknown as CoreEntry[]);
    const [aResult, bResult] = await Promise.all([a, b]);
    expect(aResult).toBe(bResult);
    spy.mockRestore();
  });

  it('rejection propagates to all gated callers (single SSH walk)', async () => {
    await manager.disconnect();
    await manager.connect(profile.id);
    const { spy, observed, fail } = holdListAllCoresSpy();

    // Capture rejections via .then so the unhandled-rejection state
    // is irrelevant to the test outcome.
    interface Settled {
      readonly ok: boolean;
      readonly err?: Error;
    }
    const settle = (p: Promise<unknown>): Promise<Settled> =>
      p.then(
        (): Settled => ({ ok: true }),
        (err: unknown): Settled => ({
          ok: false,
          err: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    const aResult = settle(
      manager.listAllCoresWithFiles({ forceRefresh: true }),
    );
    const bResult = settle(
      manager.listAllCoresWithFiles({ forceRefresh: true }),
    );

    // observed fires when the FIRST caller (a) reaches the spy. The
    // SECOND caller (b) is still paused on its own
    // `invalidateCoresCache` await at that point — fs.unlink hasn't
    // settled yet. Without an additional flush, calling fail() would
    // reject the in-flight before b reaches `fetchAndCacheCoresGated`,
    // and b would then create a fresh in-flight that nothing
    // resolves. Two setImmediate flushes give libuv time to drain
    // both unlink callbacks AND let b's flow reach the gate.
    await observed;
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    fail(new Error('SSH walk crashed'));
    const [ar, br] = await Promise.all([aResult, bResult]);

    expect(ar.ok).toBe(false);
    expect(ar.err?.message).toMatch(/SSH walk crashed/);
    expect(br.ok).toBe(false);
    expect(br.err?.message).toMatch(/SSH walk crashed/);
    // The SSH walk ran exactly once — b coalesced onto a's in-flight.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('gate clears after rejection — next call starts a fresh SSH walk', async () => {
    await manager.disconnect();
    await manager.connect(profile.id);

    // One-shot rejecting mock: the first call rejects, the second
    // call falls through to the real FakeMisterClient impl. Asserts
    // that the gate cleared after the failure (otherwise the second
    // call would still be holding the rejected promise and it'd
    // either hang or rethrow the old error).
    const spy = vi.spyOn(client, 'listAllCoresWithFiles');
    spy.mockImplementationOnce(async () => {
      throw new Error('SSH walk crashed');
    });

    await expect(
      manager.listAllCoresWithFiles({ forceRefresh: true }),
    ).rejects.toThrow(/SSH walk crashed/);

    // Second call runs the real impl (mockImplementationOnce was
    // one-shot). If the gate hadn't cleared, this would hang on the
    // already-rejected in-flight promise.
    const fresh = await manager.listAllCoresWithFiles({ forceRefresh: true });
    expect(Array.isArray(fresh)).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it('listRoms gate is keyed by (coreId, subPath); different keys run in parallel', async () => {
    await manager.listAllCoresWithFiles();
    // Hold listRoms by coreId so we can interleave a NES top-level
    // call with a NES sub-path call AND a SNES top-level call.
    type RomsResolver = (roms: Rom[]) => void;
    const resolvers = new Map<string, RomsResolver>();
    const spy = vi
      .spyOn(client, 'listRoms')
      .mockImplementation((coreId: string, subPath?: string) => {
        const key = `${coreId}::${subPath ?? ''}`;
        return new Promise<Rom[]>((resolve) => {
          resolvers.set(key, resolve);
        });
      });

    // Force misses on the disk cache so the gate is exercised.
    await manager.clearCacheForCurrentHost();
    const a1 = manager.listRoms('NES', '', { forceRefresh: true });
    const a2 = manager.listRoms('NES', '', { forceRefresh: true });
    const b = manager.listRoms('NES', 'sub', { forceRefresh: true });
    const c = manager.listRoms('SNES', '', { forceRefresh: true });
    // Same race as the cores tests: each manager call has its own
    // disk-cache lookup + witness stat to flush before reaching the
    // gate. Two setImmediate flushes give libuv time to drain.
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));

    // Three distinct keys → three client calls. The duplicate
    // (a2 === a1's key) coalesced.
    expect(spy).toHaveBeenCalledTimes(3);

    resolvers.get('NES::')?.([]);
    resolvers.get('NES::sub')?.([]);
    resolvers.get('SNES::')?.([]);
    await Promise.all([a1, a2, b, c]);
    spy.mockRestore();
  });

  it('rapid burst of cache-invalidating ops triggers at most one network walk', async () => {
    // Repro the live bug the user reported: rapid mark-as-system /
    // unmark cycles invalidate caches and trigger refetches; without
    // the gate, two listAllCoresWithFiles SSH walks ran in parallel
    // and one got killed mid-stream. With the gate, the burst
    // coalesces.
    await manager.listAllCoresWithFiles();
    await manager.disconnect();
    await manager.connect(profile.id);

    const { spy, observed, release } = holdListAllCoresSpy();

    // Five concurrent forceRefresh callers — the worst-case shape.
    const inflight = Array.from({ length: 5 }, () =>
      manager.listAllCoresWithFiles({ forceRefresh: true }),
    );
    // Same race as above: observed fires when the first caller
    // reaches the spy; let the other four catch up before asserting.
    await observed;
    await new Promise<void>((r) => setImmediate(r));
    await new Promise<void>((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledTimes(1);

    release([] as CoreEntry[]);
    await Promise.all(inflight);
    spy.mockRestore();
  });
});
