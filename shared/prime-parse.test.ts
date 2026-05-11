import { describe, expect, it } from 'vitest';

import {
  buildPrimeScript,
  buildSizeAndMtimeScript,
  buildWitnessScript,
  parsePrimeOutput,
  parseSizeAndMtimeOutput,
  parseWitnessOutput,
} from '@shared/prime-parse';

describe('parsePrimeOutput', () => {
  it('decodes a populated prime payload (all three files + 5 witnesses)', () => {
    const ledgerJson = '{"schemaVersion":1,"hiddenCores":[]}';
    const marksJson = '{"schemaVersion":1,"marked":[]}';
    const classificationsJson = '{"schemaVersion":1,"overrides":[]}';
    const stdout = [
      'LEDGER',
      Buffer.from(ledgerJson, 'utf-8').toString('base64'),
      'MARKS',
      Buffer.from(marksJson, 'utf-8').toString('base64'),
      'CLASSIFICATIONS',
      Buffer.from(classificationsJson, 'utf-8').toString('base64'),
      'WITNESSES',
      '1700000001 /media/fat/_Console',
      '1700000002 /media/fat/_Computer',
      '1700000003 /media/fat/_Other',
      '1700000004 /media/fat/_Utility',
      '1700000010 /media/fat/games',
      'END',
      '',
    ].join('\n');

    const out = parsePrimeOutput(stdout);
    expect(out).not.toBeNull();
    expect(out?.ledgerJson).toBe(ledgerJson);
    expect(out?.marksJson).toBe(marksJson);
    expect(out?.classificationsJson).toBe(classificationsJson);
    expect(out?.witnesses).toEqual({
      '/media/fat/_Console': 1700000001,
      '/media/fat/_Computer': 1700000002,
      '/media/fat/_Other': 1700000003,
      '/media/fat/_Utility': 1700000004,
      '/media/fat/games': 1700000010,
    });
  });

  it('emits empty strings for missing files (cold device, no agent state yet)', () => {
    const stdout = [
      'LEDGER',
      '',
      'MARKS',
      '',
      'CLASSIFICATIONS',
      '',
      'WITNESSES',
      '1700000000 /media/fat/_Console',
      'END',
      '',
    ].join('\n');

    const out = parsePrimeOutput(stdout);
    expect(out?.ledgerJson).toBe('');
    expect(out?.marksJson).toBe('');
    expect(out?.classificationsJson).toBe('');
    expect(out?.witnesses).toEqual({ '/media/fat/_Console': 1700000000 });
  });

  it('a path emitted with `0 <path>` (missing on device) records mtime=0', () => {
    // The shell uses `0 <path>` when stat fails — caller treats this
    // as a witness mismatch via `witnessesMatch` (which rejects 0).
    const stdout = [
      'LEDGER',
      '',
      'MARKS',
      '',
      'CLASSIFICATIONS',
      '',
      'WITNESSES',
      '0 /media/fat/_Other',
      '1700000001 /media/fat/games',
      'END',
      '',
    ].join('\n');

    const out = parsePrimeOutput(stdout);
    expect(out?.witnesses['/media/fat/_Other']).toBe(0);
    expect(out?.witnesses['/media/fat/games']).toBe(1700000001);
  });

  it('returns null when a required section label is missing (truncated output)', () => {
    // No END label — the SSH stream got cut off mid-way.
    const stdout = [
      'LEDGER',
      '',
      'MARKS',
      '',
      'CLASSIFICATIONS',
      '',
      'WITNESSES',
      '1700000000 /media/fat/games',
      // (no END)
    ].join('\n');

    expect(parsePrimeOutput(stdout)).toBeNull();
  });

  it('returns null when sections appear out of order (corrupted output)', () => {
    const stdout = [
      'MARKS',
      '',
      'LEDGER',
      '',
      'CLASSIFICATIONS',
      '',
      'WITNESSES',
      'END',
    ].join('\n');

    expect(parsePrimeOutput(stdout)).toBeNull();
  });

  it('handles multi-line base64 chunks (busybox 76-col wrap fallback)', () => {
    const ledgerJson = JSON.stringify({
      schemaVersion: 1,
      hiddenCores: Array.from({ length: 5 }, (_, i) => ({
        coreId: `Core${String(i)}`,
        gamesDirHidden: true,
        rbfPaths: [`/media/fat/_Console/Core${String(i)}.rbf`],
        hiddenAt: '2026-01-01T00:00:00.000Z',
      })),
    });
    // Simulate a busybox build that wrapped at 76 columns.
    const b64 = Buffer.from(ledgerJson, 'utf-8').toString('base64');
    const wrapped = b64.match(/.{1,76}/g)?.join('\n') ?? b64;
    const stdout = [
      'LEDGER',
      wrapped,
      'MARKS',
      '',
      'CLASSIFICATIONS',
      '',
      'WITNESSES',
      '1700000000 /media/fat/games',
      'END',
      '',
    ].join('\n');

    const out = parsePrimeOutput(stdout);
    expect(out?.ledgerJson).toBe(ledgerJson);
  });

  it('UTF-8 round-trips through base64 (folder names with accents)', () => {
    const json = JSON.stringify({
      schemaVersion: 1,
      overrides: [
        {
          coreId: 'NES',
          folderPath: 'café',
          classification: 'atomic',
          setAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    const stdout = [
      'LEDGER',
      '',
      'MARKS',
      '',
      'CLASSIFICATIONS',
      Buffer.from(json, 'utf-8').toString('base64'),
      'WITNESSES',
      '1700000000 /media/fat/games',
      'END',
      '',
    ].join('\n');

    const out = parsePrimeOutput(stdout);
    expect(out?.classificationsJson).toBe(json);
  });
});

describe('buildPrimeScript', () => {
  it('emits each label, the file payload pipeline, and witness lines', () => {
    const script = buildPrimeScript({
      ledgerPath: '/media/fat/.mistercurator/state.json',
      marksPath: '/media/fat/.mistercurator/system-files.json',
      classificationsPath:
        '/media/fat/.mistercurator/folder-classifications.json',
      coresWitnessPaths: ['/media/fat/_Console', '/media/fat/games'],
    });

    expect(script).toContain(`echo 'LEDGER'`);
    expect(script).toContain(`echo 'MARKS'`);
    expect(script).toContain(`echo 'CLASSIFICATIONS'`);
    expect(script).toContain(`echo 'WITNESSES'`);
    expect(script).toContain(`echo 'END'`);
    // base64-decoder relies on the `tr -d '\n'` flatten, so it must
    // be present.
    expect(script).toContain(`tr -d '\\n'`);
    // Each witness path is checked for existence and stat'd.
    expect(script).toContain(`/media/fat/_Console`);
    expect(script).toContain(`/media/fat/games`);
    expect(script).toContain(`stat -c '%Y %n'`);
  });

  it('single-quote-escapes paths (defense against shell-special characters)', () => {
    const script = buildPrimeScript({
      ledgerPath: "/tmp/Don't.json",
      marksPath: '/tmp/marks.json',
      classificationsPath: '/tmp/cls.json',
      coresWitnessPaths: [],
    });
    // The apostrophe inside the path must be escaped via the
    // POSIX `'\''` idiom — never closes the surrounding quote early.
    expect(script).toContain(`'/tmp/Don'\\''t.json'`);
  });
});

describe('parseWitnessOutput', () => {
  it('parses the witness-only block', () => {
    const stdout = [
      'WITNESSES',
      '1700000000 /media/fat/games/X68000',
      'END',
      '',
    ].join('\n');
    expect(parseWitnessOutput(stdout)).toEqual({
      '/media/fat/games/X68000': 1700000000,
    });
  });

  it('returns null when END is missing (truncation)', () => {
    expect(parseWitnessOutput('WITNESSES\n1700000000 /a\n')).toBeNull();
  });

  it('handles missing-on-device entries (mtime 0)', () => {
    const stdout = ['WITNESSES', '0 /vanished', 'END', ''].join('\n');
    expect(parseWitnessOutput(stdout)).toEqual({ '/vanished': 0 });
  });

  it('ignores garbage lines outside the WITNESSES section', () => {
    const stdout = ['random preamble', 'WITNESSES', '1 /a', 'END', ''].join('\n');
    expect(parseWitnessOutput(stdout)).toEqual({ '/a': 1 });
  });
});

describe('buildWitnessScript', () => {
  it('produces a stat-only script (no file-payload section)', () => {
    const script = buildWitnessScript(['/media/fat/games/NES']);
    expect(script).not.toContain('LEDGER');
    expect(script).not.toContain('MARKS');
    expect(script).not.toContain('CLASSIFICATIONS');
    expect(script).toContain(`echo 'WITNESSES'`);
    expect(script).toContain(`echo 'END'`);
    expect(script).toContain(`stat -c '%Y %n'`);
  });
});

describe('buildSizeAndMtimeScript / parseSizeAndMtimeOutput (commit 4 lazy migration)', () => {
  it('build: emits a SIZE_MTIME-bracketed script with stat -c using real tab separators', () => {
    const script = buildSizeAndMtimeScript(['/media/fat/games/NEOGEO/mslug.zip']);
    expect(script).toContain(`echo 'SIZE_MTIME'`);
    expect(script).toContain(`echo 'END'`);
    // The format must be tab-separated so paths with spaces don't
    // fragment. The witness script uses space; this one uses real
    // TAB characters in the stat format string (the JS template
    // literal renders `\t` as a literal tab).
    expect(script).toContain('stat -c \'%s\t%Y\t%n\'');
  });

  it('build: shell-quotes paths with spaces and apostrophes', () => {
    const script = buildSizeAndMtimeScript([
      "/media/fat/games/X68000/D'Oh.dim",
      '/media/fat/games/SNES/Super Mario World.sfc',
    ]);
    // Single-quote escape: '\'' inside the wrapping quotes.
    expect(script).toContain(`'/media/fat/games/X68000/D'\\''Oh.dim'`);
    expect(script).toContain(`'/media/fat/games/SNES/Super Mario World.sfc'`);
  });

  it('build: emits a fallback line (size=0, mtime=0) for paths that vanish', () => {
    // The script's `if [ -f ...; ... else printf '0\t0\t<path>\n'; fi`
    // structure ensures the parser sees one entry per requested
    // path even when the path is missing.
    const script = buildSizeAndMtimeScript(['/missing']);
    expect(script).toContain(`printf '0\\t0\\t%s\\n'`);
  });

  it('parse: decodes a populated SIZE_MTIME block with multiple paths', () => {
    const stdout = [
      'SIZE_MTIME',
      '14199857\t1709054222\t/media/fat/games/mame/grdians.zip',
      '524288\t1700000000\t/media/fat/games/SNES/SMW.sfc',
      'END',
      '',
    ].join('\n');
    expect(parseSizeAndMtimeOutput(stdout)).toEqual({
      '/media/fat/games/mame/grdians.zip': {
        size: 14199857,
        mtime: 1709054222,
      },
      '/media/fat/games/SNES/SMW.sfc': {
        size: 524288,
        mtime: 1700000000,
      },
    });
  });

  it('parse: returns null when END is missing (truncation)', () => {
    expect(
      parseSizeAndMtimeOutput('SIZE_MTIME\n100\t200\t/a\n'),
    ).toBeNull();
  });

  it('parse: handles missing-on-device entries (size=0, mtime=0)', () => {
    const stdout = ['SIZE_MTIME', '0\t0\t/vanished', 'END', ''].join('\n');
    expect(parseSizeAndMtimeOutput(stdout)).toEqual({
      '/vanished': { size: 0, mtime: 0 },
    });
  });

  it('parse: paths containing tabs use the SECOND tab as the path delimiter', () => {
    // Path with embedded tab is rare but legal. The first two tabs
    // delimit the numeric fields; everything after is the path.
    const stdout = [
      'SIZE_MTIME',
      '100\t200\t/games/odd\tname.sfc',
      'END',
      '',
    ].join('\n');
    expect(parseSizeAndMtimeOutput(stdout)).toEqual({
      '/games/odd\tname.sfc': { size: 100, mtime: 200 },
    });
  });

  it('parse: ignores garbage lines outside the SIZE_MTIME section', () => {
    const stdout = [
      'random preamble',
      'SIZE_MTIME',
      '1\t2\t/a',
      'END',
      '',
    ].join('\n');
    expect(parseSizeAndMtimeOutput(stdout)).toEqual({
      '/a': { size: 1, mtime: 2 },
    });
  });

  it('parse: clamps non-numeric size/mtime to 0 (defensive against busybox quirks)', () => {
    const stdout = ['SIZE_MTIME', 'NaN\txyz\t/a', 'END', ''].join('\n');
    expect(parseSizeAndMtimeOutput(stdout)).toEqual({
      '/a': { size: 0, mtime: 0 },
    });
  });
});
