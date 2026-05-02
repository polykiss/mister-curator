import { describe, expect, it } from 'vitest';

import type { Core, Rom } from '@shared/types';

import {
  applyBulkVisibilityChange,
  applyVisibilityChange,
  recountCore,
} from '@app/renderer/src/lib/optimistic';

function makeRom(filename: string, hidden: boolean): Rom {
  const visible = hidden ? filename.slice(1) : filename;
  return {
    coreId: 'NES',
    filename,
    displayName: visible,
    sizeBytes: 1024,
    hidden,
    path: `/media/fat/games/NES/${filename}`,
  };
}

describe('applyVisibilityChange', () => {
  it('renames a visible ROM to dot-prefixed when hiding', () => {
    const roms = [makeRom('foo.nes', false), makeRom('bar.nes', false)];
    const next = applyVisibilityChange(roms, { filename: 'foo.nes', hidden: true });

    expect(next[0]).toEqual({
      coreId: 'NES',
      filename: '.foo.nes',
      displayName: 'foo.nes',
      sizeBytes: 1024,
      hidden: true,
      path: '/media/fat/games/NES/.foo.nes',
    });
    expect(next[1]).toBe(roms[1]); // unchanged reference
  });

  it('strips the leading dot when un-hiding', () => {
    const roms = [makeRom('.bar.nes', true)];
    const next = applyVisibilityChange(roms, { filename: '.bar.nes', hidden: false });

    expect(next[0]?.filename).toBe('bar.nes');
    expect(next[0]?.hidden).toBe(false);
    expect(next[0]?.path).toBe('/media/fat/games/NES/bar.nes');
  });

  it('returns the same content when already in the target state', () => {
    const roms = [makeRom('foo.nes', false)];
    const next = applyVisibilityChange(roms, { filename: 'foo.nes', hidden: false });

    expect(next).toEqual(roms);
  });

  it('leaves unrelated rows untouched and returns a new array reference', () => {
    const roms = [makeRom('foo.nes', false), makeRom('bar.nes', false)];
    const next = applyVisibilityChange(roms, { filename: 'foo.nes', hidden: true });

    expect(next).not.toBe(roms);
    expect(next[1]).toBe(roms[1]);
  });

  it('is a no-op when the filename is not in the list', () => {
    const roms = [makeRom('foo.nes', false)];
    const next = applyVisibilityChange(roms, { filename: 'gone.nes', hidden: true });

    expect(next).toEqual(roms);
  });
});

describe('applyBulkVisibilityChange', () => {
  it('applies a mix of hide and show in one pass', () => {
    const roms = [
      makeRom('a.nes', false),
      makeRom('.b.nes', true),
      makeRom('c.nes', false),
    ];
    const next = applyBulkVisibilityChange(roms, [
      { filename: 'a.nes', hidden: true },
      { filename: '.b.nes', hidden: false },
    ]);

    expect(next.find((r) => r.displayName === 'a.nes')?.hidden).toBe(true);
    expect(next.find((r) => r.displayName === 'b.nes')?.hidden).toBe(false);
    expect(next.find((r) => r.displayName === 'c.nes')?.hidden).toBe(false);
  });

  it('handles an empty change set as identity', () => {
    const roms = [makeRom('foo.nes', false)];
    expect(applyBulkVisibilityChange(roms, [])).toEqual(roms);
  });
});

describe('recountCore', () => {
  it('recomputes romCount and hiddenCount from the current rom list', () => {
    const core: Core = { id: 'NES', name: 'NES', romCount: 99, hiddenCount: 99 };
    const roms = [
      makeRom('a.nes', false),
      makeRom('.b.nes', true),
      makeRom('c.nes', false),
      makeRom('.d.nes', true),
    ];
    expect(recountCore(core, roms)).toEqual({
      ...core,
      romCount: 4,
      hiddenCount: 2,
    });
  });

  it('returns a new core object even when counts are unchanged', () => {
    const core: Core = { id: 'NES', name: 'NES', romCount: 1, hiddenCount: 0 };
    const roms = [makeRom('a.nes', false)];
    const next = recountCore(core, roms);
    expect(next).not.toBe(core);
    expect(next).toEqual(core);
  });
});
