import { describe, expect, it } from 'vitest';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import { filterRoms } from '@app/renderer/src/lib/filter-roms';

function makeRom(args: {
  readonly filename: string;
  readonly displayName?: string;
  readonly kind?: Rom['kind'];
  readonly path?: string;
  readonly containedRomPath?: string;
}): Rom {
  return {
    coreId: 'NES',
    filename: args.filename,
    displayName: args.displayName ?? args.filename,
    sizeBytes: 1024,
    hidden: false,
    path: args.path ?? `/media/fat/games/NES/${args.filename}`,
    kind: args.kind ?? 'file',
    containedRomPath: args.containedRomPath,
  };
}

function makeMetadata(args: {
  readonly name?: string;
  readonly publisher?: string | null;
  readonly genre?: string | null;
}): RomMetadata {
  return {
    version: 7,
    hash: 'abc123',
    name: args.name ?? '',
    system: 'NES',
    year: null,
    publisher: args.publisher ?? null,
    developer: null,
    genre: args.genre ?? null,
    description: null,
    players: null,
    rating: null,
    releaseDate: null,
    boxArtUrl: null,
    titleScreenUrl: null,
    screenshotUrl: null,
    screenshotUrls: [],
    box3DUrl: null,
    marqueeUrl: null,
    clearLogoUrl: null,
    source: 'screenscraper',
    fetchedAt: '2024-01-01T00:00:00.000Z',
  };
}

type MetaMap = Record<string, { readonly metadata: RomMetadata | null } | undefined>;

describe('filterRoms', () => {
  it('empty query returns input identity (same reference)', () => {
    const roms = [makeRom({ filename: 'mario.nes' })];
    expect(filterRoms(roms, '', {})).toBe(roms);
  });

  it('whitespace-only query returns input identity', () => {
    const roms = [makeRom({ filename: 'mario.nes' })];
    expect(filterRoms(roms, '   ', {})).toBe(roms);
  });

  it('matches displayName, case-insensitive', () => {
    const roms = [
      makeRom({ filename: 'mario.nes', displayName: 'Super Mario Bros' }),
      makeRom({ filename: 'zelda.nes', displayName: 'The Legend of Zelda' }),
    ];
    const result = filterRoms(roms, 'MARIO', {});
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe('mario.nes');
  });

  it('matches metadata name when present', () => {
    const roms = [
      makeRom({ filename: 'smb.nes', displayName: 'smb' }),
      makeRom({ filename: 'zelda.nes', displayName: 'zelda' }),
    ];
    const metaMap: MetaMap = {
      '/media/fat/games/NES/smb.nes': { metadata: makeMetadata({ name: 'Super Mario Bros.' }) },
      '/media/fat/games/NES/zelda.nes': { metadata: makeMetadata({ name: 'The Legend of Zelda' }) },
    };
    const result = filterRoms(roms, 'super mario', metaMap);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe('smb.nes');
  });

  it('matches publisher when present', () => {
    const roms = [
      makeRom({ filename: 'pac.nes', displayName: 'Pac-Man' }),
      makeRom({ filename: 'mario.nes', displayName: 'Mario' }),
    ];
    const metaMap: MetaMap = {
      '/media/fat/games/NES/pac.nes': {
        metadata: makeMetadata({ publisher: 'Namco' }),
      },
      '/media/fat/games/NES/mario.nes': {
        metadata: makeMetadata({ publisher: 'Nintendo' }),
      },
    };
    const result = filterRoms(roms, 'namco', metaMap);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe('pac.nes');
  });

  it('matches genre when present', () => {
    const roms = [
      makeRom({ filename: 'sf2.sfc', displayName: 'Street Fighter 2' }),
      makeRom({ filename: 'mario.sfc', displayName: 'Super Mario World' }),
    ];
    const metaMap: MetaMap = {
      '/media/fat/games/NES/sf2.sfc': {
        metadata: makeMetadata({ genre: 'Fighting' }),
      },
      '/media/fat/games/NES/mario.sfc': {
        metadata: makeMetadata({ genre: 'Platform' }),
      },
    };
    const result = filterRoms(roms, 'fight', metaMap);
    expect(result).toHaveLength(1);
    expect(result[0]?.filename).toBe('sf2.sfc');
  });

  it('no match returns empty array', () => {
    const roms = [makeRom({ filename: 'mario.nes', displayName: 'Super Mario Bros' })];
    expect(filterRoms(roms, 'pokemon', {})).toHaveLength(0);
  });

  it('null metadata fields do not throw', () => {
    const roms = [makeRom({ filename: 'game.nes', displayName: 'Test Game' })];
    const metaMap: MetaMap = {
      '/media/fat/games/NES/game.nes': {
        metadata: makeMetadata({ name: 'Test Game', publisher: null, genre: null }),
      },
    };
    expect(() => filterRoms(roms, 'test', metaMap)).not.toThrow();
    expect(filterRoms(roms, 'test', metaMap)).toHaveLength(1);
  });

  it('undefined metadata entry does not throw', () => {
    const roms = [makeRom({ filename: 'game.nes', displayName: 'Cool Game' })];
    expect(() => filterRoms(roms, 'cool', {})).not.toThrow();
    expect(filterRoms(roms, 'cool', {})).toHaveLength(1);
  });

  it('folder-container row: matched by own displayName', () => {
    const folder = makeRom({
      filename: '1 World A-Z',
      displayName: '1 World A-Z',
      kind: 'folder-container',
    });
    // folder-container has no metadata lookup path → only displayName matched
    const result = filterRoms([folder], 'world', {});
    expect(result).toHaveLength(1);
  });

  it('folder-container row: NOT included when displayName does not match', () => {
    const folder = makeRom({
      filename: 'Unrelated Folder',
      displayName: 'Unrelated Folder',
      kind: 'folder-container',
    });
    const result = filterRoms([folder], 'mario', {});
    expect(result).toHaveLength(0);
  });

  it('folder-atomic row: matches via containedRomPath metadata', () => {
    const atomicFolder = makeRom({
      filename: 'Xenogears',
      displayName: 'Xenogears',
      kind: 'folder-atomic',
      path: '/media/fat/games/PSX/Xenogears',
      containedRomPath: '/media/fat/games/PSX/Xenogears/disc1.bin',
    });
    const metaMap: MetaMap = {
      '/media/fat/games/PSX/Xenogears/disc1.bin': {
        metadata: makeMetadata({ name: 'Xenogears', publisher: 'SquareSoft', genre: 'RPG' }),
      },
    };
    const result = filterRoms([atomicFolder], 'squaresoft', metaMap);
    expect(result).toHaveLength(1);
  });

  it('preserves original order', () => {
    const roms = [
      makeRom({ filename: 'b.nes', displayName: 'Banana' }),
      makeRom({ filename: 'a.nes', displayName: 'Apple' }),
      makeRom({ filename: 'c.nes', displayName: 'Cherry' }),
    ];
    const result = filterRoms(roms, 'a', {});
    // All three match ('a' is in Banana, Apple, Cherry... actually only Apple and Banana)
    // Let's pick a query that matches 2 out of 3 in order
    const result2 = filterRoms(roms, 'e', {}); // Banana, Apple, Cherry — all have 'e' except... wait
    // 'e' in Banana? no. 'e' in Apple? yes. 'e' in Cherry? yes.
    expect(result2.map((r) => r.filename)).toEqual(['a.nes', 'c.nes']);
  });

  it('performance smoke: 1500-entry list filters in <16ms', () => {
    const roms: Rom[] = [];
    for (let i = 0; i < 1500; i++) {
      roms.push(
        makeRom({
          filename: `rom_${String(i).padStart(4, '0')}.nes`,
          displayName: `ROM Title ${String(i)}`,
        }),
      );
    }
    const t0 = performance.now();
    const result = filterRoms(roms, 'title 1', {});
    const elapsed = performance.now() - t0;
    expect(result.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(16);
  });
});
