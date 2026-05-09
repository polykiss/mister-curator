import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MisterConnectionError } from '@shared/types';
import type { CoreEntry, MisterProfile } from '@shared/types';
import type { MisterSecret } from '@shared/mister-client';

/**
 * The connection mock simulates the underlying ssh2 Client. Tests can
 * call `connectionListeners.get('close')?.()` to fake an unexpected
 * disconnect — that's what the real ssh2 transport does on close/
 * error.
 */
const mocks = vi.hoisted(() => {
  const connectionListeners = new Map<string, () => void>();
  return {
    connect: vi.fn(),
    dispose: vi.fn(),
    execCommand: vi.fn(),
    exec: vi.fn(),
    isConnected: vi.fn(),
    connectionListeners,
    connection: {
      once: vi.fn((event: string, handler: () => void) => {
        connectionListeners.set(event, handler);
      }),
    },
  };
});

vi.mock('node-ssh', () => ({
  NodeSSH: vi.fn().mockImplementation(() => ({
    connect: mocks.connect,
    dispose: mocks.dispose,
    execCommand: mocks.execCommand,
    exec: mocks.exec,
    isConnected: mocks.isConnected,
    connection: mocks.connection,
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
    mocks.exec.mockReset().mockResolvedValue('');
    mocks.isConnected.mockReset().mockReturnValue(true);
    mocks.connection.once.mockClear();
    mocks.connectionListeners.clear();
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

    it('configures SSH-level keepalive on the underlying ssh2 client', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);

      const args = mocks.connect.mock.calls[0]?.[0] as Record<string, unknown>;
      // PR #20 round 3 widened this from 5s × 2 (10s detection) to
      // 15s × 4 (60s detection). The aggressive cadence false-fired
      // on idle WiFi where intermittent latency spikes (6ms → 194ms)
      // caused two consecutive missed responses even on a healthy
      // link. 60s before declaring transport dead lets normal WiFi
      // jitter pass while still catching real drops.
      expect(args.keepaliveInterval).toBe(15_000);
      expect(args.keepaliveCountMax).toBe(4);
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

  describe('onUnexpectedDisconnect', () => {
    it('attaches close + error listeners after a successful connect', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);

      // The real client subscribes once each on the underlying ssh2
      // Client. Both events flow into the same handler so the manager
      // sees a single "unexpected disconnect" regardless of which one
      // ssh2 fired first.
      expect(mocks.connection.once).toHaveBeenCalledWith(
        'close',
        expect.any(Function),
      );
      expect(mocks.connection.once).toHaveBeenCalledWith(
        'error',
        expect.any(Function),
      );
    });

    it('fires registered listeners when the transport closes mid-session', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      const listener = vi.fn();
      client.onUnexpectedDisconnect(listener);

      mocks.connectionListeners.get('close')?.();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires once even when both close and error fire (ssh2 dedup)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      const listener = vi.fn();
      client.onUnexpectedDisconnect(listener);

      mocks.connectionListeners.get('error')?.();
      mocks.connectionListeners.get('close')?.();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('suppresses the unexpected path during a clean disconnect()', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      const listener = vi.fn();
      client.onUnexpectedDisconnect(listener);

      mocks.isConnected.mockReturnValue(true);
      await client.disconnect();

      // ssh2 will still fire 'close' as part of dispose. The flag set
      // inside disconnect() must squelch the listener.
      mocks.connectionListeners.get('close')?.();

      expect(listener).not.toHaveBeenCalled();
    });

    it('returns an unsubscribe function that removes the listener', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      const listener = vi.fn();
      const unsubscribe = client.onUnexpectedDisconnect(listener);
      unsubscribe();

      mocks.connectionListeners.get('close')?.();

      expect(listener).not.toHaveBeenCalled();
    });

    it('rearms after a fresh connect() — listeners can fire again on the next session', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      const listener = vi.fn();
      client.onUnexpectedDisconnect(listener);
      mocks.connectionListeners.get('close')?.();
      expect(listener).toHaveBeenCalledTimes(1);

      // Reconnect — ssh2 attaches new listeners; the unexpectedFired
      // dedup flag resets.
      mocks.connection.once.mockClear();
      mocks.connectionListeners.clear();
      await client.connect(profile, secret);
      mocks.connectionListeners.get('close')?.();

      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  describe('listAllCoresWithFiles', () => {
    it('parses P-tagged rbf entries and G-tagged games-dir entries into CoreEntry[]', async () => {
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

      // PR #11 round 2 / Change 1: P-line records carry the FULL
      // path emitted by `find` so the parser can disambiguate
      // folder-shaped cores (e.g. `_Computer/AO486/AO486.rbf` at
      // depth 2) from flat ones (`_Console/NES.rbf` at depth 1).
      // The parser dedupes folder-shaped cores by parent dir.
      const stdout = [
        'P\tConsole\t/media/fat/_Console/NES_20240115.rbf',
        'P\tConsole\t/media/fat/_Console/NES_20231215.rbf',
        'P\tConsole\t/media/fat/_Console/SNES_20240115.rbf',
        'P\tConsole\t/media/fat/_Console/SMS_20240115.rbf',
        'P\tConsole\t/media/fat/_Console/Game Gear.mgl',
        'P\tConsole\t/media/fat/_Console/Atari 2600.mgl',
        'P\tConsole\t/media/fat/_Console/Mega Duck.mgl',
        'P\tComputer\t/media/fat/_Computer/AO486/AO486_20240115.rbf',
        'P\tComputer\t/media/fat/_Computer/Atari800_20240220.rbf',
        'P\tArcade\t/media/fat/_Arcade/Galaga_20240115.rbf',
        'P\tArcade\t/media/fat/_Arcade/Pacman_20240310.rbf',
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

      // PR-A item 1: arcade rbfs are dropped entirely from the
      // matcher output; no synthetic placeholder either.
      expect(ids).not.toContain('Galaga');
      expect(ids).not.toContain('Pacman');
      expect(cores.find((c) => c.category === 'Arcade')).toBeUndefined();

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
      // The find clause matches both extensions, both cases.
      expect(script).toMatch(/-iname '\*\.rbf'/);
      expect(script).toMatch(/-iname '\*\.mgl'/);
    });

    it('emits a shell script that prunes dot subdirs and skips _Console (autoboot)', async () => {
      // PR #11 round 3 / Bug 2: the autoboot dir holds firmware
      // shortcuts ("Sony PlayStation.mgl" etc.) that reference
      // existing cores under canonical-mismatched names. They
      // surfaced as 10 phantom rows post-Round-2 because nothing
      // in the user's games dirs canonicalised to "sonyplaystation"
      // or "nintendo64". Round 3 drops the dir from
      // MISTER_CATEGORY_DIRS so the shell never enumerates it.
      //
      // The dot-prefixed subdir prune (Round 2 / Change 1) stays:
      // `_Console/._hidden/` would otherwise leak as a phantom
      // folder-shaped core.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // One find per category dir with -mindepth 1 -maxdepth 2.
      expect(script).toMatch(/find '\/media\/fat\/_Console' -mindepth 1 -maxdepth 2/);
      expect(script).toMatch(/find '\/media\/fat\/_Computer' -mindepth 1 -maxdepth 2/);
      // The prune clause skips dot-prefixed subdirs.
      expect(script).toContain(`-type d -name '.*' -prune`);
      // Output format: one line per rbf/mgl with full path.
      expect(script).toMatch(/-printf 'P\\t.*?\\t%p\\n'/);
      // Round 3: autoboot dir is intentionally NOT enumerated.
      expect(script).not.toContain('_Console (autoboot)');
    });

    it('still emits the arcade-dir probe (PR-A item 1 dropped the placeholder, not the probe)', async () => {
      // The A sentinel is harmless leftover plumbing — the shell
      // script keeps emitting it; the matcher just ignores it now.
      // Leaving the probe in place keeps the script stable; a
      // follow-up cleanup can drop it once we're sure no other
      // consumer cares.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`if [ -d '/media/fat/_Arcade' ]; then`);
      expect(script).toContain(`printf 'A\\n'`);
    });

    it('parses the A sentinel without emitting an Arcade row (PR-A item 1)', async () => {
      // Pre-PR-A the A sentinel triggered a synthetic placeholder
      // row. PR-A dropped the placeholder; the sentinel is still
      // emitted by the shell (the probe is harmless) but the
      // matcher ignores it.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(['A', ''].join('\n')),
      );

      const cores = await client.listAllCoresWithFiles();
      expect(cores.find((c) => c.category === 'Arcade')).toBeUndefined();
    });

    it('emits a games-dir glob that picks up dot-prefixed (hidden) games dirs', async () => {
      // The shell loop enumerates BOTH visible and dot-prefixed
      // games dirs so the matcher can surface previously-hidden
      // cores like `.ATARI7800`. The glob pattern `* .[!.]*`
      // covers both buckets in one pass while still skipping
      // `.` and `..`.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toMatch(/cd '\/media\/fat\/games'\s+for d in \* \.\[!\.]\*/);
      expect(script).toContain(`printf 'G\\t%s\\n' "$d"`);
      expect(script).toContain(`printf 'GD\\t%s\\t%s\\n' "$d" "$name"`);
      expect(script).toContain(`printf 'SE\\t%s\\t%s\\tf\\t%s\\n'`);
    });

    it('emits raw F-line file paths for the recursive walk (PR #11 round 2)', async () => {
      // Pre-Round-2 the shell pre-aggregated per (top, sub) totals
      // via awk. That had no notion of system folders, so files
      // inside `Vectrex/Overlays/` were counted toward
      // recursiveRomCount even though listRoms suppressed them.
      // Round 2 emits raw F-lines and aggregates in JS with the
      // same `shouldCountAsRom` filter listRoms uses, so the two
      // paths can never disagree.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.listAllCoresWithFiles();

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;

      // One `find` over the whole games tree; emits per-file
      // lines tagged 'F\t<%P>'. JS does the filtering and
      // aggregation.
      expect(script).toMatch(
        /find '\/media\/fat\/games' -mindepth 3 -type f -printf 'F\\t%P\\n'/,
      );
      // The old awk pre-aggregation is gone.
      expect(script).not.toContain('| awk -F/');
      expect(script).not.toContain(`printf "SR\\t%s\\t%s`);
      // No per-folder forks (`sr_total=$(find …)`).
      expect(script).not.toContain('sr_total=$(find');
      expect(script).not.toContain('sr_hidden=$(find');
      // Single bulk find — counted exactly once in the recursive
      // pass.
      const findRecursive = script.match(
        /find '\/media\/fat\/games' -mindepth 3/g,
      );
      expect(findRecursive).toHaveLength(1);
    });

    it('matches the diagnostic-observed real-MiSTer shape (PR #11 round 3 regression)', async () => {
      // Mini-snapshot of the user's real MiSTer that exhibits the
      // bugs the diagnostic surfaced. After Round 2 + Round 3:
      //   - No `_hidden` synthetic core (the shell prune drops
      //     `_Console/._hidden/` from enumeration).
      //   - No duplicate row when an mgl name canonicalises to a
      //     games-dir basename — `.Atari 2600.mgl` + `Atari2600/`
      //     collapse to one row whose id is `Atari2600` (Bug 1
      //     hard invariant: id === gamesDirBasename).
      //   - Vectrex `Overlays/` filtered (shouldCountAsRom drops
      //     ancestor system folders) → recursiveRomCount = 0.
      //   - Empty orphan `games/Adam/` dropped (orphan filter).
      //   - No `_Console (autoboot)/` enumeration: autoboot is
      //     intentionally NOT in MISTER_CATEGORY_DIRS (Round 3
      //     Bug 2). The shell would not emit a P-line for it; the
      //     stdout fixture mirrors that.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      // Build a stdout that mimics the real shape.
      const lines: string[] = [
        // _Console rbfs (visible). Note: no autoboot P-line — the
        // shell does not enumerate `_Console (autoboot)/` post-Round 3.
        'P\tConsole\t/media/fat/_Console/Vectrex_20240524.rbf',
        'P\tConsole\t/media/fat/_Console/.Atari 2600.mgl',
        // Games-dir announcements
        'G\tVECTREX',
        'GD\tVECTREX\tOverlays',
        'G\tAtari2600',
        'GF\tAtari2600\tCombat.bin',
        'G\tAdam', // empty
        'A',
      ];
      // Vectrex/Overlays has 90 image files — pre-Round-2 those
      // counted; now they don't.
      for (let i = 0; i < 90; i += 1) {
        lines.push(`F\tVECTREX/Overlays/grav-bezel-${String(i)}.png`);
      }
      mocks.execCommand.mockResolvedValueOnce(execOk([...lines, ''].join('\n')));

      const cores = await client.listAllCoresWithFiles();
      const ids = cores.map((c) => c.id);

      // No phantom `_hidden` core (the shell prune killed it).
      expect(ids).not.toContain('_hidden');
      // No duplicate Atari 2600 / Atari2600 — they collapse to one
      // and the id is the on-disk games-dir basename (Bug 1).
      const atariRows = cores.filter(
        (c) => c.id.toLowerCase().replace(/[^a-z0-9]/g, '') === 'atari2600',
      );
      expect(atariRows).toHaveLength(1);
      expect(atariRows[0]?.id).toBe('Atari2600');
      // Empty orphan dropped.
      expect(ids).not.toContain('Adam');
      // Round 3 Bug 2: no autoboot phantom row. None of the
      // autoboot mgl names should surface as standalone cores.
      expect(ids).not.toContain('SEGA 32X');
      expect(ids).not.toContain('Sony PlayStation');
      expect(ids).not.toContain('Nintendo 64');
      // Vectrex's Overlays filtered → 0 ROMs (cores-list count
      // matches what listRoms would return).
      const vectrex = cores.find((c) => c.id === 'VECTREX');
      expect(vectrex?.romCount).toBe(0);
      expect(vectrex?.recursiveRomCount).toBe(0);
    });

    it('aggregates F-lines through shouldCountAsRom — Vectrex/Overlays excluded', async () => {
      // Regression: pre-Round-2, this shape contributed 90 to the
      // recursive count. The unified filter now drops every file
      // under `Overlays/` so the matcher's recursiveRomCount and
      // listRoms agree on 0.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      const fLines: string[] = [];
      for (let i = 0; i < 90; i += 1) {
        fLines.push(`F\tVECTREX/Overlays/grav-bezel-${String(i)}.png`);
      }
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'P\tConsole\t/media/fat/_Console/Vectrex_20240524.rbf',
            'G\tVECTREX',
            'GD\tVECTREX\tOverlays',
            ...fLines,
            '',
          ].join('\n'),
        ),
      );

      const cores = await client.listAllCoresWithFiles();
      // Vectrex's only top-level entry is `Overlays/`, which is a
      // system folder. shouldCountAsRom drops it at the top level
      // → romCount = 0. The orphan filter would normally drop the
      // entire core (no rbf-only path remains for the entry to
      // exist as a core), but Vectrex has the rbf, so the core
      // survives with `0` ROMs.
      const vectrex = cores.find((c) => c.id === 'VECTREX');
      expect(vectrex).toBeDefined();
      expect(vectrex?.romCount).toBe(0);
      expect(vectrex?.recursiveRomCount).toBe(0);
    });

    it('parses a case-mismatched dot-prefixed games dir as a hidden core (Round 5)', async () => {
      // Visible rbf + dot-prefixed, case-mismatched games dir
      // (Atari7800.rbf alongside .ATARI7800/). Round 5 reports it
      // as a hidden core with the dir's real romCount, no zeroing.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'R\tConsole\tfile\tAtari7800_20240423.rbf',
            'G\t.ATARI7800',
            'GF\t.ATARI7800\tleftover.bin',
            '',
          ].join('\n'),
        ),
      );

      const cores = await client.listAllCoresWithFiles();
      // PR #11 round 2: games-dir name wins as the display id.
      const atari = cores.find((c) => c.id === 'ATARI7800');
      expect(atari).toBeDefined();
      expect(atari?.gamesDirHidden).toBe(true);
      expect(atari?.gamesDirName).toBe('ATARI7800');
      expect(atari?.romCount).toBe(1);
    });

    it('threads SE/SR per-subfolder lines into recursive ROM counts (Issue 5)', async () => {
      // Real-MiSTer NEOGEO shape: 12 BIOS files at top level (filtered
      // as system) + 9 organisational subfolders (containers).
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      const subDirs = Array.from({ length: 9 }, (_, i) => `org${String(i)}`);
      const subLines: string[] = [];
      for (const sd of subDirs) {
        // Mark each subfolder as a container by listing many same-
        // extension files.
        for (let j = 0; j < 30; j += 1) {
          subLines.push(`SE\tNEOGEO\t${sd}\tf\tg${String(j)}.zip`);
        }
        // SR tells the matcher the recursive total (cheap on the
        // device — `find -type f | wc -l`).
        subLines.push(`SR\tNEOGEO\t${sd}\t30\t0`);
      }
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'R\tConsole\tfile\tNEOGEO_20250909.rbf',
            'G\tNEOGEO',
            'GF\tNEOGEO\tboot.rom',
            'GF\tNEOGEO\tsfix.sfix',
            ...subDirs.map((sd) => `GD\tNEOGEO\t${sd}`),
            ...subLines,
            '',
          ].join('\n'),
        ),
      );

      const cores = await client.listAllCoresWithFiles();
      const neo = cores.find((c) => c.id === 'NEOGEO');
      expect(neo?.romCount).toBe(9);
      expect(neo?.recursiveRomCount).toBe(270);
    });
  });

  describe('listRoms', () => {
    it('targets the games-dir basename via the coreId argument (PR #11 round 3 / Bug 1)', async () => {
      // The matcher's invariant guarantees CoreEntry.id === on-disk
      // basename when a games dir exists. listRoms uses that id
      // directly to build `/media/fat/games/<id>/`. This test pins
      // the contract: callers can pass the matcher-supplied id and
      // get the right path, even when the original mgl/rbf prefix
      // had spaces or punctuation that canonicalize away.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      // The matcher would have collapsed `.Atari 2600.mgl` and
      // `games/Atari2600/` into one CoreEntry with id="Atari2600".
      // Calling listRoms with that id must hit /media/fat/games/Atari2600/.
      await client.listRoms('Atari2600');

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // Round 4: the existence check + find both target the
      // games-dir path. The script no longer cd's first.
      expect(script).toContain(`[ -d '/media/fat/games/Atari2600' ]`);
      expect(script).toContain(`find '/media/fat/games/Atari2600'`);
      // And critically — it does NOT target the rbf-prefix variant.
      expect(script).not.toContain('Atari 2600');
    });

    it('parses raw find output into Rom entries with classified folders (PR #11 round 4)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // Round 4: shell emits raw `<type>\t<%P>\t<size>` lines from
      // a single find. JS aggregates by top-level segment and runs
      // `classifyFolder` over the direct-child files+dirs.
      //
      // This fixture covers:
      //   - top-level files (NES roms + a .zip)
      //   - a Saturn-shape disc folder (.cue+.bin → folder-atomic)
      //   - a hidden folder (dot-prefix preserved as `hidden`)
      //   - a NEOGEO-shape container (5+ .zip carts → many-same →
      //     folder-container post-round-5)
      //   - depth-3 size contributions (the 1.7GB track in Panzer
      //     Dragoon adds to the parent folder's total)
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            // Top-level files at depth 1.
            'f\t.Action 52 (USA) (Unl).nes\t131072',
            'f\tCastlevania (USA, Europe).nes\t131072',
            'f\tCastlevania.zip\t40960',
            // Saturn-shape disc folder.
            'd\tPanzer Dragoon Saga (USA)\t0',
            'f\tPanzer Dragoon Saga (USA)/PDS.cue\t512',
            'f\tPanzer Dragoon Saga (USA)/PDS (Track 01).bin\t1958295040',
            // Hidden disc folder.
            'd\t.Hidden Disc Game\t0',
            'f\t.Hidden Disc Game/HDG.cue\t512',
            'f\t.Hidden Disc Game/HDG.bin\t125828608',
            // NEOGEO-shape container: 6 .zip files of one extension
            // trip the many-same rule. Round 5: cart-ext alone
            // classifies atomic, so a NEOGEO-shape needs the count
            // signal to flip to container.
            'd\t1 World A-Z\t0',
            'f\t1 World A-Z/mslug.zip\t10485760',
            'f\t1 World A-Z/kof97.zip\t10485760',
            'f\t1 World A-Z/samsho.zip\t10485760',
            'f\t1 World A-Z/lastblade2.zip\t10485760',
            'f\t1 World A-Z/garou.zip\t5242880',
            'f\t1 World A-Z/mslug3.zip\t5242880',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('NES');

      expect(roms).toHaveLength(6);

      const hiddenFile = roms.find((r) => r.filename === '.Action 52 (USA) (Unl).nes');
      expect(hiddenFile?.kind).toBe('file');
      expect(hiddenFile?.hidden).toBe(true);
      // Round 11: `.nes` is now stripped at display time.
      expect(hiddenFile?.displayName).toBe('Action 52 (USA) (Unl)');
      expect(hiddenFile?.sizeBytes).toBe(131072);

      const visibleFile = roms.find((r) => r.filename === 'Castlevania (USA, Europe).nes');
      expect(visibleFile?.kind).toBe('file');
      expect(visibleFile?.hidden).toBe(false);

      // Round 8: archive extension stripped at display time.
      const archived = roms.find((r) => r.filename === 'Castlevania.zip');
      expect(archived?.displayName).toBe('Castlevania');

      const discFolder = roms.find((r) => r.filename === 'Panzer Dragoon Saga (USA)');
      expect(discFolder?.kind).toBe('folder-atomic');
      expect(discFolder?.hidden).toBe(false);
      // Folder size is the sum of all descendant file sizes.
      expect(discFolder?.sizeBytes).toBe(1958295552);
      expect(discFolder?.path).toBe('/media/fat/games/NES/Panzer Dragoon Saga (USA)');

      const hiddenFolder = roms.find((r) => r.filename === '.Hidden Disc Game');
      expect(hiddenFolder?.kind).toBe('folder-atomic');
      expect(hiddenFolder?.hidden).toBe(true);
      expect(hiddenFolder?.displayName).toBe('Hidden Disc Game');

      const containerFolder = roms.find((r) => r.filename === '1 World A-Z');
      expect(containerFolder?.kind).toBe('folder-container');
      expect(containerFolder?.sizeBytes).toBe(52428800);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // Round 4: existence check + single find with -printf.
      expect(script).toContain(`[ -d '/media/fat/games/NES' ]`);
      expect(script).toContain(
        `find '/media/fat/games/NES' -mindepth 1 -maxdepth 3 -printf '%y\\t%P\\t%s\\n'`,
      );
      // Classification flag plumbing (has_disc / has_cart / etc.) is
      // gone — `classifyFolder` runs in JS now.
      expect(script).not.toContain('has_disc');
      expect(script).not.toContain('du -sb');
    });

    it('classifies a folder via the hasManySameExtension long-tail rule (Round 9 / Round 4 reroute)', async () => {
      // Round 9: even when no recognised cart extension is present,
      // a folder with 5+ files of one extension is treated as
      // drillable. Round 4 moved this check into `classifyFolder`,
      // fed by the raw direct-child filenames the find pass emits.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'd\tFutureFormat Collection\t0',
            // Five files sharing `.fmt` — none of these are in the
            // CART_EXTENSIONS list, so only the long-tail rule can
            // flip the classification.
            'f\tFutureFormat Collection/a.fmt\t1024',
            'f\tFutureFormat Collection/b.fmt\t1024',
            'f\tFutureFormat Collection/c.fmt\t1024',
            'f\tFutureFormat Collection/d.fmt\t1024',
            'f\tFutureFormat Collection/e.fmt\t1024',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('FuturePastel');
      expect(roms[0]?.kind).toBe('folder-container');
    });

    it('lists ROMs at a sub-path when drilled into a container', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'f\tmslug.zip\t1024',
            'f\tkof97.zip\t2048',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('NEOGEO', '1 World A-Z');

      expect(roms.map((r) => r.filename)).toEqual(['kof97.zip', 'mslug.zip']);
      // Display names strip the archive extension.
      expect(roms.find((r) => r.filename === 'mslug.zip')?.displayName).toBe('mslug');
      expect(roms[0]?.relativePath).toBe('1 World A-Z/kof97.zip');
      expect(roms[0]?.path).toBe('/media/fat/games/NEOGEO/1 World A-Z/kof97.zip');

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`find '/media/fat/games/NEOGEO/1 World A-Z'`);
    });

    it('rejects subPaths that try to climb out of the core dir', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      await expect(client.listRoms('NEOGEO', '../etc')).rejects.toThrow(
        /Invalid subPath/,
      );
      await expect(client.listRoms('NEOGEO', 'foo/..')).rejects.toThrow(
        /Invalid subPath/,
      );
      await expect(client.listRoms('NEOGEO', '/abs')).rejects.toThrow(
        /Invalid subPath/,
      );
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('throws "Unknown core" when the core directory is missing', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(execFail(1, 'No such file or directory'));

      await expect(client.listRoms('TurboGrafx')).rejects.toThrow(/Unknown core/);
    });

    it('returns [] for an empty core directory', async () => {
      // The find pass emits no lines when the dir is empty. The
      // existence check passes (`[ -d ... ]` is true), so we get
      // exit code 0 with empty stdout.
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      const roms = await client.listRoms('Empty');
      expect(roms).toEqual([]);
    });

    it('handles X68000 shape — 600 single-game folders — within the fork budget and classifies atomic (PR #11 round 4 / round 5)', async () => {
      // Live test: clicking X68000 (649 folders, 2018 files) hung
      // for 10s and timed out pre-Round-4 because the per-folder
      // shell loop ran ~1300 subprocess invocations on busybox.
      // Round 4 collapses the script to one find. Round 5 fixes the
      // classification so each folder reads as one game (atomic),
      // not a drillable container — the user complained that
      // clicking a folder produced a useless extra step into a
      // single .zip file.
      //
      // This regression pins:
      //   - fork budget (1 invocation)
      //   - all 600 folders classify atomic (real X68000 shape:
      //     `<game>/<game>.zip` with optional companion files,
      //     no subdirs)
      //   - per-folder size sum across the file payload
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const lines: string[] = [];
      const folderCount = 600;
      for (let i = 0; i < folderCount; i += 1) {
        const folder = `Game ${String(i).padStart(3, '0')}`;
        // Top-level folder.
        lines.push(`d\t${folder}\t0`);
        // Folder ROM payload: one .zip + occasionally a manual or
        // readme companion. NO subdirs — that's the real X68000
        // shape.
        lines.push(`f\t${folder}/${folder}.zip\t40960`);
        if (i % 3 === 0) {
          lines.push(`f\t${folder}/manual.txt\t8192`);
        }
        if (i % 7 === 0) {
          lines.push(`f\t${folder}/readme.md\t2048`);
        }
      }
      lines.push('');
      mocks.execCommand.mockResolvedValueOnce(execOk(lines.join('\n')));

      const roms = await client.listRoms('X68000');

      // All 600 folders surface as Rom entries.
      expect(roms).toHaveLength(folderCount);
      // PR #11 round 5: every X68000 folder classifies atomic. The
      // cart-ext rule fires in classifyFolder, no subdirs / no
      // many-same to flip the call.
      const atomics = roms.filter((r) => r.kind === 'folder-atomic');
      expect(atomics).toHaveLength(folderCount);
      // None classify as containers — drilling into an X68000
      // folder shows nothing the cores list doesn't already say.
      const containers = roms.filter((r) => r.kind === 'folder-container');
      expect(containers).toHaveLength(0);
      // Folder size sums every descendant file. Game 000 has the
      // .zip, the manual (i % 3 === 0), and the readme (i % 7 === 0).
      const game000 = roms.find((r) => r.filename === 'Game 000');
      expect(game000?.sizeBytes).toBe(40960 + 8192 + 2048);

      // Fork budget: at most one execCommand call per listRoms.
      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      // The script body must invoke `find` at most once. Anything
      // more (e.g. the pre-Round-4 per-folder `du -sb` loop) blows
      // the 10s SSH op budget on busybox.
      const findInvocations = script.match(/(^|\s)find\s/g) ?? [];
      expect(findInvocations.length).toBe(1);
      // No du / awk / per-folder loops survive Round 4.
      expect(script).not.toContain('du -sb');
      expect(script).not.toContain('for d in');
      expect(script).not.toContain('uniq -c');
    });

    it('classifies Saturn / MegaCD folders as atomic from disc markers', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            // .cue + .bin shape (Saturn).
            'd\tNights into Dreams (USA)\t0',
            'f\tNights into Dreams (USA)/nid.cue\t512',
            'f\tNights into Dreams (USA)/nid (Track 01).bin\t748314624',
            // .iso shape (single-track CD-ROM).
            'd\tDaytona USA (USA)\t0',
            'f\tDaytona USA (USA)/daytona.iso\t536870912',
            // Multi-track without .cue (track filename pattern).
            'd\tBurning Rangers (USA)\t0',
            'f\tBurning Rangers (USA)/Track 01.bin\t536870912',
            'f\tBurning Rangers (USA)/Track 02.bin\t536870912',
            // .gdi (Dreamcast).
            'd\tShenmue (USA)\t0',
            'f\tShenmue (USA)/shenmue.gdi\t512',
            'f\tShenmue (USA)/shenmue.bin\t748314624',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('Saturn');

      const cue = roms.find((r) => r.filename === 'Nights into Dreams (USA)');
      expect(cue?.kind).toBe('folder-atomic');
      const iso = roms.find((r) => r.filename === 'Daytona USA (USA)');
      expect(iso?.kind).toBe('folder-atomic');
      const trackOnly = roms.find((r) => r.filename === 'Burning Rangers (USA)');
      // No .cue, but track-pattern filenames trip the atomic rule.
      expect(trackOnly?.kind).toBe('folder-atomic');
      const gdi = roms.find((r) => r.filename === 'Shenmue (USA)');
      expect(gdi?.kind).toBe('folder-atomic');
    });

    it('preserves both top-level files and folders in a mixed games dir', async () => {
      // Some cores' games dirs hold both bare-file ROMs and folder
      // ROMs side by side (e.g. a NES core where most ROMs are flat
      // .nes files but a few games are stored in folders for
      // overlays/companion files).
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'f\tFlat ROM 1.nes\t40960',
            'f\tFlat ROM 2.nes\t40960',
            'd\tFolder ROM\t0',
            'f\tFolder ROM/main.nes\t40960',
            'f\tFolder ROM/cover.png\t8192',
            '',
          ].join('\n'),
        ),
      );

      const roms = await client.listRoms('Mixed');
      expect(roms).toHaveLength(3);
      const files = roms.filter((r) => r.kind === 'file');
      expect(files).toHaveLength(2);
      const folders = roms.filter((r) => r.kind.startsWith('folder-'));
      expect(folders).toHaveLength(1);
      expect(folders[0]?.sizeBytes).toBe(40960 + 8192);
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

    /**
     * Replays a stream of PROGRESS lines through the `onStdout` callback
     * the client passes to `ssh.exec`. Mirrors how a real SSH channel
     * delivers data: the test can split the stream into arbitrary chunk
     * boundaries to exercise the line-buffering parser.
     */
    function makeStreamingExec(
      chunks: readonly (Buffer | string)[],
    ): (
      command: string,
      params: readonly string[],
      options: {
        onStdout?: (chunk: Buffer) => void;
        stream?: 'stdout' | 'stderr' | 'both';
      },
    ) => Promise<string> {
      return async (_command, _params, options) => {
        for (const c of chunks) {
          options.onStdout?.(typeof c === 'string' ? Buffer.from(c) : c);
        }
        return '';
      };
    }

    it('runs a 5-core batch in exactly one ssh.exec call with a per-core subshell', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
      mocks.exec.mockImplementationOnce(
        makeStreamingExec([
          ['NES', 'SNES', 'Genesis', 'Atari800', 'SMS']
            .map(
              (id, i) => `PROGRESS\t${String(i + 1)}\t5\t${id}\n`,
            )
            .join(''),
        ]),
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

      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toEqual(['NES', 'SNES', 'Genesis', 'Atari800', 'SMS']);
      expect(result.failed).toEqual([]);

      const script = mocks.exec.mock.calls[0]?.[0] as string;
      // 3 games dirs (NES, SNES, Genesis) + 5 rbfs = 8 mv commands woven
      // through five `(set -e ...)` per-core subshells.
      const mvCount = (script.match(/mv '/g) ?? []).length;
      expect(mvCount).toBe(8);
      const subshellCount = (script.match(/\(set -e/g) ?? []).length;
      expect(subshellCount).toBe(5);
      // Each core line emits PROGRESS / PROGRESS_FAIL — never the old
      // OK/FAIL shape.
      expect(script).toMatch(/printf 'PROGRESS\\t/);
      expect(script).toMatch(/printf 'PROGRESS_FAIL\\t/);
      expect(script).not.toMatch(/printf 'OK\\t/);
    });

    it('returns a partial-success result when one core fails mid-batch', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
      mocks.exec.mockImplementationOnce(
        makeStreamingExec([
          'PROGRESS\t1\t3\tNES\n',
          'PROGRESS_FAIL\t2\t3\tSNES\tmv: cannot stat SNES\n',
          'PROGRESS\t3\t3\tGenesis\n',
        ]),
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

      expect(mocks.exec).toHaveBeenCalledTimes(1);
      expect(result.succeeded).toEqual(['NES', 'Genesis']);
      expect(result.failed).toEqual([
        { coreId: 'SNES', reason: 'mv: cannot stat SNES' },
      ]);
    });

    it('emits a progress event per parseable line in stream order', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
      // Split chunk on a non-line boundary to exercise the line-buffer
      // logic — partial line "PROGRESS\t1\t" + rest in next chunk.
      mocks.exec.mockImplementationOnce(
        makeStreamingExec([
          'PROGRESS\t1\t',
          '3\tNES\nPROGRESS_FAIL\t2\t3\tSNES\twoops\n',
          'PROGRESS\t3\t3\tGenesis\n',
        ]),
      );

      const events: { done: number; total: number; coreId: string; result: string }[] = [];
      await client.setBulkCoreVisibility(
        ['NES', 'SNES', 'Genesis'].map((id) => ({
          core: makeCore({
            id,
            rbfPaths: [`/media/fat/_Console/${id}_20240115.rbf`],
            gamesDirExists: true,
          }),
          hidden: true,
        })),
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

      expect(events).toEqual([
        { done: 1, total: 3, coreId: 'NES', result: 'ok' },
        { done: 2, total: 3, coreId: 'SNES', result: 'fail' },
        { done: 3, total: 3, coreId: 'Genesis', result: 'ok' },
      ]);
    });

    it('flushes a trailing partial line that arrives without a newline', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
      mocks.exec.mockImplementationOnce(
        // No trailing newline — defensive against shells that drop it.
        makeStreamingExec(['PROGRESS\t1\t1\tNES']),
      );

      const result = await client.setBulkCoreVisibility([
        {
          core: makeCore({
            id: 'NES',
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            gamesDirExists: true,
          }),
          hidden: true,
        },
      ]);

      expect(result.succeeded).toEqual(['NES']);
    });

    it('ignores malformed progress lines silently', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
      mocks.exec.mockImplementationOnce(
        makeStreamingExec([
          'something irrelevant\n',
          'PROGRESS\tnotanumber\t1\tNES\n',
          'PROGRESS_FAIL\t1\t1\n', // missing fields
          'PROGRESS\t1\t1\tNES\n',
        ]),
      );

      const events: unknown[] = [];
      const result = await client.setBulkCoreVisibility(
        [
          {
            core: makeCore({
              id: 'NES',
              rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
              gamesDirExists: true,
            }),
            hidden: true,
          },
        ],
        { onProgress: (e) => events.push(e) },
      );

      expect(result.succeeded).toEqual(['NES']);
      expect(events).toHaveLength(1);
    });

    it('issues zero SSH calls when every change is a no-op', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();
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

      expect(mocks.exec).not.toHaveBeenCalled();
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('refuses if any change targets an arcade core', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.exec.mockClear();

      await expect(
        client.setBulkCoreVisibility([
          {
            core: makeCore({ id: 'Galaga', category: 'Arcade' }),
            hidden: true,
          },
        ]),
      ).rejects.toThrow(/Arcade/);
      expect(mocks.exec).not.toHaveBeenCalled();
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

  describe('readSystemFilesMarks / addSystemFileMark / removeSystemFileMark', () => {
    it('readSystemFilesMarks tolerates a missing file', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      const marks = await client.readSystemFilesMarks();
      expect(marks).toEqual({ schemaVersion: 1, marked: [] });

      const command = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(command).toContain(`cat '/media/fat/.mistercurator/system-files.json'`);
      expect(command).toContain('|| true');
    });

    it('readSystemFilesMarks parses a populated marks file', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const json = JSON.stringify({
        schemaVersion: 1,
        marked: [
          {
            coreId: 'C64',
            filename: 'DolphinDOS_2.0.rom',
            markedAt: '2026-05-02T12:00:00Z',
          },
        ],
      });
      mocks.execCommand.mockResolvedValueOnce(execOk(json));

      const marks = await client.readSystemFilesMarks();
      expect(marks.marked).toHaveLength(1);
      expect(marks.marked[0]?.coreId).toBe('C64');
    });

    it('addSystemFileMark reads, mutates, and writes via heredoc', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // First call: read existing marks (empty).
      mocks.execCommand.mockResolvedValueOnce(execOk(''));
      // Second call: write the mutated marks.
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.addSystemFileMark('C64', 'DolphinDOS_2.0.rom');

      expect(mocks.execCommand).toHaveBeenCalledTimes(2);
      const writeScript = mocks.execCommand.mock.calls[1]?.[0] as string;
      expect(writeScript).toContain(`mkdir -p '/media/fat/.mistercurator'`);
      expect(writeScript).toContain(`<<'MISTERCURATOR_SYSTEM_FILES_EOF'`);
      expect(writeScript).toContain('"coreId": "C64"');
      expect(writeScript).toContain('"filename": "DolphinDOS_2.0.rom"');
      expect(writeScript).toContain(
        `mv '/media/fat/.mistercurator/system-files.json.tmp' '/media/fat/.mistercurator/system-files.json'`,
      );
    });

    it('addSystemFileMark issues only one read when the mark already exists', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const existing = JSON.stringify({
        schemaVersion: 1,
        marked: [
          {
            coreId: 'C64',
            filename: 'DolphinDOS_2.0.rom',
            markedAt: '2026-05-02T12:00:00Z',
          },
        ],
      });
      mocks.execCommand.mockResolvedValueOnce(execOk(existing));

      await client.addSystemFileMark('C64', 'DolphinDOS_2.0.rom');

      // Only the read; no write because withMark is idempotent.
      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
    });

    it('removeSystemFileMark drops the entry and rewrites the file', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const existing = JSON.stringify({
        schemaVersion: 1,
        marked: [
          {
            coreId: 'C64',
            filename: 'DolphinDOS_2.0.rom',
            markedAt: '2026-05-02T12:00:00Z',
          },
        ],
      });
      mocks.execCommand.mockResolvedValueOnce(execOk(existing));
      mocks.execCommand.mockResolvedValueOnce(execOk(''));

      await client.removeSystemFileMark('C64', 'DolphinDOS_2.0.rom');

      expect(mocks.execCommand).toHaveBeenCalledTimes(2);
      const writeScript = mocks.execCommand.mock.calls[1]?.[0] as string;
      // The rewrite no longer contains the entry.
      expect(writeScript).not.toContain('DolphinDOS_2.0.rom');
    });

    it('removeSystemFileMark issues only one read when the entry is absent', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(execOk(''));
      await client.removeSystemFileMark('C64', 'never_marked.rom');

      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
    });
  });

  describe('per-op timeout (round 2)', () => {
    // PR #20 round 3 raised the default per-op timeout 10s → 60s
    // and added a separate 120s cap for hash commands. Tests below
    // walk past 60s by default; the hash-specific test walks past
    // 120s. Tests use fake timers so wall time stays trivial.

    /**
     * Helper: makes the next `ssh.execCommand` call hang forever.
     * The runSshOp wrapper should fire its 60 s timeout and bail out.
     */
    function hangOnce(): void {
      mocks.execCommand.mockImplementationOnce(
        () =>
          new Promise(() => {
            /* never resolves */
          }),
      );
    }

    it('rejects with a typed MisterConnectionError after 60 s of silence (round 3)', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        hangOnce();

        const promise = client.listRoms('NES').catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(60_001);
        const result = await promise;

        expect(result).toBeInstanceOf(MisterConnectionError);
        if (result instanceof MisterConnectionError) {
          expect(result.code).toBe('unknown');
          expect(result.message).toMatch(/no reply within 60s/);
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('triggers the unexpected-disconnect handler so the manager kicks off auto-retry', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);

        hangOnce();
        const promise = client.listRoms('NES').catch(() => undefined);
        await vi.advanceTimersByTimeAsync(60_001);
        await promise;

        expect(listener).toHaveBeenCalledTimes(1);
        // Same dispose path as a real socket close so subsequent
        // calls fail fast rather than queueing on the dead socket.
        expect(mocks.dispose).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does NOT fire the timeout when the operation completes promptly', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);

        // listRoms uses execCommand; the default mock resolves
        // immediately. We then walk past the 60s window to confirm
        // the dangling timer has been cleared.
        await client.listRoms('NES');
        await vi.advanceTimersByTimeAsync(65_000);

        expect(listener).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('hashPaths uses the higher 120s timeout AND preserves the SSH session on timeout (round 3 + round 5)', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);
        // Hang the hash command forever.
        mocks.execCommand.mockImplementationOnce(
          () =>
            new Promise(() => {
              /* never resolves */
            }),
        );

        const promise = client
          .hashPaths(['/media/fat/games/NES/foo.nes'])
          .catch((err: unknown) => err);

        // 60s shouldn't trip the hash-specific timeout.
        await vi.advanceTimersByTimeAsync(60_001);
        expect(listener).not.toHaveBeenCalled();

        // 120s does.
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await promise;

        expect(result).toBeInstanceOf(MisterConnectionError);
        if (result instanceof MisterConnectionError) {
          // Round 5 — hash-timeout uses the "session preserved"
          // message because `runSshOp(..., disposeOnTimeout: false)`
          // doesn't tear down the transport. A single multi-GB ROM
          // exceeding 120s only fails its own row; the orchestrator
          // catches and emits per-path error.
          expect(result.message).toMatch(
            /Command timed out after 120s; SSH session preserved\./,
          );
        }
        // Round 5 — unexpected-disconnect listener does NOT fire on
        // a hash timeout, because the SSH transport stays alive.
        expect(listener).not.toHaveBeenCalled();
        expect(mocks.dispose).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('disposeOnTimeout: true (default) still tears down on a non-hash timeout', async () => {
      // Confirms round-5 behavior didn't accidentally weaken the
      // default. listRoms uses the default-timeout path.
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);
        mocks.execCommand.mockImplementationOnce(
          () =>
            new Promise(() => {
              /* never resolves */
            }),
        );

        const promise = client.listRoms('NES').catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(60_001);
        const result = await promise;

        expect(result).toBeInstanceOf(MisterConnectionError);
        if (result instanceof MisterConnectionError) {
          expect(result.message).toMatch(/no reply within 60s/);
        }
        expect(listener).toHaveBeenCalledTimes(1);
        expect(mocks.dispose).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('streaming bulk exec keeps the timeout reset while progress flows', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);

        // The streaming exec resolves only after we manually push a
        // `chunk` through `onStdout`. Each chunk arrival should bump
        // the deadline forward so a slow-but-progressing batch
        // never trips the timeout. Using mutable holders so TS can't
        // narrow the assigned values to `never` inside the closure.
        const streamResolveHolder: { current: (() => void) | null } = {
          current: null,
        };
        const onStdoutHolder: { current: ((c: Buffer) => void) | null } = {
          current: null,
        };
        mocks.exec.mockImplementationOnce(
          (
            _cmd: string,
            _params: readonly string[],
            options: { onStdout?: (c: Buffer) => void },
          ) =>
            new Promise<string>((resolve) => {
              onStdoutHolder.current = options.onStdout ?? null;
              streamResolveHolder.current = () => resolve('');
            }),
        );

        const cores = [
          {
            id: 'NES',
            name: 'NES',
            romCount: 1,
            hiddenCount: 0,
            category: 'Console',
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            gamesDirExists: true,
            gamesDirHidden: false,
          },
        ];
        const bulkPromise = client
          .setBulkCoreVisibility(
            cores.map((core) => ({ core: core as never, hidden: true })),
          )
          .catch((err: unknown) => err);

        // 50s in, push a progress chunk; deadline resets.
        await vi.advanceTimersByTimeAsync(50_000);
        onStdoutHolder.current?.(Buffer.from('PROGRESS\t1\t1\tNES\n'));
        // Another 50s — would have fired without the touch().
        await vi.advanceTimersByTimeAsync(50_000);
        // Resolve cleanly.
        streamResolveHolder.current?.();
        await vi.advanceTimersByTimeAsync(0);
        const result = await bulkPromise;

        expect(listener).not.toHaveBeenCalled();
        expect(result).toMatchObject({ succeeded: ['NES'] });
      } finally {
        vi.useRealTimers();
      }
    });

    it('streaming bulk exec fires the timeout after 60s with no chunks (round 3)', async () => {
      vi.useFakeTimers();
      const client = new RealMisterClient();
      try {
        await client.connect(profile, secret);
        const listener = vi.fn();
        client.onUnexpectedDisconnect(listener);

        mocks.exec.mockImplementationOnce(
          () =>
            new Promise(() => {
              /* never resolves, never produces chunks */
            }),
        );

        const cores = [
          {
            id: 'NES',
            name: 'NES',
            romCount: 1,
            hiddenCount: 0,
            category: 'Console',
            rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
            gamesDirExists: true,
            gamesDirHidden: false,
          },
        ];
        const promise = client
          .setBulkCoreVisibility(
            cores.map((core) => ({ core: core as never, hidden: true })),
          )
          .catch((err: unknown) => err);
        await vi.advanceTimersByTimeAsync(60_001);
        const result = await promise;

        expect(result).toBeInstanceOf(MisterConnectionError);
        expect(listener).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('primeConnect / statWitnesses (PR #12 cache layer)', () => {
    function buildPrimeStdout(args: {
      readonly ledger?: string;
      readonly marks?: string;
      readonly classifications?: string;
      readonly witnesses: readonly { readonly path: string; readonly mtime: number }[];
    }): string {
      const enc = (s: string): string =>
        s === '' ? '' : Buffer.from(s, 'utf-8').toString('base64');
      const lines = [
        'LEDGER',
        enc(args.ledger ?? ''),
        'MARKS',
        enc(args.marks ?? ''),
        'CLASSIFICATIONS',
        enc(args.classifications ?? ''),
        'WITNESSES',
        ...args.witnesses.map((w) => `${String(w.mtime)} ${w.path}`),
        'END',
        '',
      ];
      return lines.join('\n');
    }

    it('primeConnect issues exactly one execCommand and parses ledger / marks / witnesses', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          buildPrimeStdout({
            ledger: '{"schemaVersion":1,"hiddenCores":[]}',
            marks: '{"schemaVersion":1,"marked":[]}',
            classifications: '{"schemaVersion":1,"overrides":[]}',
            witnesses: [
              { path: '/media/fat/_Console', mtime: 1700000001 },
              { path: '/media/fat/games', mtime: 1700000010 },
            ],
          }),
        ),
      );

      const result = await client.primeConnect([
        '/media/fat/_Console',
        '/media/fat/games',
      ]);

      // PR #12 perf contract: prime is one round trip — that's the
      // whole point of merging ledger + marks + classifications +
      // witnesses into a single shell. Bumping this number means
      // we've regressed warm connect time on slow links.
      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result.ledger.hiddenCores).toEqual([]);
      expect(result.marks.marked).toEqual([]);
      expect(result.classifications.overrides).toEqual([]);
      expect(result.witnesses['/media/fat/_Console']).toBe(1700000001);
      expect(result.witnesses['/media/fat/games']).toBe(1700000010);
      // The script body: contains the section labels and the witness
      // stat command. Defensive — guards against a future refactor
      // accidentally splitting prime into multiple round trips.
      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain(`echo 'LEDGER'`);
      expect(script).toContain(`echo 'MARKS'`);
      expect(script).toContain(`echo 'CLASSIFICATIONS'`);
      expect(script).toContain(`echo 'WITNESSES'`);
      expect(script).toContain(`stat -c '%Y %n'`);
    });

    it('statWitnesses issues exactly one execCommand and parses the WITNESSES block', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            'WITNESSES',
            '1700000005 /media/fat/games/X68000',
            'END',
            '',
          ].join('\n'),
        ),
      );

      const result = await client.statWitnesses(['/media/fat/games/X68000']);

      // The cache layer's listRoms validation hot path: must be 1
      // SSH op per cache check. Anything more would defeat the
      // <500ms warm-connect goal on cores like X68000.
      expect(mocks.execCommand).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ '/media/fat/games/X68000': 1700000005 });
    });

    it('statWitnesses returns empty without calling SSH when given an empty path list', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      const result = await client.statWitnesses([]);
      expect(result).toEqual({});
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('primeConnect throws when the prime output is truncated (treated by caller as cache miss)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      // Missing END marker — likely truncation on a flaky link.
      mocks.execCommand.mockResolvedValueOnce(
        execOk('LEDGER\n\nMARKS\n\nCLASSIFICATIONS\n\nWITNESSES\n'),
      );

      await expect(
        client.primeConnect(['/media/fat/games']),
      ).rejects.toThrow(/expected shape/);
    });

    it('primeConnect records mtime 0 for paths the device has lost (cache treats as mismatch)', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();

      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          buildPrimeStdout({
            witnesses: [
              { path: '/media/fat/_Vanished', mtime: 0 },
              { path: '/media/fat/games', mtime: 1700000010 },
            ],
          }),
        ),
      );

      const result = await client.primeConnect([
        '/media/fat/_Vanished',
        '/media/fat/games',
      ]);
      expect(result.witnesses['/media/fat/_Vanished']).toBe(0);
      expect(result.witnesses['/media/fat/games']).toBe(1700000010);
    });
  });

  describe('hashPaths (PR #16 round 2 — md5 + sha1 + size)', () => {
    it('shell-quotes paths into a `set --` script and parses the 5-tab result', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      const md5a = 'a'.repeat(32);
      const md5b = 'b'.repeat(32);
      const sha1a = 'c'.repeat(40);
      const sha1b = 'd'.repeat(40);
      mocks.execCommand.mockResolvedValueOnce(
        execOk(
          [
            `/media/fat/games/SNES/SMW.sfc\t${md5a}\t${sha1a}\t524288\t1700000000`,
            `/media/fat/games/SNES/Sonic.sfc\t${md5b}\t${sha1b}\t1048576\t1700000100`,
          ].join('\n') + '\n',
        ),
      );
      const result = await client.hashPaths([
        '/media/fat/games/SNES/SMW.sfc',
        '/media/fat/games/SNES/Sonic.sfc',
      ]);
      expect(result).toHaveLength(2);
      expect(result[0]?.md5).toBe(md5a);
      expect(result[0]?.sha1).toBe(sha1a);
      expect(result[0]?.size).toBe(524288);
      expect(result[1]?.mtime).toBe(1700000100);

      const script = mocks.execCommand.mock.calls[0]?.[0] as string;
      expect(script).toContain("set -- '/media/fat/games/SNES/SMW.sfc'");
      expect(script).toContain('for f in "$@"');
      // Sanity: the script computes both algorithms.
      expect(script).toContain('md5sum');
      expect(script).toContain('sha1sum');
    });

    it('returns [] for empty input without making an SSH call', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockClear();
      const result = await client.hashPaths([]);
      expect(result).toEqual([]);
      expect(mocks.execCommand).not.toHaveBeenCalled();
    });

    it('throws on non-zero exit so the caller can route to "couldn\'t hash"', async () => {
      const client = new RealMisterClient();
      await client.connect(profile, secret);
      mocks.execCommand.mockResolvedValueOnce(execFail(2, 'shell broke'));
      await expect(client.hashPaths(['/x'])).rejects.toThrow(
        /Failed to hash paths/,
      );
    });
  });
});
