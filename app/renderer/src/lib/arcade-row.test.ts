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

  it('threads entry.primaryZipSizeBytes into rom.sizeBytes for mra rows', () => {
    // feat/arcade-polish-context-menu — primary-zip size drives the
    // density bar. The renderer reads from rom.sizeBytes; the
    // wire-side ArcadeMraEntry carries the stat'd size.
    const rom = makeArcadeRom({
      ...mra('Metal Slug.mra'),
      primaryZipSizeBytes: 4_500_000,
    });
    expect(rom.sizeBytes).toBe(4_500_000);
  });

  it('falls back to 0 when an mra has no primary-zip size (missing zip or pre-stat connect race)', () => {
    const rom = makeArcadeRom(mra('Metal Slug.mra'));
    expect(rom.sizeBytes).toBe(0);
  });

  it('never carries a size for subfolder rows (density bar stays empty on folders)', () => {
    const rom = makeArcadeRom({
      ...sub('_Konami'),
      // Defensive: even if the wire shape somehow surfaces a size
      // for a subfolder, we drop it — subfolders shouldn't drive
      // the density-bar scale.
      primaryZipSizeBytes: 999_999,
    });
    expect(rom.sizeBytes).toBe(0);
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
    const out = entriesAtDepth(fixture, '', true);
    // Compare as sets to keep the assertion independent of insertion
    // order (the adapter sorts these downstream via sortRoms).
    expect(new Set(out.map((e) => e.relativePath))).toEqual(
      new Set(['_Konami', 'Galaga.mra', 'Metal Slug.mra']),
    );
  });

  it('returns entries one segment below the current subPath', () => {
    const out = entriesAtDepth(fixture, '_Konami', true);
    expect(new Set(out.map((e) => e.relativePath))).toEqual(
      new Set(['_Konami/Contra.mra', '_Konami/TMNT.mra', '_Konami/sub']),
    );
  });

  it('handles two-level deep nesting', () => {
    const out = entriesAtDepth(fixture, '_Konami/sub', true);
    expect(out.map((e) => e.relativePath)).toEqual(['_Konami/sub/deep.mra']);
  });

  it('returns nothing when subPath does not exist in the tree', () => {
    expect(entriesAtDepth(fixture, 'nonsense', true)).toEqual([]);
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
    const out = entriesAtDepth(entries, '', true);
    expect(out.map((e) => e.relativePath)).toEqual(['Galaga.mra']);
  });

  it('hides a user-organisational subfolder the user emptied (no mras anywhere below)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Metal Slug.mra'),
      sub('_alternatives'),
    ];
    const out = entriesAtDepth(entries, '', true);
    expect(out.map((e) => e.relativePath)).toEqual(['Metal Slug.mra']);
  });

  it('surfaces a subfolder with .mras at depth 1 (direct children)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      sub('_Konami'),
      mra('_Konami/TMNT.mra', 'TMNT.mra'),
    ];
    const out = entriesAtDepth(entries, '', true);
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
    const out = entriesAtDepth(entries, '', true);
    expect(out.map((e) => e.relativePath)).toContain('_alternatives');
  });

  it('handles a completely empty arcade list without throwing', () => {
    expect(entriesAtDepth([], '', true)).toEqual([]);
    expect(entriesAtDepth([], '_Konami', true)).toEqual([]);
    expect(entriesAtDepth([], '', false)).toEqual([]);
  });

  it('never filters out .mra rows (the suppression is folder-only)', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Solo.mra'),
      sub('emptyFolder'),
    ];
    const out = entriesAtDepth(entries, '', true);
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
    const out = entriesAtDepth(entries, '_Konami', true);
    expect(out.map((e) => e.relativePath).sort()).toEqual([
      '_Konami/Contra.mra',
    ]);
  });
});

describe('entriesAtDepth — hidden-aware folder count (bug fix)', () => {
  // Live bug: `_alternatives/` showed in the arcade list but drilled
  // into empty because every mra inside is hidden. The folder-empty
  // check now obeys the same `includeHidden` filter as the visible
  // row list, so the two paths can't disagree.

  it('hides a folder whose subtree contains only HIDDEN mras when includeHidden=false', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Galaga.mra'),
      sub('_alternatives'),
      { ...mra('_alternatives/altA.mra', 'altA.mra'), hidden: true },
      { ...mra('_alternatives/altB.mra', 'altB.mra'), hidden: true },
    ];
    const out = entriesAtDepth(entries, '', false);
    expect(out.map((e) => e.relativePath)).toEqual(['Galaga.mra']);
  });

  it('SHOWS the same folder when includeHidden=true (user flipped "Show hidden")', () => {
    const entries: readonly ArcadeMraEntry[] = [
      mra('Galaga.mra'),
      sub('_alternatives'),
      { ...mra('_alternatives/altA.mra', 'altA.mra'), hidden: true },
    ];
    const out = entriesAtDepth(entries, '', true);
    expect(new Set(out.map((e) => e.relativePath))).toEqual(
      new Set(['Galaga.mra', '_alternatives']),
    );
  });

  it('keeps a folder visible when at least ONE mra below it is visible', () => {
    const entries: readonly ArcadeMraEntry[] = [
      sub('_alternatives'),
      { ...mra('_alternatives/altA.mra', 'altA.mra'), hidden: true },
      mra('_alternatives/altB.mra', 'altB.mra'),
    ];
    const out = entriesAtDepth(entries, '', false);
    expect(out.map((e) => e.relativePath)).toContain('_alternatives');
  });

  it('drops a folder whose only mras live two levels deep WITHOUT a drillable intermediate subfolder', () => {
    // Real-world `parseArcadeMraEntries` only emits TOP-LEVEL subfolder
    // entries — nested directories don't surface as drillable rows. So
    // a layout like `_alternatives/_alts/.alt.mra` (no entry for the
    // intermediate `_alternatives/_alts` directory) has mras the
    // renderer can't reach from `_alternatives/`. Counting them toward
    // "folder has content" would resurface the bug this fix targets:
    // the parent row appears, drilling shows nothing.
    const entries: readonly ArcadeMraEntry[] = [
      sub('_alternatives'),
      // No entry for `_alternatives/HiddenSub` — matches what the
      // real parser emits.
      mra('_alternatives/HiddenSub/altA.mra', 'altA.mra'),
    ];
    const visibleAtRoot = entriesAtDepth(entries, '', false);
    expect(visibleAtRoot.map((e) => e.relativePath)).toEqual([]);
    // And the drill view itself: navigating into `_alternatives` would
    // surface zero rows under the same filter, so the two paths agree.
    const drillAlternatives = entriesAtDepth(entries, '_alternatives', false);
    expect(drillAlternatives.map((e) => e.relativePath)).toEqual([]);
  });

  it('keeps a folder visible when an intermediate subfolder IS in the listing AND drilling through it reaches a visible mra', () => {
    // The case where parseArcadeMraEntries (or a future variant) DOES
    // emit a nested subfolder row: the renderer can drill through it,
    // so deep mras DO count. Recursion only stops at the visibility
    // filter, not at depth.
    const entries: readonly ArcadeMraEntry[] = [
      sub('_alternatives'),
      sub('_alternatives/Konami'),
      mra('_alternatives/Konami/deep.mra', 'deep.mra'),
    ];
    const out = entriesAtDepth(entries, '', false);
    expect(out.map((e) => e.relativePath)).toContain('_alternatives');
  });

  it('hides hidden mras at the current depth when includeHidden=false', () => {
    // The direct-mra-at-depth visibility filter lives in the same
    // function now, so we don't have two separate hide passes that
    // can drift.
    const entries: readonly ArcadeMraEntry[] = [
      mra('Galaga.mra'),
      { ...mra('Hidden.mra', 'Hidden.mra'), hidden: true },
    ];
    expect(entriesAtDepth(entries, '', false).map((e) => e.relativePath)).toEqual([
      'Galaga.mra',
    ]);
    expect(
      new Set(entriesAtDepth(entries, '', true).map((e) => e.relativePath)),
    ).toEqual(new Set(['Galaga.mra', 'Hidden.mra']));
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
