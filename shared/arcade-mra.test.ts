import { describe, expect, it } from 'vitest';

import {
  countArcadeMraEntries,
  parseArcadeMraEntries,
} from '@shared/arcade-mra';

describe('parseArcadeMraEntries — top-level files', () => {
  it('emits one entry per top-level .mra file', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: 'Metal Slug.mra' },
      { type: 'f', relPath: 'Street Fighter II.mra' },
      { type: 'f', relPath: 'Pac-Man.mra' },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.kind)).toEqual(['mra', 'mra', 'mra']);
    expect(out.map((e) => e.displayName)).toEqual([
      'Metal Slug.mra',
      'Street Fighter II.mra',
      'Pac-Man.mra',
    ]);
    expect(out.every((e) => !e.hidden)).toBe(true);
  });

  it('marks dot-prefixed .mra files as hidden, exposes display name without the dot', () => {
    const [e] = parseArcadeMraEntries([
      { type: 'f', relPath: '.Metal Slug.mra' },
    ]);
    expect(e?.hidden).toBe(true);
    expect(e?.displayName).toBe('Metal Slug.mra');
    // relativePath retains the dot — that's what the rename op
    // operates on.
    expect(e?.relativePath).toBe('.Metal Slug.mra');
  });

  it('drops non-.mra files at top level (.rbf, README, etc.)', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: 'Metal Slug.mra' }, // kept
      { type: 'f', relPath: 'README.md' }, // dropped
      { type: 'f', relPath: 'something.rbf' }, // dropped
      { type: 'f', relPath: 'notes.txt' }, // dropped
    ]);
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });

  it('extension match is case-insensitive', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: 'Game.MRA' },
      { type: 'f', relPath: 'Game2.Mra' },
    ]);
    expect(out).toHaveLength(2);
  });
});

describe('parseArcadeMraEntries — subfolders', () => {
  it('emits a top-level subfolder as kind=subfolder', () => {
    const [e] = parseArcadeMraEntries([
      { type: 'd', relPath: '_Konami' },
    ]);
    expect(e?.kind).toBe('subfolder');
    expect(e?.relativePath).toBe('_Konami');
    expect(e?.displayName).toBe('_Konami');
    expect(e?.hidden).toBe(false);
  });

  it('emits cores/ as kind=cores-subfolder (firmware stash, not user-curatable)', () => {
    const out = parseArcadeMraEntries([
      { type: 'd', relPath: 'cores' },
    ]);
    expect(out[0]?.kind).toBe('cores-subfolder');
    expect(out[0]?.displayName).toBe('cores');
  });

  it('cores/ is case-insensitive (Cores/, CORES/)', () => {
    const a = parseArcadeMraEntries([{ type: 'd', relPath: 'Cores' }]);
    const b = parseArcadeMraEntries([{ type: 'd', relPath: 'CORES' }]);
    expect(a[0]?.kind).toBe('cores-subfolder');
    expect(b[0]?.kind).toBe('cores-subfolder');
  });

  it('marks dot-prefixed subfolder as hidden', () => {
    const [e] = parseArcadeMraEntries([
      { type: 'd', relPath: '._Konami' },
    ]);
    expect(e?.hidden).toBe(true);
    expect(e?.displayName).toBe('_Konami');
  });
});

describe('parseArcadeMraEntries — nested entries', () => {
  it('emits a .mra inside a subfolder with the slash-joined relativePath', () => {
    const [e] = parseArcadeMraEntries([
      { type: 'f', relPath: '_Konami/TMNT.mra' },
    ]);
    expect(e?.kind).toBe('mra');
    expect(e?.relativePath).toBe('_Konami/TMNT.mra');
    expect(e?.displayName).toBe('TMNT.mra');
  });

  it('drops .rbf inside cores/', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: 'cores/MetalSlug.rbf' },
      { type: 'f', relPath: 'cores/SF2.rbf' },
    ]);
    expect(out).toEqual([]);
  });

  it('drops files inside .AppleDouble/ subtree (any segment)', () => {
    const out = parseArcadeMraEntries([
      { type: 'd', relPath: '.AppleDouble' },
      { type: 'f', relPath: '.AppleDouble/Metal Slug.mra' },
      { type: 'f', relPath: '_Konami/.AppleDouble/TMNT.mra' },
      { type: 'f', relPath: 'Metal Slug.mra' }, // genuine
    ]);
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });
});

describe('parseArcadeMraEntries — OS metadata filter', () => {
  it('drops ._ AppleDouple files at every level', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: '._Metal Slug.mra' },
      { type: 'f', relPath: '_Konami/._TMNT.mra' },
      { type: 'f', relPath: 'Metal Slug.mra' }, // genuine
    ]);
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });

  it('drops .DS_Store + Thumbs.db at top level', () => {
    const out = parseArcadeMraEntries([
      { type: 'f', relPath: '.DS_Store' },
      { type: 'f', relPath: 'Thumbs.db' },
      { type: 'f', relPath: 'Metal Slug.mra' },
    ]);
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });
});

describe('parseArcadeMraEntries — empty input', () => {
  it('returns empty array for empty input', () => {
    expect(parseArcadeMraEntries([])).toEqual([]);
  });
});

describe('countArcadeMraEntries', () => {
  it('totals + hidden subset for .mra entries; subfolders for organisational dirs', () => {
    const counts = countArcadeMraEntries([
      { relativePath: 'A.mra', displayName: 'A.mra', kind: 'mra', hidden: false },
      { relativePath: 'B.mra', displayName: 'B.mra', kind: 'mra', hidden: false },
      { relativePath: '.C.mra', displayName: 'C.mra', kind: 'mra', hidden: true },
      { relativePath: '_Konami', displayName: '_Konami', kind: 'subfolder', hidden: false },
      { relativePath: 'cores', displayName: 'cores', kind: 'cores-subfolder', hidden: false },
    ]);
    expect(counts.totalMras).toBe(3);
    expect(counts.hiddenMras).toBe(1);
    // cores-subfolder is firmware-managed; excluded from the
    // user-organisational subfolder count.
    expect(counts.subfolders).toBe(1);
  });

  it('zeros out for empty input', () => {
    expect(countArcadeMraEntries([])).toEqual({
      totalMras: 0,
      hiddenMras: 0,
      subfolders: 0,
    });
  });
});
