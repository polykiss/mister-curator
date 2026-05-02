import { describe, expect, it } from 'vitest';

import { displayRomName } from '@shared/display';

describe('displayRomName', () => {
  it('returns empty string unchanged', () => {
    expect(displayRomName('')).toBe('');
  });

  it('strips a trailing .zip', () => {
    expect(displayRomName('Advanced Wars GBA.zip')).toBe('Advanced Wars GBA');
  });

  it('strips a trailing .7z', () => {
    expect(displayRomName('Castlevania.7z')).toBe('Castlevania');
  });

  it('strips a trailing .rar', () => {
    expect(displayRomName('Final Fantasy.rar')).toBe('Final Fantasy');
  });

  it('matches the archive extension case-insensitively', () => {
    expect(displayRomName('Game.ZIP')).toBe('Game');
    expect(displayRomName('Game.Zip')).toBe('Game');
    expect(displayRomName('Game.7Z')).toBe('Game');
    expect(displayRomName('Game.RAR')).toBe('Game');
  });

  it('only strips when the archive ext is at the very end', () => {
    // The .zip is in the middle of the filename — not a trailing archive
    // wrapper, so the display name keeps it.
    expect(displayRomName('Super Mario.zip.bak')).toBe('Super Mario.zip.bak');
  });

  it('leaves non-archive extensions untouched', () => {
    expect(displayRomName('Super Mario.sfc')).toBe('Super Mario.sfc');
    expect(displayRomName('Castlevania.nes')).toBe('Castlevania.nes');
    expect(displayRomName('lynxboot.img')).toBe('lynxboot.img');
  });

  it('leaves names without an extension untouched', () => {
    expect(displayRomName('Panzer Dragoon (USA) (1S)')).toBe(
      'Panzer Dragoon (USA) (1S)',
    );
    expect(displayRomName('Castlevania - Symphony of the Night')).toBe(
      'Castlevania - Symphony of the Night',
    );
  });

  it('does not produce an empty string when the whole name IS the archive ext', () => {
    // Pathological input — `.zip` as the entire visible name. Strip
    // would produce '', so we leave the input unchanged. This protects
    // sort/render code that assumes display name is non-empty.
    expect(displayRomName('.zip')).toBe('.zip');
    expect(displayRomName('.7z')).toBe('.7z');
  });

  it('strips only one archive extension (no recursion into .zip.zip)', () => {
    expect(displayRomName('foo.zip.zip')).toBe('foo.zip');
  });

  it('handles a name that contains an archive ext mid-string', () => {
    expect(displayRomName('zipline.nes')).toBe('zipline.nes');
    expect(displayRomName('rar but cool game.zip')).toBe('rar but cool game');
  });
});
