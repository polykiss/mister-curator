import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ZIP_BLOCK_SEP,
  computePlayability,
  decodeArcadeMraTsv,
  parseArcadeMra,
} from '@shared/arcade-mra-parse';

const FIXTURES_DIR = join(__dirname, '__fixtures__/mra-heads');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

describe('parseArcadeMra — Galaga (clone with parent, single rom block, pipe list)', () => {
  const raw = fixture('galaga.mra');
  const meta = parseArcadeMra(raw, 'Galaga (Midway, Set 1).mra');

  it('extracts displayName + relativePath + hidden=false', () => {
    expect(meta.relativePath).toBe('Galaga (Midway, Set 1).mra');
    expect(meta.displayName).toBe('Galaga (Midway, Set 1).mra');
    expect(meta.hidden).toBe(false);
  });

  it('extracts the pipe-fallback list as a single rom-block', () => {
    expect(meta.requiredZips).toEqual([
      ['galaga.zip', 'galagamw.zip', 'namco51.zip', 'namco54.zip'],
    ]);
  });

  it('extracts rbf and setname', () => {
    expect(meta.rbf).toBe('galaga');
    expect(meta.setname).toBe('galagamw');
  });

  it('ignores no-zip <rom> blocks (synthetic hex parts)', () => {
    // Galaga's .mra has <rom index="1"/>, <rom index="2"/>, and
    // <rom index="3"> with embedded <part>...hex...</part> data
    // — none of those carry zip attrs and none should leak into
    // requiredZips.
    expect(meta.requiredZips).toHaveLength(1);
  });
});

describe('parseArcadeMra — ST-V Astra SuperStars (multi-block: BIOS + game)', () => {
  const raw = fixture('astra-superstars.mra');
  const meta = parseArcadeMra(raw, 'Astra SuperStars (J 980514 V1.002).mra');

  it('captures every zip-bearing <rom> block in document order', () => {
    // index=0 has no zip (synthetic), index=1/2/3 each carry a
    // zip attr. The two distinct zips are astrass.zip (the game,
    // appearing twice — indexes 1 and 3) and stvbios.zip
    // (index 2). The parser preserves duplicates because each
    // block is a separate ROM-region declaration.
    expect(meta.requiredZips).toEqual([
      ['astrass.zip'],
      ['stvbios.zip'],
      ['astrass.zip'],
    ]);
  });

  it('extracts rbf=ST-V and setname=astrass', () => {
    expect(meta.rbf).toBe('ST-V');
    expect(meta.setname).toBe('astrass');
  });
});

describe('parseArcadeMra — Computer Space (TTL no-zip)', () => {
  const raw = fixture('computer-space.mra');
  const meta = parseArcadeMra(raw, 'Computer Space.mra');

  it('returns empty requiredZips for a no-rom .mra', () => {
    expect(meta.requiredZips).toEqual([]);
  });

  it('collapses empty <setname></setname> to undefined', () => {
    expect(meta.setname).toBeUndefined();
  });

  it('still extracts the rbf', () => {
    expect(meta.rbf).toBe('computerspace');
  });
});

describe('parseArcadeMra — Alpha Mission (subfolder, single-quoted attr)', () => {
  // This fixture came from `_alternatives/_ASO/Alpha Mission.mra`
  // on the real device. Distinctive features:
  //   • uses `zip='alphamis.zip|aso.zip'` with SINGLE quotes
  //   • lives in a nested subfolder so relativePath includes a slash
  const raw = fixture('alt-subfolder.mra');
  const meta = parseArcadeMra(raw, '_alternatives/_ASO/Alpha Mission.mra');

  it('preserves the nested relativePath', () => {
    expect(meta.relativePath).toBe('_alternatives/_ASO/Alpha Mission.mra');
    expect(meta.displayName).toBe('Alpha Mission.mra');
    expect(meta.hidden).toBe(false);
  });

  it('parses single-quoted zip attr value with pipe fallback', () => {
    expect(meta.requiredZips).toEqual([['alphamis.zip', 'aso.zip']]);
  });

  it('extracts rbf and setname', () => {
    expect(meta.rbf).toBe('SNK_TripleZ80');
    expect(meta.setname).toBe('alphamis');
  });
});

describe('parseArcadeMra — hidden-file relativePath', () => {
  it('marks dot-prefixed basename as hidden + strips dot from displayName', () => {
    const raw = fixture('galaga.mra');
    const meta = parseArcadeMra(raw, '.Galaga (Midway, Set 1).mra');
    expect(meta.hidden).toBe(true);
    expect(meta.displayName).toBe('Galaga (Midway, Set 1).mra');
    expect(meta.relativePath).toBe('.Galaga (Midway, Set 1).mra');
  });

  it('only looks at the basename, not parent segments', () => {
    const raw = fixture('alt-subfolder.mra');
    const meta = parseArcadeMra(
      raw,
      '_alternatives/_ASO/.Alpha Mission.mra',
    );
    expect(meta.hidden).toBe(true);
    expect(meta.displayName).toBe('Alpha Mission.mra');
  });
});

describe('parseArcadeMra — malformed / pathological input', () => {
  it('returns empty fields for empty input', () => {
    const meta = parseArcadeMra('', 'foo.mra');
    expect(meta.requiredZips).toEqual([]);
    expect(meta.rbf).toBe('');
    expect(meta.setname).toBeUndefined();
  });

  it('drops <rom> blocks with empty zip attr', () => {
    const raw = '<rom index="0" zip=""></rom>\n<rom zip="a.zip"></rom>';
    const meta = parseArcadeMra(raw, 'x.mra');
    expect(meta.requiredZips).toEqual([['a.zip']]);
  });

  it('does not match a substring like xxxzip="..."', () => {
    // Negative case for the `\b` word-boundary in the attr regex —
    // make sure we're not greedily catching anything ending in `zip`.
    const raw = '<rom index="0" notazip="oops.zip"></rom>';
    const meta = parseArcadeMra(raw, 'x.mra');
    expect(meta.requiredZips).toEqual([]);
  });
});

describe('decodeArcadeMraTsv', () => {
  it('round-trips a single-block .mra', () => {
    // What the server-side awk would emit for a Galaga-like row.
    const line = ['Galaga.mra', 'galaga.zip|galagamw.zip', 'galaga', 'galagamw'].join(
      '\t',
    );
    const meta = decodeArcadeMraTsv(line);
    expect(meta).not.toBeNull();
    expect(meta!.requiredZips).toEqual([['galaga.zip', 'galagamw.zip']]);
    expect(meta!.rbf).toBe('galaga');
    expect(meta!.setname).toBe('galagamw');
  });

  it('round-trips a multi-block .mra (ZIP_BLOCK_SEP between blocks)', () => {
    const line = [
      'Astra.mra',
      ['astrass.zip', 'stvbios.zip', 'astrass.zip'].join(ZIP_BLOCK_SEP),
      'ST-V',
      'astrass',
    ].join('\t');
    const meta = decodeArcadeMraTsv(line);
    expect(meta!.requiredZips).toEqual([
      ['astrass.zip'],
      ['stvbios.zip'],
      ['astrass.zip'],
    ]);
  });

  it('handles a no-zip TTL row (empty zip field)', () => {
    const line = ['Computer Space.mra', '', 'computerspace', ''].join('\t');
    const meta = decodeArcadeMraTsv(line);
    expect(meta!.requiredZips).toEqual([]);
    expect(meta!.setname).toBeUndefined();
  });

  it('returns null on empty relativePath', () => {
    const line = ['', '', '', ''].join('\t');
    expect(decodeArcadeMraTsv(line)).toBeNull();
  });

  it('returns null when fewer than four fields', () => {
    expect(decodeArcadeMraTsv('foo.mra\tbar')).toBeNull();
  });

  it('marks dot-prefixed basename as hidden', () => {
    const line = ['.Foo.mra', 'foo.zip', 'rbf', 'foo'].join('\t');
    const meta = decodeArcadeMraTsv(line);
    expect(meta!.hidden).toBe(true);
    expect(meta!.displayName).toBe('Foo.mra');
  });
});

describe('computePlayability', () => {
  const meta = (zips: readonly (readonly string[])[]) => ({
    relativePath: 'x.mra',
    displayName: 'x.mra',
    hidden: false,
    requiredZips: zips,
    rbf: 'r',
  });

  it('no-zip mra → no-roms-needed regardless of disk state', () => {
    expect(computePlayability(meta([]), new Set())).toBe('no-roms-needed');
    expect(computePlayability(meta([]), new Set(['anything.zip']))).toBe(
      'no-roms-needed',
    );
  });

  it('every-zip-missing → missing', () => {
    const m = meta([['a.zip', 'b.zip'], ['c.zip']]);
    expect(computePlayability(m, new Set())).toBe('missing');
    expect(computePlayability(m, new Set(['unrelated.zip']))).toBe('missing');
  });

  it('one pipe-fallback alternative present → playable', () => {
    // The lenient rule: a single hit anywhere across all blocks /
    // all alternatives means we count it playable. Mirrors the
    // MAME loader's fallback-search behaviour conservatively.
    const m = meta([['a.zip', 'b.zip'], ['c.zip']]);
    expect(computePlayability(m, new Set(['b.zip']))).toBe('playable');
    expect(computePlayability(m, new Set(['c.zip']))).toBe('playable');
  });

  it('partial block presence still counts as playable', () => {
    // Two-block .mra (e.g. ST-V BIOS + game). Even if only the
    // game zip is present and BIOS is missing, the lenient rule
    // calls it playable. This is documented as a trade-off in
    // the parser source — strict mode is a V2 setting.
    const m = meta([['astrass.zip'], ['stvbios.zip']]);
    expect(computePlayability(m, new Set(['astrass.zip']))).toBe('playable');
  });
});
