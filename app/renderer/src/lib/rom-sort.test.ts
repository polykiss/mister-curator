import { describe, expect, it } from 'vitest';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import {
  DEFAULT_SORT,
  isPinnedRow,
  nextSortState,
  sortRoms,
  type SortState,
} from '@app/renderer/src/lib/rom-sort';

function makeRom(args: {
  readonly filename: string;
  readonly displayName?: string;
  readonly kind?: Rom['kind'];
  readonly hidden?: boolean;
}): Rom {
  return {
    coreId: 'SNES',
    filename: args.filename,
    displayName: args.displayName ?? args.filename,
    sizeBytes: 1024,
    hidden: args.hidden ?? false,
    path: `/media/fat/games/SNES/${args.filename}`,
    kind: args.kind ?? 'file',
    relativePath: args.filename,
  };
}

function makeMeta(overrides: Partial<RomMetadata>): RomMetadata {
  return {
    version: 4,
    hash: 'a'.repeat(32),
    name: '?',
    system: 'Super Nintendo Entertainment System',
    year: null,
    publisher: null,
    developer: null,
    genre: null,
    description: null,
    players: null,
    rating: null,
    releaseDate: null,
    boxArtUrl: null,
    titleScreenUrl: null,
    screenshotUrl: null,
    source: 'screenscraper',
    fetchedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

function row(
  rom: Rom,
  metadata: RomMetadata | null | undefined = undefined,
): { readonly rom: Rom; readonly metadata: RomMetadata | null | undefined } {
  return { rom, metadata };
}

describe('nextSortState', () => {
  it('clicking a different column sets it to asc', () => {
    expect(nextSortState({ key: 'name', dir: 'asc' }, 'year')).toEqual({
      key: 'year',
      dir: 'asc',
    });
    expect(nextSortState({ key: 'name', dir: 'desc' }, 'rating')).toEqual({
      key: 'rating',
      dir: 'asc',
    });
  });

  it('clicking the active column flips asc → desc → asc', () => {
    expect(nextSortState({ key: 'name', dir: 'asc' }, 'name')).toEqual({
      key: 'name',
      dir: 'desc',
    });
    expect(nextSortState({ key: 'name', dir: 'desc' }, 'name')).toEqual({
      key: 'name',
      dir: 'asc',
    });
  });
});

describe('isPinnedRow', () => {
  it('explorable folders (folder-container) pin to the top', () => {
    expect(
      isPinnedRow(makeRom({ filename: 'F', kind: 'folder-container' })),
    ).toBe(true);
  });

  it('single-game folders (folder-atomic) do NOT pin — they sort with games', () => {
    // PR #23 round 3 part 2: folder-atomic IS the X68000 single-game-
    // folder shape; the user thinks of it as "the game", not "a
    // folder". Pinning it to the top fights the mental model.
    expect(isPinnedRow(makeRom({ filename: 'F', kind: 'folder-atomic' }))).toBe(
      false,
    );
  });

  it('file rows do not pin', () => {
    expect(isPinnedRow(makeRom({ filename: 'F', kind: 'file' }))).toBe(false);
  });
});

describe('sortRoms — folder pinning', () => {
  it('explorable folders pin to the top, files + single-game folders follow user sort', () => {
    // PR #23 round 3 part 2: only `folder-container` (explorable
    // folder) pins. `folder-atomic` (single-game folder, the X68000
    // shape) sorts with games — the user thinks of it as a game, not
    // a folder, so the visual "drill-in targets pinned at top" rule
    // shouldn't catch it.
    const rows = [
      row(makeRom({ filename: 'sonic.smc', displayName: 'Sonic' }), makeMeta({ name: 'Sonic' })),
      row(makeRom({ filename: 'fld-z', displayName: 'Z Folder', kind: 'folder-container' })),
      row(makeRom({ filename: 'aria.gba', displayName: 'Aria' }), makeMeta({ name: 'Aria' })),
      row(makeRom({ filename: 'castlevania', displayName: 'Castlevania', kind: 'folder-atomic' })),
    ];
    const state: SortState = { key: 'name', dir: 'asc' };
    const out = sortRoms(rows, state);
    // Pinned: just the container (Z Folder), alphabetical-asc immune
    // to user direction.
    expect(out[0]?.rom.displayName).toBe('Z Folder');
    // Mixed below (asc): Aria, Castlevania (folder-atomic, single-game),
    // Sonic. Articles stripped so the comparison is lowercase first
    // letter.
    expect(out.slice(1).map((r) => r.rom.displayName)).toEqual([
      'Aria',
      'Castlevania',
      'Sonic',
    ]);
  });
});

describe('sortRoms — by name', () => {
  it('asc + leading article stripped', () => {
    const rows = [
      row(makeRom({ filename: 'b.smc' }), makeMeta({ name: 'The Legend of Zelda' })),
      row(makeRom({ filename: 'a.smc' }), makeMeta({ name: 'Aladdin' })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ name: 'A Boy and His Blob' })),
    ];
    const out = sortRoms(rows, { key: 'name', dir: 'asc' });
    expect(out.map((r) => r.metadata?.name)).toEqual([
      'Aladdin',
      'A Boy and His Blob',
      'The Legend of Zelda',
    ]);
  });

  it('falls back to filename when metadata.name is absent', () => {
    const rows = [
      row(makeRom({ filename: 'zelda.smc', displayName: 'zelda.smc' })),
      row(makeRom({ filename: 'aladdin.smc', displayName: 'aladdin.smc' })),
    ];
    const out = sortRoms(rows, { key: 'name', dir: 'asc' });
    expect(out.map((r) => r.rom.displayName)).toEqual([
      'aladdin.smc',
      'zelda.smc',
    ]);
  });

  it('desc reverses', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ name: 'Aladdin' })),
      row(makeRom({ filename: 'b.smc' }), makeMeta({ name: 'Sonic' })),
    ];
    const out = sortRoms(rows, { key: 'name', dir: 'desc' });
    expect(out.map((r) => r.metadata?.name)).toEqual(['Sonic', 'Aladdin']);
  });
});

describe('sortRoms — by year', () => {
  it('asc orders by numeric year, missing years to the end', () => {
    const rows = [
      row(makeRom({ filename: 'b.smc' }), makeMeta({ year: 1991 })),
      row(makeRom({ filename: 'a.smc' }), makeMeta({ year: null })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ year: 1986 })),
    ];
    const out = sortRoms(rows, { key: 'year', dir: 'asc' });
    expect(out.map((r) => r.metadata?.year)).toEqual([1986, 1991, null]);
  });

  it('desc reverses present values; missing still at the end', () => {
    const rows = [
      row(makeRom({ filename: 'b.smc' }), makeMeta({ year: 1991 })),
      row(makeRom({ filename: 'a.smc' }), makeMeta({ year: null })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ year: 1986 })),
    ];
    const out = sortRoms(rows, { key: 'year', dir: 'desc' });
    // Per spec: missing values land at the end regardless of direction.
    expect(out.map((r) => r.metadata?.year)).toEqual([1991, 1986, null]);
  });
});

describe('sortRoms — by genre', () => {
  it('asc sorts by primary genre, missing genres to the end', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ genre: 'Platform' })),
      row(makeRom({ filename: 'b.smc' }), makeMeta({ genre: null })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ genre: 'Action, Adventure' })),
    ];
    const out = sortRoms(rows, { key: 'genre', dir: 'asc' });
    // pickPrimaryGenre takes the first comma-separated piece.
    expect(out.map((r) => r.metadata?.genre)).toEqual([
      'Action, Adventure',
      'Platform',
      null,
    ]);
  });
});

describe('sortRoms — by rating', () => {
  it('asc orders by numeric rating, missing ratings to the end', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ rating: 9.5 })),
      row(makeRom({ filename: 'b.smc' }), makeMeta({ rating: null })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ rating: 7 })),
    ];
    const out = sortRoms(rows, { key: 'rating', dir: 'asc' });
    expect(out.map((r) => r.metadata?.rating)).toEqual([7, 9.5, null]);
  });

  it('desc reverses present, missing still at end', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ rating: 9.5 })),
      row(makeRom({ filename: 'b.smc' }), makeMeta({ rating: null })),
      row(makeRom({ filename: 'c.smc' }), makeMeta({ rating: 7 })),
    ];
    const out = sortRoms(rows, { key: 'rating', dir: 'desc' });
    expect(out.map((r) => r.metadata?.rating)).toEqual([9.5, 7, null]);
  });
});

describe('sortRoms — DEFAULT_SORT is name asc', () => {
  it('matches the spec default', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'name', dir: 'asc' });
  });
});

describe('sortRoms — PR-D2 userOverride layering', () => {
  // Sort goes through the same display-merge helpers as the
  // visible row text. If the user renames a row to "Aaa" via the
  // edit modal, that row sorts to the top — matches what the user
  // sees on screen.

  it('sort by name uses userOverride.name when set', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ name: 'Sonic' })),
      row(
        makeRom({ filename: 'b.smc' }),
        // SS resolved as "Zelda" but the user overrode to "Aardvark".
        // The override wins → row sorts to the top.
        {
          ...makeMeta({ name: 'Zelda' }),
          userOverride: { name: 'Aardvark' },
        },
      ),
    ];
    const out = sortRoms(rows, { key: 'name', dir: 'asc' });
    expect(out.map((r) => r.metadata?.name)).toEqual(['Zelda', 'Sonic']);
    // The display-merge name "Aardvark" drove the sort, but the
    // raw `metadata.name` is still "Zelda" — the test reads it
    // directly to prove the data wasn't mutated.
  });

  it('sort by year uses userOverride.year when set', () => {
    const rows = [
      row(makeRom({ filename: 'a.smc' }), makeMeta({ year: 1995 })),
      row(
        makeRom({ filename: 'b.smc' }),
        {
          ...makeMeta({ year: 2010 }),
          userOverride: { year: 1985 },
        },
      ),
    ];
    const out = sortRoms(rows, { key: 'year', dir: 'asc' });
    // Override 1985 sorts before source 1995.
    expect(out.map((r) => r.metadata?.year)).toEqual([2010, 1995]);
  });
});
