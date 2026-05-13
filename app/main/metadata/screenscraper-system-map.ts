/**
 * Map a MiSTer core id (the directory name under `/media/fat/games/`)
 * to ScreenScraper's `systemeid`. Required for SS's `jeuInfos` hash
 * search; the canonical system *name* comes from the SS response
 * itself (`response.jeu.systeme.nom`), so this map carries the id
 * only.
 *
 * Adding a coreId:
 *   - Verify the systemeid against ScreenScraper's published list
 *     (`https://www.screenscraper.fr/api2/systemesListe.php` with
 *     auth, or the public wiki). DO NOT guess; an off-by-one id
 *     fetches metadata for a different system entirely.
 *   - Use the EXACT coreId the device returns from
 *     `listAllCoresWithFiles` — case-sensitive. The MiSTer's core
 *     directory under `/media/fat/games/<coreId>/` is the truth.
 *     Aliases for hypothetical-but-unseen-in-the-wild coreIds (e.g.
 *     `MasterSystem` alongside the MiSTer's `SMS`) are fine but not
 *     load-bearing.
 *   - Skip coreIds without a clean SS mapping (Arcade, hbmame,
 *     AO486 PC games). Better to fall through to the "no-hint"
 *     diag log than to commit a wrong mapping.
 *
 * PR-D1 (PR #27): `mame` mapped to 75 (ScreenScraper's `arcade` /
 * MAME systemeid). Combined with the new filename-hint
 * name-search fallback, MAME's 650 ROMs that previously got
 * synthetic-key sentinels (because SS hash lookups for arcade
 * romsets always miss — the romset hash isn't what SS indexes)
 * now flow through hash-miss → name-search → high-confidence bind
 * via the paren-shortname hint (`(mslug2)` → searches `mslug2` →
 * SS returns Metal Slug 2). The wholeCoreUnmappable gate in
 * MetadataOrchestrator stops firing for mame; the synthetic-key
 * path stays as future-proofing for cores that genuinely have no
 * SS mapping.
 */
export const SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID: ReadonlyMap<string, number> =
  new Map([
    // ─── Nintendo ────────────────────────────────────────────────────
    ['NES', 3],
    ['SNES', 4],
    ['GAMEBOY', 9],
    ['GAMEBOYCOLOR', 10],
    ['GAMEBOYADVANCE', 12],
    ['GBA', 12],
    ['VIRTUALBOY', 11],
    ['NINTENDO64', 14],
    ['N64', 14],
    // ─── Sega ────────────────────────────────────────────────────────
    ['Genesis', 1],
    ['MegaDrive', 1],
    ['SMS', 2],
    ['MasterSystem', 2],
    ['GameGear', 21],
    // Round 10 (PR #20) — MiSTer's actual coreId for the 32X core
    // is `S32X`, not `Sega32X`. The legacy `Sega32X` alias stays
    // for any non-MiSTer caller; `S32X` is the live-test entry.
    ['S32X', 19],
    ['Sega32X', 19],
    ['SegaCD', 20],
    ['MegaCD', 20],
    ['Saturn', 22],
    ['SG1000', 109],
    // ─── Atari ───────────────────────────────────────────────────────
    ['Atari2600', 26],
    ['Atari5200', 40],
    ['Atari7800', 41],
    ['AtariLynx', 28],
    ['Lynx', 28],
    // ─── NEC ─────────────────────────────────────────────────────────
    ['TurboGrafx16', 31],
    ['TGFX16', 31],
    ['PCEngine', 31],
    ['TGFX16-CD', 114],
    ['PCEngineCD', 114],
    // ─── SNK ─────────────────────────────────────────────────────────
    ['NEOGEO', 142],
    ['NeoGeo', 142],
    ['NeoGeoPocket', 25],
    ['NEOGEOPocket', 25],
    ['NeoGeoPocketColor', 82],
    // ─── Sony ────────────────────────────────────────────────────────
    ['PSX', 57],
    ['PlayStation', 57],
    // ─── Microsoft ───────────────────────────────────────────────────
    // Round 10 (PR #20) — MSX system in SS is 113. SS doesn't split
    // MSX1 vs MSX2 vs MSX2+ vs Turbo-R; one systemeid covers the
    // family. MiSTer ships separate cores (`MSX`, `MSX1`); both
    // route to 113 here so SS lookups fire from either core dir.
    ['MSX', 113],
    ['MSX1', 113],
    // ─── Misc ───────────────────────────────────────────────────────
    ['ColecoVision', 48],
    ['Coleco', 48],
    ['Intellivision', 115],
    ['Vectrex', 102],
    ['WonderSwan', 45],
    ['WonderSwanColor', 46],
    ['Odyssey2', 104],
    // ─── Computers (feat/screenscraper-system-map-audit) ────────────
    // User-flagged gap: a manual SS search for an X68000 title
    // returned `outcome=empty reason=no-system-mapping` because the
    // whole `_Computer/` category had zero entries here pre-audit.
    // The IDs below are verified against ScreenScraper's published
    // system list (https://www.screenscraper.fr/api2/systemesListe.php).
    ['X68000', 79], // Sharp X68000
    ['C64', 66], // Commodore 64
    ['VIC20', 73], // Commodore VIC-20
    ['Minimig', 64], // Commodore Amiga (MiSTer's Amiga core is `Minimig`)
    ['AtariST', 42], // Atari ST
    ['Atari800', 43], // Atari 8-bit (400/800/XL/XE)
    ['Apple-II', 86], // Apple II
    ['BBCMicro', 37], // BBC Micro
    ['Amstrad', 65], // Amstrad CPC
    ['ZX-Spectrum', 76], // Sinclair ZX Spectrum
    // ─── Arcade ──────────────────────────────────────────────────────
    // PR-D1 (PR #27): mame core → ScreenScraper systemeid 75
    // (arcade). Hash lookups for arcade romsets typically miss (SS
    // doesn't index per-romset hashes), but the new filename-hint
    // pipeline catches them via the `(mslug2)` paren-shortname →
    // jeuRecherche search → name-match scoring path.
    ['mame', 75],
  ]);

/**
 * feat/screenscraper-system-map-audit — coreIds left unmapped on
 * purpose. Keep this list in sync with the comment block above so a
 * future audit doesn't re-investigate already-considered cores.
 *
 * AO486 / hbmame / Arcade — see the "skip coreIds without a clean
 * SS mapping" rule at the top of this file.
 *
 * Cores below are common on MiSTer but their SS systemeid couldn't
 * be verified with high confidence at audit time. Each one needs a
 * cross-check against `systemesListe.php` before adding. Leaving
 * them unmapped is strictly better than guessing — a wrong id
 * silently fetches metadata for the wrong system.
 *
 *   PC-88, PC-98          — Japanese computer split, multiple SS ids
 *   TI-99_4A / TI994A     — Texas Instruments TI-99/4A
 *   ChannelF              — Fairchild Channel F
 *   Arcadia               — Emerson Arcadia 2001
 *   PokemonMini           — Nintendo Pokémon Mini
 *   TomyTutor             — Tomy Tutor
 *   AcornElectron         — Acorn Electron (BBC Micro sibling)
 *   SVI318 / SVI328       — Spectravideo
 *   CoCo2                 — Tandy CoCo 2 / TRS-80 Color
 *   ZX-81 / ZX81          — Sinclair ZX81
 *
 * If you map one, also add to the `unmapped / edge cases` /
 * `aliases pointing at the same system` test blocks so the new
 * coverage is pinned.
 */

/**
 * Resolve a coreId to its ScreenScraper `systemeid`, or null when
 * unmapped. Pure lookup against `SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID`
 * — the orchestrator wraps this in a `SystemIdResolver` that also
 * accepts an optional `romPath` (currently ignored; reserved for
 * future per-extension routing).
 */
export function lookupScreenScraperSystemId(
  coreId: string | undefined,
): number | null {
  if (coreId === undefined) return null;
  return SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID.get(coreId) ?? null;
}
