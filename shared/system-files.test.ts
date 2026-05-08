import { describe, expect, it } from 'vitest';

import {
  isAutoDetectedSystemFile,
  isAutoDetectedSystemFolder,
  isSystemFile,
  shouldCountAsRom,
} from '@shared/system-files';
import type { SystemFilesMarks } from '@shared/types';

const f = (filename: string): { filename: string; kind: 'file' } => ({
  filename,
  kind: 'file',
});
const d = (filename: string): { filename: string; kind: 'folder' } => ({
  filename,
  kind: 'folder',
});

describe('isSystemFile — Neo Geo BIOS stack (snapshot reality)', () => {
  // Exactly the dozen-odd system files that ship with a typical
  // MiSTer NEOGEO install. The user's snapshot says NEOGEO has
  // "files=12 dirs=9"; this list mirrors the real on-disk shape so
  // the test fails the moment our heuristic regresses against it.
  const NEOGEO_SYSTEM_FILES: readonly string[] = [
    '000-lo.lo',
    'sfix.sfix',
    'sp-s2.sp1',
    'neo-epo.sp1',
    'uni-bios.rom',
    'uni-bioscd.rom',
    'top-sp1.bin',
    'neocd.bin',
    'cd_bios.rom',
    'romsets.xml',
    'gog-romsets.xml',
    'boot.rom',
  ];

  for (const name of NEOGEO_SYSTEM_FILES) {
    it(`flags ${name} as system`, () => {
      expect(isSystemFile(f(name))).toBe(true);
    });
  }

  // Real .neo/.zip ROM names (NEOGEO actually ships ROMs as zips/.neo).
  const NEOGEO_REAL_ROMS: readonly string[] = [
    'mslug.zip',
    'kof97.zip',
    'mslug2.zip',
    'samsho.zip',
    'lastblade2.zip',
  ];

  for (const name of NEOGEO_REAL_ROMS) {
    it(`does NOT flag ${name} as system`, () => {
      expect(isSystemFile(f(name))).toBe(false);
    });
  }
});

describe('isSystemFile — folder rules', () => {
  it('flags Palettes / Overlays / Filters / old as system folders', () => {
    expect(isSystemFile(d('Palettes'))).toBe(true);
    expect(isSystemFile(d('Overlays'))).toBe(true);
    expect(isSystemFile(d('Filters'))).toBe(true);
    expect(isSystemFile(d('old'))).toBe(true);
  });

  it('matches folder names case-insensitively', () => {
    expect(isSystemFile(d('palettes'))).toBe(true);
    expect(isSystemFile(d('OVERLAYS'))).toBe(true);
  });

  it('does NOT flag a normal disc-game folder as system', () => {
    expect(isSystemFile(d('Panzer Dragoon (USA) (1S)'))).toBe(false);
    expect(isSystemFile(d('Castlevania - Symphony of the Night'))).toBe(false);
  });

  it('does NOT flag .xml or .ini names when they are folders, only files', () => {
    // (defensive — folders almost never have these extensions, but the
    // heuristic should never confuse a folder for a config file)
    expect(isSystemFile(d('config.ini'))).toBe(false);
  });
});

describe('isSystemFile — extension rules', () => {
  it('flags every .xml file as system (config heuristic)', () => {
    expect(isSystemFile(f('romsets.xml'))).toBe(true);
    expect(isSystemFile(f('Anything Goes Here.xml'))).toBe(true);
  });

  it('flags every .ini file as system', () => {
    expect(isSystemFile(f('downloader.ini'))).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isSystemFile(f('ROMSETS.XML'))).toBe(true);
    expect(isSystemFile(f('Boot.Rom'))).toBe(true);
    expect(isSystemFile(f('Sfix.Sfix'))).toBe(true);
  });
});

describe('isSystemFile — hidden (dot-prefixed) variants', () => {
  it('treats the hidden form of a system file as system too', () => {
    expect(isSystemFile(f('.cd_bios.rom'))).toBe(true);
    expect(isSystemFile(f('.romsets.xml'))).toBe(true);
  });

  it('treats the hidden form of a real ROM as not-system', () => {
    expect(isSystemFile(f('.mslug.zip'))).toBe(false);
  });
});

describe('isSystemFile — *boot.*/*bios.* suffix patterns', () => {
  // The cases that motivated the suffix rule. AtariLynx's lynxboot.img
  // doesn't match any prefix; before the suffix rule, the count
  // wouldn't drop it and "Hide empty" missed AtariLynx with only its
  // BIOS installed.
  const SUFFIX_HITS: readonly string[] = [
    'lynxboot.img',
    'sega_bios.rom',
    'gba_bios.bin',
    'ngp_bios.bin',
    'pcecd_bios.rom',
    // The plain forms also match (also covered by the prefix rule).
    'boot.img',
    'bios.rom',
  ];
  for (const name of SUFFIX_HITS) {
    it(`flags ${name} via the *boot/*bios suffix rule`, () => {
      expect(isSystemFile(f(name))).toBe(true);
    });
  }

  it('does not flag a real ROM whose name happens to start with letters that look BIOS-y', () => {
    // Suffix rule requires `boot.` or `bios.` immediately before the
    // ext. "Boot Camp Wars.zip" is not flagged.
    expect(isSystemFile(f('Boot Camp Wars.zip'))).toBe(false);
    expect(isSystemFile(f('Bootleg Bird (Hack).gba'))).toBe(false);
  });
});

describe('isSystemFile — edge cases', () => {
  it('returns false for empty filenames', () => {
    expect(isSystemFile(f(''))).toBe(false);
    expect(isSystemFile(d(''))).toBe(false);
  });

  it('does not match prefix-overlapping ROM names', () => {
    // Names that start with letters that overlap a prefix-matched
    // BIOS like "boot." should not get caught.
    expect(isSystemFile(f('booty island.zip'))).toBe(false);
    expect(isSystemFile(f('biosphere.rbf'))).toBe(false);
  });
});

describe('isSystemFile — user-marked layer', () => {
  // The long-tail file types that the heuristic deliberately doesn't
  // chase — palette tables, BIOS variants, mod tools. Auto-detection
  // returns false; a user mark layered on top must flip the result.
  const longTail: readonly string[] = [
    'pal.act',
    'custom.flt',
    'Empty.d64',
    'DolphinDOS_2.0.rom',
    'SpeedDOS_plus_2.7.rom',
    'SID curve designer.html',
    'boot1_opensource.rom',
    'CP-ClockF83_1.3.D64',
  ];

  it('does not auto-detect any of the long-tail names', () => {
    for (const name of longTail) {
      expect(isAutoDetectedSystemFile(f(name))).toBe(false);
    }
  });

  it('returns true when the (coreId, filename) pair is in the marks list', () => {
    const marks: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        { coreId: 'C64', filename: 'DolphinDOS_2.0.rom', markedAt: '2026-05-02' },
      ],
    };
    expect(
      isSystemFile(f('DolphinDOS_2.0.rom'), { marks, coreId: 'C64' }),
    ).toBe(true);
  });

  it('returns false when the marks list lacks the file (unmarked long-tail)', () => {
    const marks: SystemFilesMarks = { schemaVersion: 1, marked: [] };
    expect(isSystemFile(f('Empty.d64'), { marks, coreId: 'C64' })).toBe(false);
  });

  it('returns false when no options are supplied (auto-detector only)', () => {
    expect(isSystemFile(f('Empty.d64'))).toBe(false);
    expect(isSystemFile(f('pal.act'))).toBe(false);
  });

  it('does not bleed marks across cores — same filename, different core', () => {
    const marks: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        { coreId: 'C64', filename: 'shared_name.rom', markedAt: '2026-05-02' },
      ],
    };
    expect(isSystemFile(f('shared_name.rom'), { marks, coreId: 'C64' })).toBe(true);
    expect(isSystemFile(f('shared_name.rom'), { marks, coreId: 'NES' })).toBe(false);
  });

  it('still returns true for an auto-detected file even with no marks', () => {
    expect(isSystemFile(f('boot.rom'), { marks: undefined, coreId: undefined })).toBe(
      true,
    );
  });

  it('marks layer also applies to folders (Palettes / Overlays variants)', () => {
    // The user might mark a custom folder name like "_resources" that
    // isn't in the auto-detect list. The mark wins.
    const marks: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        { coreId: 'Atari800', filename: '_resources', markedAt: '2026-05-02' },
      ],
    };
    expect(
      isSystemFile(d('_resources'), { marks, coreId: 'Atari800' }),
    ).toBe(true);
    // Without the mark, the folder is not auto-detected.
    expect(isSystemFile(d('_resources'))).toBe(false);
  });
});

describe('isAutoDetectedSystemFile (auto layer in isolation)', () => {
  it('returns true for the auto-detector hits', () => {
    expect(isAutoDetectedSystemFile(f('boot.rom'))).toBe(true);
    expect(isAutoDetectedSystemFile(f('lynxboot.img'))).toBe(true);
    expect(isAutoDetectedSystemFile(f('romsets.xml'))).toBe(true);
    expect(isAutoDetectedSystemFile(d('Palettes'))).toBe(true);
  });

  it('returns false for everything outside the auto-detector', () => {
    expect(isAutoDetectedSystemFile(f('mslug.zip'))).toBe(false);
    expect(isAutoDetectedSystemFile(f('pal.act'))).toBe(false);
    expect(isAutoDetectedSystemFile(d('Panzer Dragoon (USA) (1S)'))).toBe(false);
  });
});

describe('isAutoDetectedSystemFolder', () => {
  it('flags the four documented system folders', () => {
    expect(isAutoDetectedSystemFolder('Palettes')).toBe(true);
    expect(isAutoDetectedSystemFolder('Overlays')).toBe(true);
    expect(isAutoDetectedSystemFolder('Filters')).toBe(true);
    expect(isAutoDetectedSystemFolder('old')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isAutoDetectedSystemFolder('OVERLAYS')).toBe(true);
    expect(isAutoDetectedSystemFolder('overlays')).toBe(true);
  });

  it('strips a leading dot before matching', () => {
    expect(isAutoDetectedSystemFolder('.Palettes')).toBe(true);
  });

  it('returns false for non-system folders', () => {
    expect(isAutoDetectedSystemFolder('1 World A-Z')).toBe(false);
    expect(isAutoDetectedSystemFolder('Game Folder')).toBe(false);
    expect(isAutoDetectedSystemFolder('overlays.bak')).toBe(false);
  });
});

describe('shouldCountAsRom — unified filter for matcher + listRoms', () => {
  it('counts a regular top-level file', () => {
    expect(
      shouldCountAsRom({
        relPath: 'mslug.zip',
        isDirectory: false,
        coreId: 'NEOGEO',
      }),
    ).toBe(true);
  });

  it('rejects a top-level system file (BIOS)', () => {
    expect(
      shouldCountAsRom({
        relPath: 'boot.rom',
        isDirectory: false,
        coreId: 'NEOGEO',
      }),
    ).toBe(false);
  });

  it('rejects a top-level system folder (Vectrex/Overlays)', () => {
    expect(
      shouldCountAsRom({
        relPath: 'Overlays',
        isDirectory: true,
        coreId: 'VECTREX',
      }),
    ).toBe(false);
  });

  it('rejects ANY file inside a system-folder ancestor (Vectrex/Overlays/grav-bezel.png)', () => {
    // The Vectrex bug: pre-Round-2-of-PR-#11, the recursive walk
    // counted ~90 PNG files inside `Overlays/` because the walk
    // didn't apply the system-folder filter to nested files.
    // shouldCountAsRom now poisons any path with a system ancestor.
    expect(
      shouldCountAsRom({
        relPath: 'Overlays/grav-bezel.png',
        isDirectory: false,
        coreId: 'VECTREX',
      }),
    ).toBe(false);
  });

  it('counts a regular file inside a non-system ancestor (NEOGEO/1 World A-Z/mslug.zip)', () => {
    expect(
      shouldCountAsRom({
        relPath: '1 World A-Z/mslug.zip',
        isDirectory: false,
        coreId: 'NEOGEO',
      }),
    ).toBe(true);
  });

  it('counts a sub-directory if its ancestors are user-content', () => {
    expect(
      shouldCountAsRom({
        relPath: '1 World A-Z',
        isDirectory: true,
        coreId: 'NEOGEO',
      }),
    ).toBe(true);
  });

  it('honors a user-mark at the leaf level', () => {
    const marks: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [{ coreId: 'C64', filename: 'pal.act', markedAt: '2026-05-08' }],
    };
    expect(
      shouldCountAsRom({
        relPath: 'pal.act',
        isDirectory: false,
        coreId: 'C64',
        marks,
      }),
    ).toBe(false);
  });

  it('honors a user-mark on an ancestor segment', () => {
    const marks: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        { coreId: 'Atari800', filename: '_resources', markedAt: '2026-05-08' },
      ],
    };
    expect(
      shouldCountAsRom({
        relPath: '_resources/some-file.bin',
        isDirectory: false,
        coreId: 'Atari800',
        marks,
      }),
    ).toBe(false);
  });

  it('returns false for an empty path', () => {
    expect(
      shouldCountAsRom({ relPath: '', isDirectory: false, coreId: 'X' }),
    ).toBe(false);
  });
});

describe('shouldCountAsRom — OS metadata filter (issue #17)', () => {
  it('rejects an AppleDouble sidecar at the leaf', () => {
    expect(
      shouldCountAsRom({
        relPath: '._castlevania.chd',
        isDirectory: false,
        coreId: 'GBA',
      }),
    ).toBe(false);
  });

  it('rejects .DS_Store / Thumbs.db / desktop.ini at the leaf', () => {
    for (const name of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '.directory']) {
      expect(
        shouldCountAsRom({
          relPath: name,
          isDirectory: false,
          coreId: 'GENESIS',
        }),
      ).toBe(false);
    }
  });

  it('rejects an OS metadata directory itself', () => {
    for (const name of [
      '.AppleDouble',
      '.Spotlight-V100',
      '.Trashes',
      '.fseventsd',
      '$RECYCLE.BIN',
      'lost+found',
    ]) {
      expect(
        shouldCountAsRom({
          relPath: name,
          isDirectory: true,
          coreId: 'GENESIS',
        }),
      ).toBe(false);
    }
  });

  it('rejects ANY file inside an OS metadata directory ancestor', () => {
    // The macOS-on-MiSTer scenario: someone copies a games dir from a
    // Mac, leaving `.AppleDouble/` shadows and `._sonic.zip` sidecars.
    // Both ancestor and leaf shapes need to fail closed.
    expect(
      shouldCountAsRom({
        relPath: '.AppleDouble/sonic.zip',
        isDirectory: false,
        coreId: 'GENESIS',
      }),
    ).toBe(false);
    expect(
      shouldCountAsRom({
        relPath: '$RECYCLE.BIN/some-rom.gba',
        isDirectory: false,
        coreId: 'GBA',
      }),
    ).toBe(false);
  });

  it('still counts real ROM files alongside OS metadata', () => {
    expect(
      shouldCountAsRom({
        relPath: 'sonic.zip',
        isDirectory: false,
        coreId: 'GENESIS',
      }),
    ).toBe(true);
    expect(
      shouldCountAsRom({
        relPath: 'Castlevania - Aria of Sorrow.gba',
        isDirectory: false,
        coreId: 'GBA',
      }),
    ).toBe(true);
  });
});
