import { describe, expect, it } from 'vitest';

import { buildHashScript, parseHashOutput } from '@shared/hash-script';

describe('hash-script', () => {
  describe('buildHashScript', () => {
    it('shell-quotes each path so spaces and apostrophes survive', () => {
      const script = buildHashScript([
        '/media/fat/games/SNES/Super Mario World.sfc',
        "/media/fat/games/SNES/D'Oh.sfc",
      ]);
      expect(script).toContain(
        "set -- '/media/fat/games/SNES/Super Mario World.sfc'",
      );
      expect(script).toContain(`'/media/fat/games/SNES/D'\\''Oh.sfc'`);
    });

    it('emits a 5-tab path/md5/sha1/size/mtime printf format', () => {
      const script = buildHashScript(['/x']);
      expect(script).toContain("printf '%s\\t%s\\t%s\\t%s\\t%s\\n'");
    });

    it('iterates positional args, guards each with [ -f ]', () => {
      const script = buildHashScript(['/a', '/b']);
      expect(script).toContain('for f in "$@"');
      expect(script).toContain('if [ -f "$f" ]');
    });

    it('routes .zip / .ZIP paths through unzip -p for both md5 and sha1', () => {
      const script = buildHashScript(['/games/SNES/Sonic.zip']);
      expect(script).toContain('case "$f" in');
      expect(script).toContain('*.zip|*.ZIP)');
      expect(script).toContain('unzip -p "$f"');
      // Both algorithms route through unzip -p.
      expect(script).toMatch(/md5=\$\(unzip -p "\$f"[^\n]*\| md5sum/);
      expect(script).toMatch(/sha1=\$\(unzip -p "\$f"[^\n]*\| sha1sum/);
    });

    it('computes inner-content size for .zip via unzip -p | wc -c', () => {
      // SS's romtaille is the EXTRACTED ROM size, not the zip wrapper.
      // The script reads the zip a third time to get the right value.
      const script = buildHashScript(['/games/SNES/Sonic.zip']);
      expect(script).toMatch(
        /size=\$\(unzip -p "\$f" 2>\/dev\/null \| wc -c \| tr -d ' '\)/,
      );
    });

    it('uses direct md5sum / sha1sum / stat for non-archive paths', () => {
      const script = buildHashScript(['/games/SNES/Sonic.sfc']);
      // Default arm of the case ... esac.
      expect(script).toMatch(/\*\)\s*\n\s*md5=\$\(md5sum "\$f"/);
      expect(script).toMatch(/sha1=\$\(sha1sum "\$f"/);
      expect(script).toMatch(/size=\$\(stat -c %s "\$f"/);
    });

    it('captures wrapper mtime exactly once per file (shared across branches)', () => {
      // mtime stays on the wrapper file regardless of whether we
      // unzipped to compute the hash; cache invalidation tracks
      // what the user touches. One stat -c %Y per loop iteration.
      const script = buildHashScript(['/x.zip']);
      const matches = script.match(/stat -c %Y/g);
      expect(matches?.length).toBe(1);
    });

    it('drops a line when any field is empty', () => {
      const script = buildHashScript(['/x']);
      // The printf gate requires md5, sha1, size, and mtime all
      // non-empty — defends against partial tool failures.
      expect(script).toContain(
        '[ -n "$md5" ] && [ -n "$sha1" ] && [ -n "$size" ] && [ -n "$mtime" ]',
      );
    });
  });

  describe('parseHashOutput', () => {
    it('parses one well-formed line', () => {
      const out = parseHashOutput(
        '/p/SMW.sfc\t' +
          'a'.repeat(32) +
          '\t' +
          'b'.repeat(40) +
          '\t524288\t1700000000\n',
      );
      expect(out).toEqual([
        {
          path: '/p/SMW.sfc',
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 524288,
          mtime: 1700000000,
        },
      ]);
    });

    it('parses multiple lines and skips blanks', () => {
      const out = parseHashOutput(
        '/a\t' +
          'a'.repeat(32) +
          '\t' +
          'a'.repeat(40) +
          '\t100\t10\n' +
          '\n' +
          '/b\t' +
          'b'.repeat(32) +
          '\t' +
          'b'.repeat(40) +
          '\t200\t20\n',
      );
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ path: '/a', size: 100, mtime: 10 });
      expect(out[1]).toMatchObject({ path: '/b', size: 200, mtime: 20 });
    });

    it('skips lines whose md5 isn\'t 32 hex chars', () => {
      const out = parseHashOutput(
        '/a\tnotahash\t' +
          'a'.repeat(40) +
          '\t100\t10\n',
      );
      expect(out).toEqual([]);
    });

    it('skips lines whose sha1 isn\'t 40 hex chars', () => {
      const out = parseHashOutput(
        '/a\t' +
          'a'.repeat(32) +
          '\tshort\t100\t10\n',
      );
      expect(out).toEqual([]);
    });

    it('skips lines whose size or mtime is non-integer', () => {
      const md5 = 'a'.repeat(32);
      const sha1 = 'b'.repeat(40);
      expect(
        parseHashOutput(`/a\t${md5}\t${sha1}\tabc\t100\n`),
      ).toEqual([]);
      expect(
        parseHashOutput(`/a\t${md5}\t${sha1}\t100\txyz\n`),
      ).toEqual([]);
    });

    it('rejects uppercase hex (busybox emits lowercase)', () => {
      const out = parseHashOutput(
        '/a\t' +
          'A'.repeat(32) +
          '\t' +
          'a'.repeat(40) +
          '\t100\t10\n',
      );
      expect(out).toEqual([]);
    });

    it('handles paths containing tabs by splitting on the LAST four', () => {
      const path = '/games/odd\tname.sfc';
      const md5 = 'a'.repeat(32);
      const sha1 = 'b'.repeat(40);
      const out = parseHashOutput(
        `${path}\t${md5}\t${sha1}\t100\t1700000000\n`,
      );
      expect(out).toEqual([
        { path, md5, sha1, size: 100, mtime: 1700000000 },
      ]);
    });

    it('returns empty for empty input', () => {
      expect(parseHashOutput('')).toEqual([]);
    });
  });
});
