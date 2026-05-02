import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FakeMisterClient } from '@app/main/clients/fake-mister-client';
import { MisterConnectionError } from '@shared/types';
import type { CoreEntry, MisterProfile } from '@shared/types';
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

  describe('isRealCore guard rails', () => {
    function userFolderEntry(id: string): CoreEntry {
      return {
        id,
        name: id,
        romCount: 0,
        hiddenCount: 0,
        category: 'Console',
        rbfPaths: [],
        gamesDirExists: false,
        gamesDirHidden: false,
      };
    }

    it('hideCore refuses a user-folder CoreEntry (no rbfs, no games dir)', async () => {
      await expect(client.hideCore(userFolderEntry('_hidden'))).rejects.toThrow(
        /not a real core/i,
      );
    });

    it('showCore refuses a user-folder CoreEntry', async () => {
      await expect(client.showCore(userFolderEntry('_alternatives'))).rejects.toThrow(
        /not a real core/i,
      );
    });

    it('setBulkCoreVisibility refuses if any change targets a user folder', async () => {
      await expect(
        client.setBulkCoreVisibility([
          { core: userFolderEntry('_Organized'), hidden: true },
        ]),
      ).rejects.toThrow(/not a real core/i);
    });

    it('emits exactly one Arcade placeholder whenever _Arcade/ exists (regression)', async () => {
    // The cores list in `fixtures/sample-mister/_Arcade/` carries .rbf
    // entries. Real MiSTers carry hundreds of .mra files instead, but
    // either way the placeholder must appear exactly once.
    const cores = await client.listAllCoresWithFiles();
    const arcades = cores.filter((c) => c.category === 'Arcade');
    expect(arcades).toHaveLength(1);
    expect(arcades[0]?.name).toBe('Arcade');
  });

  it('hideCore refuses the synthetic Arcade placeholder', async () => {
      const cores = await client.listAllCoresWithFiles();
      const arcade = cores.find((c) => c.category === 'Arcade');
      expect(arcade).toBeDefined();
      await expect(client.hideCore(arcade!)).rejects.toThrow(/Arcade|not a real/i);
    });
  });

  describe('bulk partial-success', () => {
    it('returns succeeded + failed for a mixed batch (3 cores, 1 fails)', async () => {
      // Simulate one of the cores having a stale path that mv cannot stat.
      const cores = await client.listAllCoresWithFiles();
      const nes = cores.find((c) => c.id === 'NES');
      const snes = cores.find((c) => c.id === 'SNES');
      const genesis = cores.find((c) => c.id === 'Genesis');
      expect(nes && snes && genesis).toBeDefined();

      // Synthesise a CoreEntry with a non-existent rbf path so its
      // rename will fail. The other two should still succeed.
      const broken: CoreEntry = {
        ...snes!,
        rbfPaths: ['/media/fat/_Console/IDoNotExist_20240115.rbf'],
      };

      const result = await client.setBulkCoreVisibility([
        { core: nes!, hidden: true },
        { core: broken, hidden: true },
        { core: genesis!, hidden: true },
      ]);

      expect(result.succeeded).toContain('NES');
      expect(result.succeeded).toContain('Genesis');
      expect(result.succeeded).not.toContain('SNES');
      expect(result.failed.map((f) => f.coreId)).toEqual(['SNES']);
      expect(result.failed[0]?.reason).toMatch(/not found|ENOENT/i);
    });

    it('setBulkRomVisibility returns per-rom partial-success', async () => {
      const result = await client.setBulkRomVisibility('NES', [
        { filename: 'Castlevania (USA, Europe).nes', hidden: true }, // exists, ok
        { filename: 'IDoNotExist.nes', hidden: true }, // mv will fail
        { filename: 'Contra (USA).nes', hidden: true }, // exists, ok
      ]);

      expect(result.succeeded).toContain('Castlevania (USA, Europe).nes');
      expect(result.succeeded).toContain('Contra (USA).nes');
      expect(result.succeeded).not.toContain('IDoNotExist.nes');
      expect(result.failed.map((f) => f.filename)).toEqual(['IDoNotExist.nes']);
    });
  });

  describe('folder ROMs', () => {
    it('lists folder ROMs alongside file ROMs in mixed cores', async () => {
      const roms = await client.listRoms('AO486');
      const file = roms.find((r) => r.filename === 'Default.img');
      const folder = roms.find((r) => r.filename === 'Boot Disk Compilation');
      expect(file?.kind).toBe('file');
      expect(folder).toBeDefined();
      expect(folder?.kind).toBe('folder');
      // Folder size aggregates contained files (both touch'd to 0 bytes).
      expect(folder?.sizeBytes).toBe(0);
    });

    it('lists folder ROMs in a disc-based core (Saturn)', async () => {
      const roms = await client.listRoms('Saturn');
      const filenames = roms.map((r) => r.filename);
      expect(filenames).toContain('sega_bios.rom'); // file
      expect(filenames).toContain('Panzer Dragoon (USA) (1S)'); // folder
      expect(filenames).toContain('Burning Rangers (USA)'); // folder

      const panzer = roms.find((r) => r.filename === 'Panzer Dragoon (USA) (1S)');
      expect(panzer?.kind).toBe('folder');
      expect(panzer?.hidden).toBe(false);
      expect(panzer?.path).toBe('/media/fat/games/Saturn/Panzer Dragoon (USA) (1S)');

      const hiddenFolder = roms.find((r) => r.filename === '.Hidden Disc Game');
      expect(hiddenFolder?.kind).toBe('folder');
      expect(hiddenFolder?.hidden).toBe(true);
      expect(hiddenFolder?.displayName).toBe('Hidden Disc Game');
    });

    it('hide-by-rename works on folder ROMs', async () => {
      await client.setRomVisibility('Saturn', 'Panzer Dragoon (USA) (1S)', true);
      const after = await client.listRoms('Saturn');
      expect(after.find((r) => r.filename === '.Panzer Dragoon (USA) (1S)')).toBeDefined();
      await fs.access(
        path.join(workDir, 'games', 'Saturn', '.Panzer Dragoon (USA) (1S)', 'Panzer Dragoon.cue'),
      );
    });

    it('counts a disc core (Saturn) by its disc folders, excluding the BIOS file', async () => {
      const cores = await client.listAllCoresWithFiles();
      const saturn = cores.find((c) => c.id === 'Saturn');
      expect(saturn).toBeDefined();
      // Fixture: 1 BIOS file (sega_bios.rom — system, excluded) + 3 dirs
      // (2 visible + 1 hidden). romCount counts only the dirs.
      expect(saturn!.romCount).toBe(3);
      // The hidden folder counts toward hiddenCount.
      expect(saturn!.hiddenCount).toBe(1);
    });
  });

  describe('system-files marks', () => {
    it('returns an empty marks list when no file exists', async () => {
      const marks = await client.readSystemFilesMarks();
      expect(marks).toEqual({ schemaVersion: 1, marked: [] });
    });

    it('round-trips a single mark via add → read', async () => {
      await client.addSystemFileMark('C64', 'DolphinDOS_2.0.rom');
      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(1);
      expect(marks.marked[0]?.coreId).toBe('C64');
      expect(marks.marked[0]?.filename).toBe('DolphinDOS_2.0.rom');
      expect(marks.marked[0]?.markedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('addSystemFileMark is idempotent (re-marking is a no-op)', async () => {
      await client.addSystemFileMark('NES', 'header.txt');
      await client.addSystemFileMark('NES', 'header.txt');
      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(1);
    });

    it('removeSystemFileMark drops the entry', async () => {
      await client.addSystemFileMark('NES', 'header.txt');
      await client.removeSystemFileMark('NES', 'header.txt');
      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(0);
    });

    it('removeSystemFileMark for a non-existent entry is a no-op', async () => {
      await client.removeSystemFileMark('NES', 'never_marked.bin');
      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(0);
    });

    it('listAllCoresWithFiles applies the marks to per-core counts', async () => {
      // NEOGEO has 9 game dirs + 12 BIOS files in the fixture-equivalent
      // shape. We don't have NEOGEO in the fake fixture, so use NES
      // instead — it has 9 ROMs (7 visible + 2 hidden). Mark one
      // visible ROM and expect the count to drop by 1.
      const before = await client.listAllCoresWithFiles();
      const nesBefore = before.find((c) => c.id === 'NES');
      const romCountBefore = nesBefore?.romCount ?? 0;
      expect(romCountBefore).toBeGreaterThan(0);

      await client.addSystemFileMark('NES', 'Castlevania (USA, Europe).nes');

      const after = await client.listAllCoresWithFiles(
        await client.readSystemFilesMarks(),
      );
      const nesAfter = after.find((c) => c.id === 'NES');
      expect(nesAfter?.romCount).toBe(romCountBefore - 1);
    });

    it('persists across reset only when the marks file survives', async () => {
      // The marks file lives under .mistercurator/, a directory the
      // fixture doesn't ship. After reset() the working tree is the
      // pristine fixture, so the marks file is gone — this is the
      // expected behavior. Verifies that we don't accidentally cache
      // marks across a reconnect.
      await client.addSystemFileMark('NES', 'persisted_test.nes');
      await client.reset();
      await client.connect(profile, secret);
      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(0);
    });
  });

  describe('ledger self-heal', () => {
    it('drops a stale entry that names a non-existent core', async () => {
      // Pre-seed the ledger with a `_hidden` entry that no real core
      // matches in our fixture tree.
      await client.writeHideLedger({
        schemaVersion: 1,
        hiddenCores: [
          {
            coreId: '_hidden',
            gamesDirHidden: true,
            rbfPaths: [],
            hiddenAt: '2026-05-01T00:00:00Z',
          },
          {
            coreId: 'NES',
            gamesDirHidden: true,
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            hiddenAt: '2026-05-01T00:00:00Z',
          },
        ],
      });

      // First, hide NES so the NES entry stays valid.
      const cores = await client.listAllCoresWithFiles();
      const nes = cores.find((c) => c.id === 'NES');
      await client.hideCore(nes!);
      // After hideCore, the ledger has both entries (the one we
      // pre-seeded for NES is replaced via withCoreHidden).

      const healed = await client.readHideLedger();
      expect(healed.hiddenCores.map((e) => e.coreId)).toEqual(['NES']);

      // The on-disk ledger should have been rewritten without `_hidden`.
      const onDisk = await fs.readFile(
        path.join(workDir, '.mistercurator', 'state.json'),
        'utf-8',
      );
      expect(onDisk).not.toContain('"coreId": "_hidden"');
    });

    it('keeps the ledger as-is when nothing is stale', async () => {
      const cores = await client.listAllCoresWithFiles();
      const nes = cores.find((c) => c.id === 'NES');
      await client.hideCore(nes!);

      const before = await client.readHideLedger();
      const after = await client.readHideLedger();
      // Same shape, same content — heal was a no-op.
      expect(after).toEqual(before);
    });
  });
});
