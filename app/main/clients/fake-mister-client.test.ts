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
    const cores = await client.listCores();
    const ids = cores.map((c) => c.id);
    expect(ids).toEqual(['Genesis', 'NES', 'SNES']);

    const nes = cores.find((c) => c.id === 'NES');
    expect(nes).toBeDefined();
    expect(nes!.romCount).toBe(9);
    expect(nes!.hiddenCount).toBe(2);
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

    await expect(fs.access(path.join(workDir, 'NES', visible!.filename))).rejects.toThrow();
    await fs.access(path.join(workDir, 'NES', `.${visible!.filename}`));

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
    await fs.access(path.join(workDir, 'NES', visibleName));

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
    await expect(disconnected.listCores()).rejects.toThrow(/not connected/);
  });
});
