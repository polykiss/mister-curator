import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';
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

  describe('listCores', () => {
    it('parses the batched core listing', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk('Genesis\t10\t2\nNES\t9\t2\nSNES\t9\t2\n'),
      );

      const cores = await client.listCores();

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(cores).toEqual([
        { id: 'Genesis', name: 'Genesis', romCount: 10, hiddenCount: 2 },
        { id: 'NES', name: 'NES', romCount: 9, hiddenCount: 2 },
        { id: 'SNES', name: 'SNES', romCount: 9, hiddenCount: 2 },
      ]);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`cd '/media/fat/games'`);
      expect(script).toContain('for d in */;');
    });

    it('throws when not connected', async () => {
      mocks.isConnected.mockReturnValue(false);
      const client = new RealMisterClient();

      await expect(client.listCores()).rejects.toThrow(/not connected/);
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
});
