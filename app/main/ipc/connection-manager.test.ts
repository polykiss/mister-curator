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
import type { CoreEntry, MisterProfile } from '@shared/types';

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

describe('ConnectionManager — permission slip', () => {
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

  it('marks cores in the ledger as managedByApp on listAllCoresWithFiles', async () => {
    // Pre-state: nothing in the ledger. Hide NES via the manager.
    await manager.hideCore('NES');

    const cores = await manager.listAllCoresWithFiles();
    const nes = cores.find((c) => c.id === 'NES');
    expect(nes?.gamesDirHidden).toBe(true);
    expect(nes?.managedByApp).toBe(true);

    const sms = cores.find((c) => c.id === 'SMS');
    // SMS was never hidden through the app.
    expect(sms?.managedByApp).toBe(false);
  });

  it('refuses showCore for a core that is not in the ledger', async () => {
    // Manually pre-create a hidden games dir that LOOKS hidden but
    // wasn't done by the app. This simulates MiSTer's stock state
    // where dot-prefixed dirs are pre-existing.
    await fs.rename(
      path.join(workDir, 'games', 'AO486'),
      path.join(workDir, 'games', '.AO486'),
    );

    // The cores list now reports AO486 as hidden but managedByApp=false.
    const cores = await manager.listAllCoresWithFiles();
    const ao486 = cores.find((c) => c.id === 'AO486');
    expect(ao486?.gamesDirHidden).toBe(true);
    expect(ao486?.managedByApp).toBe(false);

    await expect(manager.showCore('AO486')).rejects.toThrow(/not managed/i);
  });

  it('"show all" via setBulkCoreVisibility skips ledger-foreign cores (3-of-10)', async () => {
    // Manually pre-hide three games dirs ourselves (they go into the
    // ledger). Then manually pre-hide three OTHER games dirs without
    // going through the manager (these do NOT go into the ledger).
    await manager.hideCore('NES');
    await manager.hideCore('SNES');
    await manager.hideCore('Genesis');

    // Three external-hidden dirs (simulating stock MiSTer state):
    await fs.rename(
      path.join(workDir, 'games', 'AO486'),
      path.join(workDir, 'games', '.AO486'),
    );
    await fs.rename(
      path.join(workDir, 'games', 'Saturn'),
      path.join(workDir, 'games', '.Saturn'),
    );
    await fs.rename(
      path.join(workDir, 'games', 'Orphan'),
      path.join(workDir, 'games', '.Orphan'),
    );

    // The user clicks "Unhide all" — but the manager only un-hides
    // ledger-managed cores. We simulate this by passing every hidden
    // core's coreId.
    const cores = await manager.listAllCoresWithFiles();
    const hiddenCoreIds = cores
      .filter((c: CoreEntry) => c.gamesDirHidden || c.rbfPaths.some((p) => p.includes('/.')))
      .map((c) => c.id);

    const result = await manager.setBulkCoreVisibility(
      hiddenCoreIds.map((coreId) => ({ coreId, hidden: false })),
    );

    expect([...result.succeeded].sort()).toEqual(['Genesis', 'NES', 'SNES']);
    // The non-managed ones are reported as failed (not silently dropped).
    const failedIds = result.failed.map((f) => f.coreId).sort();
    expect(failedIds).toContain('AO486');
    expect(failedIds).toContain('Saturn');
    expect(failedIds).toContain('Orphan');
    for (const f of result.failed) {
      expect(f.reason).toMatch(/not managed/i);
    }

    // The three external-hidden dirs are still hidden on disk.
    await fs.access(path.join(workDir, 'games', '.AO486'));
    await fs.access(path.join(workDir, 'games', '.Saturn'));
    await fs.access(path.join(workDir, 'games', '.Orphan'));
  });

  it('hideCore round-trip leaves the ledger in sync', async () => {
    await manager.hideCore('NES');
    const after = await manager.listAllCoresWithFiles();
    expect(after.find((c) => c.id === 'NES')?.managedByApp).toBe(true);

    await manager.showCore('NES');
    const final = await manager.listAllCoresWithFiles();
    expect(final.find((c) => c.id === 'NES')?.managedByApp).toBe(false);
    expect(final.find((c) => c.id === 'NES')?.gamesDirHidden).toBe(false);
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
