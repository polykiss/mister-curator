import { describe, expect, it } from 'vitest';

import {
  classifyFolder,
  countRomGroups,
  groupRomFiles,
  isLaunchableRomExtension,
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
  // disc markers. Round 5: 5+ same-extension files trip the long-tail
  // many-same rule, which is now the *only* signal that flips a
  // cart-format folder to container (the cart-ext rule itself
  // classifies atomic post-round-5 — the X68000 single-game shape).
  const neoGeoSubfolder: FolderContents = {
    files: [
      'mslug.zip',
      'kof97.zip',
      'samsho.zip',
      'lastblade2.zip',
      'garou.zip',
      'mslug3.zip',
    ],
    dirs: [],
  };

  it('returns container for the NEOGEO shape (6+ cart files of one extension)', () => {
    expect(classifyFolder(neoGeoSubfolder)).toBe('container');
  });

  it('returns container when there are subdirectories (likely a tree of games)', () => {
    expect(classifyFolder({ files: [], dirs: ['Region A', 'Region B'] })).toBe(
      'container',
    );
  });

  it('subdirs win over a single cart-format file', () => {
    // PR #11 round 5: a folder with both a cart file AND subdirs is a
    // container — the subdir signal is stronger than the
    // single-game-folder cart shape.
    expect(
      classifyFolder({ files: ['main.zip'], dirs: ['Extras'] }),
    ).toBe('container');
  });
});

describe('classifyFolder — X68000 single-game-folder shape (PR #11 round 5)', () => {
  // Real X68000 shape: `<game-name>/<game>.zip` with no subdirs and
  // optionally a manual or readme alongside. Each folder IS one game;
  // drilling in produces a useless extra click. The cart-ext rule
  // classifies these atomic post-round-5.
  it('returns atomic for one .zip alone', () => {
    expect(classifyFolder({ files: ['Castlevania.zip'], dirs: [] })).toBe('atomic');
  });

  it('returns atomic for a .zip plus a manual companion', () => {
    expect(
      classifyFolder({ files: ['Castlevania.zip', 'manual.txt'], dirs: [] }),
    ).toBe('atomic');
  });

  it('returns atomic for a single file at any of the cart extensions', () => {
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
        'atomic',
      );
    }
  });

  it('returns atomic for 4 cart files of one extension (under the many-same threshold)', () => {
    // Edge case: a small folder with multiple cart files but fewer
    // than SAME_EXTENSION_THRESHOLD (5). The cart-ext rule fires →
    // atomic. False positives are recoverable via the row-menu
    // "Treat as container" override.
    const files = ['a.zip', 'b.zip', 'c.zip', 'd.zip'];
    expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
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

describe('classifyFolder — round 9 extension list expansion (round 5 atomic flip)', () => {
  // Each newly-added extension gets at least one assertion. The
  // names match real MiSTer cores so a regression on any of them
  // would be caught immediately.
  //
  // Round 5: a single file with a cart-format extension classifies
  // atomic (the X68000 / Atari / WonderSwan shape — the folder *is*
  // one game). Container detection moved to subdirs / many-same-ext.
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
    it(`treats a folder containing a single .${ext} file (${name}) as atomic`, () => {
      expect(
        classifyFolder({ files: [`Sample Game.${ext}`], dirs: [] }),
      ).toBe('atomic');
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
    // Mixed case still counts as the same extension family. Round 5:
    // 5 .neo files trip the many-same rule (cart-ext alone would
    // classify atomic post-round-5; many-same is the signal that
    // overrides it for the 5+ NEOGEO-style shape).
    const files = ['a.NEO', 'b.neo', 'c.Neo', 'd.NEO', 'e.neo'];
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

describe('classifyFolder — fix/floppy-folder-classification (FLOPPY_EXTENSIONS)', () => {
  // The reported bug: X68000 multi-disk game folders containing 2-4
  // floppy images each rendered as drillable containers (or — when
  // any subdir like `Manuals/` was present — as containers via the
  // dirs-mean-container rule), forcing a useless drill-in to load
  // the game. Multi-disk folders with 5+ disks (rare but real)
  // tripped the many-same-extension rule and ALSO classified as
  // container.
  //
  // Fix: a third extension bucket (FLOPPY_EXTENSIONS) wired into
  // rule 1, parallel to DISC_EXTENSIONS. ANY floppy file in the
  // folder pins the classification to atomic — overriding both
  // the dirs-mean-container rule AND the many-same-extension rule.
  // Mirrors the disc-marker rule's precedence for the same reason:
  // the file IS the game, subdirs are companions, multiple disks
  // are still one game.

  describe('multi-disk X68000 shape', () => {
    it('2-4 .dim files → atomic', () => {
      expect(
        classifyFolder({
          files: ['Carrot Party Disk 1.dim', 'Carrot Party Disk 2.dim', 'Carrot Party Disk 3.dim'],
          dirs: [],
        }),
      ).toBe('atomic');
    });

    it('single .dim → atomic', () => {
      expect(
        classifyFolder({ files: ['Game.dim'], dirs: [] }),
      ).toBe('atomic');
    });

    it('5+ .dim → atomic (overrides the many-same-extension container rule)', () => {
      // Pre-fix: 5+ files of one extension hit the long-tail
      // many-same rule → container. Post-fix: floppy precedence
      // pins to atomic regardless of count.
      const files: string[] = [];
      for (let i = 1; i <= 8; i += 1) files.push(`Disk ${String(i)}.dim`);
      expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
    });

    it('mixed floppy extensions in one folder still classify atomic', () => {
      expect(
        classifyFolder({
          files: ['disk1.d88', 'disk2.dim'],
          dirs: [],
        }),
      ).toBe('atomic');
    });

    it('floppy file + manual companion → atomic (cart shape carryover)', () => {
      expect(
        classifyFolder({
          files: ['game.adf', 'manual.txt'],
          dirs: [],
        }),
      ).toBe('atomic');
    });

    it('floppy + subdir → atomic (overrides the dirs-mean-container rule)', () => {
      // Real X68000 layout sometimes has Saves/ or Manuals/ next to
      // the disk images. Pre-fix: subdir rule fired → container.
      // Post-fix: floppy precedence pins to atomic.
      expect(
        classifyFolder({
          files: ['game.dim'],
          dirs: ['Manuals'],
        }),
      ).toBe('atomic');
    });
  });

  describe('extension list — every spec-listed floppy extension classifies atomic', () => {
    // Each newly-recognized floppy extension tested via a single-file
    // folder. Includes the shared-with-CART entries so future
    // refactors that move things between sets stay covered.
    const FLOPPY_EXTS = [
      // X68000
      '.dim', '.d88', '.xdf', '.hdm', '.2hd', '.2dd',
      // Amiga
      '.adf', '.adz', '.ipf', '.hdf',
      // Atari ST
      '.st', '.msa', '.stx',
      // Apple II
      '.nib', '.woz', '.po', '.do', '.2mg',
      // C64
      '.d64', '.d71', '.d81', '.g64', '.t64',
      // Shared (X68000 / Apple II / Amstrad CPC)
      '.dsk',
      // Spectrum
      '.trd', '.scl',
      // BBC Micro
      '.ssd', '.dsd',
    ] as const;

    it.each(FLOPPY_EXTS)('single %s file → atomic', (ext) => {
      expect(classifyFolder({ files: [`Game${ext}`], dirs: [] })).toBe(
        'atomic',
      );
    });

    it.each(FLOPPY_EXTS)('%s is launchable (counts toward sidebar totals)', (ext) => {
      expect(isLaunchableRomExtension(`Game${ext}`)).toBe(true);
    });
  });

  describe('non-floppy folders unchanged', () => {
    it('three .txt files → unknown (no floppy/cart/disc — falls through to unknown)', () => {
      // Pre-existing behavior preserved: classifyFolder returns
      // 'unknown' for un-recognizable shapes; resolveClassification
      // turns 'unknown' into 'atomic' for safety.
      expect(
        classifyFolder({
          files: ['a.txt', 'b.txt', 'c.txt'],
          dirs: [],
        }),
      ).toBe('unknown');
    });

    it('NEOGEO 6+ .zip files → container (many-same-extension still wins for non-floppy)', () => {
      // Regression pin: floppy precedence MUST NOT cross-contaminate
      // the .zip cart-shape. NEOGEO's 1 World A-Z layout still
      // classifies as container.
      const files = ['mslug.zip', 'kof97.zip', 'samsho.zip', 'lastblade2.zip', 'garou.zip', 'mslug3.zip'];
      expect(classifyFolder({ files, dirs: [] })).toBe('container');
    });
  });

  describe('floppy + disc in same folder', () => {
    // Edge case from spec: which atomic-rule wins doesn't matter
    // outcome-wise (both → atomic) but pin the behavior so the
    // contract is explicit. Both signals fire in rule 1 — the OR
    // returns true at the first match (disc check runs first as a
    // happenstance of code order, not a load-bearing precedence).
    it('atomic wins regardless of which rule fires first', () => {
      expect(
        classifyFolder({
          files: ['game.cue', 'game.bin', 'game.dim'],
          dirs: [],
        }),
      ).toBe('atomic');
      // Reverse order in the file list — still atomic.
      expect(
        classifyFolder({
          files: ['game.dim', 'game.cue'],
          dirs: [],
        }),
      ).toBe('atomic');
    });
  });
});

describe('classifyFolder — fix/scrape-and-count-correctness commit 3 (disc collection refinement)', () => {
  // Pre-fix: any folder containing a disc extension pinned to atomic
  // unconditionally — so a PSX `_translations/` directory holding 30
  // independent `.iso` files rendered as one drill-down-blocked row.
  // Post-fix: when the disc-marker rule fires AND the folder is flat
  // AND > 5 distinct game-groups live there, classify as container so
  // the user can pick a game.

  it('PSX collection: 30 flat .iso files → container (was atomic)', () => {
    const files: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      files.push(`Translation ${String(i).padStart(2, '0')}.iso`);
    }
    expect(classifyFolder({ files, dirs: [] })).toBe('container');
  });

  it('above the threshold (6 .iso files) → container', () => {
    const files = [
      'A.iso', 'B.iso', 'C.iso', 'D.iso', 'E.iso', 'F.iso',
    ];
    expect(classifyFolder({ files, dirs: [] })).toBe('container');
  });

  it('exactly at the threshold (5 .iso files) → atomic', () => {
    const files = ['A.iso', 'B.iso', 'C.iso', 'D.iso', 'E.iso'];
    expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
  });

  it('Saturn shape: 1 .cue + 30 .bin → 1 group → atomic (unchanged)', () => {
    const files: string[] = ['game.cue'];
    for (let i = 1; i <= 30; i += 1) {
      files.push(`game (Track ${String(i).padStart(2, '0')}).bin`);
    }
    expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
  });

  it('multi-disc release: 2 .cue + their .bins → 2 groups → atomic (unchanged)', () => {
    expect(
      classifyFolder({
        files: [
          'Game.cue',
          'Game (Track 01).bin',
          'Game (Track 02).bin',
          'Game Disc 2.cue',
          'Game Disc 2 (Track 01).bin',
        ],
        dirs: [],
      }),
    ).toBe('atomic');
  });

  it('disc-collection refinement DOES NOT fire when subdirs are present', () => {
    // Subdirs mean the user organised content into folders — the
    // dirs rule (or the looksLikeDiscSet shape) handles it.
    // Refinement only flips flat folders.
    const files: string[] = [];
    for (let i = 0; i < 10; i += 1) files.push(`Game ${String(i)}.iso`);
    expect(
      classifyFolder({ files, dirs: ['Manuals'] }),
    ).toBe('atomic');
  });

  it('floppy precedence still wins over the disc-collection refinement', () => {
    // A folder with both floppy AND many disc images: floppy pins
    // first. (Real-world this combo is rare but the rule order is
    // the load-bearing contract.)
    const files: string[] = ['game.dim'];
    for (let i = 0; i < 10; i += 1) files.push(`Game ${String(i)}.iso`);
    expect(classifyFolder({ files, dirs: [] })).toBe('atomic');
  });
});

describe('groupRomFiles — fix/scrape-and-count-correctness commit 2', () => {
  // Disc-set grouping: a `.cue` claims sibling `.bin` files whose
  // basename starts at a name boundary with the cue's stem. Other
  // files (`.iso`, `.chd`, `.gdi`, standalone `.bin`, plain carts)
  // each count as one game.

  it('Saturn shape: one .cue + N .bin tracks → 1 group', () => {
    const groups = groupRomFiles([
      'Castlevania.cue',
      'Castlevania (Track 01).bin',
      'Castlevania (Track 02).bin',
      'Castlevania (Track 03).bin',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.representative).toBe('Castlevania.cue');
    expect(groups[0]?.files.length).toBe(4);
    expect(countRomGroups([
      'Castlevania.cue',
      'Castlevania (Track 01).bin',
      'Castlevania (Track 02).bin',
      'Castlevania (Track 03).bin',
    ])).toBe(1);
  });

  it('multi-disc set: two .cue + their respective .bin siblings → 2 groups', () => {
    expect(
      countRomGroups([
        'Game.cue',
        'Game (Track 01).bin',
        'Game (Track 02).bin',
        'Game Disc 2.cue',
        'Game Disc 2 (Track 01).bin',
        'Game Disc 2 (Track 02).bin',
      ]),
    ).toBe(2);
  });

  it('longest cue stem wins when more than one could claim a .bin', () => {
    // `Game.cue` and `Game Disc 2.cue` both prefix `Game Disc 2 (Track
    // 01).bin`. Longest-match (`Game Disc 2`) keeps that .bin in the
    // disc-2 group instead of falsely sucking it into the disc-1 group.
    const groups = groupRomFiles([
      'Game.cue',
      'Game Disc 2.cue',
      'Game Disc 2 (Track 01).bin',
    ]);
    expect(groups).toHaveLength(2);
    const disc2 = groups.find((g) => g.representative === 'Game Disc 2.cue');
    expect(disc2?.files).toEqual([
      'Game Disc 2.cue',
      'Game Disc 2 (Track 01).bin',
    ]);
  });

  it('boundary check prevents Game.cue from claiming Gameboy.bin', () => {
    // `Gameboy.bin` startsWith `game` but the next character (`b`) is
    // alphanumeric, so it's NOT at a name boundary — different game.
    expect(
      countRomGroups(['Game.cue', 'Game (Track 01).bin', 'Gameboy.bin']),
    ).toBe(2);
  });

  it('standalone .bin (no .cue claims it) is its own group', () => {
    expect(countRomGroups(['Loose Track.bin'])).toBe(1);
  });

  it('.iso / .chd / .gdi each count as one group per file', () => {
    expect(
      countRomGroups([
        'Game A.iso',
        'Game B.iso',
        'Game C.chd',
        'Game D.gdi',
      ]),
    ).toBe(4);
  });

  it('.dim multi-disk floppy games do NOT collapse at this layer', () => {
    // Floppy multi-disk grouping is the atomic-folder classifier's job
    // (the whole folder = one game). At the file-list layer each .dim
    // is its own group; flat container folders that should be 1 game
    // rely on the atomic classification upstream.
    expect(countRomGroups(['Game Disk 1.dim', 'Game Disk 2.dim'])).toBe(2);
  });

  it('NEOGEO 30 .zip files → 30 groups (one per game)', () => {
    const files: string[] = [];
    for (let i = 0; i < 30; i += 1) files.push(`mslug${String(i)}.zip`);
    expect(countRomGroups(files)).toBe(30);
  });

  it('case-insensitive cue stem match', () => {
    expect(
      countRomGroups([
        'Game.CUE',
        'Game (Track 01).BIN',
        'GAME (Track 02).bin',
      ]),
    ).toBe(1);
  });

  it('the .cue is the group representative even when listed last', () => {
    const groups = groupRomFiles([
      'Game (Track 01).bin',
      'Game (Track 02).bin',
      'Game.cue',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.representative).toBe('Game (Track 01).bin');
    // First file inserted becomes the representative — pin that the
    // group itself contains all three (cue + both bins).
    expect(groups[0]?.files.length).toBe(3);
  });

  it('empty input → 0 groups', () => {
    expect(countRomGroups([])).toBe(0);
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

describe('isLaunchableRomExtension — PR-B (PR #24) positive ROM filter', () => {
  // The cores-list count had been inflated by anything that passed the
  // negative `shouldCountAsRom` filter (no system-folder ancestor, not
  // BIOS-named) regardless of extension. Real-MiSTer NES showed ~680
  // ROMs vs 25 actual because .png screenshots, .ips ROM-hack patches,
  // .nfo notes etc. inside non-system folders all counted. This filter
  // is the positive layer that excludes those by extension.

  describe('common cartridge formats — true', () => {
    it.each([
      ['.nes', 'NES cartridge'],
      ['.smc', 'SNES cartridge'],
      ['.sfc', 'SNES cartridge (alt)'],
      ['.gba', 'Game Boy Advance'],
      ['.gb', 'Game Boy'],
      ['.gbc', 'Game Boy Color'],
      ['.md', 'Sega Genesis / Mega Drive'],
      ['.zip', 'Archived cartridge dump'],
      ['.7z', 'Archived cartridge dump (7z)'],
      ['.bin', 'Generic binary cartridge'],
    ])('counts %s files (%s)', (ext) => {
      expect(isLaunchableRomExtension(`Game${ext}`)).toBe(true);
    });
  });

  describe('disc image formats — true', () => {
    it.each([
      ['.cue', 'CUE sheet (Saturn / MegaCD / etc.)'],
      ['.gdi', 'Dreamcast GDI'],
      ['.iso', 'ISO image'],
      ['.chd', 'Compressed Hunks of Data'],
    ])('counts %s files (%s)', (ext) => {
      expect(isLaunchableRomExtension(`Disc${ext}`)).toBe(true);
    });
  });

  describe('PR-B (PR #24) extension expansions — true', () => {
    // These extensions weren't in the pre-PR-B `CART_EXTENSIONS` list
    // because no path needed them (`classifyFolder` could fall back
    // to `unknown → atomic`). The cores-list count needs them to
    // recognize C64 disk images (.d64), Famicom Disk System (.fds),
    // generic .rom files, etc. as launchable.
    it.each([
      ['.d64', 'Commodore 64 disk image'],
      ['.t64', 'Commodore 64 tape archive'],
      ['.crt', 'Commodore 64 cartridge'],
      ['.prg', 'Commodore 64 program'],
      ['.rom', 'Generic ROM (BIOS-named .rom files filtered separately)'],
      ['.fds', 'Famicom Disk System'],
      ['.unf', 'NES UNIF format'],
      ['.unif', 'NES UNIF format (long)'],
      ['.atr', 'Atari 8-bit disk image'],
      ['.xex', 'Atari 8-bit executable'],
    ])('counts %s files (%s)', (ext) => {
      expect(isLaunchableRomExtension(`Game${ext}`)).toBe(true);
    });
  });

  describe('non-ROM extensions — false (this is the bug fix)', () => {
    it.each([
      ['.pal', 'NES palette file (Palettes/ folder content)'],
      ['.ips', 'ROM-hack patch (Hacks/ folder content)'],
      ['.nfo', 'Release notes'],
      ['.dat', 'Data table (cheat list, mapping)'],
      ['.png', 'Screenshot'],
      ['.jpg', 'Box art image'],
      ['.pdf', 'Manual'],
      ['.txt', 'Readme'],
      ['.sav', 'Save state'],
      ['.srm', 'SRAM dump'],
      ['.nsf', 'NES Sound File (music, not playable)'],
      ['.xml', 'Config (also caught by shouldCountAsRom)'],
      ['.ini', 'Config (also caught by shouldCountAsRom)'],
    ])('does NOT count %s files (%s)', (ext) => {
      expect(isLaunchableRomExtension(`File${ext}`)).toBe(false);
    });
  });

  describe('case sensitivity', () => {
    it('matches uppercase extensions', () => {
      expect(isLaunchableRomExtension('GAME.NES')).toBe(true);
      expect(isLaunchableRomExtension('disc.CUE')).toBe(true);
      expect(isLaunchableRomExtension('art.PNG')).toBe(false);
    });

    it('matches mixed-case extensions', () => {
      expect(isLaunchableRomExtension('Game.NeS')).toBe(true);
      expect(isLaunchableRomExtension('art.Png')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('returns false for files with no extension', () => {
      expect(isLaunchableRomExtension('readme')).toBe(false);
      expect(isLaunchableRomExtension('LICENSE')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isLaunchableRomExtension('')).toBe(false);
    });

    it('treats dot-prefixed names correctly — extension is what follows the LAST dot', () => {
      // `.gitkeep` has extension `.gitkeep` (everything after the
      // leading dot) — not in the launchable list.
      expect(isLaunchableRomExtension('.gitkeep')).toBe(false);
      // `.hidden.nes` has extension `.nes` — last-dot rule applies.
      expect(isLaunchableRomExtension('.hidden.nes')).toBe(true);
    });

    it('handles multi-dot filenames by using the last dot', () => {
      expect(isLaunchableRomExtension('Game.with.dots.nes')).toBe(true);
      expect(isLaunchableRomExtension('Game (USA, v1.1).png')).toBe(false);
    });
  });
});
