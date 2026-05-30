import { describe, expect, it } from 'vitest';

import { auditCores } from '@shared/core-audit';
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

describe('auditCores', () => {
  it('empty input → both arrays empty', () => {
    const result = auditCores([]);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('all-clean cores (rbf + games dir) → both arrays empty', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
        gamesDirExists: true,
        romCount: 100,
      }),
      makeCore({
        id: 'SNES',
        rbfPaths: ['/media/fat/_Console/SNES_20240201.rbf'],
        gamesDirExists: true,
        romCount: 200,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('core with games dir but no rbf → missingCoreFile', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'X68000',
        rbfPaths: [],
        gamesDirExists: true,
        gamesDirName: 'X68000',
        romCount: 42,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(1);
    expect(result.missingCoreFile[0]?.id).toBe('X68000');
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('core with rbf but no games dir → noRomsForCore', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'Minimig',
        rbfPaths: ['/media/fat/_Computer/Minimig_20240115.rbf'],
        gamesDirExists: false,
        romCount: 0,
      }),
    ];
    const result = auditCores(cores);
    expect(result.noRomsForCore).toHaveLength(1);
    expect(result.noRomsForCore[0]?.id).toBe('Minimig');
    expect(result.missingCoreFile).toHaveLength(0);
  });

  it('fully-hidden core (all rbfs dotted + games dir hidden) → neither array', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/.NES_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'NES',
        romCount: 50,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('fully-hidden rbf-only core (all rbfs dotted, no games dir) → neither array', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'Minimig',
        rbfPaths: ['/media/fat/_Computer/.Minimig_20240115.rbf'],
        gamesDirExists: false,
        romCount: 0,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('core with any visible rbf (mix of dotted+undotted) → not skipped', () => {
    // Only ALL-dotted rbfPaths triggers the fully-hidden skip.
    // A mix means the core is at least partially visible.
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: [
          '/media/fat/_Console/NES_20240115.rbf',
          '/media/fat/_Console/.NES_20240115.rbf',
        ],
        gamesDirExists: false,
      }),
    ];
    const result = auditCores(cores);
    expect(result.noRomsForCore).toHaveLength(1);
    expect(result.noRomsForCore[0]?.id).toBe('NES');
  });

  it('Arcade category → skipped regardless of rbf/gamesDir state', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: '__arcade__',
        category: 'Arcade',
        rbfPaths: [],
        gamesDirExists: true,
        romCount: 500,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('core with rbf + hidden games dir → neither array (has games dir)', () => {
    // rbf present + games dir exists (just hidden) = core is installed and
    // has ROMs — user hid the dir. Not a missing-core or no-roms situation.
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'NES',
        romCount: 50,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile).toHaveLength(0);
    expect(result.noRomsForCore).toHaveLength(0);
  });

  it('mame core → included in noRomsForCore when no games dir', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'mame',
        category: 'Computer',
        rbfPaths: ['/media/fat/_Computer/mame_20240115.rbf'],
        gamesDirExists: false,
      }),
    ];
    const result = auditCores(cores);
    expect(result.noRomsForCore).toHaveLength(1);
    expect(result.noRomsForCore[0]?.id).toBe('mame');
  });

  it('multiple cores with mixed states → categorized correctly', () => {
    const cores: CoreEntry[] = [
      makeCore({
        id: 'NES',
        rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
        gamesDirExists: true,
        romCount: 100,
      }),
      makeCore({
        id: 'X68000',
        rbfPaths: [],
        gamesDirExists: true,
        gamesDirName: 'X68000',
        romCount: 10,
      }),
      makeCore({
        id: 'Minimig',
        rbfPaths: ['/media/fat/_Computer/Minimig_20240115.rbf'],
        gamesDirExists: false,
      }),
      makeCore({
        id: 'GhostHidden',
        rbfPaths: ['/media/fat/_Console/.GhostHidden_20240115.rbf'],
        gamesDirExists: true,
        gamesDirHidden: true,
        gamesDirName: 'GhostHidden',
        romCount: 5,
      }),
    ];
    const result = auditCores(cores);
    expect(result.missingCoreFile.map((c) => c.id)).toEqual(['X68000']);
    expect(result.noRomsForCore.map((c) => c.id)).toEqual(['Minimig']);
  });
});
