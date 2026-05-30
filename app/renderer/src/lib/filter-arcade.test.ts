import { describe, expect, it } from 'vitest';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import type { RomMetadata } from '@shared/metadata-types';

import { filterArcadeEntries } from '@app/renderer/src/lib/filter-arcade';

function makeMra(args: {
  readonly relativePath: string;
  readonly displayName?: string;
  readonly hidden?: boolean;
}): ArcadeMraEntry {
  return {
    relativePath: args.relativePath,
    displayName: args.displayName ?? args.relativePath,
    kind: 'mra',
    hidden: args.hidden ?? false,
  };
}

function makeFolder(args: {
  readonly relativePath: string;
  readonly displayName?: string;
  readonly kind?: 'subfolder' | 'cores-subfolder';
}): ArcadeMraEntry {
  return {
    relativePath: args.relativePath,
    displayName: args.displayName ?? args.relativePath,
    kind: args.kind ?? 'subfolder',
    hidden: false,
  };
}

function makeMeta(args: {
  readonly name?: string;
  readonly publisher?: string | null;
}): RomMetadata {
  return {
    version: 7,
    hash: 'xyz',
    name: args.name ?? '',
    system: 'Arcade',
    year: null,
    publisher: args.publisher ?? null,
    developer: null,
    genre: null,
    description: null,
    players: null,
    rating: null,
    releaseDate: null,
    boxArtUrl: null,
    titleScreenUrl: null,
    screenshotUrl: null,
    fetchedAt: '2024-01-01T00:00:00.000Z',
    source: 'screenscraper',
  };
}

const NO_META: Record<string, RomMetadata | null> = {};

describe('filterArcadeEntries', () => {
  it('empty query returns input identity (same reference)', () => {
    const entries = [makeMra({ relativePath: 'Metal Slug.mra' })];
    expect(filterArcadeEntries(entries, '', NO_META, entries)).toBe(entries);
  });

  it('whitespace-only query returns input identity', () => {
    const entries = [makeMra({ relativePath: 'Metal Slug.mra' })];
    expect(filterArcadeEntries(entries, '  ', NO_META, entries)).toBe(entries);
  });

  it('matches displayName, case-insensitive', () => {
    const entries = [
      makeMra({ relativePath: 'Metal Slug.mra', displayName: 'Metal Slug' }),
      makeMra({ relativePath: 'Pac-Man.mra', displayName: 'Pac-Man' }),
    ];
    const result = filterArcadeEntries(entries, 'slug', NO_META, entries);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBe('Metal Slug.mra');
  });

  it('matches relativePath (e.g. subfolder prefix in query)', () => {
    // Query "_konami" matches entries whose relativePath contains "_konami"
    const entries = [
      makeMra({ relativePath: '_Konami/TMNT.mra', displayName: 'TMNT' }),
      makeMra({ relativePath: 'Metal Slug.mra', displayName: 'Metal Slug' }),
    ];
    const result = filterArcadeEntries(entries, '_konami', NO_META, entries);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBe('_Konami/TMNT.mra');
  });

  it('matches metadata name when present', () => {
    const entries = [
      makeMra({ relativePath: 'tmnt.mra', displayName: 'tmnt' }),
      makeMra({ relativePath: 'pacman.mra', displayName: 'pacman' }),
    ];
    const meta: Record<string, RomMetadata | null> = {
      'tmnt.mra': makeMeta({ name: 'Teenage Mutant Ninja Turtles' }),
    };
    const result = filterArcadeEntries(entries, 'ninja turtles', meta, entries);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBe('tmnt.mra');
  });

  it('matches metadata publisher when present', () => {
    const entries = [
      makeMra({ relativePath: 'sf2.mra', displayName: 'Street Fighter 2' }),
      makeMra({ relativePath: 'gradius.mra', displayName: 'Gradius' }),
    ];
    const meta: Record<string, RomMetadata | null> = {
      'sf2.mra': makeMeta({ publisher: 'Capcom' }),
      'gradius.mra': makeMeta({ publisher: 'Konami' }),
    };
    const result = filterArcadeEntries(entries, 'capcom', meta, entries);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBe('sf2.mra');
  });

  it('no match returns empty array', () => {
    const entries = [makeMra({ relativePath: 'Metal Slug.mra', displayName: 'Metal Slug' })];
    expect(filterArcadeEntries(entries, 'pacman', NO_META, entries)).toHaveLength(0);
  });

  it('subfolder included by its own displayName', () => {
    const konami = makeFolder({ relativePath: '_Konami', displayName: '_Konami' });
    const mra = makeMra({ relativePath: 'Metal Slug.mra', displayName: 'Metal Slug' });
    const presentable = [konami, mra];
    const allEntries = [
      konami,
      mra,
      makeMra({ relativePath: '_Konami/TMNT.mra', displayName: 'TMNT' }),
    ];
    const result = filterArcadeEntries(presentable, 'konami', NO_META, allEntries);
    expect(result.some((e) => e.relativePath === '_Konami')).toBe(true);
  });

  it('subfolder included because a descendant .mra matches', () => {
    const konami = makeFolder({ relativePath: '_Konami', displayName: '_Konami' });
    const presentable = [konami]; // only the folder at root depth
    const allEntries = [
      konami,
      makeMra({ relativePath: '_Konami/TMNT.mra', displayName: 'Teenage Mutant Ninja Turtles' }),
      makeMra({ relativePath: '_Konami/Gradius.mra', displayName: 'Gradius' }),
    ];
    // Query matches a .mra inside _Konami/ — subfolder should be visible
    const result = filterArcadeEntries(presentable, 'turtles', NO_META, allEntries);
    expect(result).toHaveLength(1);
    expect(result[0]?.relativePath).toBe('_Konami');
  });

  it('subfolder excluded when neither own name nor any child matches', () => {
    const sega = makeFolder({ relativePath: '_Sega', displayName: '_Sega' });
    const presentable = [sega];
    const allEntries = [
      sega,
      makeMra({ relativePath: '_Sega/OutRun.mra', displayName: 'OutRun' }),
    ];
    // Query doesn't match sega name or any of its children
    const result = filterArcadeEntries(presentable, 'konami', NO_META, allEntries);
    expect(result).toHaveLength(0);
  });

  it('preserves original order', () => {
    const entries = [
      makeMra({ relativePath: 'Zebra.mra', displayName: 'Zebra Game' }),
      makeMra({ relativePath: 'Apple.mra', displayName: 'Apple Game' }),
      makeMra({ relativePath: 'Cherry.mra', displayName: 'Cherry Game' }),
    ];
    const result = filterArcadeEntries(entries, 'game', NO_META, entries);
    expect(result.map((e) => e.relativePath)).toEqual([
      'Zebra.mra',
      'Apple.mra',
      'Cherry.mra',
    ]);
  });
});
