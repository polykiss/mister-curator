import { describe, expect, it } from 'vitest';

import { isSystemFile } from '@shared/system-files';

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
