import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MisterConnectionError } from '@shared/types';
import type { CoreEntry, MisterProfile } from '@shared/types';
import type { MisterSecret } from '@shared/mister-client';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  dispose: vi.fn(),
  execCommand: vi.fn(),
  isConnected: vi.fn(),
}));

vi.mock('node-ssh', () => ({
  NodeSSH: vi.fn().mockImplementation(() => ({
    connect: mocks.connect,
    dispose: mocks.dispose,
    execCommand: mocks.execCommand,
    isConnected: mocks.isConnected,
  })),
}));

const { RealMisterClient } = await import('@app/main/clients/real-mister-client');

const profile: MisterProfile = {
  id: 'test-mister',
  name: 'Test MiSTer',
  host: '192.168.1.42',
  port: 22,
  username: 'root',
  authMethod: 'password',
};

const secret: MisterSecret = { type: 'password', password: '1' };

function execOk(stdout = ''): { stdout: string; stderr: string; code: number; signal: null } {
  return { stdout, stderr: '', code: 0, signal: null };
}

function execFail(
  code = 1,
  stderr = '',
): { stdout: string; stderr: string; code: number; signal: null } {
  return { stdout: '', stderr, code, signal: null };
}

describe('RealMisterClient', () => {
  beforeEach(() => {
    mocks.connect.mockReset().mockResolvedValue(undefined);
    mocks.dispose.mockReset();
    mocks.execCommand.mockReset().mockResolvedValue(execOk());
    mocks.isConnected.mockReset().mockReturnValue(true);
  });

  describe('connect', () => {
    it('opens the SSH connection and verifies /media/fat/games exists', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);

      expect(mocks.connect).toHaveBeenCalledTimes(1);
      const args = mocks.connect.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.host).toBe(profile.host);
      expect(args.port).toBe(profile.port);
      expect(args.username).toBe(profile.username);
      expect(args.password).toBe('1');
      expect(args.readyTimeout).toBe(8000);

      // Dir check probes the games dir.
      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const dirCheck = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(dirCheck).toBe(`[ -d '/media/fat/games' ]`);
    });

    it('passes the private key (not the path) when authMethod is key', async () => {
      const keyProfile: MisterProfile = { ...profile, authMethod: 'key' };
      const keySecret: MisterSecret = { type: 'key', privateKey: '----- PRIVATE KEY -----' };

      const client = new RealMisterClient();
      await client.connect(keyProfile, keySecret);

      const args = mocks.connect.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.privateKey).toBe('----- PRIVATE KEY -----');
      expect(args.password).toBeUndefined();
    });

    it('rejects mismatched secret type with auth_failed before opening any connection', async () => {
      const client = new RealMisterClient();
      const wrong: MisterSecret = { type: 'key', privateKey: 'irrelevant' };

      await expect(client.connect(profile, wrong)).rejects.toMatchObject({
        name: 'MisterConnectionError',
        code: 'auth_failed',
      });
      expect(mocks.connect).not.toHaveBeenCalled();
    });

    it('maps ECONNREFUSED to unreachable', async () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 192.168.1.42:22'), {
        code: 'ECONNREFUSED',
      });
      mocks.connect.mockRejectedValueOnce(err);

      const client = new RealMisterClient();
      await expect(client.connect(profile, secret)).rejects.toMatchObject({
        name: 'MisterConnectionError',
        code: 'unreachable',
      });
      expect(mocks.dispose).toHaveBeenCalled();
    });

    it('maps timeout messages to unreachable', async () => {
      mocks.connect.mockRejectedValueOnce(new Error('Timed out while waiting for handshake'));

      const client = new RealMisterClient();
      await expect(client.connect(profile, secret)).rejects.toMatchObject({
        code: 'unreachable',
      });
    });

    it('maps "All configured authentication methods failed" to auth_failed', async () => {
      mocks.connect.mockRejectedValueOnce(
        new Error('All configured authentication methods failed'),
      );

      const client = new RealMisterClient();
      await expect(client.connect(profile, secret)).rejects.toMatchObject({
        code: 'auth_failed',
      });
    });

    it('maps unrecognized errors to unknown', async () => {
      mocks.connect.mockRejectedValueOnce(new Error('Some weird internal failure'));

      const client = new RealMisterClient();
      await expect(client.connect(profile, secret)).rejects.toMatchObject({
        code: 'unknown',
      });
    });

    it('throws not_a_mister when /media/fat/games is missing', async () => {
      mocks.execCommand.mockResolvedValueOnce(execFail(1));

      const client = new RealMisterClient();
      const error = await client.connect(profile, secret).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(MisterConnectionError);
      expect((error as MisterConnectionError).code).toBe('not_a_mister');
      expect(mocks.dispose).toHaveBeenCalled();
    });
  });

  describe('disconnect', () => {
    it('disposes the underlying SSH client', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);

      mocks.isConnected.mockReturnValue(true);
      await client.disconnect();

      expect(mocks.dispose).toHaveBeenCalled();
    });

    it('is a no-op when not connected', async () => {
      mocks.isConnected.mockReturnValue(false);
      const client = new RealMisterClient();

      await client.disconnect();
      expect(mocks.dispose).not.toHaveBeenCalled();
    });
  });

  describe('listAllCoresWithFiles', () => {
    it('parses R-tagged rbf entries and G-tagged games-dir entries into CoreEntry[]', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // Per-entry GF/GD lines: NES has 9 ROMs (7 visible + 2 hidden),
      // SNES the same, AO486 has 1 file, Orphan has 3 files. None of
      // these names match the system-file heuristic so all of them
      // count toward romCount.
      const nesGames: string[] = [];
      for (let i = 0; i < 7; i += 1) nesGames.push(`GF\tNES\tgame${String(i)}.nes`);
      for (let i = 0; i < 2; i += 1) nesGames.push(`GF\tNES\t.hidden${String(i)}.nes`);
      const snesGames: string[] = [];
      for (let i = 0; i < 7; i += 1) snesGames.push(`GF\tSNES\tgame${String(i)}.sfc`);
      for (let i = 0; i < 2; i += 1) snesGames.push(`GF\tSNES\t.hidden${String(i)}.sfc`);

      const stdout = [
        'R\tConsole\tfile\tNES_20240115.rbf',
        'R\tConsole\tfile\tNES_20231215.rbf',
        'R\tConsole\tfile\tSNES_20240115.rbf',
        'R\tConsole\tfile\tSMS_20240115.rbf',
        'R\tConsole\tfile\tGame Gear.mgl',
        'R\tConsole\tfile\tAtari 2600.mgl',
        'R\tConsole\tfile\tMega Duck.mgl',
        'R\tComputer\tdir\tAO486',
        'R\tComputer\tfile\tAtari800_20240220.rbf',
        'R\tArcade\tfile\tGalaga_20240115.rbf',
        'R\tArcade\tfile\tPacman_20240310.rbf',
        'G\tNES',
        ...nesGames,
        'G\tSNES',
        ...snesGames,
        'G\tAO486',
        'GF\tAO486\tDefault.img',
        'G\tOrphan',
        'GF\tOrphan\ta.bin',
        'GF\tOrphan\tb.bin',
        'GF\tOrphan\tc.bin',
        '',
      ].join('\n');

      mocks.execCommand.mockResolvedValueOnce(execOk(stdout));

      const cores = await client.listAllCoresWithFiles();

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);

      const ids = cores.map((c) => c.id);
      expect(ids).toContain('NES');
      expect(ids).toContain('SMS');
      expect(ids).toContain('AO486');
      expect(ids).toContain('Orphan');

      // .mgl cores are first-class — Game Gear / Atari 2600 / Mega Duck.
      expect(ids).toContain('Game Gear');
      expect(ids).toContain('Atari 2600');
      expect(ids).toContain('Mega Duck');
      const gameGear = cores.find((c) => c.id === 'Game Gear');
      expect(gameGear?.rbfPaths).toEqual(['/media/fat/_Console/Game Gear.mgl']);

      // Both arcade entries collapse into one synthetic placeholder.
      expect(ids).not.toContain('Galaga');
      expect(ids).not.toContain('Pacman');
      const arcade = cores.find((c) => c.category === 'Arcade');
      expect(arcade?.name).toBe('Arcade');

      const nes = cores.find((c) => c.id === 'NES');
      expect(nes?.category).toBe('Console');
      expect(nes?.rbfPaths).toEqual([
        '/media/fat/_Console/NES_20240115.rbf',
        '/media/fat/_Console/NES_20231215.rbf',
      ]);
      expect(nes?.romCount).toBe(9);
      expect(nes?.hiddenCount).toBe(2);
      expect(nes?.gamesDirExists).toBe(true);

      const ao486 = cores.find((c) => c.id === 'AO486');
      expect(ao486?.category).toBe('Computer');
      expect(ao486?.rbfPaths).toEqual(['/media/fat/_Computer/AO486']);

      const orphan = cores.find((c) => c.id === 'Orphan');
      expect(orphan?.category).toBe('Unknown');
      expect(orphan?.rbfPaths).toEqual([]);

      const sms = cores.find((c) => c.id === 'SMS');
      expect(sms?.gamesDirExists).toBe(false);
      expect(sms?.romCount).toBe(0);
    });

    it('throws when not connected', async () => {
      mocks.isConnected.mockReturnValue(false);
      const client = new RealMisterClient();

      await expect(client.listAllCoresWithFiles()).rejects.toThrow(/not connected/);
    });

    it('emits a shell script that recognises .mgl files alongside .rbf', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // The case branch for files matches both extensions, both cases.
      expect(script).toContain('*.rbf|*.RBF|*.mgl|*.MGL');
    });

    it('emits a shell script that gates folder-shaped cores on rbf/mgl content', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // The folder branch uses find -iname for both extensions before
      // emitting an R-line, so user-created folders without a .rbf or
      // .mgl inside (e.g. _alternatives, _Organized) are skipped.
      expect(script).toMatch(/find ".*?".*-iname '\*\.rbf'/);
      expect(script).toMatch(/-iname '\*\.mgl'/);
    });

    it('emits an arcade-dir probe so the placeholder appears whenever _Arcade exists', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`if [ -d '/media/fat/_Arcade' ]; then`);
      expect(script).toContain(`printf 'A\\n'`);
    });

    it('parses the A sentinel into a synthetic Arcade placeholder row', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // Real-MiSTer shape: _Arcade exists but contains only .mra files,
      // so no R-Arcade lines are emitted — only the A sentinel.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'R\tConsole\tfile\tNES_20240115.rbf',
            'A',
            '',
          ].join('\n'),
        ),
      );

      const cores = await client.listAllCoresWithFiles();
      const arcade = cores.find((c) => c.category === 'Arcade');
      expect(arcade).toBeDefined();
      expect(arcade?.name).toBe('Arcade');
    });
  });

  describe('listRoms', () => {
    it('parses ROM filenames, hidden detection, displayName, and size', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // The listRoms script emits `F\t<name>\t<size>` for files and
      // `D\t<name>\t<size>` for folder ROMs. Mix both in the test to
      // cover Saturn-style discs (folder ROMs) alongside NES-style
      // cartridges in one core.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'F\t.Action 52 (USA) (Unl).nes\t131072',
            'F\tCastlevania (USA, Europe).nes\t131072',
            'F\tSuper Mario Bros. (USA).nes\t40960',
            'D\tPanzer Dragoon Saga (USA)\t1958295552',
            'D\t.Hidden Disc Game\t125829120',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('NES');

      expect(roms).toHaveLength(5);

      const hiddenFile = roms.find((r) => r.filename === '.Action 52 (USA) (Unl).nes');
      expect(hiddenFile?.kind).toBe('file');
      expect(hiddenFile?.hidden).toBe(true);
      expect(hiddenFile?.displayName).toBe('Action 52 (USA) (Unl).nes');
      expect(hiddenFile?.sizeBytes).toBe(131072);

      const visibleFile = roms.find((r) => r.filename === 'Castlevania (USA, Europe).nes');
      expect(visibleFile?.kind).toBe('file');
      expect(visibleFile?.hidden).toBe(false);

      const folderRom = roms.find((r) => r.filename === 'Panzer Dragoon Saga (USA)');
      expect(folderRom).toBeDefined();
      expect(folderRom?.kind).toBe('folder');
      expect(folderRom?.hidden).toBe(false);
      expect(folderRom?.sizeBytes).toBe(1958295552);
      expect(folderRom?.path).toBe('/media/fat/games/NES/Panzer Dragoon Saga (USA)');

      const hiddenFolder = roms.find((r) => r.filename === '.Hidden Disc Game');
      expect(hiddenFolder?.kind).toBe('folder');
      expect(hiddenFolder?.hidden).toBe(true);
      expect(hiddenFolder?.displayName).toBe('Hidden Disc Game');

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`cd '/media/fat/games/NES'`);
      // File branch (find -printf) and directory branch (du -sb).
      expect(script).toContain('-type f -printf');
      expect(script).toContain('-type d -exec du -sb');
    });

    it('throws "Unknown core" when the core directory is missing', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(execFail(1, 'No such file or directory'));

      await expect(client.listRoms('TurboGrafx')).rejects.toThrow(/Unknown core/);
    });
  });

  describe('setRomVisibility', () => {
    it('builds a single mv command with both paths properly single-quote escaped', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const tricky = "Don't Starve (USA).nes";
      await client.setRomVisibility('NES', tricky, true);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const command = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(command).toBe(
        `mv '/media/fat/games/NES/Don'\\''t Starve (USA).nes' '/media/fat/games/NES/.Don'\\''t Starve (USA).nes'`,
      );
    });

    it('strips a leading dot when un-hiding', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.setRomVisibility('NES', '.Color a Dinosaur (USA).nes', false);

      const command = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(command).toBe(
        `mv '/media/fat/games/NES/.Color a Dinosaur (USA).nes' '/media/fat/games/NES/Color a Dinosaur (USA).nes'`,
      );
    });

    it('is a no-op (zero SSH calls) when the file is already in the desired state', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.setRomVisibility('NES', 'foo.nes', false);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });
  });

  describe('setBulkRomVisibility', () => {
    it('runs all renames in exactly one SSH call for a 5-element batch', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      // Mock the bulk script's stdout so the parser sees five OK lines.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(['a.nes', 'b.nes', '.c.nes', 'd.nes', '.e.nes']
          .map((id) => `OK\t${id}`)
          .join('\n')),
      );

      const result = await client.setBulkRomVisibility('NES', [
        { filename: 'a.nes', hidden: true },
        { filename: 'b.nes', hidden: true },
        { filename: '.c.nes', hidden: false },
        { filename: 'd.nes', hidden: true },
        { filename: '.e.nes', hidden: false },
      ]);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toEqual(['a.nes', 'b.nes', '.c.nes', 'd.nes', '.e.nes']);
      expect(result.failed).toEqual([]);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`cd '/media/fat/games/NES'`);
      // Each rename is wrapped in an `if err=$(mv ...)` block so the
      // batch never aborts on the first failure.
      const ifMvCount = (script.match(/if err=\$\(mv /g) ?? []).length;
      expect(ifMvCount).toBe(5);
      expect(script).toContain(`mv 'a.nes' '.a.nes'`);
      expect(script).toContain(`mv '.c.nes' 'c.nes'`);
    });

    it('skips no-op changes but still issues exactly one call when at least one rename is needed', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk('OK\tbar.nes'));

      await client.setBulkRomVisibility('NES', [
        { filename: 'foo.nes', hidden: false }, // already visible — no-op
        { filename: 'bar.nes', hidden: true }, // needs rename
      ]);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const ifMvCount = (script.match(/if err=\$\(mv /g) ?? []).length;
      expect(ifMvCount).toBe(1);
      expect(script).toContain(`mv 'bar.nes' '.bar.nes'`);
      expect(script).not.toContain(`mv 'foo.nes'`);
    });

    it('makes zero SSH calls when every change is a no-op', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const result = await client.setBulkRomVisibility('NES', [
        { filename: 'foo.nes', hidden: false },
        { filename: '.bar.nes', hidden: true },
      ]);

      expect(mocks.execCommand).not.toHaveBeenCalled();
      expect(result).toEqual({ succeeded: [], failed: [] });
    });

    it('returns a partial-success result when some renames fail', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // One failure mid-batch — parser should still consume the surrounding OKs.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'OK\ta.nes',
            'FAIL\tb.nes\tmv: cannot stat b.nes',
            'OK\tc.nes',
          ].join('\n'),
        ),
      );

      const result = await client.setBulkRomVisibility('NES', [
        { filename: 'a.nes', hidden: true },
        { filename: 'b.nes', hidden: true },
        { filename: 'c.nes', hidden: true },
      ]);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toEqual(['a.nes', 'c.nes']);
      expect(result.failed).toEqual([
        { filename: 'b.nes', reason: 'mv: cannot stat b.nes' },
      ]);
    });
  });

  describe('hideCore / showCore', () => {
    function makeCore(overrides: Partial<CoreEntry> = {}): CoreEntry {
      return {
        id: 'NES',
        name: 'NES',
        romCount: 9,
        hiddenCount: 2,
        category: 'Console',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/NES_20231215.rbf',
        ],
        gamesDirExists: true,
        gamesDirHidden: false,
        ...overrides,
      };
    }

    it('hideCore renames the games dir AND every matching rbf in one shell script', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.hideCore(makeCore());

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script.startsWith('set -e\n')).toBe(true);
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toHaveLength(3);
      expect(mvLines).toContain(`mv '/media/fat/games/NES' '/media/fat/games/.NES'`);
      expect(mvLines).toContain(
        `mv '/media/fat/_Console/NES_20240115.rbf' '/media/fat/_Console/.NES_20240115.rbf'`,
      );
      expect(mvLines).toContain(
        `mv '/media/fat/_Console/NES_20231215.rbf' '/media/fat/_Console/.NES_20231215.rbf'`,
      );
    });

    it('hideCore on an already-fully-hidden core makes ZERO SSH calls', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.hideCore(
        makeCore({
          gamesDirHidden: true,
          rbfPaths: [
            '/media/fat/_Console/.NES_20240115.rbf',
            '/media/fat/_Console/.NES_20231215.rbf',
          ],
        }),
      );

      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('hideCore handles folder-shaped cores (the rbfPath IS a folder)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.hideCore(
        makeCore({
          id: 'AO486',
          category: 'Computer',
          rbfPaths: ['/media/fat/_Computer/AO486'],
          gamesDirExists: false,
        }),
      );

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toEqual([
        `mv '/media/fat/_Computer/AO486' '/media/fat/_Computer/.AO486'`,
      ]);
    });

    it('hideCore handles rbf-only cores (no games dir to rename)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.hideCore(
        makeCore({
          id: 'SMS',
          rbfPaths: ['/media/fat/_Console/SMS_20240115.rbf'],
          gamesDirExists: false,
        }),
      );

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toEqual([
        `mv '/media/fat/_Console/SMS_20240115.rbf' '/media/fat/_Console/.SMS_20240115.rbf'`,
      ]);
    });

    it('showCore is the inverse — strips the dot from games dir AND rbfs', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.showCore(
        makeCore({
          gamesDirHidden: true,
          rbfPaths: [
            '/media/fat/_Console/.NES_20240115.rbf',
            '/media/fat/_Console/.NES_20231215.rbf',
          ],
        }),
      );

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toHaveLength(3);
      expect(mvLines).toContain(`mv '/media/fat/games/.NES' '/media/fat/games/NES'`);
      expect(mvLines).toContain(
        `mv '/media/fat/_Console/.NES_20240115.rbf' '/media/fat/_Console/NES_20240115.rbf'`,
      );
    });

    it('hideCore refuses a CoreEntry that is not a real core (user folder shape)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // No rbfs, no games dir — looks like `_Console/_hidden`.
      await expect(
        client.hideCore(
          makeCore({
            id: '_hidden',
            category: 'Console',
            rbfPaths: [],
            gamesDirExists: false,
          }),
        ),
      ).rejects.toThrow(/not a real core/i);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('showCore refuses a CoreEntry that is not a real core', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await expect(
        client.showCore(
          makeCore({
            id: '_alternatives',
            category: 'Console',
            rbfPaths: [],
            gamesDirExists: false,
          }),
        ),
      ).rejects.toThrow(/not a real core/i);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('hideCore refuses arcade cores', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await expect(
        client.hideCore(
          makeCore({
            id: 'Galaga',
            category: 'Arcade',
            rbfPaths: ['/media/fat/_Arcade/Galaga_20240115.rbf'],
          }),
        ),
      ).rejects.toThrow(/Arcade/);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('half-success surfaces a clear error (no special "ledger" handling at the client layer)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execFail(1, "mv: can't rename '/media/fat/_Console/NES_20231215.rbf'"),
      );

      await expect(client.hideCore(makeCore())).rejects.toThrow(/hide core NES/);
    });
  });

  describe('setBulkCoreVisibility', () => {
    function makeCore(overrides: Partial<CoreEntry>): CoreEntry {
      return {
        id: 'X',
        name: 'X',
        romCount: 0,
        hiddenCount: 0,
        category: 'Console',
        rbfPaths: [],
        gamesDirExists: false,
        gamesDirHidden: false,
        ...overrides,
      };
    }

    it('runs a 5-core batch in exactly one execCommand call', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          ['NES', 'SNES', 'Genesis', 'Atari800', 'SMS']
            .map((id) => `OK\t${id}`)
            .join('\n'),
        ),
      );

      const cores = ['NES', 'SNES', 'Genesis', 'Atari800', 'SMS'].map((id) =>
        makeCore({
          id,
          rbfPaths: [`/media/fat/_Console/${id}_20240115.rbf`],
          gamesDirExists: id !== 'SMS' && id !== 'Atari800',
        }),
      );

      const result = await client.setBulkCoreVisibility(
        cores.map((core) => ({ core, hidden: true })),
      );

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toHaveLength(5);
      expect(result.failed).toEqual([]);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // 3 games dirs (NES, SNES, Genesis) + 5 rbfs = 8 mv commands woven
      // through five `(set -e ...)` per-core subshells.
      const mvCount = (script.match(/mv '/g) ?? []).length;
      expect(mvCount).toBe(8);
      // Each core gets its own atomic subshell.
      const subshellCount = (script.match(/\(set -e/g) ?? []).length;
      expect(subshellCount).toBe(5);
    });

    it('returns a partial-success result when one core fails mid-batch', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'OK\tNES',
            'FAIL\tSNES\tmv: cannot stat SNES',
            'OK\tGenesis',
          ].join('\n'),
        ),
      );

      const result = await client.setBulkCoreVisibility(
        ['NES', 'SNES', 'Genesis'].map((id) => ({
          core: makeCore({
            id,
            rbfPaths: [`/media/fat/_Console/${id}_20240115.rbf`],
            gamesDirExists: true,
          }),
          hidden: true,
        })),
      );

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toEqual(['NES', 'Genesis']);
      expect(result.failed).toEqual([
        { coreId: 'SNES', reason: 'mv: cannot stat SNES' },
      ]);
    });

    it('issues zero SSH calls when every change is a no-op', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.setBulkCoreVisibility([
        {
          core: makeCore({
            id: 'NES',
            rbfPaths: ['/media/fat/_Console/.NES_20240115.rbf'],
            gamesDirExists: true,
            gamesDirHidden: true,
          }),
          hidden: true,
        },
      ]);

      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('refuses if any change targets an arcade core', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await expect(
        client.setBulkCoreVisibility([
          {
            core: makeCore({ id: 'Galaga', category: 'Arcade' }),
            hidden: true,
          },
        ]),
      ).rejects.toThrow(/Arcade/);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });
  });

  describe('readHideLedger / writeHideLedger', () => {
    it('readHideLedger parses the cat output and tolerates missing files', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const ledgerJson = JSON.stringify({
        schemaVersion: 1,
        hiddenCores: [
          {
            coreId: 'NES',
            gamesDirHidden: true,
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            hiddenAt: '2026-05-01T12:00:00Z',
          },
        ],
      });
      mocks.execCommand.mockResolvedValueOnce(execOk(ledgerJson));
      // The self-heal step inside readHideLedger calls
      // listAllCoresWithFiles to verify each entry. Return a snapshot
      // that includes NES so the entry survives.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'R\tConsole\tfile\tNES_20240115.rbf',
            'G\tNES',
            'GF\tNES\tCastlevania.nes',
            'GF\tNES\tContra.nes',
            'GF\tNES\tFinal Fantasy.nes',
            'GF\tNES\tMega Man 2.nes',
            'GF\tNES\tMetroid.nes',
            'GF\tNES\tSuper Mario Bros.nes',
            'GF\tNES\tZelda.nes',
            'GF\tNES\t.hidden1.nes',
            'GF\tNES\t.hidden2.nes',
          ].join('\n'),
        ),
      );

      const ledger = await client.readHideLedger();
      expect(ledger.hiddenCores).toHaveLength(1);
      expect(ledger.hiddenCores[0]?.coreId).toBe('NES');

      const command = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(command).toContain(`cat '/media/fat/.mistercurator/state.json'`);
      // Tolerates the missing-file case at the shell level.
      expect(command).toContain('|| true');
    });

    it('readHideLedger self-heals: drops a stale entry and rewrites the ledger', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // The ledger references a `_hidden` user folder from before the
      // closeout fix, plus a real NES entry.
      const ledgerJson = JSON.stringify({
        schemaVersion: 1,
        hiddenCores: [
          {
            coreId: '_hidden',
            gamesDirHidden: true,
            rbfPaths: [],
            hiddenAt: '2026-05-01T12:00:00Z',
          },
          {
            coreId: 'NES',
            gamesDirHidden: true,
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            hiddenAt: '2026-05-01T12:00:00Z',
          },
        ],
      });
      mocks.execCommand.mockResolvedValueOnce(execOk(ledgerJson));
      // listAllCoresWithFiles snapshot: only NES exists. _hidden doesn't.
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'R\tConsole\tfile\tNES_20240115.rbf',
            'G\tNES',
            'GF\tNES\tCastlevania.nes',
            'GF\tNES\tContra.nes',
            'GF\tNES\tFinal Fantasy.nes',
            'GF\tNES\tMega Man 2.nes',
            'GF\tNES\tMetroid.nes',
            'GF\tNES\tSuper Mario Bros.nes',
            'GF\tNES\tZelda.nes',
            'GF\tNES\t.hidden1.nes',
            'GF\tNES\t.hidden2.nes',
          ].join('\n'),
        ),
      );
      // The heal triggers a writeHideLedger.
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      const ledger = await client.readHideLedger();
      expect(ledger.hiddenCores).toHaveLength(1);
      expect(ledger.hiddenCores[0]?.coreId).toBe('NES');

      // Three execCommands total: cat ledger, list cores, write cleaned ledger.
      expect(mocks.execCommand).toHaveBeenCalledTimes(3);
      const writeScript = mocks.execCommand.mock.calls[2]?.[0] as string;
      expect(writeScript).toContain(`mkdir -p '/media/fat/.mistercurator'`);
      // The rewrite contains NES but not _hidden.
      expect(writeScript).toContain('"coreId": "NES"');
      expect(writeScript).not.toContain('"coreId": "_hidden"');
    });

    it('readHideLedger returns empty ledger when cat returns nothing (file missing)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      const ledger = await client.readHideLedger();
      expect(ledger).toEqual({ schemaVersion: 1, hiddenCores: [] });
    });

    it('writeHideLedger emits mkdir, heredoc with the documented delimiter, and atomic mv', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.writeHideLedger({
        schemaVersion: 1,
        hiddenCores: [
          {
            coreId: 'NES',
            gamesDirHidden: true,
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            hiddenAt: '2026-05-01T12:00:00Z',
          },
        ],
      });

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`mkdir -p '/media/fat/.mistercurator'`);
      expect(script).toContain(`<<'MISTERCURATOR_LEDGER_EOF'`);
      expect(script).toContain('\nMISTERCURATOR_LEDGER_EOF\n');
      expect(script).toContain(
        `mv '/media/fat/.mistercurator/state.json.tmp' '/media/fat/.mistercurator/state.json'`,
      );
    });

    it('writeHideLedger rejects fast when payload contains the heredoc delimiter', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await expect(
        client.writeHideLedger({
          schemaVersion: 1,
          hiddenCores: [
            {
              coreId: 'MISTERCURATOR_LEDGER_EOF',
              gamesDirHidden: true,
              rbfPaths: [],
              hiddenAt: '2026-05-01T12:00:00Z',
            },
          ],
        }),
      ).rejects.toThrow(/heredoc delimiter/);

      // Must short-circuit before issuing any execCommand so a corrupt ledger
      // can never be written.
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });
  });
});
