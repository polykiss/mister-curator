import { describe, expect, it } from 'vitest';

import { buildMd5sumScript, parseMd5sumOutput } from '@shared/md5sum-script';

describe('md5sum-script', () => {
  describe('buildMd5sumScript', () => {
    it('shell-quotes each path so spaces and apostrophes survive', () => {
      const script = buildMd5sumScript([
        '/media/fat/games/SNES/Super Mario World.sfc',
        "/media/fat/games/SNES/D'Oh.sfc",
      ]);
      expect(script).toContain(
        "set -- '/media/fat/games/SNES/Super Mario World.sfc'",
      );
      // Single-quote in the apostrophe path is escaped via the
      // close-quote / backslash-quote / reopen-quote idiom.
      expect(script).toContain(`'/media/fat/games/SNES/D'\\''Oh.sfc'`);
    });

    it('emits a tab-separated path<TAB>hash<TAB>mtime per file', () => {
      const script = buildMd5sumScript(['/x']);
      // The printf uses literal tabs (\\t) in the source — what
      // matters is that the format string is the three-field TSV
      // we parse on the way back.
      expect(script).toContain("printf '%s\\t%s\\t%s\\n'");
    });

    it('iterates positional args, guards each with [ -f ]', () => {
      const script = buildMd5sumScript(['/a', '/b']);
      expect(script).toContain('for f in "$@"');
      expect(script).toContain('if [ -f "$f" ]');
    });

    it('routes .zip / .ZIP paths through unzip -p before md5sum (round 6)', () => {
      const script = buildMd5sumScript(['/media/fat/games/SNES/Sonic.zip']);
      // Case-glob covers both extensions in a single arm.
      expect(script).toContain('case "$f" in');
      expect(script).toContain('*.zip|*.ZIP)');
      expect(script).toContain('unzip -p "$f"');
      // The unzip arm pipes into md5sum (matches the device-side
      // behaviour described in the docstring).
      expect(script).toMatch(/unzip -p "\$f"[^\n]*\|\s*md5sum/);
    });

    it('keeps the direct md5sum branch for non-archive paths', () => {
      const script = buildMd5sumScript(['/media/fat/games/SNES/Sonic.sfc']);
      // The wildcard fallback in case ... esac runs md5sum directly.
      expect(script).toMatch(/\*\)\s*\n\s*h=\$\(md5sum "\$f"/);
    });

    it('captures wrapper mtime regardless of the hash branch', () => {
      // Cache invalidation keys on wrapper mtime — the same `stat`
      // call applies to .zip and direct paths.
      const script = buildMd5sumScript(['/x.zip']);
      expect(script).toContain('m=$(stat -c %Y "$f"');
      // No second `stat` against a hypothetical inner-file path.
      expect(script.match(/stat -c %Y/g)?.length).toBe(1);
    });
  });

  describe('parseMd5sumOutput', () => {
    it('parses one well-formed line', () => {
      const out = parseMd5sumOutput(
        '/media/fat/games/SNES/SMW.sfc\t1234567890abcdef1234567890abcdef\t1700000000\n',
      );
      expect(out).toEqual([
        {
          path: '/media/fat/games/SNES/SMW.sfc',
          hash: '1234567890abcdef1234567890abcdef',
          mtime: 1700000000,
        },
      ]);
    });

    it('parses multiple lines and skips blanks', () => {
      const out = parseMd5sumOutput(
        '/a\t' +
          'a'.repeat(32) +
          '\t100\n' +
          '\n' +
          '/b\t' +
          'b'.repeat(32) +
          '\t200\n',
      );
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ path: '/a', mtime: 100 });
      expect(out[1]).toMatchObject({ path: '/b', mtime: 200 });
    });

    it('skips lines whose hash field is not a 32-char md5', () => {
      const out = parseMd5sumOutput('/a\tnotahash\t100\n');
      expect(out).toEqual([]);
    });

    it('skips lines whose hash has uppercase hex (busybox emits lowercase)', () => {
      // Defensive: the parser pins to lowercase to keep the cache
      // canonical. An upstream change emitting uppercase would be a
      // bug we want to surface as "no hash returned" rather than
      // mixing case in the cache.
      const out = parseMd5sumOutput('/a\t' + 'F'.repeat(32) + '\t100\n');
      expect(out).toEqual([]);
    });

    it('skips lines whose mtime is not a non-negative integer', () => {
      const out = parseMd5sumOutput('/a\t' + 'a'.repeat(32) + '\tabc\n');
      expect(out).toEqual([]);
    });

    it('handles paths containing tabs by splitting on the LAST two', () => {
      // A pathological filename with embedded tabs. The hash is
      // fixed-width so the trailing two tabs delimit the trailer
      // unambiguously.
      const path = '/media/fat/games/odd\tname.sfc';
      const out = parseMd5sumOutput(
        `${path}\t${'a'.repeat(32)}\t100\n`,
      );
      expect(out).toEqual([
        { path, hash: 'a'.repeat(32), mtime: 100 },
      ]);
    });

    it('returns empty for empty input', () => {
      expect(parseMd5sumOutput('')).toEqual([]);
    });
  });
});
