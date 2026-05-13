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
