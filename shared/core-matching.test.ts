import { describe, expect, it } from 'vitest';

import type { CoreEntry, HideLedger } from '@shared/types';

import {
  ARCADE_PLACEHOLDER_ID,
  canonicalize,
  computeAutoReapplyChanges,
  computeCoreRenames,
  dottedPath,
  extractCorePrefix,
  isArcadePlaceholder,
  isCoreFile,
  isCoreHidden,
  isRealCore,
  matchRbfsToGamesDirs,
  pathBasename,
  undottedPath,
} from '@shared/core-matching';
import { InMemoryDiagnosticsCollector } from '@shared/diag';

describe('extractCorePrefix', () => {
  it('strips a trailing 8-digit date suffix', () => {
    expect(extractCorePrefix('NES_20240115.rbf')).toBe('NES');
  });

  it('strips dates from compound names', () => {
    expect(extractCorePrefix('Atari2600_20240220.rbf')).toBe('Atari2600');
  });

  it('strips a leading dot (currently-hidden form)', () => {
    expect(extractCorePrefix('.NES_20240115.rbf')).toBe('NES');
  });

  it('preserves underscores when the trailing segment is not a date', () => {
    expect(extractCorePrefix('Tatung_Einstein.rbf')).toBe('Tatung_Einstein');
  });

  it('handles cores with no underscores at all', () => {
    expect(extractCorePrefix('MyCore.rbf')).toBe('MyCore');
  });

  it('handles folder-shaped cores (no .rbf suffix)', () => {
    expect(extractCorePrefix('AO486')).toBe('AO486');
    expect(extractCorePrefix('.AO486')).toBe('AO486');
  });

  it('strips longer (14-digit) datetime suffixes', () => {
    expect(extractCorePrefix('Foo_20240115123045.rbf')).toBe('Foo');
  });

  it('is case-insensitive for the .rbf suffix only', () => {
    expect(extractCorePrefix('NES_20240115.RBF')).toBe('NES');
  });

  it('strips the .mgl extension just like .rbf', () => {
    expect(extractCorePrefix('GameboyColor.mgl')).toBe('GameboyColor');
    expect(extractCorePrefix('GameboyColor.MGL')).toBe('GameboyColor');
  });

  it('preserves spaces in core names with no date suffix (real .mgl shape)', () => {
    expect(extractCorePrefix('Game Gear.mgl')).toBe('Game Gear');
    expect(extractCorePrefix('Atari 2600.mgl')).toBe('Atari 2600');
    expect(extractCorePrefix('Mega Duck.mgl')).toBe('Mega Duck');
    expect(extractCorePrefix('Pocket Challenge V2.mgl')).toBe('Pocket Challenge V2');
  });

  it('handles a hidden .mgl filename', () => {
    expect(extractCorePrefix('.Game Gear.mgl')).toBe('Game Gear');
  });
});

describe('isCoreFile', () => {
  it('accepts .rbf files (any case)', () => {
    expect(isCoreFile('NES_20240115.rbf')).toBe(true);
    expect(isCoreFile('NES_20240115.RBF')).toBe(true);
  });

  it('accepts .mgl files (any case)', () => {
    expect(isCoreFile('Game Gear.mgl')).toBe(true);
    expect(isCoreFile('Game Gear.MGL')).toBe(true);
  });

  it('rejects everything else', () => {
    expect(isCoreFile('README.txt')).toBe(false);
    expect(isCoreFile('AO486')).toBe(false); // folder name, not a file
    expect(isCoreFile('something.mra')).toBe(false); // arcade metadata, not in scope
    expect(isCoreFile('')).toBe(false);
  });
});

describe('pathBasename / pathDirname / dottedPath / undottedPath', () => {
  it('basename strips trailing slash', () => {
    expect(pathBasename('/a/b/c')).toBe('c');
    expect(pathBasename('/a/b/c/')).toBe('c');
  });

  it('dottedPath adds dot only to basename and preserves trailing slash', () => {
    expect(dottedPath('/a/b/c')).toBe('/a/b/.c');
    expect(dottedPath('/a/b/c/')).toBe('/a/b/.c/');
  });

  it('dottedPath is idempotent', () => {
    expect(dottedPath('/a/.c')).toBe('/a/.c');
  });

  it('undottedPath strips leading dot from basename only', () => {
    expect(undottedPath('/a/b/.c')).toBe('/a/b/c');
    expect(undottedPath('/a/b/.c/')).toBe('/a/b/c/');
  });

  it('undottedPath is idempotent', () => {
    expect(undottedPath('/a/b/c')).toBe('/a/b/c');
  });

  it('round-trips dotted/undotted', () => {
    expect(undottedPath(dottedPath('/x/y/z.rbf'))).toBe('/x/y/z.rbf');
  });
});

describe('canonicalize', () => {
  it('lowercases and strips every non-alphanumeric character', () => {
    expect(canonicalize('Atari 2600')).toBe('atari2600');
    expect(canonicalize('Atari2600')).toBe('atari2600');
    expect(canonicalize('Game Gear')).toBe('gamegear');
    expect(canonicalize('GameGear')).toBe('gamegear');
    expect(canonicalize('Pocket Challenge V2')).toBe('pocketchallengev2');
    expect(canonicalize('PocketChallengeV2')).toBe('pocketchallengev2');
    expect(canonicalize('Mega Duck')).toBe('megaduck');
    expect(canonicalize('Sord M5')).toBe('sordm5');
    expect(canonicalize('SordM5')).toBe('sordm5');
    expect(canonicalize('Super_Vision_8000')).toBe('supervision8000');
    expect(canonicalize('SuperVision8000')).toBe('supervision8000');
    expect(canonicalize('TI-99_4A')).toBe('ti994a');
    expect(canonicalize('Ti994a')).toBe('ti994a');
    expect(canonicalize('WonderSwan Color')).toBe('wonderswancolor');
    expect(canonicalize('WonderSwanColor')).toBe('wonderswancolor');
    expect(canonicalize('CD-i')).toBe('cdi');
    expect(canonicalize('CDi')).toBe('cdi');
    expect(canonicalize('Amstrad PCW')).toBe('amstradpcw');
    expect(canonicalize('Amstrad-PCW')).toBe('amstradpcw');
  });

  it('does NOT match real semantic synonyms — that would need a hardcoded table', () => {
    // GBC and GameboyColor are the same console but the rbf
    // prefixes / games-dir names are genuinely different. Canonical
    // form respects that — synonyms are out of scope.
    expect(canonicalize('GBC')).toBe('gbc');
    expect(canonicalize('GameboyColor')).toBe('gameboycolor');
    expect(canonicalize('GBC')).not.toBe(canonicalize('GameboyColor'));
    // Same for Coleco / ColecoVision and NeoGeo-CD / NeoGeoCD.
    expect(canonicalize('Coleco')).not.toBe(canonicalize('ColecoVision'));
    // (NeoGeo-CD canonicalises to "neogeocd" — same as "NeoGeoCD".)
    expect(canonicalize('NeoGeo-CD')).toBe(canonicalize('NeoGeoCD'));
  });

  it('returns empty string for empty input or all-punctuation input', () => {
    expect(canonicalize('')).toBe('');
    expect(canonicalize('---')).toBe('');
    expect(canonicalize('   ')).toBe('');
  });

  it('preserves digits', () => {
    expect(canonicalize('NES')).toBe('nes');
    expect(canonicalize('S32X')).toBe('s32x');
    expect(canonicalize('PC8801')).toBe('pc8801');
  });
});

describe('matchRbfsToGamesDirs', () => {
  it('joins a single rbf with a matching games dir', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [
        {
          rawName: 'NES',
          files: [
            'Castlevania.nes',
            'Contra.nes',
            'Final Fantasy.nes',
            'Mega Man 2.nes',
            'Metroid.nes',
            'Super Mario Bros.nes',
            'Zelda.nes',
            '.Action 52.nes',
            '.Color a Dinosaur.nes',
          ],
          dirs: [],
        },
      ],
    });

    expect(result).toEqual([
      {
        id: 'NES',
        name: 'NES',
        romCount: 9,
        hiddenCount: 2,
        // No subFolders supplied → recursive equals top-level count
        // (Round 3 fallback, Issue 5).
        recursiveRomCount: 9,
        recursiveHiddenCount: 2,
        category: 'Console',
        rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: false,
        gamesDirName: 'NES',
      },
    ]);
  });

  it('collapses multiple rbf versions onto one CoreEntry', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
        {
          category: 'Console',
          filename: 'NES_20231215.rbf',
          fullPath: '/media/fat/_Console/NES_20231215.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [{ rawName: 'NES', files: ['Castlevania.nes'], dirs: [] }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.rbfPaths).toEqual([
      '/media/fat/_Console/NES_20240115.rbf',
      '/media/fat/_Console/NES_20231215.rbf',
    ]);
  });

  it('emits CoreEntry with category=Unknown for an orphan games dir', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [
        { rawName: 'WeirdCore', files: ['a.bin', 'b.bin', 'c.bin'], dirs: [] },
      ],
    });

    expect(result[0]?.category).toBe('Unknown');
    expect(result[0]?.rbfPaths).toEqual([]);
    expect(result[0]?.gamesDirExists).toBe(true);
  });

  it('emits CoreEntry for an rbf with no matching games dir', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'SMS_20240115.rbf',
          fullPath: '/media/fat/_Console/SMS_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [],
    });

    expect(result[0]).toMatchObject({
      id: 'SMS',
      gamesDirExists: false,
      romCount: 0,
      rbfPaths: ['/media/fat/_Console/SMS_20240115.rbf'],
    });
  });

  it('detects a hidden games dir from the leading dot', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [
        {
          rawName: '.SNES',
          files: ['a.sfc', 'b.sfc', 'c.sfc', 'd.sfc', 'e.sfc'],
          dirs: [],
        },
      ],
    });
    expect(result[0]?.id).toBe('SNES');
    expect(result[0]?.gamesDirHidden).toBe(true);
  });

  it('handles folder-shaped cores (filename without .rbf)', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Computer',
          filename: 'AO486',
          fullPath: '/media/fat/_Computer/AO486',
          isFolder: true,
        },
      ],
      gamesDirs: [{ rawName: 'AO486', files: [], dirs: [] }],
    });

    expect(result[0]?.category).toBe('Computer');
    expect(result[0]?.rbfPaths).toEqual(['/media/fat/_Computer/AO486']);
    expect(result[0]?.gamesDirExists).toBe(true);
  });

  it('collapses every arcade rbf into one synthetic placeholder row', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Arcade',
          filename: 'Galaga_20240115.rbf',
          fullPath: '/media/fat/_Arcade/Galaga_20240115.rbf',
          isFolder: false,
        },
        {
          category: 'Arcade',
          filename: 'Pacman_20240310.rbf',
          fullPath: '/media/fat/_Arcade/Pacman_20240310.rbf',
          isFolder: false,
        },
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [],
    });

    const arcadeEntries = result.filter((c) => c.category === 'Arcade');
    expect(arcadeEntries).toHaveLength(1);
    expect(arcadeEntries[0]?.id).toBe(ARCADE_PLACEHOLDER_ID);
    expect(arcadeEntries[0]?.name).toBe('Arcade');
    expect(arcadeEntries[0]?.rbfPaths).toEqual([]);
    expect(isArcadePlaceholder(arcadeEntries[0]!)).toBe(true);

    // Non-arcade cores are unaffected by the collapse.
    expect(result.find((c) => c.id === 'NES')?.category).toBe('Console');
    // Individual arcade core ids are NOT in the output.
    expect(result.map((c) => c.id)).not.toContain('Galaga');
    expect(result.map((c) => c.id)).not.toContain('Pacman');
  });

  it('emits no arcade placeholder when no arcade signal at all', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [],
      arcadeDirExists: false,
    });
    expect(result.find((c) => c.category === 'Arcade')).toBeUndefined();
  });

  it('emits the arcade placeholder when arcadeDirExists, even with no arcade rbfs', () => {
    // Real MiSTers populate /media/fat/_Arcade/ with .mra files, not
    // .rbf or .mgl. The placeholder must still appear so users see
    // "Arcade" in the cores list.
    const result = matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [],
      arcadeDirExists: true,
    });
    const arcade = result.find((c) => c.category === 'Arcade');
    expect(arcade).toBeDefined();
    expect(arcade?.id).toBe(ARCADE_PLACEHOLDER_ID);
    expect(arcade?.name).toBe('Arcade');
    expect(arcade?.rbfPaths).toEqual([]);
  });

  it('emits exactly one placeholder when both arcadeDirExists AND arcade rbfs are present', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Arcade',
          filename: 'Galaga_20240115.rbf',
          fullPath: '/media/fat/_Arcade/Galaga_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [],
      arcadeDirExists: true,
    });
    const arcadeRows = result.filter((c) => c.category === 'Arcade');
    expect(arcadeRows).toHaveLength(1);
  });

  it('sorts the result by core id, case-insensitive', () => {
    const result = matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'Zebra.rbf',
          fullPath: '/media/fat/_Console/Zebra.rbf',
          isFolder: false,
        },
        {
          category: 'Console',
          filename: 'apollo.rbf',
          fullPath: '/media/fat/_Console/apollo.rbf',
          isFolder: false,
        },
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [],
    });
    expect(result.map((c) => c.id)).toEqual(['apollo', 'NES', 'Zebra']);
  });

  describe('romCount excludes system files', () => {
    // F1: BIOSes, .xml/.ini configs, and *boot/*bios suffix files must
    // not count toward romCount. A core that only contains a BIOS still
    // qualifies as "empty" for the "Hide empty cores" sweep so cores like
    // AtariLynx (only `lynxboot.img` installed) get caught.

    it('treats a core with only a BIOS as empty (romCount=0)', () => {
      // Real example: AtariLynx with only lynxboot.img. Before the
      // system-file filter this counted as romCount=1 and slipped past
      // "Hide empty cores".
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'AtariLynx_20240115.rbf',
            fullPath: '/media/fat/_Console/AtariLynx_20240115.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'AtariLynx', files: ['lynxboot.img'], dirs: [] },
        ],
      });
      const lynx = result.find((c) => c.id === 'AtariLynx');
      expect(lynx?.romCount).toBe(0);
      expect(lynx?.hiddenCount).toBe(0);
    });

    it('counts a real ROM alongside a BIOS (romCount=1)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'AtariLynx', files: ['boot.rom', 'mygame.lnx'], dirs: [] },
        ],
      });
      const lynx = result.find((c) => c.id === 'AtariLynx');
      expect(lynx?.romCount).toBe(1);
    });

    it('counts folder ROMs even if every file is a BIOS', () => {
      // Saturn-shape: 1 BIOS file + 17 disc folders. romCount must
      // reflect the folders so "Hide empty" never nukes a disc collection.
      const dirs: string[] = [];
      for (let i = 0; i < 17; i += 1) dirs.push(`Disc Game ${String(i)}`);
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'Saturn', files: ['sega_bios.rom'], dirs },
        ],
      });
      const saturn = result.find((c) => c.id === 'Saturn');
      expect(saturn?.romCount).toBe(17);
    });

    it('mixes BIOS-filtered files with folder ROMs (romCount = folders)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NeoGeo',
            files: ['boot.rom', 'romsets.xml', 'sfix.sfix'],
            dirs: ['mslug', 'kof97', 'samsho', 'lastblade2', 'mslug2'],
          },
        ],
      });
      const neogeo = result.find((c) => c.id === 'NeoGeo');
      expect(neogeo?.romCount).toBe(5);
      expect(neogeo?.hiddenCount).toBe(0);
    });

    it('excludes a hidden BIOS from hiddenCount as well as romCount', () => {
      // A hidden BIOS is still a BIOS — it doesn't make the core
      // hide-relevant for the "Unhide all" UI flow.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NeoGeo',
            files: ['.boot.rom', '.romsets.xml', 'mslug.zip'],
            dirs: [],
          },
        ],
      });
      const neogeo = result.find((c) => c.id === 'NeoGeo');
      expect(neogeo?.romCount).toBe(1);
      expect(neogeo?.hiddenCount).toBe(0);
    });

    it('mirrors the NEOGEO snapshot (12 BIOS files + 9 game dirs → romCount=9)', () => {
      // Real snapshot shape: NEOGEO ships with a dozen system files
      // mixed in with the actual ROM folders (.zip / .neo).
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NEOGEO',
            files: [
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
            ],
            dirs: [
              'mslug',
              'kof97',
              'mslug2',
              'samsho',
              'lastblade2',
              'mslug3',
              'kof98',
              'samsho2',
              'lastblade',
            ],
          },
        ],
      });
      const neogeo = result.find((c) => c.id === 'NEOGEO');
      expect(neogeo?.romCount).toBe(9);
      expect(neogeo?.hiddenCount).toBe(0);
    });
  });

  describe('romCount honours user-marked system files', () => {
    // Marks layer over the auto-detector — they take a (coreId, filename)
    // pair and pull the file out of the count just like a BIOS would.

    it('excludes a user-marked file from romCount', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'C64', files: ['mygame.d64', 'DolphinDOS_2.0.rom'], dirs: [] },
        ],
        systemFilesMarks: {
          schemaVersion: 1,
          marked: [
            { coreId: 'C64', filename: 'DolphinDOS_2.0.rom', markedAt: '2026-05-02' },
          ],
        },
      });
      const c64 = result.find((c) => c.id === 'C64');
      expect(c64?.romCount).toBe(1);
    });

    it('excludes a user-marked folder from romCount', () => {
      // Folders aren't auto-filtered, but marking should still pull them
      // out of the count — covers Palettes / Overlays / custom folders.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'Atari800',
            files: [],
            dirs: ['_resources', 'Game 1', 'Game 2'],
          },
        ],
        systemFilesMarks: {
          schemaVersion: 1,
          marked: [
            { coreId: 'Atari800', filename: '_resources', markedAt: '2026-05-02' },
          ],
        },
      });
      const atari = result.find((c) => c.id === 'Atari800');
      expect(atari?.romCount).toBe(2);
    });

    it('matches the marks coreId case-insensitively against the games dir name', () => {
      // games dir is `.APOGEE` (visible name "APOGEE") but the user
      // marked the file under coreId "Apogee" (canonical form). The
      // case-insensitive lookup ensures the mark applies anyway.
      // (PR #11 round 2: include a non-marked sibling so the orphan
      // filter doesn't drop the entry — the test is asserting on
      // marks lookup, not orphan handling.)
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: '.APOGEE',
            files: ['random_data.bin', 'mygame.bin'],
            dirs: [],
          },
        ],
        systemFilesMarks: {
          schemaVersion: 1,
          marked: [
            { coreId: 'Apogee', filename: 'random_data.bin', markedAt: '2026-05-02' },
          ],
        },
      });
      const apogee = result.find((c) => c.id === 'APOGEE');
      // marked file dropped (random_data.bin), unmarked file kept (mygame.bin).
      expect(apogee?.romCount).toBe(1);
    });

    it('a hidden user-marked file is excluded from hiddenCount as well', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'C64', files: ['.DolphinDOS_2.0.rom', 'mygame.d64'], dirs: [] },
        ],
        systemFilesMarks: {
          schemaVersion: 1,
          marked: [
            { coreId: 'C64', filename: '.DolphinDOS_2.0.rom', markedAt: '2026-05-02' },
          ],
        },
      });
      const c64 = result.find((c) => c.id === 'C64');
      expect(c64?.romCount).toBe(1);
      expect(c64?.hiddenCount).toBe(0);
    });

    it('does not bleed across cores when filenames overlap', () => {
      // PR #11 round 2: each games dir needs SOMETHING countable
      // beyond the marked file so the orphan filter doesn't drop it.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'C64',
            files: ['shared.rom', 'c64-only.d64'],
            dirs: [],
          },
          {
            rawName: 'NES',
            files: ['shared.rom', 'nes-only.nes'],
            dirs: [],
          },
        ],
        systemFilesMarks: {
          schemaVersion: 1,
          marked: [
            { coreId: 'C64', filename: 'shared.rom', markedAt: '2026-05-02' },
          ],
        },
      });
      // C64 marked: shared.rom dropped, c64-only.d64 kept → 1.
      expect(result.find((c) => c.id === 'C64')?.romCount).toBe(1);
      // NES not marked: both files kept → 2.
      expect(result.find((c) => c.id === 'NES')?.romCount).toBe(2);
    });
  });

  describe('case-insensitive hidden games-dir matching', () => {
    // The five real-MiSTer shapes from docs/snapshots/real-mister-layout.txt:
    //   _Console/Atari7800_20240423.rbf  + games/.ATARI7800/
    //   _Console/Gameboy2P_20250621.rbf  + games/.GAMEBOY2P/
    //   _Console/Vectrex_20240524.rbf    + games/.VECTREX/
    //   _Computer/Altair8800_*.rbf       + games/.ALTAIR8800/  (hypothetical
    //                                                            — Altair lives
    //                                                            in _Computer)
    //   _Utility/memtest_*.rbf           + games/.MEMTEST/
    //
    // All five share the same shape: visible rbf + dot-prefixed,
    // CASE-MISMATCHED games dir. Round 5: the matcher resolves them
    // to a single hidden core entry. The user can click "Show" on
    // any of them just like a core they hid via the app — the model
    // is two states (visible / hidden) with no third "externally
    // hidden" bucket.

    it('matches Atari7800 (visible rbf) with .ATARI7800 (hidden, case-mismatch)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Atari7800_20240423.rbf',
            fullPath: '/media/fat/_Console/Atari7800_20240423.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          {
            rawName: '.ATARI7800',
            files: ['random_data.bin'],
            dirs: [],
          },
        ],
      });

      const atari = result.find((c) => c.id.toLowerCase() === 'atari7800');
      expect(atari).toBeDefined();
      // PR #11 round 2: games-dir name wins as the display id when
      // both an rbf and a games dir exist for the same canonical key
      // (Round 5 spec: "named whichever the games dir was"). The
      // rbf's smarter casing is forgotten in favor of the on-disk
      // basename — operations target gamesDirName, which is the same
      // string anyway.
      expect(atari?.id).toBe('ATARI7800');
      // On-disk basename (visible form) is preserved so renames
      // target /media/fat/games/.ATARI7800.
      expect(atari?.gamesDirName).toBe('ATARI7800');
      expect(atari?.gamesDirExists).toBe(true);
      expect(atari?.gamesDirHidden).toBe(true);
      // Round 5: the dir's actual contents surface — no zeroing-out
      // of cores that the user might want to inspect / restore.
      expect(atari?.romCount).toBe(1);
      expect(atari?.recursiveRomCount).toBe(1);
      // The two-state model: any dot-prefixed side reads as hidden.
      expect(isCoreHidden(atari!)).toBe(true);
    });

    it('matches Gameboy2P with .GAMEBOY2P (hidden, case-mismatch)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Gameboy2P_20250621.rbf',
            fullPath: '/media/fat/_Console/Gameboy2P_20250621.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: '.GAMEBOY2P', files: ['stuff.bin', 'stuff2.bin'], dirs: [] },
        ],
      });
      const gb2p = result.find((c) => c.id.toLowerCase() === 'gameboy2p');
      expect(gb2p?.id).toBe('GAMEBOY2P');
      expect(gb2p?.gamesDirHidden).toBe(true);
      expect(gb2p?.gamesDirName).toBe('GAMEBOY2P');
      expect(gb2p?.romCount).toBe(2);
      expect(isCoreHidden(gb2p!)).toBe(true);
    });

    it('matches Vectrex with .VECTREX (hidden, case-mismatch, single subdir)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Vectrex_20240524.rbf',
            fullPath: '/media/fat/_Console/Vectrex_20240524.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: '.VECTREX', files: [], dirs: ['_subdir'] },
        ],
      });
      const v = result.find((c) => c.id.toLowerCase() === 'vectrex');
      expect(v?.id).toBe('VECTREX');
      expect(v?.gamesDirName).toBe('VECTREX');
      expect(v?.romCount).toBe(1);
      expect(isCoreHidden(v!)).toBe(true);
    });

    it('matches Altair8800 with .ALTAIR8800 (Computer category)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: 'Altair8800_20241230.rbf',
            fullPath: '/media/fat/_Computer/Altair8800_20241230.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: '.ALTAIR8800', files: ['rom1.bin'], dirs: [] },
        ],
      });
      const a = result.find((c) => c.id.toLowerCase() === 'altair8800');
      expect(a?.id).toBe('ALTAIR8800');
      expect(a?.category).toBe('Computer');
      expect(a?.romCount).toBe(1);
      expect(isCoreHidden(a!)).toBe(true);
    });

    it('matches memtest with .MEMTEST (Utility category)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Utility',
            filename: 'memtest_20210130.rbf',
            fullPath: '/media/fat/_Utility/memtest_20210130.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.MEMTEST', files: ['data.bin'], dirs: [] }],
      });
      const m = result.find((c) => c.id.toLowerCase() === 'memtest');
      expect(m?.id).toBe('MEMTEST');
      expect(m?.category).toBe('Utility');
      expect(m?.romCount).toBe(1);
      expect(isCoreHidden(m!)).toBe(true);
    });

    it('rbf with no matching games dir at all is visible (no hidden flag)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Newcore_20260101.rbf',
            fullPath: '/media/fat/_Console/Newcore_20260101.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [],
      });
      const c = result.find((x) => x.id === 'Newcore');
      expect(c?.gamesDirExists).toBe(false);
      expect(c?.romCount).toBe(0);
      expect(isCoreHidden(c!)).toBe(false);
    });

    it('rbf with both visible AND hidden case-mismatched games dirs: last-write wins', () => {
      // Unusual: rbf "Foo" + games/foo (visible) + games/.FOO (hidden).
      // PR #11 round 2 keys by canonical form. All three share the
      // canonical "foo" key. Whichever games dir is processed second
      // overrides the gamesDirHidden flag — the on-disk reality is
      // ambiguous (both exist) so the matcher reports whichever the
      // shell pass enumerated last. The user can clean up via SSH.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Foo_20260101.rbf',
            fullPath: '/media/fat/_Console/Foo_20260101.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'foo', files: ['game.bin'], dirs: [] },
          { rawName: '.FOO', files: ['leftover.bin'], dirs: [] },
        ],
      });
      const foos = result.filter((c) => c.id.toLowerCase() === 'foo');
      expect(foos).toHaveLength(1);
      // Last write (.FOO) wins.
      expect(foos[0]?.gamesDirHidden).toBe(true);
      expect(foos[0]?.gamesDirName).toBe('FOO');
    });

    it('rbf with only visible mismatched-case games dir matches case-insensitively', () => {
      // rbf "Apogee" matches games/APOGEE (visible, case-mismatch).
      // The dedupe collapses both representations into a single
      // entry, picking whichever side carries the games dir as
      // canonical (so renames target the right basename); the rbf
      // path joins it via mergeAliases.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: 'Apogee_20240502.rbf',
            fullPath: '/media/fat/_Computer/Apogee_20240502.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'APOGEE', files: ['game.bin'], dirs: [] },
        ],
      });
      const apogee = result.find((c) => c.id.toLowerCase() === 'apogee');
      expect(apogee).toBeDefined();
      // No duplicate entries — case-mismatched siblings collapse.
      expect(
        result.filter((c) => c.id.toLowerCase() === 'apogee'),
      ).toHaveLength(1);
      expect(apogee?.gamesDirName).toBe('APOGEE');
      expect(apogee?.gamesDirHidden).toBe(false);
      expect(apogee?.gamesDirExists).toBe(true);
      expect(apogee?.romCount).toBe(1);
      expect(apogee?.rbfPaths).toEqual([
        '/media/fat/_Computer/Apogee_20240502.rbf',
      ]);
      expect(isCoreHidden(apogee!)).toBe(false);
    });
  });

  describe('recursive ROM count (Round 3 / Issue 5)', () => {
    // The matcher walks one level deep into the games dir, classifies
    // each top-level subfolder, and either contributes the recursive
    // file count (containers) or 1 (atomic / unknown). The `~` prefix
    // in the UI is intentional — recursive walks can over- or
    // under-count due to non-standard ROM extensions.

    it('atomic disc folders count as 1 (Saturn shape)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'Saturn',
            files: ['sega_bios.rom'],
            dirs: ['Game A', 'Game B', 'Game C'],
            subFolders: [
              {
                name: 'Game A',
                files: ['Game A.cue', 'Game A (Track 01).bin', 'Game A (Track 02).bin'],
                dirs: [],
                recursiveFileCount: 3,
              },
              {
                name: 'Game B',
                files: ['Game B.iso'],
                dirs: [],
                recursiveFileCount: 1,
              },
              {
                name: 'Game C',
                files: ['Game C (Track 01).bin', 'Game C (Track 02).bin'],
                dirs: [],
                recursiveFileCount: 2,
              },
            ],
          },
        ],
      });
      const saturn = result.find((c) => c.id === 'Saturn');
      // System BIOS dropped; 3 disc folders, each = 1 atomic ROM.
      expect(saturn?.romCount).toBe(3);
      expect(saturn?.recursiveRomCount).toBe(3);
    });

    it('container folders contribute their recursive file count (NEOGEO shape)', () => {
      // Real NEOGEO has 9 organisational subfolders (containers) plus
      // 12 BIOS files at the top.
      const subFolders = Array.from({ length: 9 }, (_, i) => ({
        name: `org${String(i)}`,
        // Many files of the same extension → container by the long-
        // tail rule.
        files: Array.from({ length: 30 }, (__, j) => `g${String(j)}.zip`),
        dirs: [],
        recursiveFileCount: 30,
      }));
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NEOGEO',
            files: [
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
            ],
            dirs: subFolders.map((s) => s.name),
            subFolders,
          },
        ],
      });
      const neogeo = result.find((c) => c.id === 'NEOGEO');
      // Top-level: 9 (subfolders, BIOSes filtered out).
      expect(neogeo?.romCount).toBe(9);
      // Recursive: 9 × 30 = 270 (matches "9 folders · ~270 ROMs").
      expect(neogeo?.recursiveRomCount).toBe(270);
    });

    it('disc images dedupe via the atomic classification (one folder = 1)', () => {
      // A folder with both .iso AND .cue+.bin: the disc-marker rule
      // pins it atomic, so it counts 1 regardless of how many .bin
      // companion files live inside.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'Mixed',
            files: [],
            dirs: ['Some Game'],
            subFolders: [
              {
                name: 'Some Game',
                files: [
                  'Game.iso',
                  'Game.cue',
                  'Game.bin',
                  'Game (Track 02).bin',
                ],
                dirs: [],
                recursiveFileCount: 4,
              },
            ],
          },
        ],
      });
      const mixed = result.find((c) => c.id === 'Mixed');
      expect(mixed?.romCount).toBe(1);
      expect(mixed?.recursiveRomCount).toBe(1);
    });

    it('system files at the top level are excluded from both counts', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'AtariLynx',
            files: ['lynxboot.img', 'mygame.lnx'],
            dirs: [],
            subFolders: [],
          },
        ],
      });
      const lynx = result.find((c) => c.id === 'AtariLynx');
      expect(lynx?.romCount).toBe(1); // BIOS dropped
      expect(lynx?.recursiveRomCount).toBe(1);
    });

    it('hidden top-level files contribute to recursiveHiddenCount but not visible bucket', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NES',
            files: ['a.nes', '.b.nes', '.c.nes'],
            dirs: [],
            subFolders: [],
          },
        ],
      });
      const nes = result.find((c) => c.id === 'NES');
      expect(nes?.romCount).toBe(3);
      expect(nes?.hiddenCount).toBe(2);
      expect(nes?.recursiveRomCount).toBe(3);
      expect(nes?.recursiveHiddenCount).toBe(2);
    });

    it('hidden container folder pulls every nested file into the hidden bucket', () => {
      // A container folder that has been dot-prefixed (whole
      // organisational tree hidden) — every ROM under it is
      // effectively hidden. The matcher sums the recursive count
      // into recursiveHiddenCount.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'NEOGEO',
            files: [],
            dirs: ['.org-a'],
            subFolders: [
              {
                name: '.org-a',
                files: Array.from({ length: 10 }, (_, i) => `g${String(i)}.zip`),
                dirs: [],
                recursiveFileCount: 10,
              },
            ],
          },
        ],
      });
      const neogeo = result.find((c) => c.id === 'NEOGEO');
      expect(neogeo?.recursiveRomCount).toBe(10);
      expect(neogeo?.recursiveHiddenCount).toBe(10);
    });

    it('empty container folder counts 0 inside (recursive = 0)', () => {
      // PR #11 round 2: a games dir with romCount > 0 but
      // recursive = 0 used to be kept; now it's filtered by the
      // orphan rule (no rbf, no countable content). Add an rbf so
      // the entry survives the filter and the recursive count
      // assertion can run.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Empty_20260101.rbf',
            fullPath: '/media/fat/_Console/Empty_20260101.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          {
            rawName: 'Empty',
            files: [],
            dirs: ['containerish'],
            subFolders: [
              {
                name: 'containerish',
                // 5+ same extension triggers container heuristic.
                files: ['a.zip', 'b.zip', 'c.zip', 'd.zip', 'e.zip'],
                dirs: [],
                recursiveFileCount: 0, // simulating a stale snapshot
              },
            ],
          },
        ],
      });
      const e = result.find((c) => c.id === 'Empty');
      expect(e?.romCount).toBe(1);
      expect(e?.recursiveRomCount).toBe(0);
    });

    it('legacy callers without subFolders fall back to top-level count', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'NES', files: ['a.nes', 'b.nes'], dirs: ['c'] },
        ],
      });
      const nes = result.find((c) => c.id === 'NES');
      // No subFolders → matcher mirrors top-level count.
      expect(nes?.romCount).toBe(3);
      expect(nes?.recursiveRomCount).toBe(3);
    });

    describe('PR #13 — folderClassifications overrides flow into recursiveRomCount', () => {
      // The X68000 reproduction: a multi-disk game folder with 6 .dim
      // files trips the heuristic's many-same-ext rule and classifies
      // as container by default. Six top-level folders of this shape
      // produce recursive=36 (= 6 × 6) before any user override.
      function buildSixMultiDiskFolders(): {
        readonly fixture: Parameters<typeof matchRbfsToGamesDirs>[0];
        readonly folderNames: readonly string[];
      } {
        const folderNames = ['Game01', 'Game02', 'Game03', 'Game04', 'Game05', 'Game06'];
        const subFolders = folderNames.map((name) => ({
          name,
          files: ['disk1.dim', 'disk2.dim', 'disk3.dim', 'disk4.dim', 'disk5.dim', 'disk6.dim'],
          dirs: [],
          recursiveFileCount: 6,
        }));
        return {
          fixture: {
            rbfs: [],
            gamesDirs: [
              {
                rawName: 'X68000',
                files: [],
                dirs: folderNames,
                subFolders,
              },
            ],
          },
          folderNames,
        };
      }

      it('multi-disk folders classify container without overrides → recursive overcounts', () => {
        const { fixture } = buildSixMultiDiskFolders();
        const result = matchRbfsToGamesDirs(fixture);
        const x68000 = result.find((c) => c.id === 'X68000');
        // Heuristic-only baseline: each multi-disk folder hits the
        // many-same-ext rule and contributes its recursive file count.
        expect(x68000?.romCount).toBe(6);
        expect(x68000?.recursiveRomCount).toBe(36);
      });

      it('user atomic override on every folder collapses recursive to folder count', () => {
        const { fixture, folderNames } = buildSixMultiDiskFolders();
        const result = matchRbfsToGamesDirs({
          ...fixture,
          folderClassifications: {
            schemaVersion: 1,
            overrides: folderNames.map((name) => ({
              coreId: 'X68000',
              folderPath: name,
              classification: 'atomic' as const,
              setAt: '2026-01-01T00:00:00.000Z',
            })),
          },
        });
        const x68000 = result.find((c) => c.id === 'X68000');
        expect(x68000?.romCount).toBe(6);
        // Each atomic-overridden folder contributes 1 → total 6.
        // recursive === romCount, so the cores-pane breakdown rule
        // collapses to a single-number display.
        expect(x68000?.recursiveRomCount).toBe(6);
      });

      it('user container override on a single-zip atomic folder expands count', () => {
        // X68000 single-zip folder (atomic by heuristic). User picks
        // "Treat as folder of ROMs" because they bundled multiple
        // games into the .zip and want drill-in. The override flips
        // to container; recursive contributes the file count.
        const result = matchRbfsToGamesDirs({
          rbfs: [],
          gamesDirs: [
            {
              rawName: 'X68000',
              files: [],
              dirs: ['Castlevania'],
              subFolders: [
                {
                  name: 'Castlevania',
                  files: ['castlevania.zip'],
                  dirs: [],
                  recursiveFileCount: 1,
                },
              ],
            },
          ],
          folderClassifications: {
            schemaVersion: 1,
            overrides: [
              {
                coreId: 'X68000',
                folderPath: 'Castlevania',
                classification: 'container',
                setAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        });
        const x68000 = result.find((c) => c.id === 'X68000');
        expect(x68000?.romCount).toBe(1);
        // Container override → contributes recursiveFileCount (1).
        expect(x68000?.recursiveRomCount).toBe(1);
      });

      it('mix of overrides matches per-folder behavior', () => {
        // Two atomic-overridden folders + one container-overridden
        // folder. recursive = 1 + 1 + (recursive count of container).
        const result = matchRbfsToGamesDirs({
          rbfs: [],
          gamesDirs: [
            {
              rawName: 'X68000',
              files: [],
              dirs: ['A', 'B', 'C'],
              subFolders: [
                {
                  name: 'A',
                  files: ['d1.dim', 'd2.dim', 'd3.dim', 'd4.dim', 'd5.dim'],
                  dirs: [],
                  recursiveFileCount: 5,
                },
                {
                  name: 'B',
                  files: ['d1.dim', 'd2.dim', 'd3.dim', 'd4.dim', 'd5.dim'],
                  dirs: [],
                  recursiveFileCount: 5,
                },
                {
                  name: 'C',
                  files: ['game.zip'],
                  dirs: [],
                  recursiveFileCount: 1,
                },
              ],
            },
          ],
          folderClassifications: {
            schemaVersion: 1,
            overrides: [
              {
                coreId: 'X68000',
                folderPath: 'A',
                classification: 'atomic',
                setAt: '2026-01-01T00:00:00.000Z',
              },
              {
                coreId: 'X68000',
                folderPath: 'B',
                classification: 'atomic',
                setAt: '2026-01-01T00:00:00.000Z',
              },
              {
                coreId: 'X68000',
                folderPath: 'C',
                classification: 'container',
                setAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        });
        const x68000 = result.find((c) => c.id === 'X68000');
        expect(x68000?.romCount).toBe(3);
        // 1 (A atomic) + 1 (B atomic) + 1 (C container's recursive=1) = 3.
        // recursive === romCount → cores pane shows simple count.
        expect(x68000?.recursiveRomCount).toBe(3);
      });

      it('system-marked folder is filtered before classifyFolder runs (zero contribution)', () => {
        // The classification-override layer is one axis; the system-
        // mark layer is another. A folder marked system never reaches
        // computeRecursiveRomCount (filtered upstream by
        // shouldCountAsRom). This test belt-and-suspenders against a
        // future regression where system-mark stops filtering folders.
        const result = matchRbfsToGamesDirs({
          rbfs: [],
          gamesDirs: [
            {
              rawName: 'SNES',
              files: ['Castlevania.smc'],
              dirs: ['_translations'],
              subFolders: [
                {
                  name: '_translations',
                  files: Array.from({ length: 30 }, (_, i) => `t${String(i)}.smc`),
                  dirs: [],
                  recursiveFileCount: 30,
                },
              ],
            },
          ],
          systemFilesMarks: {
            schemaVersion: 1,
            marked: [
              {
                coreId: 'SNES',
                filename: '_translations',
                markedAt: '2026-01-01T00:00:00.000Z',
              },
            ],
          },
        });
        const snes = result.find((c) => c.id === 'SNES');
        // _translations filtered → only the .smc file counts.
        expect(snes?.romCount).toBe(1);
        expect(snes?.recursiveRomCount).toBe(1);
      });
    });
  });

  describe('coreId / on-disk-path invariant (PR #11 round 3 / Bug 1)', () => {
    // Hard invariant: every CoreEntry's `id` must equal the on-disk
    // games-dir basename when a games dir exists, OR the rbf prefix
    // otherwise. Operational paths (listRoms, setRomVisibility,
    // hideCore) join `<coreId>` to the games-dir prefix; if `id`
    // drifts from the basename, listRoms targets a non-existent
    // directory and silently returns empty.
    //
    // The user-reported X68000 bug from Round 2 live testing
    // motivated this round: the cores list showed 649 folders and
    // ~2014 ROMs but clicking gave nothing. Adding the explicit
    // enforcement here prevents the regression from hiding behind
    // future matcher refactors.

    it('Atari 2600 (.mgl) + Atari2600 (games dir) → id = "Atari2600"', () => {
      // The diagnostic showed `.Atari 2600.mgl` and `games/Atari2600/`
      // both on disk. Pre-Round-2 they were two phantom rows. Round 2
      // collapses them via canonical form. Round 3 enforces that the
      // merged entry's id is the games-dir basename so listRoms
      // targets the right path.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: '.Atari 2600.mgl',
            fullPath: '/media/fat/_Console/.Atari 2600.mgl',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'Atari2600', files: ['Combat.bin'], dirs: [] },
        ],
      });
      const atari = result.find(
        (c) => canonicalize(c.id) === 'atari2600',
      );
      expect(atari).toBeDefined();
      // The on-disk basename — NOT "Atari 2600" (the mgl prefix).
      expect(atari?.id).toBe('Atari2600');
      expect(atari?.gamesDirName).toBe('Atari2600');
      // The two MUST agree; resolveOnDiskGamesDirBasename relies on it.
      expect(atari?.id).toBe(atari?.gamesDirName);
    });

    it('Atari2600 (games dir first) + Atari 2600 (.mgl second) → id = "Atari2600"', () => {
      // Order independence: the invariant holds regardless of
      // whether the games-dir or the rbf is processed first.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: '.Atari 2600.mgl',
            fullPath: '/media/fat/_Console/.Atari 2600.mgl',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'Atari2600', files: ['Combat.bin'], dirs: [] },
        ],
      });
      const atari = result.find(
        (c) => canonicalize(c.id) === 'atari2600',
      );
      expect(atari?.id).toBe('Atari2600');
    });

    it('VECTREX hidden games dir → id = "VECTREX" (Round 5 hidden support)', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Vectrex_20240524.rbf',
            fullPath: '/media/fat/_Console/Vectrex_20240524.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: '.VECTREX', files: ['game.vec'], dirs: [] },
        ],
      });
      const vec = result.find((c) => canonicalize(c.id) === 'vectrex');
      expect(vec?.id).toBe('VECTREX');
      expect(vec?.gamesDirName).toBe('VECTREX');
      expect(vec?.gamesDirHidden).toBe(true);
    });

    it('rbf-only core (no games dir) → id = rbf prefix', () => {
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'SMS_20240115.rbf',
            fullPath: '/media/fat/_Console/SMS_20240115.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [],
      });
      const sms = result.find((c) => c.id === 'SMS');
      expect(sms).toBeDefined();
      expect(sms?.gamesDirExists).toBe(false);
      // id = rbf prefix; gamesDirName is undefined.
      expect(sms?.id).toBe('SMS');
      expect(sms?.gamesDirName).toBeUndefined();
    });

    it('hard invariant — every CoreEntry honors the rule', () => {
      // Exercise multiple shapes in one pass so the invariant runs
      // against each: rbf+games-dir (canonical-merged), rbf-only,
      // games-dir-only, hidden games dir, X68000-shape (literal
      // match).
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: '.Atari 2600.mgl',
            fullPath: '/media/fat/_Console/.Atari 2600.mgl',
            isFolder: false,
          },
          {
            category: 'Console',
            filename: 'NES_20240115.rbf',
            fullPath: '/media/fat/_Console/NES_20240115.rbf',
            isFolder: false,
          },
          {
            category: 'Console',
            filename: 'SMS_20240115.rbf',
            fullPath: '/media/fat/_Console/SMS_20240115.rbf',
            isFolder: false,
          },
          {
            category: 'Computer',
            filename: 'X68000_20240524.rbf',
            fullPath: '/media/fat/_Computer/X68000_20240524.rbf',
            isFolder: false,
          },
          {
            category: 'Console',
            filename: 'Vectrex_20240524.rbf',
            fullPath: '/media/fat/_Console/Vectrex_20240524.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [
          { rawName: 'Atari2600', files: ['Combat.bin'], dirs: [] },
          { rawName: 'NES', files: ['Mario.nes'], dirs: [] },
          { rawName: 'mame', files: ['romzip.zip'], dirs: [] }, // games-dir-only
          { rawName: 'X68000', files: ['boot3.vhd', 'real.bin'], dirs: [] },
          { rawName: '.VECTREX', files: ['game.vec'], dirs: [] }, // hidden
        ],
      });

      for (const c of result) {
        if (c.category === 'Arcade') continue; // placeholder is special
        if (c.gamesDirExists) {
          expect(c.gamesDirName).toBeDefined();
          expect(c.id).toBe(c.gamesDirName);
        } else {
          // rbf-only: id is non-empty.
          expect(c.id.length).toBeGreaterThan(0);
          expect(c.gamesDirName).toBeUndefined();
        }
      }

      // Spot-check a few of the documented cases.
      expect(result.find((c) => c.id === 'Atari2600')).toBeDefined();
      expect(result.find((c) => c.id === 'NES')).toBeDefined();
      expect(result.find((c) => c.id === 'mame')).toBeDefined();
      expect(result.find((c) => c.id === 'X68000')).toBeDefined();
      expect(result.find((c) => c.id === 'VECTREX')).toBeDefined();
      expect(result.find((c) => c.id === 'SMS')).toBeDefined();
    });
  });

  describe('phantom-duplicate regression (PR #11 round 2)', () => {
    // The diagnostic run against the user's MiSTer (PR #11 round 1)
    // surfaced ten canonical-form duplicates. Each pair has both
    // representations on disk: the rbf/mgl uses one casing /
    // punctuation, the games dir uses another. Canonical-form
    // merging in Round 2 collapses each pair to a single CoreEntry.
    it.each([
      ['.Atari 2600.mgl', 'Atari2600'],
      ['.Game Gear.mgl', 'GameGear'],
      ['.Mega Duck.mgl', 'MegaDuck'],
      ['.Pocket Challenge V2.mgl', 'PocketChallengeV2'],
      ['WonderSwan Color.mgl', 'WonderSwanColor'],
      ['.CDi_20250626.rbf', 'CD-i'],
      ['.SordM5_20250903.rbf', 'Sord M5'],
      ['Super_Vision_8000_20250622.rbf', 'SuperVision8000'],
    ])(
      'merges %s with games-dir %s into one CoreEntry',
      (rbfFilename, gamesDir) => {
        const result = matchRbfsToGamesDirs({
          rbfs: [
            {
              category: 'Console',
              filename: rbfFilename,
              fullPath: `/media/fat/_Console/${rbfFilename}`,
              isFolder: false,
            },
          ],
          gamesDirs: [
            { rawName: gamesDir, files: ['game.bin'], dirs: [] },
          ],
        });
        // Pre-Round-2: this would have been TWO entries (the rbf
        // prefix and the games-dir name canonicalised differently
        // under lowercase-only matching). Round 2: ONE entry.
        const matches = result.filter(
          (c) => canonicalize(c.id) === canonicalize(gamesDir),
        );
        expect(matches).toHaveLength(1);
        // Games-dir name wins as the display id.
        expect(matches[0]?.id).toBe(gamesDir);
        // Both sides present on the merged entry.
        expect(matches[0]?.rbfPaths).toEqual([
          `/media/fat/_Console/${rbfFilename}`,
        ]);
        expect(matches[0]?.gamesDirExists).toBe(true);
        expect(matches[0]?.gamesDirName).toBe(gamesDir);
      },
    );

    it('does NOT collapse semantic synonyms — GBC and GameboyColor stay separate', () => {
      // The user's MiSTer has BOTH .GameboyColor.mgl AND a games dir
      // called "GBC". They're the same console, but synonyms are out
      // of scope (require a hardcoded table that would be brittle).
      // Canonical-form matching respects the on-disk reality: two
      // distinct names → two distinct cores.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: '.GameboyColor.mgl',
            fullPath: '/media/fat/_Console/.GameboyColor.mgl',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: 'GBC', files: ['game.gbc'], dirs: [] }],
      });
      expect(
        result.find((c) => canonicalize(c.id) === 'gameboycolor'),
      ).toBeDefined();
      expect(
        result.find((c) => canonicalize(c.id) === 'gbc'),
      ).toBeDefined();
    });
  });

  describe('orphan filter (PR #11 round 2 / Change 4)', () => {
    it('keeps games-dir-only cores with countable content', () => {
      // mame on a real MiSTer: hundreds of arcade ROMs in a games
      // dir but no `mame.rbf`. Should appear as a core (the user
      // can hide it, browse it).
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'mame', files: Array.from({ length: 50 }, (_, i) => `g${String(i)}.zip`), dirs: [] },
        ],
      });
      const mame = result.find((c) => c.id === 'mame');
      expect(mame).toBeDefined();
      expect(mame?.romCount).toBe(50);
    });

    it('drops empty games-dir-only cores', () => {
      // Real-MiSTer leftovers: `games/Adam/`, `games/PC8801/`,
      // `games/NeoGeo-CD/` — all empty. Pre-Round-2 these showed
      // up as 0-count rows. Now they're filtered.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          { rawName: 'Adam', files: [], dirs: [] },
          { rawName: 'PC8801', files: [], dirs: [] },
        ],
      });
      expect(result.find((c) => c.id === 'Adam')).toBeUndefined();
      expect(result.find((c) => c.id === 'PC8801')).toBeUndefined();
    });

    it('drops a games-dir whose only entries are system folders', () => {
      // Vectrex shape: `games/VECTREX/Overlays/` is the only
      // top-level entry, and Overlays is a system folder.
      // shouldCountAsRom drops Overlays at the top level →
      // romCount = 0 → orphan filter drops the whole core.
      const result = matchRbfsToGamesDirs({
        rbfs: [],
        gamesDirs: [
          {
            rawName: 'VECTREX',
            files: [],
            dirs: ['Overlays'],
            subFolders: [
              {
                name: 'Overlays',
                files: ['a.png', 'b.png'],
                dirs: [],
                recursiveFileCount: 90,
              },
            ],
          },
        ],
      });
      expect(result.find((c) => c.id === 'VECTREX')).toBeUndefined();
    });

    it('keeps an rbf-only core regardless of count (it is launchable)', () => {
      // SMS without a games dir: the user might have only just
      // installed the rbf and hasn't copied any ROMs yet. Shows in
      // the cores list as a 0-count row so the user can hide it.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'SMS_20240115.rbf',
            fullPath: '/media/fat/_Console/SMS_20240115.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [],
      });
      const sms = result.find((c) => c.id === 'SMS');
      expect(sms).toBeDefined();
      expect(sms?.romCount).toBe(0);
    });
  });

  describe('canonical-form merging (PR #11 round 2)', () => {
    it('case-mismatched siblings collapse to one entry; games-dir name wins', () => {
      // The exact shape from the real-MiSTer snapshot:
      //   _Console/Vectrex_20240524.rbf   (visible canonical .rbf)
      //   games/.VECTREX                  (hidden games dir, different case)
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: 'Vectrex_20240524.rbf',
            fullPath: '/media/fat/_Console/Vectrex_20240524.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.VECTREX', files: [], dirs: [] }],
      });

      const matches = result.filter((c) => c.id.toLowerCase() === 'vectrex');
      expect(matches).toHaveLength(1);
      const merged = matches[0]!;
      // Round 2: games-dir name wins as the display id.
      expect(merged.id).toBe('VECTREX');
      // The on-disk basename is preserved.
      expect(merged.gamesDirExists).toBe(true);
      expect(merged.gamesDirHidden).toBe(true);
      expect(merged.gamesDirName).toBe('VECTREX');
      expect(merged.rbfPaths).toEqual(['/media/fat/_Console/Vectrex_20240524.rbf']);
    });

    it('keeps an all-hidden case-mismatched pair as one hidden entry', () => {
      // PR #11 round 2: pre-existing rule was "drop the whole group
      // when every sibling is hidden" (treat as MiSTer leftover).
      // The Round 5 two-state model invalidated that — hidden cores
      // with rbfs are now first-class (the user can unhide them with
      // one click). The matcher keeps one merged hidden entry.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: '.Apogee_20240502.rbf',
            fullPath: '/media/fat/_Computer/.Apogee_20240502.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.APOGEE', files: [], dirs: [] }],
      });
      const apogee = result.find((c) => c.id.toLowerCase() === 'apogee');
      expect(apogee).toBeDefined();
      expect(apogee?.gamesDirHidden).toBe(true);
      expect(apogee?.rbfPaths).toEqual([
        '/media/fat/_Computer/.Apogee_20240502.rbf',
      ]);
      expect(isCoreHidden(apogee!)).toBe(true);
    });

    it('keeps a single hidden entry when there are no case siblings', () => {
      // A regular hidden core (NES alone, no case duplicate) is kept.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Console',
            filename: '.NES_20240115.rbf',
            fullPath: '/media/fat/_Console/.NES_20240115.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [],
      });
      expect(result.find((c) => c.id === 'NES')).toBeDefined();
    });

    it('preserves the gamesDirName when the case differs from the rbf prefix', () => {
      // `_Computer/SAMCoupe_20240421.rbf` (visible) + `games/.SAMCOUPE`
      // (hidden). PR #11 round 2: games-dir name wins as id; the
      // gamesDirName field still records the on-disk basename so
      // renames target the right path.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: 'SAMCoupe_20240421.rbf',
            fullPath: '/media/fat/_Computer/SAMCoupe_20240421.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.SAMCOUPE', files: [], dirs: [] }],
      });
      const merged = result.find((c) => c.id.toLowerCase() === 'samcoupe');
      // Games-dir name wins as the display id.
      expect(merged?.id).toBe('SAMCOUPE');
      expect(merged?.gamesDirName).toBe('SAMCOUPE');
    });
  });
});

describe('isRealCore', () => {
  function makeCore(overrides: Partial<CoreEntry> = {}): CoreEntry {
    return {
      id: 'X',
      name: 'X',
      romCount: 0,
      hiddenCount: 0,
      category: 'Console',
      rbfPaths: [],
      gamesDirExists: false,
      gamesDirHidden: false,
      ...overrides,
    };
  }

  it('returns true for a core with at least one rbf', () => {
    expect(
      isRealCore(makeCore({ rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'] })),
    ).toBe(true);
  });

  it('returns true for a core with a games dir but no rbf', () => {
    expect(isRealCore(makeCore({ gamesDirExists: true, category: 'Unknown' }))).toBe(true);
  });

  it('returns false for a CoreEntry that has neither rbfs nor a games dir', () => {
    // This is the user-folder shape — `_Console/_hidden`, `_Computer/_Organized`,
    // `_Arcade/_alternatives` etc. The matcher should never produce one of
    // these, but isRealCore is the defensive net at the operation layer.
    expect(isRealCore(makeCore({ id: '_hidden' }))).toBe(false);
    expect(isRealCore(makeCore({ id: '_Organized' }))).toBe(false);
    expect(isRealCore(makeCore({ id: '_alternatives' }))).toBe(false);
  });

  it('returns false for the synthetic Arcade placeholder', () => {
    expect(
      isRealCore(makeCore({ id: ARCADE_PLACEHOLDER_ID, category: 'Arcade' })),
    ).toBe(false);
  });

  it('returns false for any Arcade-category entry', () => {
    expect(
      isRealCore(
        makeCore({
          category: 'Arcade',
          rbfPaths: ['/media/fat/_Arcade/Galaga_20240115.rbf'],
        }),
      ),
    ).toBe(false);
  });
});

describe('isCoreHidden', () => {
  function makeCore(overrides: Partial<CoreEntry> = {}): CoreEntry {
    return {
      id: 'X',
      name: 'X',
      romCount: 0,
      hiddenCount: 0,
      category: 'Console',
      rbfPaths: [],
      gamesDirExists: false,
      gamesDirHidden: false,
      ...overrides,
    };
  }

  // Round 5 simplified the model to two states: a core is hidden if
  // EITHER its games dir or any of its rbf files is dot-prefixed.
  // Our own hide flow renames both atomically so they always agree;
  // the asymmetric cases (rbf hidden + games dir visible, or vice
  // versa, all dating to MiSTer setups predating this app) read as
  // hidden so the user can clean them up with one Unhide click.

  it('returns true when both games dir and rbfs are hidden', () => {
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: true,
          rbfPaths: ['/x/.X_20240115.rbf'],
        }),
      ),
    ).toBe(true);
  });

  it('returns true when only the games dir is hidden (rbf visible)', () => {
    // The Round 3 "externally hidden" case (Atari7800 + .ATARI7800):
    // pre-Round-5, this read as visible because the rbf was visible.
    // Round 5 reads it as hidden — the user gets one Unhide click to
    // clean it up, no special-cased UI.
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: true,
          rbfPaths: ['/x/X_20240115.rbf'],
        }),
      ),
    ).toBe(true);
  });

  it('returns true when any rbf is dot-prefixed (games dir visible)', () => {
    // The mirror image: rbf hidden, games dir visible. Same rule —
    // any dot-prefixed component reads as hidden.
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: false,
          rbfPaths: ['/x/.X_20240115.rbf'],
        }),
      ),
    ).toBe(true);
  });

  it('returns true when one rbf is hidden and another is visible', () => {
    // A "sloppy" state where the user manually undotted one rbf but
    // not the other. Reads as hidden so the eye-click un-prefixes
    // everything in lockstep.
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: false,
          rbfPaths: ['/x/.X_20240115.rbf', '/x/X_20231215.rbf'],
        }),
      ),
    ).toBe(true);
  });

  it('returns false when nothing is dot-prefixed', () => {
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: false,
          rbfPaths: ['/x/X_20240115.rbf'],
        }),
      ),
    ).toBe(false);
  });

  it('returns false when the games dir is visible and there are no rbfs', () => {
    expect(
      isCoreHidden(
        makeCore({ gamesDirExists: true, gamesDirHidden: false, rbfPaths: [] }),
      ),
    ).toBe(false);
  });

  it('returns true for an rbf-only core that is hidden', () => {
    expect(
      isCoreHidden(makeCore({ rbfPaths: ['/x/.X_20240115.rbf'] })),
    ).toBe(true);
  });

  it('returns false for the synthetic placeholder shape (no rbfs, no games dir)', () => {
    // The arcade placeholder fits this shape. Round 5 reports it as
    // visible — the cores list has its own placeholder rendering
    // path that doesn't depend on this signal.
    expect(
      isCoreHidden(
        makeCore({ rbfPaths: [], gamesDirExists: false, gamesDirHidden: false }),
      ),
    ).toBe(false);
  });
});

describe('computeCoreRenames', () => {
  function makeCore(overrides: Partial<CoreEntry> = {}): CoreEntry {
    return {
      id: 'NES',
      name: 'NES',
      romCount: 0,
      hiddenCount: 0,
      category: 'Console',
      rbfPaths: [],
      gamesDirExists: false,
      gamesDirHidden: false,
      ...overrides,
    };
  }

  it('returns an empty list when the core is already in the desired state', () => {
    const core = makeCore({
      gamesDirExists: true,
      gamesDirName: 'NES',
      gamesDirHidden: true,
      rbfPaths: ['/media/fat/_Console/.NES_20240115.rbf'],
    });
    expect(computeCoreRenames(core, true)).toEqual([]);
  });

  it('uses the id when gamesDirName is absent', () => {
    const core = makeCore({
      gamesDirExists: true,
      gamesDirName: undefined,
    });
    const renames = computeCoreRenames(core, true);
    expect(renames).toEqual([
      { from: '/media/fat/games/NES', to: '/media/fat/games/.NES' },
    ]);
  });

  it('uses gamesDirName for path construction when it differs from id (case-mismatch)', () => {
    // canonical id is "Apogee" but the on-disk dir is "APOGEE"
    const core = makeCore({
      id: 'Apogee',
      name: 'Apogee',
      gamesDirExists: true,
      gamesDirName: 'APOGEE',
    });
    const renames = computeCoreRenames(core, true);
    expect(renames).toEqual([
      { from: '/media/fat/games/APOGEE', to: '/media/fat/games/.APOGEE' },
    ]);
  });

  it('un-hides a core whose games dir was hidden under a case-mismatched name', () => {
    const core = makeCore({
      id: 'Apogee',
      gamesDirExists: true,
      gamesDirHidden: true,
      gamesDirName: 'APOGEE',
    });
    const renames = computeCoreRenames(core, false);
    expect(renames).toEqual([
      { from: '/media/fat/games/.APOGEE', to: '/media/fat/games/APOGEE' },
    ]);
  });
});

describe('matchRbfsToGamesDirs — diagnostics collector (PR #11 prep)', () => {
  it('emits an rbf record per RawRbfInput, with extractedPrefix', () => {
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
        {
          category: 'Console',
          filename: 'Game Gear.mgl',
          fullPath: '/media/fat/_Console/Game Gear.mgl',
          isFolder: false,
        },
      ],
      gamesDirs: [],
      diagnostics: diag,
    });
    const rbfRecords = diag.byKind('rbf');
    expect(rbfRecords).toHaveLength(2);
    expect(rbfRecords[0]?.extractedPrefix).toBe('NES');
    expect(rbfRecords[1]?.extractedPrefix).toBe('Game Gear');
    expect(rbfRecords[1]?.type).toBe('file');
  });

  it('emits a games-dir record per RawGamesDirInput with hidden flag', () => {
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [
        { rawName: 'NES', files: ['a.nes', 'b.nes'], dirs: [] },
        { rawName: '.HIDDEN', files: [], dirs: [] },
      ],
      diagnostics: diag,
    });
    const recs = diag.byKind('games-dir');
    expect(recs).toHaveLength(2);
    expect(recs[0]?.visibleName).toBe('NES');
    expect(recs[0]?.isHidden).toBe(false);
    expect(recs[1]?.visibleName).toBe('HIDDEN');
    expect(recs[1]?.isHidden).toBe(true);
  });

  it('emits a system-filter record per file/dir, distinguishing auto vs user-mark', () => {
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [
        {
          rawName: 'NEOGEO',
          files: ['mslug.zip', 'boot.rom'],
          dirs: ['1 World A-Z', 'Overlays'],
        },
      ],
      diagnostics: diag,
    });
    const filterRecs = diag.byKind('system-filter');
    const byPath = new Map(filterRecs.map((r) => [r.path, r]));
    // boot.rom is auto-detected as system; mslug.zip is not.
    expect(byPath.get('boot.rom')?.isAutoSystem).toBe(true);
    expect(byPath.get('boot.rom')?.decision).toBe('filtered');
    expect(byPath.get('mslug.zip')?.isAutoSystem).toBe(false);
    expect(byPath.get('mslug.zip')?.decision).toBe('kept');
    // PR #11 round 2: Overlays IS auto-detected as a system folder
    // and `shouldCountAsRom` (the unified filter) drops it. The
    // pre-Round-2 cores-list filter only honored user-marks for
    // dirs, so Overlays leaked through; that was the Vectrex bug.
    // Now both code paths agree and Overlays comes back filtered.
    expect(byPath.get('Overlays')?.entryType).toBe('dir');
    expect(byPath.get('Overlays')?.isAutoSystem).toBe(true);
    expect(byPath.get('Overlays')?.decision).toBe('filtered');
  });

  it('emits a recursive-count record per top-level entry walked', () => {
    // Round 5: classifyFolder now requires the many-same-ext signal
    // (5+ files of one extension) to flip a cart-shape folder to
    // container. Real NEOGEO `1 World A-Z/` holds 30+ .zip files,
    // so the fixture mirrors that shape.
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [],
      gamesDirs: [
        {
          rawName: 'NEOGEO',
          files: [],
          dirs: ['1 World A-Z'],
          subFolders: [
            {
              name: '1 World A-Z',
              files: [
                'mslug.zip',
                'kof97.zip',
                'samsho.zip',
                'lastblade2.zip',
                'garou.zip',
                'mslug3.zip',
              ],
              dirs: [],
              recursiveFileCount: 30,
            },
          ],
        },
      ],
      diagnostics: diag,
    });
    const recs = diag.byKind('recursive-count');
    expect(recs).toHaveLength(1);
    expect(recs[0]?.coreId).toBe('NEOGEO');
    expect(recs[0]?.classification).toBe('container');
    expect(recs[0]?.contributesCount).toBe(30);
  });

  it('emits a match-attempt record per canonical-key bucket', () => {
    // PR #11 round 2: the lowerKey is now the canonical form
    // (lowercase + non-alphanum stripped) rather than just lower-
    // case, so case-AND-punctuation-mismatched siblings collapse
    // (Atari 2600 vs Atari2600). The merged.outcome is `'merged'`
    // when both an rbf and a games dir contribute.
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Computer',
          filename: 'Apogee_20240502.rbf',
          fullPath: '/media/fat/_Computer/Apogee_20240502.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [{ rawName: 'APOGEE', files: ['game.bin'], dirs: [] }],
      diagnostics: diag,
    });
    const matchRecs = diag.byKind('match-attempt');
    const merged = matchRecs.find((r) => r.outcome === 'merged');
    expect(merged).toBeDefined();
    expect(merged?.lowerKey).toBe('apogee');
    // Both the rbf prefix ("Apogee") and the games-dir name ("APOGEE")
    // contributed to this canonical bucket.
    expect([...(merged?.groupIds ?? [])].sort()).toEqual(['APOGEE', 'Apogee']);
  });

  it('emits a core-entry record per finalized CoreEntry', () => {
    const diag = new InMemoryDiagnosticsCollector();
    matchRbfsToGamesDirs({
      rbfs: [
        {
          category: 'Console',
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [{ rawName: 'NES', files: ['a.nes'], dirs: [] }],
      diagnostics: diag,
    });
    const cores = diag.byKind('core-entry');
    expect(cores).toHaveLength(1);
    expect(cores[0]?.coreId).toBe('NES');
    expect(cores[0]?.romCount).toBe(1);
    expect(cores[0]?.hasAnyVisibleRbf).toBe(true);
    expect(cores[0]?.rbfPaths).toEqual([
      '/media/fat/_Console/NES_20240115.rbf',
    ]);
  });

  it('does not change matcher output when diagnostics is supplied', () => {
    // Bug-prevention: any future emit that accidentally mutates
    // matcher state would break this. The matcher with and without
    // a collector must produce structurally identical results.
    const input = {
      rbfs: [
        {
          category: 'Console' as const,
          filename: 'NES_20240115.rbf',
          fullPath: '/media/fat/_Console/NES_20240115.rbf',
          isFolder: false,
        },
      ],
      gamesDirs: [{ rawName: 'NES', files: ['a.nes', '.b.nes'], dirs: [] }],
    };
    const without = matchRbfsToGamesDirs(input);
    const diag = new InMemoryDiagnosticsCollector();
    const withDiag = matchRbfsToGamesDirs({ ...input, diagnostics: diag });
    expect(withDiag).toEqual(without);
  });
});

describe('computeAutoReapplyChanges', () => {
  const ledger: HideLedger = {
    schemaVersion: 1,
    hiddenCores: [
      {
        coreId: 'NES',
        gamesDirHidden: true,
        rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
        hiddenAt: '2026-01-01T00:00:00Z',
      },
      {
        coreId: 'SNES',
        gamesDirHidden: true,
        rbfPaths: ['/media/fat/_Console/SNES_20240115.rbf'],
        hiddenAt: '2026-01-01T00:00:00Z',
      },
    ],
  };

  function makeCore(id: string, overrides: Partial<CoreEntry> = {}): CoreEntry {
    return {
      id,
      name: id,
      romCount: 0,
      hiddenCount: 0,
      category: 'Console',
      rbfPaths: [],
      gamesDirExists: true,
      gamesDirHidden: false,
      ...overrides,
    };
  }

  it('returns the cores that the ledger says are hidden but the device says are visible', () => {
    const result = computeAutoReapplyChanges(ledger, [
      makeCore('NES'), // came back visible
      makeCore('SNES', { gamesDirHidden: true, rbfPaths: ['/x/.SNES_20240115.rbf'] }), // still hidden
    ]);
    expect(result).toEqual([{ coreId: 'NES', hidden: true }]);
  });

  it('skips cores that no longer exist on the device', () => {
    const result = computeAutoReapplyChanges(ledger, []);
    expect(result).toEqual([]);
  });

  it('refuses to re-hide arcade cores even if the ledger says so', () => {
    const result = computeAutoReapplyChanges(ledger, [
      makeCore('NES', { category: 'Arcade' }),
      makeCore('SNES'),
    ]);
    expect(result).toEqual([{ coreId: 'SNES', hidden: true }]);
  });

  it('returns an empty list when nothing has drifted', () => {
    const result = computeAutoReapplyChanges(ledger, [
      makeCore('NES', { gamesDirHidden: true, rbfPaths: ['/x/.NES_20240115.rbf'] }),
      makeCore('SNES', { gamesDirHidden: true, rbfPaths: ['/x/.SNES_20240115.rbf'] }),
    ]);
    expect(result).toEqual([]);
  });
});
