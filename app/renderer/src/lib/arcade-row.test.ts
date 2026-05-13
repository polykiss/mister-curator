import { describe, expect, it } from 'vitest';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import { ARCADE_VIRTUAL_CORE_ID } from '@shared/arcade-mra';

import {
  entriesAtDepth,
  makeArcadeRom,
  stripMraExtension,
} from '@app/renderer/src/lib/arcade-row';
import { DEFAULT_SORT, sortRoms } from '@app/renderer/src/lib/rom-sort';

/**
 * feat/arcade-parity-3-ui — pure helpers behind the arcade adapter's
 * cell-parity rewrite. The adapter itself is React-bound (state +
 * IPC), so the unit tests target the extracted pure surface.
 */

function mra(rel: string, displayName?: string): ArcadeMraEntry {
  return {
    relativePath: rel,
    displayName: displayName ?? rel.split('/').pop()!,
    kind: 'mra',
    hidden: false,
  };
}
function sub(rel: string): ArcadeMraEntry {
  return {
    relativePath: rel,
    displayName: rel.split('/').pop()!,
    kind: 'subfolder',
    hidden: false,
  };
}

describe('stripMraExtension', () => {
  it('strips a trailing .mra (case-insensitive)', () => {
    expect(stripMraExtension('Metal Slug.mra')).toBe('Metal Slug');
    expect(stripMraExtension('Galaga.MRA')).toBe('Galaga');
  });
  it('returns the input unchanged when there is no .mra suffix', () => {
    expect(stripMraExtension('_Konami')).toBe('_Konami');
    expect(stripMraExtension('')).toBe('');
  });
});

describe('makeArcadeRom', () => {
  it('emits Rom.kind="file" with stripped .mra displayName for an mra entry', () => {
    const rom = makeArcadeRom(mra('Metal Slug.mra'));
    expect(rom.kind).toBe('file');
    expect(rom.displayName).toBe('Metal Slug');
    // filename = relativePath (bijective with the entry; round-trip
    // after sort). Don't drop the .mra here — that key is what the
    // adapter looks up to find the original entry.
    expect(rom.filename).toBe('Metal Slug.mra');
    expect(rom.coreId).toBe(ARCADE_VIRTUAL_CORE_ID);
    expect(rom.sizeBytes).toBe(0);
    expect(rom.hidden).toBe(false);
    expect(rom.path).toBe('/media/fat/_Arcade/Metal Slug.mra');
  });

  it('emits Rom.kind="folder-container" for subfolder entries (pins to sort top)', () => {
    const rom = makeArcadeRom(sub('_Konami'));
    expect(rom.kind).toBe('folder-container');
    // Subfolders keep their displayName verbatim — no extension to strip.
    expect(rom.displayName).toBe('_Konami');
  });

  it('preserves hidden status from the entry', () => {
    const rom = makeArcadeRom({ ...mra('Galaga.mra'), hidden: true });
    expect(rom.hidden).toBe(true);
  });

  it('uses the relativePath verbatim for nested mras (round-trip key after sort)', () => {
    const rom = makeArcadeRom(mra('_Konami/TMNT.mra', 'TMNT.mra'));
    expect(rom.filename).toBe('_Konami/TMNT.mra');
    expect(rom.displayName).toBe('TMNT');
  });
});

describe('entriesAtDepth', () => {
  const fixture: readonly ArcadeMraEntry[] = [
    mra('Metal Slug.mra'),
    mra('Galaga.mra'),
    sub('_Konami'),
    mra('_Konami/TMNT.mra', 'TMNT.mra'),
    mra('_Konami/Contra.mra', 'Contra.mra'),
    sub('_Konami/sub'),
    mra('_Konami/sub/deep.mra', 'deep.mra'),
  ];

  it('returns only top-level entries at the root', () => {
    const out = entriesAtDepth(fixture, '');
    // Compare as sets to keep the assertion independent of insertion
    // order (the adapter sorts these downstream via sortRoms).
    expect(new Set(out.map((e) => e.relativePath))).toEqual(
      new Set(['_Konami', 'Galaga.mra', 'Metal Slug.mra']),
    );
  });

  it('returns entries one segment below the current subPath', () => {
    const out = entriesAtDepth(fixture, '_Konami');
    expect(new Set(out.map((e) => e.relativePath))).toEqual(
      new Set(['_Konami/Contra.mra', '_Konami/TMNT.mra', '_Konami/sub']),
    );
  });

  it('handles two-level deep nesting', () => {
    const out = entriesAtDepth(fixture, '_Konami/sub');
    expect(out.map((e) => e.relativePath)).toEqual(['_Konami/sub/deep.mra']);
  });

  it('returns nothing when subPath does not exist in the tree', () => {
    expect(entriesAtDepth(fixture, 'nonsense')).toEqual([]);
  });
});

describe('entriesAtDepth — empty subfolder suppression (phase 2 follow-up)', () => {
  it('hides a subfolder whose subtree contains zero .mras (the live `cores/` case)', () => {
    // Reproduces the live shape: _Arcade/cores/ contains only .rbf
    // core binaries; parseArcadeMraEntries surfaces it as a
    // `cores-subfolder` entry but the adapter only knows about .mra
    // rows, so drilling in would show an empty list. Phase 2 hides
    // these dead-end folders at the source.
    const entries: readonly ArcadeMraEntry[] = [
      mra('Galaga.mra'),
      { ...sub('cores'), kind: 'cores-subfolder' },
    ];
    const out = entriesAtDepth(entries, '');
    expect(out.map((e) => e.relativePath)).toEqual(['Galaga.mra']);
  });

  it('hides a user-organisational subfolder the user emptied (no mras anywhere below)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Metal Slug.mra'),
      sub('_alternatives'),
    ];
    const out = entriesAtDepth(entries, '');
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });

  it('surfaces a subfolder with .mras at depth 1 (direct children)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      sub('_Konami'),
      mra('_Konami/TMNT.mra', 'TMNT.mra'),
    ];
    const out = entriesAtDepth(entries, '');
    expect(out.map((e) => e.relativePath)).toContain('_Konami');
  });

  it('surfaces a subfolder whose .mras live only 2+ levels deep (recursive check)', () => {
    // No mras at depth 1 of `_alternatives/`, but a nested
    // `_alternatives/Konami/x.mra` keeps the folder alive — the
    // recursive count is what matters, not direct children.
    const entries: readonly ArcadeMraEntry[] = [
      sub('_alternatives'),
      sub('_alternatives/Konami'),
      mra('_alternatives/Konami/deep.mra', 'deep.mra'),
    ];
    const out = entriesAtDepth(entries, '');
    expect(out.map((e) => e.relativePath)).toContain('_alternatives');
  });

  it('handles a completely empty arcade list without throwing', () => {
    expect(entriesAtDepth([], '')).toEqual([]);
    expect(entriesAtDepth([], '_Konami')).toEqual([]);
  });

  it('never filters out .mra rows (the suppression is folder-only)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Solo.mra'),
      sub('emptyFolder'),
    ];
    const out = entriesAtDepth(entries, '');
    // Solo.mra has no subtree but it's an mra, not a folder — it
    // must survive the filter.
    expect(out.map((e) => e.relativePath)).toEqual(['Solo.mra']);
  });

  it('does not surface a child subfolder whose subtree is empty when drilling', () => {
    // Drill into _Konami: a `_Konami/sub` folder with no mras below
    // it should not surface as a drillable row either.
    const entries: readonly ArcadeMraEntry[] = [
      sub('_Konami'),
      sub('_Konami/sub'),
      mra('_Konami/Contra.mra', 'Contra.mra'),
    ];
    const out = entriesAtDepth(entries, '_Konami');
    expect(out.map((e) => e.relativePath).sort()).toEqual([
      '_Konami/Contra.mra',
    ]);
  });
});

describe('rom-sort integration with synthesised arcade roms', () => {
  it('pins folder-container rows ahead of mras regardless of sort direction', () => {
    const folder = makeArcadeRom(sub('_Konami'));
    const a = makeArcadeRom(mra('Aaa.mra'));
    const z = makeArcadeRom(mra('Zzz.mra'));
    const ascRows = sortRoms(
      [
        { rom: z, metadata: null },
        { rom: folder, metadata: null },
        { rom: a, metadata: null },
      ],
      DEFAULT_SORT,
    );
    expect(ascRows.map((r) => r.rom.displayName)).toEqual([
      '_Konami',
      'Aaa',
      'Zzz',
    ]);
    const descRows = sortRoms(
      [
        { rom: a, metadata: null },
        { rom: folder, metadata: null },
        { rom: z, metadata: null },
      ],
      { key: 'name', dir: 'desc' },
    );
    // Folder still leads even when files are sorted descending.
    expect(descRows[0]!.rom.displayName).toBe('_Konami');
    expect(descRows.slice(1).map((r) => r.rom.displayName)).toEqual([
      'Zzz',
      'Aaa',
    ]);
  });

  it('places mras with no metadata at the end of the name-sorted list (unchanged)', () => {
    // The arcade adapter passes `metadata: null` for unmatched rows.
    // sortRoms's name-sort uses rom.displayName as the floor, so
    // every mra has a name to sort by — no "missing" sandwich for
    // the name key. Other keys (year, rating) DO sandwich.
    const rows = [
      makeArcadeRom(mra('Beta.mra')),
      makeArcadeRom(mra('Alpha.mra')),
    ].map((rom) => ({ rom, metadata: null }));
    const sorted = sortRoms(rows, { key: 'year', dir: 'asc' });
    // Both lack year metadata → both go to the "missing" bucket in
    // input order. Pin that the integration doesn't blow up + the
    // order is stable.
    expect(sorted.map((r) => r.rom.displayName)).toEqual(['Beta', 'Alpha']);
  });
});
