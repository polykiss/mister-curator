import { describe, expect, it } from 'vitest';

import {
  LibretroThumbnailsFetcher,
  sanitizeLibretroFilename,
} from '@app/main/metadata/libretro-thumbnails';

describe('LibretroThumbnailsFetcher', () => {
  const fetcher = new LibretroThumbnailsFetcher();

  it('builds the expected box-art URL for a known SNES title', () => {
    const url = fetcher.getBoxArtUrl(
      'Super Nintendo Entertainment System',
      'Super Mario World',
    );
    // Round 9: the CDN serves the spaced folder form (HTTP-verified).
    // encodeURIComponent emits `Nintendo%20-%20Super%20…` for
    // "Nintendo - Super Nintendo Entertainment System".
    expect(url).toBe(
      'https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/Super%20Mario%20World.png',
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

  it('uses %20-encoded spaced system directories (round 9)', () => {
    const url = fetcher.getBoxArtUrl('Sega Genesis', 'Sonic');
    expect(url).toContain('/Sega%20-%20Mega%20Drive%20-%20Genesis/');
    // The underscored form is the GitHub repo name, NOT the CDN path.
    // Pin that we don't accidentally regress to it.
    expect(url).not.toContain('/Sega_-_Mega_Drive_-_Genesis/');
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
    expect(upper).toContain(
      'Nintendo%20-%20Super%20Nintendo%20Entertainment%20System',
    );
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
    // added so future map shrinkage breaks loudly. URL fragments
    // updated to the round-9 spaced form.
    const cases: readonly { readonly system: string; readonly dir: string }[] = [
      {
        system: 'Nintendo Game Boy Advance',
        dir: 'Nintendo%20-%20Game%20Boy%20Advance',
      },
      { system: 'Nintendo Game Boy', dir: 'Nintendo%20-%20Game%20Boy' },
      {
        system: 'Nintendo Game Boy Color',
        dir: 'Nintendo%20-%20Game%20Boy%20Color',
      },
      {
        system: 'Sega Genesis/Mega Drive',
        dir: 'Sega%20-%20Mega%20Drive%20-%20Genesis',
      },
      { system: 'SNK Neo Geo Pocket', dir: 'SNK%20-%20Neo%20Geo%20Pocket' },
      {
        system: 'SNK Neo Geo Pocket Color',
        dir: 'SNK%20-%20Neo%20Geo%20Pocket%20Color',
      },
      { system: 'Sony PlayStation', dir: 'Sony%20-%20PlayStation' },
      { system: 'Coleco ColecoVision', dir: 'Coleco%20-%20ColecoVision' },
      { system: 'Mattel Intellivision', dir: 'Mattel%20-%20Intellivision' },
      { system: 'Bandai WonderSwan', dir: 'Bandai%20-%20WonderSwan' },
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
        'Nintendo%20-%20Game%20Boy%20Advance',
      );
      expect(fetcher.getBoxArtUrl('neo geo pocket', 'X')).toContain(
        'SNK%20-%20Neo%20Geo%20Pocket',
      );
      expect(fetcher.getBoxArtUrl('playstation', 'X')).toContain(
        'Sony%20-%20PlayStation',
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

  describe('round 9 — CDN folder format + sanitizer', () => {
    it('emits the exact full URL the CDN serves for a Mega Drive ROM', () => {
      // HTTP-verified: this exact path returns a real listing.
      const url = fetcher.getBoxArtUrl(
        'Sega Genesis/Mega Drive',
        'Sonic The Hedgehog 2 (World)',
      );
      expect(url).toBe(
        'https://thumbnails.libretro.com/Sega%20-%20Mega%20Drive%20-%20Genesis/Named_Boxarts/Sonic%20The%20Hedgehog%202%20(World).png',
      );
    });

    it('never emits underscores between system-segment words', () => {
      // Negative regression: round 7's mistake was rewriting the
      // canonical " - " to "_-_" before encoding. Pin that we don't.
      const sample = [
        ['Nintendo Game Boy Advance', 'Tetris (USA)'],
        ['Sega Genesis/Mega Drive', 'Sonic'],
        ['Atari 7800', 'Asteroids (USA)'],
        ['SNK Neo Geo Pocket', 'X'],
      ] as const;
      for (const [system, rom] of sample) {
        const url = fetcher.getBoxArtUrl(system, rom)!;
        const after = url.slice('https://thumbnails.libretro.com/'.length);
        const sysSegment = after.split('/')[0] ?? '';
        expect(sysSegment).not.toContain('_');
      }
    });

    describe('sanitizeLibretroFilename', () => {
      it('replaces & with _ (Sonic & Knuckles → Sonic _ Knuckles)', () => {
        expect(sanitizeLibretroFilename('Sonic & Knuckles')).toBe(
          'Sonic _ Knuckles',
        );
      });

      it('replaces : with _', () => {
        expect(sanitizeLibretroFilename('Star Wars: Empire Strikes Back')).toBe(
          'Star Wars_ Empire Strikes Back',
        );
      });

      it('replaces * with _', () => {
        expect(sanitizeLibretroFilename("Q*bert's Qubes")).toBe(
          "Q_bert's Qubes",
        );
      });

      it('replaces every char in the documented set in one pass', () => {
        // & * / : ` < > ? \ | "
        expect(
          sanitizeLibretroFilename('A&B*C/D:E`F<G>H?I\\J|K"L'),
        ).toBe('A_B_C_D_E_F_G_H_I_J_K_L');
      });

      it('leaves alphanumerics, parens, apostrophes, and spaces alone', () => {
        const input = "Tony Hawk's Pro Skater 2 (USA)";
        expect(sanitizeLibretroFilename(input)).toBe(input);
      });

      it('does not trim — the buildUrl caller does that explicitly', () => {
        // Pure char substitution; whitespace preservation lets the
        // buildUrl path decide whether a whitespace-only string is a
        // valid filename (it isn't — empty after trim → null URL).
        expect(sanitizeLibretroFilename('  Sonic  ')).toBe('  Sonic  ');
      });
    });

    it('actually applies the sanitizer to filenames containing &', () => {
      const url = fetcher.getBoxArtUrl(
        'Sega Genesis/Mega Drive',
        'Sonic & Knuckles (World)',
      );
      // & → _, then encodeURIComponent on the rest.
      expect(url).toContain('Sonic%20_%20Knuckles%20(World).png');
      expect(url).not.toContain('Sonic%20%26%20Knuckles');
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
