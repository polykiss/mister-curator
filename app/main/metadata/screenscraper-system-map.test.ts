import { describe, expect, it } from 'vitest';

import {
  SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID,
  lookupScreenScraperSystemId,
} from '@app/main/metadata/screenscraper-system-map';

/**
 * Each `coreId → systemeid` mapping has to be verified against
 * ScreenScraper's published list. The wrong id silently fetches
 * metadata for a different system; an off-by-one here means every
 * Sega 32X ROM ends up labeled as something else entirely.
 *
 * These tests pin every entry in the map so a typo in a future
 * edit fires before the wrong-system metadata reaches users.
 */
describe('lookupScreenScraperSystemId — Nintendo cores', () => {
  it.each([
    ['NES', 3],
    ['SNES', 4],
    ['GAMEBOY', 9],
    ['GAMEBOYCOLOR', 10],
    ['GAMEBOYADVANCE', 12],
    ['GBA', 12],
    ['VIRTUALBOY', 11],
    ['NINTENDO64', 14],
    ['N64', 14],
  ])('%s → %d', (coreId, systemId) => {
    expect(lookupScreenScraperSystemId(coreId)).toBe(systemId);
  });
});

describe('lookupScreenScraperSystemId — Sega cores', () => {
  it.each([
    ['Genesis', 1],
    ['MegaDrive', 1],
    ['SMS', 2],
    ['MasterSystem', 2],
    ['GameGear', 21],
    // Round 10 (PR #20) — `S32X` is the live MiSTer coreId; the
    // legacy `Sega32X` alias stays for back-compat with anything
    // that hand-built a mapping against the older naming.
    ['S32X', 19],
    ['Sega32X', 19],
    ['SegaCD', 20],
    ['MegaCD', 20],
    ['Saturn', 22],
    ['SG1000', 109],
  ])('%s → %d', (coreId, systemId) => {
    expect(lookupScreenScraperSystemId(coreId)).toBe(systemId);
  });
});

describe('lookupScreenScraperSystemId — Atari / NEC / SNK / Sony / Misc', () => {
  it.each([
    ['Atari2600', 26],
    ['Atari5200', 40],
    ['Atari7800', 41],
    ['AtariLynx', 28],
    ['Lynx', 28],
    ['TurboGrafx16', 31],
    ['TGFX16', 31],
    ['PCEngine', 31],
    ['TGFX16-CD', 114],
    ['PCEngineCD', 114],
    ['NEOGEO', 142],
    ['NeoGeo', 142],
    ['NeoGeoPocket', 25],
    ['NEOGEOPocket', 25],
    ['NeoGeoPocketColor', 82],
    ['PSX', 57],
    ['PlayStation', 57],
    ['ColecoVision', 48],
    ['Coleco', 48],
    ['Intellivision', 115],
    ['Vectrex', 102],
    ['WonderSwan', 45],
    ['WonderSwanColor', 46],
    ['Odyssey2', 104],
  ])('%s → %d', (coreId, systemId) => {
    expect(lookupScreenScraperSystemId(coreId)).toBe(systemId);
  });
});

describe('lookupScreenScraperSystemId — Microsoft cores (round 10)', () => {
  // SS systemeid 113 covers the entire MSX family (MSX1, MSX2,
  // MSX2+, Turbo-R) under one bucket. MiSTer ships the family
  // across `MSX` and `MSX1` core dirs; both route to 113 so SS
  // lookups fire from either.
  it.each([
    ['MSX', 113],
    ['MSX1', 113],
  ])('%s → %d', (coreId, systemId) => {
    expect(lookupScreenScraperSystemId(coreId)).toBe(systemId);
  });
});

describe('lookupScreenScraperSystemId — Computer cores (feat/screenscraper-system-map-audit)', () => {
  // Pre-audit, the entire `_Computer/` MiSTer category had zero
  // SS mappings — a manual search for `X68000` returned empty with
  // `reason=no-system-mapping`. This block pins each of the
  // confirmed additions; uncertain cores (PC-88, TI-99, ChannelF,
  // etc.) stay deliberately unmapped — see the in-file comment
  // block for the audit shortlist.
  it.each([
    // The user-flagged regression case. Explicit own-test below
    // documents the live trace.
    ['X68000', 79],
    ['C64', 66],
    ['VIC20', 73],
    ['Minimig', 64],
    ['AtariST', 42],
    ['Atari800', 43],
    ['Apple-II', 86],
    ['BBCMicro', 37],
    ['Amstrad', 65],
    ['ZX-Spectrum', 76],
  ])('%s → %d', (coreId, systemId) => {
    expect(lookupScreenScraperSystemId(coreId)).toBe(systemId);
  });

  it('X68000 specifically resolves to 79 (Sharp X68000) — pre-audit live regression', () => {
    // Pinning the user's reported case explicitly so the trace from
    // the diag log
    //   [meta] · ss-manual-search-result coreId=X68000
    //           outcome=empty reason=no-system-mapping
    // can never re-occur silently.
    expect(lookupScreenScraperSystemId('X68000')).toBe(79);
  });
});

describe('lookupScreenScraperSystemId — unmapped / edge cases', () => {
  it('returns null for undefined coreId', () => {
    expect(lookupScreenScraperSystemId(undefined)).toBeNull();
  });

  it('returns null for an unmapped coreId', () => {
    // AO486 is in the user's library but PC games aren't a clean
    // SS lookup; deliberately unmapped — caller falls through to
    // `[meta] · ss-skip reason=no-hint` and the OpenVGDB+libretro
    // path runs.
    // PR-D1 (PR #27): mame is now mapped to 75 — see the test in
    // the next describe block. hbmame stays unmapped (per-romset
    // hash collisions with mame would cause SS confusion).
    expect(lookupScreenScraperSystemId('AO486')).toBeNull();
    expect(lookupScreenScraperSystemId('Arcade')).toBeNull();
    expect(lookupScreenScraperSystemId('hbmame')).toBeNull();
  });

  it('PR-D1 (PR #27): mame resolves to 75 (arcade systemeid)', () => {
    // The wholeCoreUnmappable gate in MetadataOrchestrator stops
    // firing for mame after this mapping is added. Combined with
    // the new filename-hint name-search pipeline, MAME's 650 ROMs
    // can now recover metadata via the `(mslug2)` paren-shortname
    // hint → SS jeuRecherche → high-confidence match.
    expect(lookupScreenScraperSystemId('mame')).toBe(75);
  });

  it('is case-sensitive — wrong casing returns null', () => {
    // Cheap regression guard: if a future change normalises the
    // coreId casing somewhere upstream, this test catches the
    // silent shape change.
    expect(lookupScreenScraperSystemId('snes')).toBeNull();
    expect(lookupScreenScraperSystemId('Nes')).toBeNull();
  });

  it('deliberately-unmapped cores stay null (audit shortlist — verify SS id before adding)', () => {
    // feat/screenscraper-system-map-audit — these coreIds appeared
    // on the audit's "uncertain" list. Each one needs a verified
    // SS systemeid before it can be added. Pinning null here makes
    // sure no one drops a guess in without also updating tests.
    for (const coreId of [
      'PC-88',
      'PC-98',
      'TI-99_4A',
      'TI994A',
      'ChannelF',
      'Arcadia',
      'PokemonMini',
      'TomyTutor',
      'AcornElectron',
      'SVI318',
      'CoCo2',
      'ZX-81',
      'ZX81',
    ]) {
      expect(
        lookupScreenScraperSystemId(coreId),
        `${coreId} — verify SS systemeid before mapping`,
      ).toBeNull();
    }
  });
});

describe('SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID — invariants', () => {
  it('every value is a positive integer (no off-by-one nullables)', () => {
    for (const [coreId, systemId] of SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID) {
      expect(Number.isInteger(systemId), `${coreId} → ${String(systemId)}`).toBe(
        true,
      );
      expect(systemId, `${coreId} → ${String(systemId)}`).toBeGreaterThan(0);
    }
  });

  it('aliases pointing at the same system have matching ids', () => {
    // If anyone changes one alias and forgets the other (e.g.
    // updates `MegaDrive` but not `Genesis`), the SS lookup for
    // the unupdated alias quietly drifts. This pins each known
    // alias-pair.
    const m = SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID;
    expect(m.get('Genesis')).toBe(m.get('MegaDrive'));
    expect(m.get('SMS')).toBe(m.get('MasterSystem'));
    expect(m.get('S32X')).toBe(m.get('Sega32X'));
    expect(m.get('SegaCD')).toBe(m.get('MegaCD'));
    expect(m.get('GBA')).toBe(m.get('GAMEBOYADVANCE'));
    expect(m.get('N64')).toBe(m.get('NINTENDO64'));
    expect(m.get('Lynx')).toBe(m.get('AtariLynx'));
    expect(m.get('TurboGrafx16')).toBe(m.get('TGFX16'));
    expect(m.get('TGFX16')).toBe(m.get('PCEngine'));
    expect(m.get('TGFX16-CD')).toBe(m.get('PCEngineCD'));
    expect(m.get('NEOGEO')).toBe(m.get('NeoGeo'));
    expect(m.get('NeoGeoPocket')).toBe(m.get('NEOGEOPocket'));
    expect(m.get('PSX')).toBe(m.get('PlayStation'));
    expect(m.get('ColecoVision')).toBe(m.get('Coleco'));
    expect(m.get('MSX')).toBe(m.get('MSX1'));
  });
});
