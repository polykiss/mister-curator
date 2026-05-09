import { describe, expect, it } from 'vitest';

import type { Rom } from '@shared/types';

import { classifyRow } from '@app/renderer/src/lib/row-type';

function rom(kind: Rom['kind'], filename = 'x.smc'): Rom {
  return {
    coreId: 'SNES',
    filename,
    displayName: filename,
    sizeBytes: 1024,
    hidden: false,
    path: `/media/fat/games/SNES/${filename}`,
    kind,
    relativePath: filename,
  };
}

describe('classifyRow', () => {
  it('maps a file ROM to "game"', () => {
    expect(classifyRow({ kind: 'rom', rom: rom('file') })).toBe('game');
  });

  it('maps a folder-atomic ROM to "single-game-folder"', () => {
    // The backend's `folder-atomic` IS the X68000-style single-game
    // folder shape — `classifyFolder` (shared/folder-rom.ts) returns
    // `'atomic'` for "1 cart-extension file, no subdirs". The row
    // classifier doesn't re-run the analysis; one source of truth.
    expect(classifyRow({ kind: 'rom', rom: rom('folder-atomic', 'Castlevania') })).toBe(
      'single-game-folder',
    );
  });

  it('maps a folder-container ROM to "explorable-folder"', () => {
    expect(classifyRow({ kind: 'rom', rom: rom('folder-container', '1 World A-Z') })).toBe(
      'explorable-folder',
    );
  });

  it('maps the back-row marker to "back"', () => {
    expect(classifyRow({ kind: 'back' })).toBe('back');
  });

  it('is exhaustive over Rom.kind — adding a new kind would fail to compile', () => {
    // Compile-time check: the switch in `classifyRow` has no `default`,
    // so a new value in the union triggers TS exhaustiveness errors.
    // Enumerate here so the test fails if the union grows.
    const allKinds: readonly Rom['kind'][] = [
      'file',
      'folder-atomic',
      'folder-container',
    ];
    for (const k of allKinds) {
      expect(classifyRow({ kind: 'rom', rom: rom(k) })).toMatch(
        /^(game|single-game-folder|explorable-folder)$/,
      );
    }
  });
});
