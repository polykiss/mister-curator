import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';
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
    // Joins games/ with _Console / _Computer / _Other / _Utility.
    // PR-A item 1 dropped the synthetic Arcade placeholder; the
    // matcher now drops Arcade-category rbfs entirely.
    expect(ids).toContain('NES');
    expect(ids).toContain('SNES');
    expect(ids).toContain('Genesis');
    expect(ids).toContain('AO486');
    expect(ids).toContain('Atari800');
    expect(ids).toContain('CrazyMatch');
    expect(ids).toContain('Memtest');
    expect(ids).toContain('SMS'); // rbf-only, no games dir
    expect(ids).toContain('Orphan'); // games dir without a matching rbf

    // Individual arcade cores never appear; PR-A also dropped the
    // synthetic placeholder, so no Arcade-category row at all.
    expect(ids).not.toContain('Galaga');
    expect(ids).not.toContain('Pacman');
    expect(cores.find((c) => c.category === 'Arcade')).toBeUndefined();

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

  it('filters OS metadata sidecars dropped into a games dir (issue #17)', async () => {
    // Simulate a games dir copied from a Mac / Windows host: real
    // ROMs alongside `._*` AppleDouble shadows, a `.DS_Store`, a
    // `Thumbs.db`, plus a `.AppleDouble/` subdir of more shadows.
    // None of the junk should appear in `listRoms`.
    const before = await client.listRoms('NES');
    const expectedCount = before.length;

    const nesDir = path.join(workDir, 'games', 'NES');
    await fs.writeFile(path.join(nesDir, '._castlevania.nes'), 'junk');
    await fs.writeFile(path.join(nesDir, '.DS_Store'), 'junk');
    await fs.writeFile(path.join(nesDir, 'Thumbs.db'), 'junk');
    await fs.writeFile(path.join(nesDir, 'desktop.ini'), 'junk');
    await fs.mkdir(path.join(nesDir, '.AppleDouble'), { recursive: true });
    await fs.writeFile(
      path.join(nesDir, '.AppleDouble', 'sonic.nes'),
      'junk',
    );

    const after = await client.listRoms('NES');
    expect(after.length).toBe(expectedCount);
    const names = after.map((r) => r.filename);
    expect(names).not.toContain('._castlevania.nes');
    expect(names).not.toContain('.DS_Store');
    expect(names).not.toContain('Thumbs.db');
    expect(names).not.toContain('desktop.ini');
    expect(names).not.toContain('.AppleDouble');
  });

  it('throws a clear error when listing ROMs for an unknown core', async () => {
    await expect(client.listRoms('TurboGrafx')).rejects.toThrow(/Unknown core/);
  });

  it('throws "Unknown core" when listing a subPath that does not exist on a real core', async () => {
    // Round 12 regression case — the renderer-side bug was firing
    // `listRoms('NES', '<stale-subpath-from-previous-core>')` after
    // switching cores while drilled in. The data layer correctly
    // rejects the call; the renderer's job is to never make it.
    await expect(client.listRoms('NES', 'Some Container That Does Not Exist'))
      .rejects.toThrow(/Unknown core/);
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

    it('emits no Arcade-category rows even when _Arcade/ exists (PR-A item 1)', async () => {
      // PR-A dropped the synthetic placeholder. The matcher now
      // filters Arcade-category rbfs out entirely; the user's
      // actual `mame` core surfaces as "Arcade" via
      // `coreDisplayName` instead.
      const cores = await client.listAllCoresWithFiles();
      const arcades = cores.filter((c) => c.category === 'Arcade');
      expect(arcades).toHaveLength(0);
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
      // AO486's "Boot Disk Compilation" has sub-folders → container.
      expect(folder?.kind === 'folder-container' || folder?.kind === 'folder-atomic').toBe(true);
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
      // Saturn disc folders carry .cue files → atomic.
      expect(panzer?.kind).toBe('folder-atomic');
      expect(panzer?.hidden).toBe(false);
      expect(panzer?.path).toBe('/media/fat/games/Saturn/Panzer Dragoon (USA) (1S)');

      const hiddenFolder = roms.find((r) => r.filename === '.Hidden Disc Game');
      // The classification heuristic doesn't peer inside dot-prefixed
      // folders' contents to know they're discs — but the override
      // path or its actual contents may resolve it. We only require
      // it to be one of the folder shapes.
      expect(
        hiddenFolder?.kind === 'folder-atomic' ||
          hiddenFolder?.kind === 'folder-container',
      ).toBe(true);
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

  describe('setBulkCoreVisibility progress callback', () => {
    it('emits one onProgress tick per plan with 1-based done counts', async () => {
      const cores = await client.listAllCoresWithFiles();
      const ids = ['NES', 'SNES', 'Genesis'];
      const targets = ids
        .map((id) => cores.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
      expect(targets).toHaveLength(3);

      const events: { done: number; total: number; coreId: string; result: string }[] = [];
      await client.setBulkCoreVisibility(
        targets.map((core) => ({ core, hidden: true })),
        {
          onProgress: (e) =>
            events.push({
              done: e.done,
              total: e.total,
              coreId: e.coreId,
              result: e.result,
            }),
        },
      );

      expect(events).toHaveLength(3);
      expect(events[0]?.total).toBe(3);
      expect(events.map((e) => e.done)).toEqual([1, 2, 3]);
      expect(events.every((e) => e.result === 'ok')).toBe(true);
    });

    it('reports a fail tick with reason when one core fails mid-batch', async () => {
      const cores = await client.listAllCoresWithFiles();
      const nes = cores.find((c) => c.id === 'NES')!;
      const snes = cores.find((c) => c.id === 'SNES')!;
      // Synthesize a broken plan that points at a missing path.
      const broken: CoreEntry = {
        ...snes,
        rbfPaths: ['/media/fat/_Console/IDoNotExist_20240115.rbf'],
      };

      const events: { result: string; coreId: string }[] = [];
      await client.setBulkCoreVisibility(
        [
          { core: nes, hidden: true },
          { core: broken, hidden: true },
        ],
        {
          onProgress: (e) => events.push({ result: e.result, coreId: e.coreId }),
        },
      );

      expect(events).toEqual([
        { result: 'ok', coreId: 'NES' },
        { result: 'fail', coreId: 'SNES' },
      ]);
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

  describe('case-mismatched dot-prefixed games dirs (Round 5 / PR #11 round 2)', () => {
    // Fixtures: _Console/Atari7800_*.rbf + games/.ATARI7800/leftover.bin,
    // and similar shapes for Vectrex / Gameboy2P. These dot-prefixed
    // case-mismatched dirs predate this app on the user's MiSTer. Round 5
    // model: the matcher surfaces them as ordinary HIDDEN cores —
    // single-state UI, the user can click Unhide to clean them up.
    //
    // PR #11 round 2: canonical-form matching collapses
    // ("Atari7800", "ATARI7800") into one entry. Games-dir name
    // wins as the display id, so look the entries up by the
    // games-dir basename.
    it('reports ATARI7800 as hidden with the actual romCount', async () => {
      const cores = await client.listAllCoresWithFiles();
      const atari = cores.find((c) => c.id === 'ATARI7800');
      expect(atari).toBeDefined();
      expect(atari?.gamesDirExists).toBe(true);
      expect(atari?.gamesDirHidden).toBe(true);
      expect(atari?.gamesDirName).toBe('ATARI7800');
      // Report the dir's real contents — no zeroing-out. The user
      // can inspect what's there before deciding to unhide.
      expect(atari?.romCount).toBe(1);
      expect(atari?.recursiveRomCount).toBe(1);
    });

    it('reports VECTREX as hidden with the actual romCount', async () => {
      const cores = await client.listAllCoresWithFiles();
      const vectrex = cores.find((c) => c.id === 'VECTREX');
      expect(vectrex?.gamesDirHidden).toBe(true);
      expect(vectrex?.gamesDirName).toBe('VECTREX');
      expect(vectrex?.romCount).toBe(1);
    });

    it('reports GAMEBOY2P as hidden with the actual romCount', async () => {
      const cores = await client.listAllCoresWithFiles();
      const gb2p = cores.find((c) => c.id === 'GAMEBOY2P');
      expect(gb2p?.gamesDirHidden).toBe(true);
      expect(gb2p?.gamesDirName).toBe('GAMEBOY2P');
      expect(gb2p?.romCount).toBe(1);
    });
  });

  describe('folder drilling + classification', () => {
    it('classifies NEOGEO subfolders as containers (cart-shape)', async () => {
      const cores = await client.listAllCoresWithFiles();
      const neogeo = cores.find((c) => c.id === 'NEOGEO');
      expect(neogeo).toBeDefined();

      const roms = await client.listRoms('NEOGEO');
      const sub = roms.find((r) => r.filename === '1 World A-Z');
      expect(sub).toBeDefined();
      expect(sub?.kind).toBe('folder-container');
    });

    it('classifies Saturn disc folders as atomic', async () => {
      const roms = await client.listRoms('Saturn');
      const panzer = roms.find((r) => r.filename === 'Panzer Dragoon (USA) (1S)');
      expect(panzer?.kind).toBe('folder-atomic');
    });

    it('lists ROMs at a sub-path with relative paths threaded through', async () => {
      const roms = await client.listRoms('NEOGEO', '1 World A-Z');
      const filenames = roms.map((r) => r.filename).sort();
      expect(filenames).toContain('mslug.zip');
      expect(filenames).toContain('kof97.zip');
      const mslug = roms.find((r) => r.filename === 'mslug.zip');
      expect(mslug?.relativePath).toBe('1 World A-Z/mslug.zip');
      // Display strips the .zip wrapper.
      expect(mslug?.displayName).toBe('mslug');
      expect(mslug?.path).toBe(
        '/media/fat/games/NEOGEO/1 World A-Z/mslug.zip',
      );
    });

    it('rejects subPaths that climb out of the core dir', async () => {
      await expect(client.listRoms('NEOGEO', '..')).rejects.toThrow(
        /Invalid subPath/,
      );
      await expect(client.listRoms('NEOGEO', '/etc')).rejects.toThrow(
        /Invalid subPath/,
      );
    });

    it('hides a ROM at a sub-path via setRomVisibility', async () => {
      await client.setRomVisibility(
        'NEOGEO',
        'mslug.zip',
        true,
        '1 World A-Z',
      );
      const roms = await client.listRoms('NEOGEO', '1 World A-Z');
      expect(roms.find((r) => r.filename === '.mslug.zip')).toBeDefined();
      expect(roms.find((r) => r.filename === 'mslug.zip')).toBeUndefined();
    });

    it('user override flips classification and persists across reads', async () => {
      // Saturn's "Panzer Dragoon (USA) (1S)" auto-detects as atomic.
      // Override to container.
      await client.setFolderClassification({
        coreId: 'Saturn',
        folderPath: 'Panzer Dragoon (USA) (1S)',
        classification: 'container',
        setAt: '2026-05-02',
      });
      // The client's listRoms takes the marks as a parameter — at the
      // production layer the ConnectionManager threads its cache
      // through. For this unit test we read the file ourselves and
      // pass it in.
      const marks = await client.readFolderClassifications();
      const roms = await client.listRoms('Saturn', '', marks);
      const panzer = roms.find((r) => r.filename === 'Panzer Dragoon (USA) (1S)');
      expect(panzer?.kind).toBe('folder-container');

      // Reset back to auto.
      await client.setFolderClassification({
        coreId: 'Saturn',
        folderPath: 'Panzer Dragoon (USA) (1S)',
        classification: undefined,
      });
      const marks2 = await client.readFolderClassifications();
      const roms2 = await client.listRoms('Saturn', '', marks2);
      const panzer2 = roms2.find(
        (r) => r.filename === 'Panzer Dragoon (USA) (1S)',
      );
      expect(panzer2?.kind).toBe('folder-atomic');
    });

    it('readFolderClassifications returns the empty file when missing', async () => {
      const marks = await client.readFolderClassifications();
      expect(marks).toEqual({ schemaVersion: 1, overrides: [] });
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

  describe('statPathsWithSize (fix/count-and-status-indicator commit 4)', () => {
    it('returns size + mtime for existing files; zeros for missing', async () => {
      const result = await client.statPathsWithSize([
        '/media/fat/games/NES/Castlevania (USA, Europe).nes',
        '/media/fat/games/NES/__no_such_file__.nes',
      ]);
      expect(
        result['/media/fat/games/NES/Castlevania (USA, Europe).nes'],
      ).toMatchObject({
        size: expect.any(Number),
        mtime: expect.any(Number),
      });
      // Missing path → {0, 0} per the contract.
      expect(result['/media/fat/games/NES/__no_such_file__.nes']).toEqual({
        size: 0,
        mtime: 0,
      });
    });

    it('returns an empty object for empty input', async () => {
      expect(await client.statPathsWithSize([])).toEqual({});
    });

    it('throws when called before connect', async () => {
      const disconnected = new FakeMisterClient({
        rootPath: workDir,
        pristineRootPath: fixturesDir,
        latencyMs: 0,
      });
      await expect(
        disconnected.statPathsWithSize(['/x']),
      ).rejects.toThrow();
    });
  });

  describe('hashPaths', () => {
    it('returns md5 + sha1 + size + diskSize + mtime per file', async () => {
      const targets = [
        '/media/fat/games/NES/Castlevania (USA, Europe).nes',
        '/media/fat/games/NES/Contra (USA).nes',
      ];
      const result = await client.hashPaths(targets);
      expect(result).toHaveLength(2);
      for (const r of result) {
        expect(r.md5).toMatch(/^[0-9a-f]{32}$/);
        expect(r.sha1).toMatch(/^[0-9a-f]{40}$/);
        expect(r.mtime).toBeGreaterThan(0);
        expect(r.size).toBeGreaterThanOrEqual(0);
        expect(r.diskSize).toBeGreaterThanOrEqual(0);
        expect(targets).toContain(r.path);
      }
    });

    it('produces canonical empty-input md5 + sha1 for empty fixture files', async () => {
      // Pin both algorithms — proves the FakeMisterClient uses the
      // same hashing as busybox would on-device. A drift on either
      // would silently corrupt every cache entry, and a round-trip-
      // only test wouldn't catch it.
      const [r] = await client.hashPaths([
        '/media/fat/games/NES/Castlevania (USA, Europe).nes',
      ]);
      expect(r?.md5).toBe('d41d8cd98f00b204e9800998ecf8427e');
      expect(r?.sha1).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
      expect(r?.size).toBe(0);
    });

    it('drops paths that don\'t exist on the device', async () => {
      const result = await client.hashPaths([
        '/media/fat/games/NES/Castlevania (USA, Europe).nes',
        '/media/fat/games/NES/__no_such_file__.nes',
      ]);
      expect(result).toHaveLength(1);
      expect(result[0]?.path).toBe(
        '/media/fat/games/NES/Castlevania (USA, Europe).nes',
      );
    });

    it('returns an empty array for empty input', async () => {
      expect(await client.hashPaths([])).toEqual([]);
    });

    it('throws when called before connect', async () => {
      const disconnected = new FakeMisterClient({
        rootPath: workDir,
        pristineRootPath: fixturesDir,
        latencyMs: 0,
      });
      await expect(disconnected.hashPaths(['/x'])).rejects.toThrow();
    });

    describe('round 6 / round 8 — .zip extraction', () => {
      // .zip wrappers hash the inner content (mirrors the device-
      // side `unzip -p | md5sum` pipeline). OpenVGDB indexes
      // inner-file hashes; SS multi-hash takes both md5 + sha1.
      let zipDir: string;

      beforeEach(async () => {
        zipDir = path.join(workDir, 'games', 'GBA');
        await fs.mkdir(zipDir, { recursive: true });
      });

      it('hashes the inner file of a single-entry .zip with both md5 and sha1', async () => {
        const innerBytes = Buffer.from('PRG ROM bytes — round 2 fixture\n');
        const innerMd5 = createHash('md5').update(innerBytes).digest('hex');
        const innerSha1 = createHash('sha1').update(innerBytes).digest('hex');
        const zip = new JSZip();
        zip.file('test-rom.gba', innerBytes);
        const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
        const wrapperMd5 = createHash('md5').update(zipBytes).digest('hex');
        expect(innerMd5).not.toBe(wrapperMd5); // sanity

        const localPath = path.join(zipDir, 'Test ROM.zip');
        await fs.writeFile(localPath, zipBytes);
        const logical = '/media/fat/games/GBA/Test ROM.zip';

        const [r] = await client.hashPaths([logical]);
        expect(r?.md5).toBe(innerMd5);
        expect(r?.sha1).toBe(innerSha1);
        expect(r?.md5).not.toBe(wrapperMd5);
        expect(r?.size).toBe(innerBytes.byteLength);
        expect(r?.path).toBe(logical);
      });

      it('reports the inner-content size for .zip wrappers, not the zip size', async () => {
        // SS's romtaille expects the EXTRACTED ROM size. Pin that
        // we report inner bytes rather than the wrapper's
        // (which would be larger due to zip overhead).
        const innerBytes = Buffer.alloc(1024, 0xab); // 1KB of 0xAB
        const zip = new JSZip();
        zip.file('rom.gba', innerBytes);
        const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
        // Zip overhead means the wrapper is bigger than the inner.
        expect(zipBytes.byteLength).toBeGreaterThan(innerBytes.byteLength);

        const localPath = path.join(zipDir, 'sized.zip');
        await fs.writeFile(localPath, zipBytes);
        const [r] = await client.hashPaths([
          '/media/fat/games/GBA/sized.zip',
        ]);
        expect(r?.size).toBe(1024);
        // fix/scrape-and-count-correctness commit 1: the wrapper's
        // bytes-on-disk surface in `diskSize` distinct from the
        // extracted `size`. Pin that the two are recorded
        // independently — the test that motivated commit 1.
        expect(r?.diskSize).toBe(zipBytes.byteLength);
      });

      it('matches case-insensitively on the .ZIP extension', async () => {
        const innerBytes = Buffer.from('case-test bytes');
        const innerMd5 = createHash('md5').update(innerBytes).digest('hex');
        const zip = new JSZip();
        zip.file('rom.smc', innerBytes);
        const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
        const localPath = path.join(zipDir, 'UPPERCASE.ZIP');
        await fs.writeFile(localPath, zipBytes);

        const [r] = await client.hashPaths([
          '/media/fat/games/GBA/UPPERCASE.ZIP',
        ]);
        expect(r?.md5).toBe(innerMd5);
      });

      it('records wrapper mtime, not inner-file mtime', async () => {
        const inner = Buffer.from('mtime-test');
        const zip = new JSZip();
        zip.file('rom.gba', inner);
        const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
        const localPath = path.join(zipDir, 'mtime.zip');
        await fs.writeFile(localPath, zipBytes);
        const wrapperEpoch = 1_700_000_000;
        await fs.utimes(localPath, wrapperEpoch, wrapperEpoch);

        const [r] = await client.hashPaths([
          '/media/fat/games/GBA/mtime.zip',
        ]);
        expect(r?.mtime).toBe(wrapperEpoch);
      });

      it('multi-file zip: concatenates entries through both hashers', async () => {
        const a = Buffer.from('first entry');
        const b = Buffer.from('second entry');
        const expectedMd5 = createHash('md5')
          .update(a)
          .update(b)
          .digest('hex');
        const expectedSha1 = createHash('sha1')
          .update(a)
          .update(b)
          .digest('hex');
        const zip = new JSZip();
        zip.file('a.gba', a);
        zip.file('b.gba', b);
        const zipBytes = await zip.generateAsync({ type: 'nodebuffer' });
        const localPath = path.join(zipDir, 'multi.zip');
        await fs.writeFile(localPath, zipBytes);

        const [r] = await client.hashPaths([
          '/media/fat/games/GBA/multi.zip',
        ]);
        expect(r?.md5).toBe(expectedMd5);
        expect(r?.sha1).toBe(expectedSha1);
        expect(r?.size).toBe(a.byteLength + b.byteLength);
      });

      it('skips a corrupt zip rather than emitting a wrong hash', async () => {
        const localPath = path.join(zipDir, 'corrupt.zip');
        await fs.writeFile(localPath, Buffer.from([0xff, 0xff, 0x00, 0x00]));
        const result = await client.hashPaths([
          '/media/fat/games/GBA/corrupt.zip',
        ]);
        expect(result).toHaveLength(0);
      });
    });
  });

  // feat/arcade-mra-management Phase 1: raw listing of _Arcade/ for
  // the Phase 1.5 IPC + renderer integration. Just the find →
  // {type, relPath} pipeline; the shared `parseArcadeMraEntries`
  // filter (own test file) handles the classification.
  describe('listArcadeRawListing (Phase 1)', () => {
    let arcadeDir: string;
    beforeEach(async () => {
      arcadeDir = path.join(workDir, '_Arcade');
      // Reset to a clean shape per test — fixtures only have .rbf
      // here; we add .mra + subfolders to exercise the listing.
      await fs.rm(arcadeDir, { recursive: true, force: true });
      await fs.mkdir(arcadeDir, { recursive: true });
      await fs.writeFile(path.join(arcadeDir, 'Metal Slug.mra'), 'mra');
      await fs.writeFile(path.join(arcadeDir, 'Street Fighter II.mra'), 'mra');
      // Hidden via dot-prefix.
      await fs.writeFile(path.join(arcadeDir, '.Donkey Kong.mra'), 'mra');
      // Organisational subfolder.
      await fs.mkdir(path.join(arcadeDir, '_Konami'));
      await fs.writeFile(path.join(arcadeDir, '_Konami', 'TMNT.mra'), 'mra');
      // Firmware-managed cores stash.
      await fs.mkdir(path.join(arcadeDir, 'cores'));
      await fs.writeFile(path.join(arcadeDir, 'cores', 'Galaga.rbf'), 'rbf');
      // AppleDouple sidecar — must drop.
      await fs.writeFile(path.join(arcadeDir, '._Metal Slug.mra'), 'junk');
    });

    it('returns the raw listing as {type, relPath} rows', async () => {
      const raw = await client.listArcadeRawListing();
      const relPaths = raw.map((r) => r.relPath).sort();
      // Includes .mra files, dot-prefixed .mra files, organisational
      // subfolders + their content, the cores stash + .rbf inside,
      // and AppleDouple. The shared parser filters these — this
      // method's job is just to surface everything for the parser.
      expect(relPaths).toContain('Metal Slug.mra');
      expect(relPaths).toContain('.Donkey Kong.mra');
      expect(relPaths).toContain('_Konami');
      expect(relPaths).toContain('_Konami/TMNT.mra');
      expect(relPaths).toContain('cores');
      expect(relPaths).toContain('._Metal Slug.mra'); // raw — parser drops
    });

    it('emits type=d for directories and type=f for files', async () => {
      const raw = await client.listArcadeRawListing();
      const konami = raw.find((r) => r.relPath === '_Konami');
      const metalSlug = raw.find((r) => r.relPath === 'Metal Slug.mra');
      expect(konami?.type).toBe('d');
      expect(metalSlug?.type).toBe('f');
    });

    it('returns an empty list when _Arcade/ does not exist', async () => {
      await fs.rm(arcadeDir, { recursive: true, force: true });
      const raw = await client.listArcadeRawListing();
      expect(raw).toEqual([]);
    });
  });

  // feat/arcade-playability-data (PR 1/2): pre-parsing of .mra heads
  // for the playability scan. The Fake reads the on-disk .mra files
  // and runs the shared `parseArcadeMra` over each; the contract with
  // the Real client (which uses an on-device awk) is symmetric.
  describe('parseArcadeMras (PR 1/2)', () => {
    let arcadeDir: string;
    beforeEach(async () => {
      arcadeDir = path.join(workDir, '_Arcade');
      await fs.rm(arcadeDir, { recursive: true, force: true });
      await fs.mkdir(arcadeDir, { recursive: true });
      // A single-zip mra (typical case).
      await fs.writeFile(
        path.join(arcadeDir, 'Donkey Kong.mra'),
        [
          '<misterromdescription>',
          '  <setname>dkong</setname>',
          '  <rbf>donkeykong</rbf>',
          '  <rom index="0" zip="dkong.zip"><part>00</part></rom>',
          '</misterromdescription>',
        ].join('\n'),
      );
      // A pipe-fallback clone-with-parent.
      await fs.writeFile(
        path.join(arcadeDir, 'Galaga.mra'),
        [
          '<misterromdescription>',
          '  <setname>galagamw</setname>',
          '  <rbf>galaga</rbf>',
          '  <rom index="1"/>',
          '  <rom index="0" zip="galaga.zip|galagamw.zip"><part>00</part></rom>',
          '</misterromdescription>',
        ].join('\n'),
      );
      // A TTL/discrete-logic mra with no zip refs.
      await fs.writeFile(
        path.join(arcadeDir, 'Computer Space.mra'),
        [
          '<misterromdescription>',
          '  <setname></setname>',
          '  <rbf>computerspace</rbf>',
          '  <rom index="0"/>',
          '</misterromdescription>',
        ].join('\n'),
      );
      // Hidden via dot-prefix.
      await fs.writeFile(
        path.join(arcadeDir, '.Hidden Game.mra'),
        [
          '<misterromdescription>',
          '  <setname>hidden</setname>',
          '  <rbf>hidden</rbf>',
          '  <rom zip="hidden.zip"></rom>',
          '</misterromdescription>',
        ].join('\n'),
      );
      // _alternatives/ subfolder — must be ignored by this method
      // (top-level only per PR 1/2 spec). Verify the boundary.
      await fs.mkdir(path.join(arcadeDir, '_alternatives'));
      await fs.writeFile(
        path.join(arcadeDir, '_alternatives', 'Variant.mra'),
        '<misterromdescription><rbf>x</rbf></misterromdescription>',
      );
      // Non-mra file at top level — must be ignored.
      await fs.writeFile(path.join(arcadeDir, 'README.md'), 'unrelated');
    });

    it('extracts metadata for every top-level .mra (visible + hidden)', async () => {
      const out = await client.parseArcadeMras();
      const byPath = new Map(out.map((m) => [m.relativePath, m]));
      expect(byPath.has('Donkey Kong.mra')).toBe(true);
      expect(byPath.has('Galaga.mra')).toBe(true);
      expect(byPath.has('Computer Space.mra')).toBe(true);
      expect(byPath.has('.Hidden Game.mra')).toBe(true);
    });

    it('does NOT recurse into subfolders (top-level only by spec)', async () => {
      const out = await client.parseArcadeMras();
      expect(
        out.find((m) => m.relativePath.includes('_alternatives')),
      ).toBeUndefined();
    });

    it('drops non-mra files at top level', async () => {
      const out = await client.parseArcadeMras();
      expect(out.find((m) => m.relativePath === 'README.md')).toBeUndefined();
    });

    it('parses pipe-fallback zip lists into one block of alternatives', async () => {
      const out = await client.parseArcadeMras();
      const galaga = out.find((m) => m.relativePath === 'Galaga.mra');
      expect(galaga?.requiredZips).toEqual([['galaga.zip', 'galagamw.zip']]);
      expect(galaga?.rbf).toBe('galaga');
      expect(galaga?.setname).toBe('galagamw');
    });

    it('returns empty requiredZips for TTL .mras with no zip attr', async () => {
      const out = await client.parseArcadeMras();
      const tts = out.find((m) => m.relativePath === 'Computer Space.mra');
      expect(tts?.requiredZips).toEqual([]);
      expect(tts?.setname).toBeUndefined();
    });

    it('preserves the leading-dot relativePath and reports hidden=true', async () => {
      const out = await client.parseArcadeMras();
      const hidden = out.find((m) => m.relativePath === '.Hidden Game.mra');
      expect(hidden?.hidden).toBe(true);
      expect(hidden?.displayName).toBe('Hidden Game.mra');
    });

    it('returns an empty list when _Arcade/ does not exist', async () => {
      await fs.rm(arcadeDir, { recursive: true, force: true });
      const out = await client.parseArcadeMras();
      expect(out).toEqual([]);
    });
  });

  describe('listArcadeZipBasenames (PR 1/2)', () => {
    beforeEach(async () => {
      const mameDir = path.join(workDir, 'games', 'mame');
      const hbmameDir = path.join(workDir, 'games', 'hbmame');
      await fs.rm(mameDir, { recursive: true, force: true });
      await fs.rm(hbmameDir, { recursive: true, force: true });
      await fs.mkdir(mameDir, { recursive: true });
      await fs.mkdir(hbmameDir, { recursive: true });
      await fs.writeFile(path.join(mameDir, 'galaga.zip'), 'z');
      await fs.writeFile(path.join(mameDir, 'pacman.zip'), 'z');
      // Non-zip file — must be ignored.
      await fs.writeFile(path.join(mameDir, 'README'), 'x');
      // Same basename across both dirs — caller dedupes via Set.
      await fs.writeFile(path.join(hbmameDir, 'galaga.zip'), 'z');
      await fs.writeFile(path.join(hbmameDir, 'pacmanhb.zip'), 'z');
    });

    it('returns every zip basename from both mame/ and hbmame/', async () => {
      const out = await client.listArcadeZipBasenames();
      // Sort for determinism — find / readdir order is filesystem-
      // dependent so we don't pin it.
      expect([...out].sort()).toEqual([
        'galaga.zip',
        'galaga.zip', // appears twice — once per dir; caller dedupes
        'pacman.zip',
        'pacmanhb.zip',
      ]);
    });

    it('returns the union when only one dir exists', async () => {
      await fs.rm(path.join(workDir, 'games', 'hbmame'), {
        recursive: true,
        force: true,
      });
      const out = await client.listArcadeZipBasenames();
      expect([...out].sort()).toEqual(['galaga.zip', 'pacman.zip']);
    });

    it('returns an empty list when neither dir exists', async () => {
      await fs.rm(path.join(workDir, 'games', 'mame'), {
        recursive: true,
        force: true,
      });
      await fs.rm(path.join(workDir, 'games', 'hbmame'), {
        recursive: true,
        force: true,
      });
      const out = await client.listArcadeZipBasenames();
      expect(out).toEqual([]);
    });
  });
});
