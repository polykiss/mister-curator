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

  describe('round 7 — OpenVGDB v29.0 system names', () => {
    // OpenVGDB returns manufacturer-prefixed strings ("Nintendo Game
    // Boy Advance", "Sega Genesis/Mega Drive") that the round-3 map
    // didn't cover. These cases pin the mappings the round-7 fix
    // added so future map shrinkage breaks loudly.
    const cases: readonly { readonly system: string; readonly dir: string }[] = [
      {
        system: 'Nintendo Game Boy Advance',
        dir: 'Nintendo_-_Game_Boy_Advance',
      },
      { system: 'Nintendo Game Boy', dir: 'Nintendo_-_Game_Boy' },
      { system: 'Nintendo Game Boy Color', dir: 'Nintendo_-_Game_Boy_Color' },
      {
        system: 'Sega Genesis/Mega Drive',
        dir: 'Sega_-_Mega_Drive_-_Genesis',
      },
      { system: 'SNK Neo Geo Pocket', dir: 'SNK_-_Neo_Geo_Pocket' },
      {
        system: 'SNK Neo Geo Pocket Color',
        dir: 'SNK_-_Neo_Geo_Pocket_Color',
      },
      { system: 'Sony PlayStation', dir: 'Sony_-_PlayStation' },
      { system: 'Coleco ColecoVision', dir: 'Coleco_-_ColecoVision' },
      { system: 'Mattel Intellivision', dir: 'Mattel_-_Intellivision' },
      { system: 'Bandai WonderSwan', dir: 'Bandai_-_WonderSwan' },
    ];
    for (const c of cases) {
      it(`maps "${c.system}" → ${c.dir}`, () => {
        const url = fetcher.getBoxArtUrl(c.system, 'TestRom');
        expect(url).not.toBeNull();
        expect(url).toContain(`/${c.dir}/Named_Boxarts/`);
      });
    }

    it('still resolves bare-form synonyms for back-compat', () => {
      // Round 3 entries (no manufacturer prefix) keep working.
      expect(fetcher.getBoxArtUrl('game boy advance', 'X')).toContain(
        'Nintendo_-_Game_Boy_Advance',
      );
      expect(fetcher.getBoxArtUrl('neo geo pocket', 'X')).toContain(
        'SNK_-_Neo_Geo_Pocket',
      );
      expect(fetcher.getBoxArtUrl('playstation', 'X')).toContain(
        'Sony_-_PlayStation',
      );
    });

    it('manufacturer-prefixed and bare forms produce identical URLs', () => {
      const a = fetcher.getBoxArtUrl('Nintendo Game Boy Advance', 'Tetris');
      const b = fetcher.getBoxArtUrl('Game Boy Advance', 'Tetris');
      expect(a).toBe(b);

      const c = fetcher.getBoxArtUrl('Sega Genesis/Mega Drive', 'Sonic');
      const d = fetcher.getBoxArtUrl('Sega Genesis', 'Sonic');
      expect(c).toBe(d);
    });
  });

  /**
   * Live probes against thumbnails.libretro.com. Off by default —
   * gate via `LIBRETRO_LIVE_PROBE=1` so CI never depends on the
   * libretro CDN being reachable. A handful of well-known box-art
   * URLs we expect to resolve; if any of them 404 we've drifted
   * from the upstream archive's naming convention.
   */
  describe.runIf(process.env['LIBRETRO_LIVE_PROBE'] === '1')(
    'live URL probes (gated by LIBRETRO_LIVE_PROBE=1)',
    () => {
      const probes: readonly {
        readonly system: string;
        readonly rom: string;
      }[] = [
        {
          system: 'Sega Genesis/Mega Drive',
          rom: 'Sonic The Hedgehog 2 (World)',
        },
        {
          system: 'Super Nintendo Entertainment System',
          rom: 'Super Mario World (USA)',
        },
        { system: 'Nintendo Game Boy Advance', rom: 'Tetris Worlds (USA)' },
        { system: 'Nintendo Entertainment System', rom: 'Castlevania (USA)' },
        { system: 'Atari 2600', rom: 'Pitfall! (USA)' },
      ];
      for (const p of probes) {
        it(`HEAD 200 for ${p.system} / ${p.rom}`, async () => {
          const url = fetcher.getBoxArtUrl(p.system, p.rom);
          expect(url).not.toBeNull();
          const res = await fetch(url ?? '', { method: 'HEAD' });
          expect(res.status).toBe(200);
        }, 15_000);
      }
    },
  );
});
