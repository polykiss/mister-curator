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
    // ─── Arcade ──────────────────────────────────────────────────────
    // PR-D1 (PR #27): mame core → ScreenScraper systemeid 75
    // (arcade). Hash lookups for arcade romsets typically miss (SS
    // doesn't index per-romset hashes), but the new filename-hint
    // pipeline catches them via the `(mslug2)` paren-shortname →
    // jeuRecherche search → name-match scoring path.
    ['mame', 75],
  ]);

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
