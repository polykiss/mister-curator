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

describe('ConnectionManager — hide / show + ledger bookkeeping', () => {
  let workDir: string;
  let client: FakeMisterClient;
  let manager: ConnectionManager;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-test-'));
  });

  afterAll(async () => {
    await fs.rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await client.reset();
    manager = new ConnectionManager(client, makeStubStore());
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
    manager = new ConnectionManager(client, makeStubStore());
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
