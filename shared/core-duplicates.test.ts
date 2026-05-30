import { describe, expect, it } from 'vitest';

import { detectCoreDuplicates } from '@shared/core-duplicates';
import type { CoreEntry } from '@shared/types';

function makeCore(partial: Partial<CoreEntry> & { id: string }): CoreEntry {
  return {
    name: partial.id,
    romCount: 0,
    hiddenCount: 0,
    category: 'Console',
    rbfPaths: [],
    gamesDirExists: false,
    gamesDirHidden: false,
    ...partial,
  };
}

describe('detectCoreDuplicates', () => {
  it('empty input → empty array', () => {
    expect(detectCoreDuplicates([])).toEqual([]);
  });

  it('cores with no duplicates → empty array', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/.NES_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'NES',
      }),
      makeCore({
        id: 'SNES',
        rbfPaths: ['/media/fat/_Console/SNES_20240201.rbf'],
        gamesDirExists: true,
        gamesDirHidden: false,
        gamesDirName: 'SNES',
      }),
    ];
    expect(detectCoreDuplicates(cores)).toEqual([]);
  });

  it('core with paired .rbf → one DuplicatePair (kind=rbf)', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
        ],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'NES',
      }),
    ];
    const result = detectCoreDuplicates(cores);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      coreId: 'NES',
      kind: 'rbf',
      visiblePath: '/media/fat/_Console/NES_20240115.rbf',
      hiddenPath: '/media/fat/_Console/.NES_20240115.rbf',
    });
  });

  it('core with paired gamesDir → one DuplicatePair (kind=gamesDir)', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/.NES_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: false,
        gamesDirName: 'NES',
        gamesDirDuplicate: true,
      }),
    ];
    const result = detectCoreDuplicates(cores);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      coreId: 'NES',
      kind: 'gamesDir',
      visiblePath: '/media/fat/games/NES',
      hiddenPath: '/media/fat/games/.NES',
    });
  });

  it('core with both paired rbf and gamesDir → two DuplicatePairs', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
        ],
        gamesDirExists: true,
        gamesDirHidden: false,
        gamesDirName: 'NES',
        gamesDirDuplicate: true,
      }),
    ];
    const result = detectCoreDuplicates(cores);
    expect(result).toHaveLength(2);
    const kinds = result.map((p) => p.kind).sort();
    expect(kinds).toEqual(['gamesDir', 'rbf']);
  });

  it('multiple paired rbf versions for the same core → one pair per canonical', () => {
    // Two date-versioned rbfs both have dotted+undotted variants
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
          '/media/fat/_Console/NES_20240201.rbf',
          '/media/fat/_Console/.NES_20240201.rbf',
        ],
      }),
    ];
    // Both date variants collapse to the same canonical 'nes' after
    // extractCorePrefix strips the date suffix, so the map has ONE
    // entry with dotted+undotted — the last write per form wins.
    const result = detectCoreDuplicates(cores);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe('rbf');
  });

  it('rbf duplicate does not emit gamesDir pair when gamesDirDuplicate is absent', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
        ],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'NES',
        // gamesDirDuplicate not set
      }),
    ];
    const result = detectCoreDuplicates(cores);
    expect(result.every((p) => p.kind === 'rbf')).toBe(true);
  });

  it('coreName is preserved in pair', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        name: 'Nintendo Entertainment System',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
        ],
      }),
    ];
    const result = detectCoreDuplicates(cores);
    expect(result[0]?.coreName).toBe('Nintendo Entertainment System');
  });
});
