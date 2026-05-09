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
  it('folder rows pin', () => {
    expect(isPinnedRow(makeRom({ filename: 'F', kind: 'folder-atomic' }))).toBe(
      true,
    );
    expect(
      isPinnedRow(makeRom({ filename: 'F', kind: 'folder-container' })),
    ).toBe(true);
  });

  it('file rows do not pin', () => {
    expect(isPinnedRow(makeRom({ filename: 'F', kind: 'file' }))).toBe(false);
  });
});

describe('sortRoms — folder pinning', () => {
  it('folders pin to the top regardless of sort, files follow user sort', () => {
    const rows = [
      row(makeRom({ filename: 'sonic.smc', displayName: 'Sonic' }), makeMeta({ name: 'Sonic' })),
      row(makeRom({ filename: 'fld-z', displayName: 'Z Folder', kind: 'folder-container' })),
      row(makeRom({ filename: 'aria.gba', displayName: 'Aria' }), makeMeta({ name: 'Aria' })),
      row(makeRom({ filename: 'fld-a', displayName: 'A Folder', kind: 'folder-atomic' })),
    ];
    const state: SortState = { key: 'name', dir: 'desc' };
    const out = sortRoms(rows, state);
    // Folders first, alphabetical asc among themselves regardless of
    // the user-asked desc.
    expect(out.slice(0, 2).map((r) => r.rom.displayName)).toEqual([
      'A Folder',
      'Z Folder',
    ]);
    // Files after, user's desc applied.
    expect(out.slice(2).map((r) => r.rom.displayName)).toEqual([
      'Sonic',
      'Aria',
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
