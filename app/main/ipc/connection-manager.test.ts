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
import type { MisterProfile } from '@shared/types';

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

/**
 * feat/arcade-playability-data (PR 1/2) — orchestrator coverage for
 * loadArcadeData + the IPC-shaped getArcadePlayability. The fake
 * client reads .mra files off disk and lists zip basenames; the
 * shared parser does the work, so we exercise the orchestration
 * (cache hit / miss / witness-changed) rather than reparse-correctness
 * (that lives in shared/arcade-mra-parse.test.ts).
 */
describe('ConnectionManager — arcade playability data layer (PR 1/2)', () => {
  let workDir: string;
  let cacheDir: string;
  let perTestCacheDir: string;
  let client: FakeMisterClient;
  let cache: CacheManager;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-arcade-test-'));
    cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-arcade-test-cache-'));
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
    // Seed `_Arcade/` with three .mras hitting each playability bucket
    // and a `games/mame/` zip dir matching one of them.
    const arcadeDir = path.join(workDir, '_Arcade');
    await fs.rm(arcadeDir, { recursive: true, force: true });
    await fs.mkdir(arcadeDir, { recursive: true });
    await fs.writeFile(
      path.join(arcadeDir, 'Donkey Kong.mra'),
      [
        '<misterromdescription>',
        '  <setname>dkong</setname>',
        '  <rbf>donkeykong</rbf>',
        '  <rom index="0" zip="dkong.zip"/>',
        '</misterromdescription>',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(arcadeDir, 'Missing Game.mra'),
      [
        '<misterromdescription>',
        '  <setname>missing</setname>',
        '  <rbf>missing</rbf>',
        '  <rom index="0" zip="missing.zip"/>',
        '</misterromdescription>',
      ].join('\n'),
    );
    await fs.writeFile(
      path.join(arcadeDir, 'TTL Game.mra'),
      [
        '<misterromdescription>',
        '  <setname></setname>',
        '  <rbf>ttl</rbf>',
        '  <rom index="0"/>',
        '</misterromdescription>',
      ].join('\n'),
    );
    const mameDir = path.join(workDir, 'games', 'mame');
    const hbmameDir = path.join(workDir, 'games', 'hbmame');
    await fs.rm(mameDir, { recursive: true, force: true });
    await fs.rm(hbmameDir, { recursive: true, force: true });
    await fs.mkdir(mameDir, { recursive: true });
    // hbmame/ exists but empty — needed so its witness has a real
    // mtime. `witnessesMatch` rejects mtime=0 unconditionally, so a
    // missing zip dir would force a perpetual cache miss.
    await fs.mkdir(hbmameDir, { recursive: true });
    // Only dkong.zip exists — drives the three-bucket split below.
    await fs.writeFile(path.join(mameDir, 'dkong.zip'), 'z');

    // PR 2/2: disable arcade auto-hide for the data-layer tests so
    // the connect-time rule pass doesn't dot-prefix our seeded
    // missing-ROM .mra and shift its bucket key. Auto-hide
    // behavior is covered by the dedicated PR 2/2 test block
    // below. The Fake maps `/media/fat/...` → `<rootPath>/...`,
    // so the ledger lives directly under workDir/.mistercurator.
    const stateDir = path.join(workDir, '.mistercurator');
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, 'state.json'),
      JSON.stringify({
        schemaVersion: 1,
        hiddenCores: [],
        arcadeAutoHideEnabled: false,
      }),
    );

    perTestCacheDir = await fs.mkdtemp(path.join(cacheDir, 'run-'));
    cache = new CacheManager(perTestCacheDir);
    manager = new ConnectionManager(client, makeStubStore(), cache);
  });

  it('cold connect populates the snapshot + on-disk cache and buckets correctly', async () => {
    await manager.connect(profile.id);
    const out = await manager.getArcadePlayability();
    expect(new Set(out.playable)).toEqual(new Set(['Donkey Kong.mra']));
    expect(new Set(out.missing)).toEqual(new Set(['Missing Game.mra']));
    expect(new Set(out.noRomsNeeded)).toEqual(new Set(['TTL Game.mra']));

    // The on-disk cache file exists under the per-host dir.
    const cacheFile = path.join(
      perTestCacheDir,
      '127.0.0.1',
      'arcade-mra-meta.json',
    );
    const parsed = JSON.parse(await fs.readFile(cacheFile, 'utf-8'));
    expect(parsed.version).toBe(1);
    expect(parsed.host).toBe('127.0.0.1');
    expect(parsed.entries.length).toBe(3);
    expect(parsed.zipBasenames).toEqual(['dkong.zip']);
  });

  it('warm reconnect with matching witnesses serves the cache without re-walking', async () => {
    await manager.connect(profile.id);
    await manager.getArcadePlayability(); // populate cache
    await manager.disconnect();

    const parseSpy = vi.spyOn(client, 'parseArcadeMras');
    const zipSpy = vi.spyOn(client, 'listArcadeZipBasenames');
    await manager.connect(profile.id);
    const out = await manager.getArcadePlayability();
    // Same buckets as before.
    expect(new Set(out.playable)).toEqual(new Set(['Donkey Kong.mra']));
    expect(new Set(out.missing)).toEqual(new Set(['Missing Game.mra']));
    expect(new Set(out.noRomsNeeded)).toEqual(new Set(['TTL Game.mra']));
    // And critically, neither network method fired.
    expect(parseSpy).not.toHaveBeenCalled();
    expect(zipSpy).not.toHaveBeenCalled();
    parseSpy.mockRestore();
    zipSpy.mockRestore();
  });

  it('mtime change on _Arcade/ invalidates the cache and triggers a fresh walk', async () => {
    await manager.connect(profile.id);
    await manager.getArcadePlayability();
    await manager.disconnect();

    // Bump the _Arcade/ mtime. Sub-second resolution makes plain
    // writes risky for the same-clock-second case; utimes is
    // deterministic.
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, '_Arcade'), future, future);

    const parseSpy = vi.spyOn(client, 'parseArcadeMras');
    await manager.connect(profile.id);
    await manager.getArcadePlayability();
    expect(parseSpy).toHaveBeenCalled();
    parseSpy.mockRestore();
  });

  it('a new zip in games/mame/ shifts a row from missing → playable on next refresh', async () => {
    await manager.connect(profile.id);
    const before = await manager.getArcadePlayability();
    expect(before.missing).toContain('Missing Game.mra');

    // Drop the missing zip onto disk and bump the dir mtime so the
    // cache witnesses notice on next connect.
    await fs.writeFile(
      path.join(workDir, 'games', 'mame', 'missing.zip'),
      'z',
    );
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games', 'mame'), future, future);
    await manager.disconnect();

    await manager.connect(profile.id);
    const after = await manager.getArcadePlayability();
    expect(after.playable).toContain('Missing Game.mra');
    expect(after.missing).not.toContain('Missing Game.mra');
  });

  it('forceRefresh bypasses the in-memory + on-disk cache', async () => {
    await manager.connect(profile.id);
    await manager.getArcadePlayability();

    const parseSpy = vi.spyOn(client, 'parseArcadeMras');
    await manager.loadArcadeData({ forceRefresh: true });
    expect(parseSpy).toHaveBeenCalledTimes(1);
    parseSpy.mockRestore();
  });

  it('an empty _Arcade/ dir results in empty buckets (no scan error)', async () => {
    await fs.rm(path.join(workDir, '_Arcade'), { recursive: true, force: true });
    await fs.mkdir(path.join(workDir, '_Arcade'));
    await manager.connect(profile.id);
    const out = await manager.getArcadePlayability();
    expect(out.playable).toEqual([]);
    expect(out.missing).toEqual([]);
    expect(out.noRomsNeeded).toEqual([]);
  });
});

/**
 * feat/arcade-ux-and-ledger (PR 2/2) — auto-hide rule + ledger
 * coverage. Same fake-mister fixture as the PR-1 block; this
 * block starts with auto-hide ENABLED (the V1 default) so the
 * connect path applies the rule.
 */
describe('ConnectionManager — arcade auto-hide rule + ledger (PR 2/2)', () => {
  let workDir: string;
  let cacheDir: string;
  let perTestCacheDir: string;
  let client: FakeMisterClient;
  let cache: CacheManager;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-arcade-ux-test-'));
    cacheDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'cm-arcade-ux-test-cache-'),
    );
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

    const arcadeDir = path.join(workDir, '_Arcade');
    await fs.rm(arcadeDir, { recursive: true, force: true });
    await fs.mkdir(arcadeDir, { recursive: true });
    // Three .mras: playable, missing, TTL.
    await fs.writeFile(
      path.join(arcadeDir, 'Donkey Kong.mra'),
      '<misterromdescription><setname>dkong</setname><rbf>donkeykong</rbf><rom index="0" zip="dkong.zip"/></misterromdescription>',
    );
    await fs.writeFile(
      path.join(arcadeDir, 'Missing Game.mra'),
      '<misterromdescription><setname>missing</setname><rbf>missing</rbf><rom index="0" zip="missing.zip"/></misterromdescription>',
    );
    await fs.writeFile(
      path.join(arcadeDir, 'TTL Game.mra'),
      '<misterromdescription><setname></setname><rbf>ttl</rbf><rom index="0"/></misterromdescription>',
    );

    const mameDir = path.join(workDir, 'games', 'mame');
    const hbmameDir = path.join(workDir, 'games', 'hbmame');
    await fs.rm(mameDir, { recursive: true, force: true });
    await fs.rm(hbmameDir, { recursive: true, force: true });
    await fs.mkdir(mameDir, { recursive: true });
    await fs.mkdir(hbmameDir, { recursive: true });
    await fs.writeFile(path.join(mameDir, 'dkong.zip'), 'z');

    // No state.json — auto-hide defaults to ENABLED on first connect.

    perTestCacheDir = await fs.mkdtemp(path.join(cacheDir, 'run-'));
    cache = new CacheManager(perTestCacheDir);
    manager = new ConnectionManager(client, makeStubStore(), cache);
  });

  it('first connect auto-hides every missing-ROM mra and emits the toast signal', async () => {
    const result = await manager.connect(profile.id);
    // Toast signal carries the count of newly auto-hidden entries.
    expect(result.firstConnectArcadeAutoHidden).toBe(1);

    // On-disk: the missing mra is now dot-prefixed.
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Missing Game.mra')),
    ).resolves.toBeUndefined();
    // Playable + TTL unchanged.
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'Donkey Kong.mra')),
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'TTL Game.mra')),
    ).resolves.toBeUndefined();

    // Ledger reflects the auto-hidden set (visible-path form).
    const playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual(['Missing Game.mra']);
  });

  it('second connect with the ledger already populated does NOT re-fire the toast', async () => {
    await manager.connect(profile.id);
    await manager.disconnect();
    const result = await manager.connect(profile.id);
    expect(result.firstConnectArcadeAutoHidden).toBeNull();
  });

  it('user shows an auto-hidden row → tombstone added, mra stays visible across reconnect', async () => {
    await manager.connect(profile.id);
    // Identify the currently-dot-prefixed missing mra.
    await manager.setArcadeMraVisibility('.Missing Game.mra', false);
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'Missing Game.mra')),
    ).resolves.toBeUndefined();

    // The tombstone is set; the auto-hidden ledger no longer carries it.
    let playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual([]);
    // Reconnect: the auto-hide pass respects the tombstone and
    // leaves the mra visible.
    await manager.disconnect();
    await manager.connect(profile.id);
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'Missing Game.mra')),
    ).resolves.toBeUndefined();
    playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual([]);
  });

  it('user hides a playable mra → user-hide survives reconnect + survives auto-hide toggle cycles', async () => {
    await manager.connect(profile.id);
    // User hides the playable mra by hand.
    await manager.setArcadeMraVisibility('Donkey Kong.mra', true);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Donkey Kong.mra')),
    ).resolves.toBeUndefined();
    // The auto-hide ledger should NOT claim this entry.
    let playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).not.toContain('Donkey Kong.mra');

    // Reconnect: user-hide preserved.
    await manager.disconnect();
    await manager.connect(profile.id);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Donkey Kong.mra')),
    ).resolves.toBeUndefined();

    // Toggle auto-hide OFF → ON. User-hide unaffected (ledger never
    // claimed it).
    await manager.setArcadeAutoHideEnabled(false);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Donkey Kong.mra')),
    ).resolves.toBeUndefined();
    await manager.setArcadeAutoHideEnabled(true);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Donkey Kong.mra')),
    ).resolves.toBeUndefined();
    playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).not.toContain('Donkey Kong.mra');
  });

  it('toggle auto-hide OFF un-hides every auto-hidden mra; ON re-applies', async () => {
    await manager.connect(profile.id);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Missing Game.mra')),
    ).resolves.toBeUndefined();

    await manager.setArcadeAutoHideEnabled(false);
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'Missing Game.mra')),
    ).resolves.toBeUndefined();
    let playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual([]);

    await manager.setArcadeAutoHideEnabled(true);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Missing Game.mra')),
    ).resolves.toBeUndefined();
    playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual(['Missing Game.mra']);
  });

  it('adding a missing ROM zip un-auto-hides the previously-hidden mra on reconnect', async () => {
    await manager.connect(profile.id);
    await expect(
      fs.access(path.join(workDir, '_Arcade', '.Missing Game.mra')),
    ).resolves.toBeUndefined();
    let playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual(['Missing Game.mra']);

    // Drop the previously-missing zip onto disk and bump dir mtime
    // so the witness invalidates the playability cache.
    await fs.writeFile(
      path.join(workDir, 'games', 'mame', 'missing.zip'),
      'z',
    );
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, 'games', 'mame'), future, future);
    await manager.disconnect();

    await manager.connect(profile.id);
    // The mra is no longer missing → no longer auto-hidden.
    await expect(
      fs.access(path.join(workDir, '_Arcade', 'Missing Game.mra')),
    ).resolves.toBeUndefined();
    playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual([]);
    expect(playability.playable).toContain('Missing Game.mra');
  });

  it('healArcade drops ledger entries pointing at .mras that vanished between sessions', async () => {
    await manager.connect(profile.id);
    let playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual(['Missing Game.mra']);

    // Physically remove the auto-hidden mra (simulating a firmware
    // update that dropped it). Bump _Arcade/ mtime explicitly so
    // the witness comparison rejects the on-disk cache — the
    // unlink-mtime-bump pair can fall inside `mtimesMatch`'s ±2s
    // tolerance window otherwise.
    await fs.unlink(path.join(workDir, '_Arcade', '.Missing Game.mra'));
    const future = new Date(Date.now() + 60_000);
    await fs.utimes(path.join(workDir, '_Arcade'), future, future);
    await manager.disconnect();
    await manager.connect(profile.id);
    playability = await manager.getArcadePlayability();
    expect(playability.autoHidden).toEqual([]);
  });

  it('getArcadeAutoHideEnabled defaults to true on a fresh ledger and persists writes', async () => {
    await manager.connect(profile.id);
    expect(manager.getArcadeAutoHideEnabled()).toBe(true);
    await manager.setArcadeAutoHideEnabled(false);
    expect(manager.getArcadeAutoHideEnabled()).toBe(false);
    // Persisted across reconnect.
    await manager.disconnect();
    await manager.connect(profile.id);
    expect(manager.getArcadeAutoHideEnabled()).toBe(false);
  });
});
