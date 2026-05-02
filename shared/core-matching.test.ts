import { describe, expect, it } from 'vitest';

import type { CoreEntry, HideLedger } from '@shared/types';

import {
  ARCADE_PLACEHOLDER_ID,
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
      gamesDirs: [{ rawName: 'NES', romCount: 9, hiddenCount: 2 }],
    });

    expect(result).toEqual([
      {
        id: 'NES',
        name: 'NES',
        romCount: 9,
        hiddenCount: 2,
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
      gamesDirs: [{ rawName: 'NES', romCount: 1, hiddenCount: 0 }],
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
      gamesDirs: [{ rawName: 'WeirdCore', romCount: 3, hiddenCount: 0 }],
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
      gamesDirs: [{ rawName: '.SNES', romCount: 5, hiddenCount: 0 }],
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
      gamesDirs: [{ rawName: 'AO486', romCount: 0, hiddenCount: 0 }],
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

  describe('case-duplicate dedupe', () => {
    it('keeps the visible entry when one sibling is hidden (visible+hidden)', () => {
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
        gamesDirs: [{ rawName: '.VECTREX', romCount: 0, hiddenCount: 0 }],
      });

      const matches = result.filter((c) => c.id.toLowerCase() === 'vectrex');
      expect(matches).toHaveLength(1);
      const merged = matches[0]!;
      // The visible rbf entry survives — its id (canonical case) wins.
      expect(merged.id).toBe('Vectrex');
      // ...but the case-mismatched games dir name is preserved so
      // operations target the on-disk basename.
      expect(merged.gamesDirExists).toBe(true);
      expect(merged.gamesDirHidden).toBe(true);
      expect(merged.gamesDirName).toBe('VECTREX');
      expect(merged.rbfPaths).toEqual(['/media/fat/_Console/Vectrex_20240524.rbf']);
    });

    it('drops the entire group when every case-sibling is hidden (both hidden)', () => {
      // Real MiSTer: `_Computer/.Apogee_*.rbf` next to `games/.APOGEE`.
      // Both hidden → MiSTer leftover, drop both.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: '.Apogee_20240502.rbf',
            fullPath: '/media/fat/_Computer/.Apogee_20240502.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.APOGEE', romCount: 0, hiddenCount: 0 }],
      });
      expect(result.find((c) => c.id.toLowerCase() === 'apogee')).toBeUndefined();
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
      // (hidden) — visible wins, gamesDirName preserves the `SAMCOUPE`
      // case so a future hide hits the right path.
      const result = matchRbfsToGamesDirs({
        rbfs: [
          {
            category: 'Computer',
            filename: 'SAMCoupe_20240421.rbf',
            fullPath: '/media/fat/_Computer/SAMCoupe_20240421.rbf',
            isFolder: false,
          },
        ],
        gamesDirs: [{ rawName: '.SAMCOUPE', romCount: 0, hiddenCount: 0 }],
      });
      const merged = result.find((c) => c.id.toLowerCase() === 'samcoupe');
      expect(merged?.id).toBe('SAMCoupe');
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

  it('returns false when at least one rbf is visible', () => {
    expect(
      isCoreHidden(
        makeCore({
          gamesDirExists: true,
          gamesDirHidden: true,
          rbfPaths: ['/x/.X_20240115.rbf', '/x/X_20231215.rbf'],
        }),
      ),
    ).toBe(false);
  });

  it('returns false when the games dir is visible', () => {
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
