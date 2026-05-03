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

  it('leaves non-strippable extensions untouched', () => {
    // Disc tracks / images and other non-cart-non-archive extensions
    // pass through. The format identity matters in the disc-folder
    // context (which file is the manifest, which are tracks).
    expect(displayRomName('Track 01.bin')).toBe('Track 01.bin');
    expect(displayRomName('Game.cue')).toBe('Game.cue');
    expect(displayRomName('Game.iso')).toBe('Game.iso');
    expect(displayRomName('Game.chd')).toBe('Game.chd');
    expect(displayRomName('Game.gdi')).toBe('Game.gdi');
    expect(displayRomName('lynxboot.img')).toBe('lynxboot.img');
    expect(displayRomName('Manual.pdf')).toBe('Manual.pdf');
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

  it('handles a name that contains a strippable ext mid-string', () => {
    // Mid-string match doesn't trigger; only trailing.
    expect(displayRomName('rar but cool game.zip')).toBe('rar but cool game');
    // `.nes` is now strippable — but only at the end. "zipline" stays
    // intact and the trailing `.nes` is removed.
    expect(displayRomName('zipline.nes')).toBe('zipline');
    // ".nes" mid-string with non-strippable trailing ext: pass through.
    expect(displayRomName('zipline.nes.bak')).toBe('zipline.nes.bak');
  });
});

describe('displayRomName — round 11 cart format extensions', () => {
  // The trio of single-cart extensions that motivated this round:
  // NEOGEO showed `2020 Super Baseball.neo` instead of just the game
  // name. Same noise on every cart-format core.
  const CART_CASES: readonly { ext: string; example: string; expected: string }[] = [
    { ext: 'neo', example: '2020 Super Baseball.neo', expected: '2020 Super Baseball' },
    { ext: 'nes', example: 'Castlevania (USA, Europe).nes', expected: 'Castlevania (USA, Europe)' },
    { ext: 'sfc', example: 'Super Mario World.sfc', expected: 'Super Mario World' },
    { ext: 'smc', example: 'Chrono Trigger.smc', expected: 'Chrono Trigger' },
    { ext: 'gba', example: 'Advance Wars.gba', expected: 'Advance Wars' },
    { ext: 'gb', example: 'Tetris.gb', expected: 'Tetris' },
    { ext: 'gbc', example: 'Pokemon Crystal.gbc', expected: 'Pokemon Crystal' },
    { ext: 'md', example: 'Sonic 2.md', expected: 'Sonic 2' },
    { ext: 'gen', example: 'Comix Zone.gen', expected: 'Comix Zone' },
    { ext: 'pce', example: 'Bonk.pce', expected: 'Bonk' },
    { ext: 'lnx', example: 'California Games.lnx', expected: 'California Games' },
    { ext: 'col', example: 'Donkey Kong.col', expected: 'Donkey Kong' },
    { ext: 'int', example: 'Astrosmash.int', expected: 'Astrosmash' },
    { ext: 'vec', example: 'Berzerk.vec', expected: 'Berzerk' },
    { ext: 'ws', example: 'Klonoa.ws', expected: 'Klonoa' },
    { ext: 'wsc', example: 'Final Fantasy.wsc', expected: 'Final Fantasy' },
    { ext: 'a78', example: 'Asteroids.a78', expected: 'Asteroids' },
    { ext: 'a26', example: 'Adventure.a26', expected: 'Adventure' },
    { ext: '32x', example: 'Knuckles Chaotix.32x', expected: 'Knuckles Chaotix' },
    { ext: 'j64', example: 'Tempest 2000.j64', expected: 'Tempest 2000' },
    { ext: 'jag', example: 'Alien vs Predator.jag', expected: 'Alien vs Predator' },
    { ext: 'sms', example: 'Phantasy Star.sms', expected: 'Phantasy Star' },
    { ext: 'gg', example: 'Sonic Triple Trouble.gg', expected: 'Sonic Triple Trouble' },
  ];

  for (const { ext, example, expected } of CART_CASES) {
    it(`strips a trailing .${ext}`, () => {
      expect(displayRomName(example)).toBe(expected);
    });
  }

  it('matches cart extensions case-insensitively (e.g. .NEO, .Sfc)', () => {
    expect(displayRomName('Game.NEO')).toBe('Game');
    expect(displayRomName('Game.Sfc')).toBe('Game');
    expect(displayRomName('Game.GBA')).toBe('Game');
  });

  it('does not strip disc-shape extensions even on cart-format cores', () => {
    // Defensive: a disc folder inside e.g. NEOGEO-CD shouldn't see
    // its `.cue` / `.bin` files renamed.
    expect(displayRomName('Disc 1.cue')).toBe('Disc 1.cue');
    expect(displayRomName('Disc 1 (Track 02).bin')).toBe('Disc 1 (Track 02).bin');
    expect(displayRomName('Game.iso')).toBe('Game.iso');
    expect(displayRomName('Game.chd')).toBe('Game.chd');
    expect(displayRomName('Game.gdi')).toBe('Game.gdi');
  });

  it('does not produce an empty string when the whole name IS a cart ext', () => {
    expect(displayRomName('.neo')).toBe('.neo');
    expect(displayRomName('.nes')).toBe('.nes');
  });
});
