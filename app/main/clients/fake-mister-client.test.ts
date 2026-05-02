import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeMisterClient } from '@app/main/clients/fake-mister-client';
import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';
import type { MisterSecret } from '@shared/mister-client';

const fixturesDir = path.resolve(import.meta.dirname, '../../../fixtures/sample-mister');

const profile: MisterProfile = {
  id: 'test-mister',
  name: 'Test MiSTer',
  host: '192.168.1.42',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

const secret: MisterSecret = { type: 'password', password: '1' };

describe('FakeMisterClient', () => {
  let workDir: string;
  let client: FakeMisterClient;

  beforeAll(async () => {
    workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-mister-test-'));
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
    await client.connect(profile, secret);
  });

  it('connects and disconnects', async () => {
    expect(client.isConnected()).toBe(true);
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('rejects connect when secret type does not match auth method', async () => {
    const fresh = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await expect(
      fresh.connect(profile, { type: 'key', privateKey: 'irrelevant' }),
    ).rejects.toBeInstanceOf(MisterConnectionError);
    expect(fresh.isConnected()).toBe(false);
  });

  it('lists the expected cores from fixtures', async () => {
    const cores = await client.listAllCoresWithFiles();
    const ids = cores.map((c) => c.id);
    // Joins games/ with _Console / _Computer / _Other / _Utility, plus a
    // single placeholder for _Arcade (individual arcade cores collapse).
    expect(ids).toContain('NES');
    expect(ids).toContain('SNES');
    expect(ids).toContain('Genesis');
    expect(ids).toContain('AO486');
    expect(ids).toContain('Atari800');
    expect(ids).toContain('CrazyMatch');
    expect(ids).toContain('Memtest');
    expect(ids).toContain('SMS'); // rbf-only, no games dir
    expect(ids).toContain('Orphan'); // games dir without a matching rbf

    // Individual arcade cores never appear; one synthetic placeholder does.
    expect(ids).not.toContain('Galaga');
    expect(ids).not.toContain('Pacman');
    const arcadeRow = cores.find((c) => c.category === 'Arcade');
    expect(arcadeRow).toBeDefined();
    expect(arcadeRow?.name).toBe('Arcade');

    // .mgl cores must be discovered alongside .rbf cores.
    expect(ids).toContain('Game Gear');
    expect(ids).toContain('Atari 2600');
    expect(ids).toContain('GameboyColor');
    expect(ids).toContain('Mega Duck');
    expect(ids).toContain('Pocket Challenge V2');
    const gameGear = cores.find((c) => c.id === 'Game Gear');
    expect(gameGear?.rbfPaths).toEqual(['/media/fat/_Console/Game Gear.mgl']);
    expect(gameGear?.category).toBe('Console');

    // User-created organizational folders without a .rbf or .mgl inside
    // are NOT cores and must be filtered out.
    expect(ids).not.toContain('_alternatives');
    expect(ids).not.toContain('_hidden');
    expect(ids).not.toContain('_Organized');

    const nes = cores.find((c) => c.id === 'NES');
    expect(nes).toBeDefined();
    expect(nes!.romCount).toBe(9);
    expect(nes!.hiddenCount).toBe(2);
    expect(nes!.category).toBe('Console');
    expect(nes!.rbfPaths).toContain('/media/fat/_Console/NES_20240115.rbf');
    expect(nes!.rbfPaths).toContain('/media/fat/_Console/NES_20231215.rbf');
    expect(nes!.gamesDirExists).toBe(true);
    expect(nes!.gamesDirHidden).toBe(false);

    const sms = cores.find((c) => c.id === 'SMS');
    expect(sms?.gamesDirExists).toBe(false);
    expect(sms?.romCount).toBe(0);

    const orphan = cores.find((c) => c.id === 'Orphan');
    expect(orphan?.category).toBe('Unknown');
    expect(orphan?.rbfPaths).toEqual([]);

    const ao486 = cores.find((c) => c.id === 'AO486');
    expect(ao486?.category).toBe('Computer');
    expect(ao486?.rbfPaths).toContain('/media/fat/_Computer/AO486');
  });

  it('lists ROMs including dot-prefixed hidden files', async () => {
    const roms = await client.listRoms('NES');
    expect(roms.length).toBe(9);
    expect(roms.some((r) => r.hidden)).toBe(true);
    expect(roms.some((r) => !r.hidden)).toBe(true);

    const hidden = roms.filter((r) => r.hidden);
    expect(hidden.length).toBe(2);
    for (const rom of hidden) {
      expect(rom.filename.startsWith('.')).toBe(true);
      expect(rom.displayName.startsWith('.')).toBe(false);
      expect(rom.path).toBe(`/media/fat/games/NES/${rom.filename}`);
    }
  });

  it('throws a clear error when listing ROMs for an unknown core', async () => {
    await expect(client.listRoms('TurboGrafx')).rejects.toThrow(/Unknown core/);
  });

  it('hides a visible ROM by renaming it on disk', async () => {
    const before = await client.listRoms('NES');
    const visible = before.find((r) => !r.hidden);
    expect(visible).toBeDefined();

    await client.setRomVisibility('NES', visible!.filename, true);

    await expect(fs.access(path.join(workDir, 'games', 'NES', visible!.filename))).rejects.toThrow();
    await fs.access(path.join(workDir, 'games', 'NES', `.${visible!.filename}`));

    const after = await client.listRoms('NES');
    const renamed = after.find((r) => r.filename === `.${visible!.filename}`);
    expect(renamed?.hidden).toBe(true);
  });

  it('unhides a hidden ROM by renaming it on disk', async () => {
    const before = await client.listRoms('NES');
    const hiddenRom = before.find((r) => r.hidden);
    expect(hiddenRom).toBeDefined();

    await client.setRomVisibility('NES', hiddenRom!.filename, false);

    const visibleName = hiddenRom!.filename.slice(1);
    await fs.access(path.join(workDir, 'games', 'NES', visibleName));

    const after = await client.listRoms('NES');
    const restored = after.find((r) => r.filename === visibleName);
    expect(restored?.hidden).toBe(false);
  });

  it('reset() restores the pristine fixture state after mutations', async () => {
    const initial = await client.listRoms('NES');
    const visible = initial.find((r) => !r.hidden);
    await client.setRomVisibility('NES', visible!.filename, true);

    await client.reset();
    await client.connect(profile, secret);

    const after = await client.listRoms('NES');
    expect(after).toEqual(initial);
  });

  it('setBulkRomVisibility handles mixed hide/show in one batch', async () => {
    const before = await client.listRoms('NES');
    const toHide = before.find((r) => !r.hidden);
    const toShow = before.find((r) => r.hidden);
    expect(toHide).toBeDefined();
    expect(toShow).toBeDefined();

    await client.setBulkRomVisibility('NES', [
      { filename: toHide!.filename, hidden: true },
      { filename: toShow!.filename, hidden: false },
    ]);

    const after = await client.listRoms('NES');
    const hiddenNow = after.find((r) => r.filename === `.${toHide!.filename}`);
    const visibleNow = after.find((r) => r.filename === toShow!.filename.slice(1));

    expect(hiddenNow?.hidden).toBe(true);
    expect(visibleNow?.hidden).toBe(false);
  });

  it('setBulkRomVisibility incurs only one round-trip latency hit', async () => {
    const slowClient = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 40,
    });
    await slowClient.connect(profile, secret);

    const roms = await slowClient.listRoms('NES');
    const visibleRoms = roms.filter((r) => !r.hidden).slice(0, 5);
    const changes = visibleRoms.map((r) => ({ filename: r.filename, hidden: true }));

    const start = performance.now();
    await slowClient.setBulkRomVisibility('NES', changes);
    const elapsed = performance.now() - start;

    // 5 sequential 40ms calls would take ~200ms; one batched call should be
    // closer to 40ms. Allow generous slack for CI jitter.
    expect(elapsed).toBeLessThan(150);
  });

  it('throws when called before connect', async () => {
    const disconnected = new FakeMisterClient({
      rootPath: workDir,
      pristineRootPath: fixturesDir,
      latencyMs: 0,
    });
    await expect(disconnected.listAllCoresWithFiles()).rejects.toThrow(/not connected/);
  });

  it('hideCore renames games dir and every matching rbf', async () => {
    const before = await client.listAllCoresWithFiles();
    const nes = before.find((c) => c.id === 'NES');
    expect(nes).toBeDefined();

    await client.hideCore(nes!);

    await expect(fs.access(path.join(workDir, 'games', 'NES'))).rejects.toThrow();
    await fs.access(path.join(workDir, 'games', '.NES'));
    await expect(
      fs.access(path.join(workDir, '_Console', 'NES_20240115.rbf')),
    ).rejects.toThrow();
    await fs.access(path.join(workDir, '_Console', '.NES_20240115.rbf'));
    await fs.access(path.join(workDir, '_Console', '.NES_20231215.rbf'));

    const after = await client.listAllCoresWithFiles();
    const nesAfter = after.find((c) => c.id === 'NES');
    expect(nesAfter?.gamesDirHidden).toBe(true);
    expect(nesAfter?.rbfPaths.every((p) => p.includes('/.'))).toBe(true);
  });

  it('hideCore handles folder-shaped cores (renames the folder itself)', async () => {
    const before = await client.listAllCoresWithFiles();
    const ao486 = before.find((c) => c.id === 'AO486');
    expect(ao486?.category).toBe('Computer');

    await client.hideCore(ao486!);

    await fs.access(path.join(workDir, '_Computer', '.AO486'));
    await fs.access(path.join(workDir, '_Computer', '.AO486', 'AO486_20240115.rbf'));
  });

  it('hideCore is a no-op for an already-hidden core', async () => {
    const before = await client.listAllCoresWithFiles();
    const nes = before.find((c) => c.id === 'NES');
    await client.hideCore(nes!);

    const refreshed = await client.listAllCoresWithFiles();
    const nesHidden = refreshed.find((c) => c.id === 'NES');
    // No throw, no-op when already hidden.
    await expect(client.hideCore(nesHidden!)).resolves.toBeUndefined();
  });

  it('showCore is the inverse of hideCore', async () => {
    const before = await client.listAllCoresWithFiles();
    const nes = before.find((c) => c.id === 'NES');
    await client.hideCore(nes!);

    const hidden = await client.listAllCoresWithFiles();
    const nesHidden = hidden.find((c) => c.id === 'NES');
    await client.showCore(nesHidden!);

    const after = await client.listAllCoresWithFiles();
    const nesShown = after.find((c) => c.id === 'NES');
    expect(nesShown?.gamesDirHidden).toBe(false);
    expect(nesShown?.rbfPaths.some((p) => p.includes('/.'))).toBe(false);
  });

  it('hideCore refuses the arcade placeholder', async () => {
    const before = await client.listAllCoresWithFiles();
    const arcade = before.find((c) => c.category === 'Arcade');
    expect(arcade).toBeDefined();
    expect(arcade?.name).toBe('Arcade');
    await expect(client.hideCore(arcade!)).rejects.toThrow(/Arcade/);
  });

  it('setBulkCoreVisibility applies many changes', async () => {
    const before = await client.listAllCoresWithFiles();
    const nes = before.find((c) => c.id === 'NES');
    const sms = before.find((c) => c.id === 'SMS');

    await client.setBulkCoreVisibility([
      { core: nes!, hidden: true },
      { core: sms!, hidden: true },
    ]);

    const after = await client.listAllCoresWithFiles();
    expect(after.find((c) => c.id === 'NES')?.gamesDirHidden).toBe(true);
    expect(
      after
        .find((c) => c.id === 'SMS')
        ?.rbfPaths.every((p) => p.includes('/.')),
    ).toBe(true);
  });

  it('readHideLedger returns the empty ledger when no file exists', async () => {
    const ledger = await client.readHideLedger();
    expect(ledger).toEqual({ schemaVersion: 1, hiddenCores: [] });
  });

  it('writeHideLedger / readHideLedger round-trip', async () => {
    const ledger = {
      schemaVersion: 1 as const,
      hiddenCores: [
        {
          coreId: 'NES',
          gamesDirHidden: true,
          rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
          hiddenAt: '2026-05-01T12:00:00Z',
        },
      ],
    };
    await client.writeHideLedger(ledger);
    expect(await client.readHideLedger()).toEqual(ledger);
  });
});
