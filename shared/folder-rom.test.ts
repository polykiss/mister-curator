import { describe, expect, it } from 'vitest';

import {
  classifyFolder,
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
