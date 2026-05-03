import { describe, expect, it } from 'vitest';

import {
  classifyFolder,
  classifyFromFlags,
  resolveClassification,
  type FolderContents,
} from '@shared/folder-rom';

describe('classifyFolder — disc / atomic shape', () => {
  // Saturn-shaped disc folder: a `.cue` plus track .bin files.
  const saturn: FolderContents = {
    files: [
      'Castlevania - Symphony of the Night.cue',
      'Castlevania - Symphony of the Night (Track 01).bin',
      'Castlevania - Symphony of the Night (Track 02).bin',
    ],
    dirs: [],
  };

  it('returns atomic when a disc-image extension is present', () => {
    expect(classifyFolder(saturn)).toBe('atomic');
  });

  it('returns atomic for any of the disc extensions', () => {
    for (const ext of ['.cue', '.gdi', '.iso', '.chd', '.CUE', '.GDI', '.ISO', '.CHD']) {
      expect(
        classifyFolder({ files: [`game${ext}`], dirs: [] }),
      ).toBe('atomic');
    }
  });

  it('returns atomic for track-numbered files even without a .cue', () => {
    // Some MegaCD dumps don't ship a .cue; fall back to track pattern.
    const megaCd: FolderContents = {
      files: [
        'BC Racers (Track 01).bin',
        'BC Racers (Track 02).bin',
        'BC Racers (Track 03).bin',
      ],
      dirs: [],
    };
    expect(classifyFolder(megaCd)).toBe('atomic');
  });

  it('disc evidence wins over cart-extension evidence', () => {
    // .bin alone would otherwise match cart-ext, but a .cue pin to
    // atomic. The order of rules guarantees this.
    const mixed: FolderContents = {
      files: ['game.cue', 'game.bin'],
      dirs: [],
    };
    expect(classifyFolder(mixed)).toBe('atomic');
  });
});

describe('classifyFolder — container shape', () => {
  // NEOGEO-shaped organisational folder: many cartridge .zips, no
  // disc markers.
  const neoGeoSubfolder: FolderContents = {
    files: ['mslug.zip', 'kof97.zip', 'samsho.zip', 'lastblade2.zip'],
    dirs: [],
  };

  it('returns container when only cart-shape extensions present', () => {
    expect(classifyFolder(neoGeoSubfolder)).toBe('container');
  });

  it('returns container for any of the cart extensions', () => {
    for (const ext of [
      '.zip',
      '.7z',
      '.rar',
      '.sfc',
      '.smc',
      '.nes',
      '.gba',
      '.gb',
      '.gbc',
      '.md',
      '.gen',
      '.pce',
      '.lnx',
      '.col',
      '.gg',
      '.sms',
      '.a78',
      '.a26',
    ]) {
      expect(classifyFolder({ files: [`game${ext}`], dirs: [] })).toBe(
        'container',
      );
    }
  });

  it('returns container when there are subdirectories (likely a tree of games)', () => {
    expect(classifyFolder({ files: [], dirs: ['Region A', 'Region B'] })).toBe(
      'container',
    );
  });
});

describe('classifyFolder — unknown shape', () => {
  it('returns unknown for an empty folder', () => {
    expect(classifyFolder({ files: [], dirs: [] })).toBe('unknown');
  });

  it('returns unknown for a few files with no recognisable extensions', () => {
    expect(
      classifyFolder({ files: ['readme', 'notes.txt', 'license'], dirs: [] }),
    ).toBe('unknown');
  });
});

describe('classifyFolder — round 9 extension list expansion', () => {
  // Each newly-added extension gets at least one assertion. The
  // names match real MiSTer cores so a regression on any of them
  // would be caught immediately.
  const KNOWN_EXTENSION_CASES: readonly { ext: string; name: string }[] = [
    { ext: 'neo', name: 'NeoGeo native cart' },
    { ext: 'j64', name: 'Atari Jaguar (.j64)' },
    { ext: 'jag', name: 'Atari Jaguar (.jag)' },
    { ext: '32x', name: 'Sega 32X' },
    { ext: 'col', name: 'ColecoVision' },
    { ext: 'int', name: 'Intellivision' },
    { ext: 'vec', name: 'Vectrex' },
    { ext: 'ws', name: 'WonderSwan' },
    { ext: 'wsc', name: 'WonderSwan Color' },
    { ext: 'lnx', name: 'Atari Lynx' },
    { ext: 'a78', name: 'Atari 7800' },
    { ext: 'a26', name: 'Atari 2600' },
    { ext: 'tap', name: 'Cassette tape (.tap)' },
    { ext: 'tzx', name: 'ZX Spectrum (.tzx)' },
    { ext: 'dsk', name: 'Disk image (.dsk)' },
    { ext: 'cdt', name: 'Amstrad CPC (.cdt)' },
    { ext: 'cas', name: 'Cassette (.cas)' },
    { ext: 'cdi', name: 'Sega Dreamcast (.cdi)' },
    { ext: 'adf', name: 'Amiga disk (.adf)' },
    { ext: 'adz', name: 'Compressed Amiga disk (.adz)' },
    { ext: 'hdf', name: 'Amiga hard disk (.hdf)' },
    { ext: 'st', name: 'Atari ST disk (.st)' },
    { ext: 'msa', name: 'Atari ST (.msa)' },
    { ext: 'uef', name: 'BBC Micro (.uef)' },
    { ext: 'cdx', name: 'Multiple (.cdx)' },
    { ext: 'bbc', name: 'BBC' },
  ];

  for (const { ext, name } of KNOWN_EXTENSION_CASES) {
    it(`treats a folder containing a single .${ext} file (${name}) as container`, () => {
      expect(
        classifyFolder({ files: [`Sample Game.${ext}`], dirs: [] }),
      ).toBe('container');
    });
  }
});

describe('classifyFolder — round 9 many-similar-files rule', () => {
  it('catches the NEOGEO regression: 148 .neo files → container', () => {
    // .neo is now in the known-extensions list, but even before that
    // the long-tail rule alone would've caught this. Exercise both
    // signals here.
    const files: string[] = [];
    for (let i = 0; i < 148; i += 1) files.push(`game${String(i).padStart(3, '0')}.neo`);
    expect(classifyFolder({ files, dirs: [] })).toBe('container');
  });

  it('returns container for 6 files sharing an unknown extension (.xyz)', () => {
    const files = ['a.xyz', 'b.xyz', 'c.xyz', 'd.xyz', 'e.xyz', 'f.xyz'];
    expect(classifyFolder({ files, dirs: [] })).toBe('container');
  });

  it('exactly at the threshold: 5 unknown-ext files → container', () => {
    const files = ['a.qqq', 'b.qqq', 'c.qqq', 'd.qqq', 'e.qqq'];
    expect(classifyFolder({ files, dirs: [] })).toBe('container');
  });

  it('returns unknown for 4 files of the same unknown extension (under threshold)', () => {
    const files = ['a.qqq', 'b.qqq', 'c.qqq', 'd.qqq'];
    expect(classifyFolder({ files, dirs: [] })).toBe('unknown');
  });

  it('returns unknown for 10 files spread across 3 unknown extensions (no single extension hits 5)', () => {
    const files = [
      'a.aa',
      'b.aa',
      'c.aa',
      'd.bb',
      'e.bb',
      'f.bb',
      'g.bb',
      'h.cc',
      'i.cc',
      'j.cc',
    ];
    expect(classifyFolder({ files, dirs: [] })).toBe('unknown');
  });

  it('matches extensions case-insensitively when counting', () => {
    // Mixed case still counts as the same extension family.
    const files = ['a.NEO', 'b.neo', 'c.Neo', 'd.NEO', 'e.neo'];
    // .neo is in the known list, so the cart-ext rule fires first;
    // either way the result is container — but the case-insensitivity
    // matters for unknown extensions where the catch-all is the only
    // signal. Construct one of those too:
    expect(classifyFolder({ files, dirs: [] })).toBe('container');

    const unknownMixed = ['a.QQQ', 'b.qqq', 'c.Qqq', 'd.QqQ', 'e.qqq'];
    expect(classifyFolder({ files: unknownMixed, dirs: [] })).toBe('container');
  });

  it('disc rule wins even when many .bin track files would otherwise count', () => {
    // 1 .cue + 30 .bin tracks. The disc-marker rule fires first; the
    // many-similar-files rule never gets a chance. Verifies rule
    // ordering — the regression we'd care about is mistakenly
    // drilling into a disc folder.
    const files: string[] = ['game.cue'];
    for (let i = 1; i <= 30; i += 1) {
      files.push(`game (Track ${String(i).padStart(2, '0')}).bin`);
    }
    expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
  });

  it('files without an extension do not count toward the threshold', () => {
    // Five files that all have empty extensions — the rule should
    // not fire. They go through to the dirs check / unknown.
    const files = ['readme', 'notes', 'license', 'changelog', 'authors'];
    expect(classifyFolder({ files, dirs: [] })).toBe('unknown');
  });
});

describe('classifyFromFlags', () => {
  it('mirrors the content-based classifier on representative inputs', () => {
    // Saturn: hasDisc=1
    expect(
      classifyFromFlags({
        hasDisc: true,
        hasTrack: false,
        hasCart: true,
        hasManySameExt: false,
        hasSubdir: false,
      }),
    ).toBe('atomic');
    // NEOGEO subfolder: hasCart=1
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: true,
        hasManySameExt: false,
        hasSubdir: false,
      }),
    ).toBe('container');
    // Just subdirs (likely organisational tree)
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: false,
        hasManySameExt: false,
        hasSubdir: true,
      }),
    ).toBe('container');
    // Empty / unrecognisable
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: false,
        hasManySameExt: false,
        hasSubdir: false,
      }),
    ).toBe('unknown');
  });

  it('returns container when hasManySameExt fires (long-tail rule)', () => {
    // Round 9 catch-all: even when no recognised cart extension is
    // present, a folder with many files of one extension is treated
    // as a container. The shell-side scan computes this flag.
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: false,
        hasManySameExt: true,
        hasSubdir: false,
      }),
    ).toBe('container');
  });

  it('disc evidence still wins over hasManySameExt', () => {
    // A Saturn-shape folder (`.cue` + many `.bin`s) sets hasDisc=1
    // and hasManySameExt=1 on the device. The disc rule must remain
    // higher-precedence so we never treat a disc folder as drillable.
    expect(
      classifyFromFlags({
        hasDisc: true,
        hasTrack: false,
        hasCart: false,
        hasManySameExt: true,
        hasSubdir: false,
      }),
    ).toBe('atomic');
  });
});

describe('resolveClassification — override layer', () => {
  it('user override wins over the heuristic', () => {
    expect(resolveClassification('container', 'atomic')).toBe('atomic');
    expect(resolveClassification('atomic', 'container')).toBe('container');
  });

  it('falls back to atomic when the heuristic returns unknown', () => {
    expect(resolveClassification('unknown', undefined)).toBe('atomic');
  });

  it('preserves the heuristic call when no override is present', () => {
    expect(resolveClassification('container', undefined)).toBe('container');
    expect(resolveClassification('atomic', undefined)).toBe('atomic');
  });
});
