import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  buildSampleInput,
  buildSampleScript,
  parseSampleOutput,
} from '@shared/sample-script';

describe('buildSampleScript', () => {
  it('emits a `set --` line with each path shell-quoted', () => {
    const script = buildSampleScript([
      '/media/fat/games/mame/foo.zip',
      "/media/fat/games/mame/has's apostrophe.zip",
    ]);
    expect(script).toContain(
      `set -- '/media/fat/games/mame/foo.zip' '/media/fat/games/mame/has'\\''s apostrophe.zip'`,
    );
  });

  it('iterates with `for f in "$@"` so the loop respects shell-quoted args', () => {
    const script = buildSampleScript(['x']);
    expect(script).toContain('for f in "$@"; do');
  });

  it('uses dd bs=65536 with skip=$tskip and falls back to tskip=0', () => {
    const script = buildSampleScript(['x']);
    expect(script).toContain('dd if="$f" bs=65536 count=1');
    expect(script).toContain('dd if="$f" bs=65536 skip=$tskip count=1');
    expect(script).toContain('[ "$tskip" -lt 0 ] && tskip=0');
  });

  it('appends size as a 16-char hex blob via printf', () => {
    // Matches the device-side recipe verified on the user's
    // MiSTer: `printf '%016x' "$sz"`. The 16-char form makes the
    // sample fingerprint sensitive to size changes even when head
    // and tail bytes happen to match.
    const script = buildSampleScript(['x']);
    expect(script).toContain("printf '%016x' \"$sz\"");
  });

  it('pipes the composite stream through md5sum and extracts the hex digest', () => {
    const script = buildSampleScript(['x']);
    expect(script).toContain("md5sum 2>/dev/null | cut -d' ' -f1");
  });

  it("emits `<path>\\t<md5>\\n` per successful row", () => {
    const script = buildSampleScript(['x']);
    expect(script).toContain(`printf '%s\\t%s\\n' "$f" "$sample"`);
  });
});

describe('parseSampleOutput', () => {
  it('parses each `<path>\\t<md5>\\n` row into the map', () => {
    const stdout = [
      'foo.zip\t' + 'a'.repeat(32),
      'bar.zip\t' + 'b'.repeat(32),
      '',
    ].join('\n');
    expect(parseSampleOutput(stdout)).toEqual({
      'foo.zip': 'a'.repeat(32),
      'bar.zip': 'b'.repeat(32),
    });
  });

  it('drops rows whose md5 is not 32 hex chars', () => {
    const stdout = [
      'short.zip\t' + 'a'.repeat(16),
      'nonhex.zip\t' + 'z'.repeat(32),
      'good.zip\t' + 'c'.repeat(32),
      '',
    ].join('\n');
    expect(parseSampleOutput(stdout)).toEqual({ 'good.zip': 'c'.repeat(32) });
  });

  it('drops rows with no tab separator', () => {
    const stdout = 'no-tab-here-this-is-noise\n';
    expect(parseSampleOutput(stdout)).toEqual({});
  });

  it('returns {} for empty stdout', () => {
    expect(parseSampleOutput('')).toEqual({});
  });

  it('supports paths containing tabs by splitting from the right', () => {
    // The shell loop pastes path + literal tab + md5 + newline.
    // Paths with literal tabs in them are pathological but legal.
    const stdout = `weird\tpath\thas\ttab.zip\t${'a'.repeat(32)}\n`;
    expect(parseSampleOutput(stdout)).toEqual({
      'weird\tpath\thas\ttab.zip': 'a'.repeat(32),
    });
  });
});

describe('buildSampleInput', () => {
  function sampleMd5(buf: Buffer): string {
    return createHash('md5').update(buildSampleInput(buf)).digest('hex');
  }

  it('produces deterministic output for the same bytes', () => {
    const buf = Buffer.alloc(200 * 1024, 0x42);
    expect(sampleMd5(buf)).toBe(sampleMd5(buf));
  });

  it('changes when the last byte flips (tail block always covers it)', () => {
    const a = Buffer.alloc(200 * 1024, 0x42);
    const b = Buffer.from(a);
    b[b.length - 1] = 0xff;
    expect(sampleMd5(a)).not.toBe(sampleMd5(b));
  });

  it('changes when the first byte flips (head block always covers it)', () => {
    const a = Buffer.alloc(200 * 1024, 0x42);
    const b = Buffer.from(a);
    b[0] = 0xff;
    expect(sampleMd5(a)).not.toBe(sampleMd5(b));
  });

  it('changes when only the size differs (size suffix is part of the input)', () => {
    const a = Buffer.alloc(100 * 1024, 0x42);
    const b = Buffer.alloc(101 * 1024, 0x42);
    expect(sampleMd5(a)).not.toBe(sampleMd5(b));
  });

  it('produces head+head+size for a small file < 64KB (head and tail aliased)', () => {
    // For sz <= 64KB, the tail-skip formula yields 0, so `dd ...
    // skip=0 count=1` reads the same block as the head dd call.
    // The composite input is head ++ head ++ sizeHex.
    const buf = Buffer.alloc(40 * 1024, 0x37);
    const sizeHex = Buffer.from(buf.length.toString(16).padStart(16, '0'));
    const expected = Buffer.concat([buf, buf, sizeHex]);
    expect(buildSampleInput(buf).equals(expected)).toBe(true);
  });

  it('produces head + partial-tail + size for a file with a partial trailing block', () => {
    // 200KB = 3 full blocks + 8192 trailing bytes. Tail skip = 3
    // → dd reads block 3 → 8192 bytes (the trailing partial). The
    // composite is head(65536) + tail(8192) + sizeHex(16) =
    // 73744 bytes.
    const buf = Buffer.alloc(200 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = i & 0xff;
    const input = buildSampleInput(buf);
    expect(input.length).toBe(65536 + 8192 + 16);
    // Head bytes match input[0..65536].
    expect(input.subarray(0, 65536).equals(buf.subarray(0, 65536))).toBe(true);
    // Tail bytes match input[65536..73728] aka buf[196608..204800].
    expect(
      input.subarray(65536, 65536 + 8192).equals(buf.subarray(196608, 204800)),
    ).toBe(true);
    // Size hex suffix.
    expect(input.subarray(73728).toString('utf8')).toBe(
      buf.length.toString(16).padStart(16, '0'),
    );
  });

  it('handles a file exactly two blocks long (head + tail covers the whole file)', () => {
    // 128KB = exactly 2 blocks. tail skip = 1 → dd reads block 1
    // → bytes [65536, 131072). Head + tail covers [0, 131072) with
    // no overlap.
    const buf = Buffer.alloc(128 * 1024);
    for (let i = 0; i < buf.length; i += 1) buf[i] = (i * 7) & 0xff;
    const input = buildSampleInput(buf);
    expect(input.length).toBe(65536 + 65536 + 16);
    expect(input.subarray(0, 65536).equals(buf.subarray(0, 65536))).toBe(true);
    expect(
      input.subarray(65536, 131072).equals(buf.subarray(65536, 131072)),
    ).toBe(true);
  });
});
