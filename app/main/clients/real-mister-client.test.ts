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

      const stdout = [
        'R\tConsole\tfile\tNES_20240115.rbf',
        'R\tConsole\tfile\tNES_20231215.rbf',
        'R\tConsole\tfile\tSNES_20240115.rbf',
        'R\tConsole\tfile\tSMS_20240115.rbf',
        'R\tComputer\tdir\tAO486',
        'R\tComputer\tfile\tAtari800_20240220.rbf',
        'R\tArcade\tfile\tGalaga_20240115.rbf',
        'G\tNES\t9\t2',
        'G\tSNES\t9\t2',
        'G\tAO486\t1\t0',
        'G\tOrphan\t3\t0',
        '',
      ].join('\n');

      mocks.execCommand.mockResolvedValueOnce(execOk(stdout));

      const cores = await client.listAllCoresWithFiles();

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);

      const ids = cores.map((c) => c.id);
      expect(ids).toContain('NES');
      expect(ids).toContain('SMS');
      expect(ids).toContain('AO486');
      expect(ids).toContain('Galaga');
      expect(ids).toContain('Orphan');

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

      const galaga = cores.find((c) => c.id === 'Galaga');
      expect(galaga?.category).toBe('Arcade');

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
  });

  describe('listRoms', () => {
    it('parses ROM filenames, hidden detection, displayName, and size', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            '.Action 52 (USA) (Unl).nes\t131072',
            'Castlevania (USA, Europe).nes\t131072',
            'Super Mario Bros. (USA).nes\t40960',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('NES');

      expect(roms).toHaveLength(3);

      const hidden = roms.find((r) => r.filename === '.Action 52 (USA) (Unl).nes');
      expect(hidden).toBeDefined();
      expect(hidden?.hidden).toBe(true);
      expect(hidden?.displayName).toBe('Action 52 (USA) (Unl).nes');
      expect(hidden?.path).toBe('/media/fat/games/NES/.Action 52 (USA) (Unl).nes');
      expect(hidden?.sizeBytes).toBe(131072);

      const visible = roms.find((r) => r.filename === 'Castlevania (USA, Europe).nes');
      expect(visible?.hidden).toBe(false);
      expect(visible?.displayName).toBe('Castlevania (USA, Europe).nes');

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`cd '/media/fat/games/NES'`);
      expect(script).toContain('for f in * .[!.]*');
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

      await client.setBulkRomVisibility('NES', [
        { filename: 'a.nes', hidden: true },
        { filename: 'b.nes', hidden: true },
        { filename: '.c.nes', hidden: false },
        { filename: 'd.nes', hidden: true },
        { filename: '.e.nes', hidden: false },
      ]);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script.startsWith('set -e\n')).toBe(true);
      expect(script).toContain(`cd '/media/fat/games/NES'`);
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toHaveLength(5);
      expect(mvLines).toContain(`mv 'a.nes' '.a.nes'`);
      expect(mvLines).toContain(`mv '.c.nes' 'c.nes'`);
    });

    it('skips no-op changes but still issues exactly one call when at least one rename is needed', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.setBulkRomVisibility('NES', [
        { filename: 'foo.nes', hidden: false }, // already visible — no-op
        { filename: 'bar.nes', hidden: true }, // needs rename
      ]);

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      expect(mvLines).toEqual([`mv 'bar.nes' '.bar.nes'`]);
    });

    it('makes zero SSH calls when every change is a no-op', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await client.setBulkRomVisibility('NES', [
        { filename: 'foo.nes', hidden: false },
        { filename: '.bar.nes', hidden: true },
      ]);

      expect(mocks.execCommand).not.toHaveBeenCalled();
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

      const cores = ['NES', 'SNES', 'Genesis', 'Atari800', 'SMS'].map((id) =>
        makeCore({
          id,
          rbfPaths: [`/media/fat/_Console/${id}_20240115.rbf`],
          gamesDirExists: id !== 'SMS' && id !== 'Atari800',
        }),
      );

      await client.setBulkCoreVisibility(
        cores.map((core) => ({ core, hidden: true })),
      );

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      const mvLines = script.split('\n').filter((l) => l.startsWith('mv '));
      // 3 games dirs (NES, SNES, Genesis) + 5 rbfs = 8 renames.
      expect(mvLines).toHaveLength(8);
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

      const ledger = await client.readHideLedger();
      expect(ledger.hiddenCores).toHaveLength(1);
      expect(ledger.hiddenCores[0]?.coreId).toBe('NES');

      const command = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(command).toContain(`cat '/media/fat/.mistercurator/state.json'`);
      // Tolerates the missing-file case at the shell level.
      expect(command).toContain('|| true');
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
