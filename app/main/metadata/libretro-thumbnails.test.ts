import { describe, expect, it } from 'vitest';

import { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';

describe('LibretroThumbnailsFetcher', () => {
  const fetcher = new LibretroThumbnailsFetcher();

  it('builds the expected box-art URL for a known SNES title', () => {
    const url = fetcher.getBoxArtUrl(
      'Super Nintendo Entertainment System',
      'Super Mario World',
    );
    expect(url).toBe(
      'https://thumbnails.libretro.com/Nintendo_-_Super_Nintendo_Entertainment_System/Named_Boxarts/Super%20Mario%20World.png',
    );
  });

  it('builds the title-screen URL with the Named_Titles segment', () => {
    const url = fetcher.getTitleScreenUrl(
      'Super Nintendo Entertainment System',
      'Super Mario World',
    );
    expect(url).toContain('/Named_Titles/');
  });

  it('builds the snap URL with the Named_Snaps segment', () => {
    const url = fetcher.getScreenshotUrl(
      'Super Nintendo Entertainment System',
      'Super Mario World',
    );
    expect(url).toContain('/Named_Snaps/');
  });

  it('replaces special characters with _ but keeps the apostrophe', () => {
    // The spec example: "Q*bert's Qubes" — `*` becomes `_`, `'`
    // survives. Then encodeURIComponent leaves `'` alone but turns
    // the space into %20.
    const url = fetcher.getBoxArtUrl('Atari 2600', "Q*bert's Qubes");
    expect(url).toContain("Q_bert's%20Qubes.png");
  });

  it('replaces all the documented bad chars (& * / : ` < > ? \\ | ")', () => {
    const url = fetcher.getBoxArtUrl(
      'Sega Genesis',
      'A&B*C/D:E`F<G>H?I\\J|K"L',
    );
    // Each special becomes _; underscore stays; alphabetics survive.
    expect(url).toContain('A_B_C_D_E_F_G_H_I_J_K_L.png');
  });

  it('uses underscore-separated system directories', () => {
    const url = fetcher.getBoxArtUrl('Sega Genesis', 'Sonic');
    expect(url).toContain('/Sega_-_Mega_Drive_-_Genesis/');
  });

  it('returns null for an unknown system', () => {
    expect(fetcher.getBoxArtUrl('Sharp X68000', 'Some Game')).toBeNull();
    expect(fetcher.getTitleScreenUrl('Apogee', 'Anything')).toBeNull();
    expect(fetcher.getScreenshotUrl('Unknown', 'Nope')).toBeNull();
  });

  it('looks systems up case-insensitively', () => {
    const upper = fetcher.getBoxArtUrl(
      'SUPER NINTENDO ENTERTAINMENT SYSTEM',
      'Super Mario World',
    );
    expect(upper).toContain('Nintendo_-_Super_Nintendo_Entertainment_System');
  });

  it('treats Sega Genesis and Sega Mega Drive as the same dir', () => {
    const a = fetcher.getBoxArtUrl('Sega Genesis', 'Sonic')!;
    const b = fetcher.getBoxArtUrl('Sega Mega Drive', 'Sonic')!;
    expect(a).toBe(b);
  });

  it('returns null when the ROM name is just blank or sanitised to empty', () => {
    expect(fetcher.getBoxArtUrl('Atari 2600', '')).toBeNull();
    expect(fetcher.getBoxArtUrl('Atari 2600', '   ')).toBeNull();
  });

  it('hasSystem mirrors the public methods\' system map', () => {
    expect(fetcher.hasSystem('Super Nintendo Entertainment System')).toBe(true);
    expect(fetcher.hasSystem('super nintendo entertainment system')).toBe(true);
    expect(fetcher.hasSystem('Apogee')).toBe(false);
  });
});
