import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeMisterClient } from '@app/main/clients/fake-mister-client';
import { ConnectionManager } from '@app/main/ipc/connection-manager';
import type { ProfileStore } from '@app/main/storage/profile-store';
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
