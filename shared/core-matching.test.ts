import { describe, expect, it } from 'vitest';

import type { CoreEntry, HideLedger } from '@shared/types';

import {
  computeAutoReapplyChanges,
  dottedPath,
  extractCorePrefix,
  isCoreHidden,
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

  it('preserves Arcade category so the UI can disable hide on it', () => {
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
    });
    expect(result[0]?.category).toBe('Arcade');
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
