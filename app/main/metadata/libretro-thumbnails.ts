/**
 * URL builder for the libretro-thumbnails archive
 * (https://thumbnails.libretro.com/). The site is a static tree of
 * PNGs organized by system and named after the ROM. There is no API
 * — the URL pattern is the contract.
 *
 * Pattern:
 *   https://thumbnails.libretro.com/<system_dir>/Named_<Type>/<filename>.png
 * where:
 *   <system_dir> = the libretro directory name with all spaces
 *                  replaced by `_` (so " - " becomes "_-_").
 *   <Type>       = "Boxarts" | "Titles" | "Snaps"
 *   <filename>   = ROM name with `& * / : \` < > ? \ | "` replaced by
 *                  `_`, then URL-encoded for the path component.
 *
 * Some MiSTer cores have no libretro-thumbnails counterpart (DOS,
 * X68000, Apogee, etc). For those, every method returns null. The
 * caller (MetadataService) treats null as "no remote art available".
 */

const BASE = 'https://thumbnails.libretro.com';

/**
 * Map from OpenVGDB `systemName` strings (the values that come back
 * from `SYSTEMS.systemName`) to libretro-thumbnails directory names
 * (in their pre-underscore-replacement form — we replace spaces in
 * the URL builder).
 *
 * Keep entries lowercase keys; the lookup is case-insensitive. Add
 * synonyms freely — OpenVGDB has historically used several names
 * for the same system (e.g. "Sega Genesis" and "Sega Genesis/Mega
 * Drive"). When in doubt, add both the manufacturer-prefixed form
 * (real OpenVGDB v29.0 strings: "Nintendo Game Boy Advance",
 * "Sega Genesis/Mega Drive", "SNK Neo Geo Pocket") and the bare
 * form so legacy callers keep working.
 *
 * The libretro directory values stay in their canonical " - "
 * form here; `buildUrl` swaps spaces for underscores when emitting.
 */
const SYSTEM_MAP: ReadonlyMap<string, string> = new Map([
  // ─── Nintendo (manufacturer-prefixed forms come from OpenVGDB) ───
  ['nintendo entertainment system', 'Nintendo - Nintendo Entertainment System'],
  ['family computer', 'Nintendo - Nintendo Entertainment System'],
  [
    'super nintendo entertainment system',
    'Nintendo - Super Nintendo Entertainment System',
  ],
  ['super famicom', 'Nintendo - Super Nintendo Entertainment System'],
  ['nintendo 64', 'Nintendo - Nintendo 64'],
  ['nintendo game boy', 'Nintendo - Game Boy'],
  ['game boy', 'Nintendo - Game Boy'],
  ['nintendo game boy color', 'Nintendo - Game Boy Color'],
  ['game boy color', 'Nintendo - Game Boy Color'],
  ['nintendo game boy advance', 'Nintendo - Game Boy Advance'],
  ['game boy advance', 'Nintendo - Game Boy Advance'],
  ['nintendo virtual boy', 'Nintendo - Virtual Boy'],
  ['virtual boy', 'Nintendo - Virtual Boy'],
  ['nintendo ds', 'Nintendo - Nintendo DS'],
  ['nintendo gamecube', 'Nintendo - GameCube'],
  ['nintendo famicom disk system', 'Nintendo - Family Computer Disk System'],
  ['family computer disk system', 'Nintendo - Family Computer Disk System'],
  // ─── Sega (OpenVGDB v29.0 returns "Sega Genesis/Mega Drive") ─────
  ['sega genesis', 'Sega - Mega Drive - Genesis'],
  ['sega mega drive', 'Sega - Mega Drive - Genesis'],
  ['sega genesis/mega drive', 'Sega - Mega Drive - Genesis'],
  ['sega mega drive/genesis', 'Sega - Mega Drive - Genesis'],
  ['sega master system', 'Sega - Master System - Mark III'],
  ['sega game gear', 'Sega - Game Gear'],
  ['sega 32x', 'Sega - 32X'],
  ['sega saturn', 'Sega - Saturn'],
  ['sega cd', 'Sega - Mega-CD - Sega CD'],
  ['sega mega-cd', 'Sega - Mega-CD - Sega CD'],
  ['sega sg-1000', 'Sega - SG-1000'],
  ['sega dreamcast', 'Sega - Dreamcast'],
  // ─── Atari ───────────────────────────────────────────────────────
  ['atari 2600', 'Atari - 2600'],
  ['atari 5200', 'Atari - 5200'],
  ['atari 7800', 'Atari - 7800'],
  ['atari lynx', 'Atari - Lynx'],
  ['atari jaguar', 'Atari - Jaguar'],
  // ─── NEC / TurboGrafx ────────────────────────────────────────────
  ['turbografx-16', 'NEC - PC Engine - TurboGrafx 16'],
  ['nec turbografx-16', 'NEC - PC Engine - TurboGrafx 16'],
  ['turbografx-cd', 'NEC - PC Engine CD - TurboGrafx-CD'],
  ['nec turbografx-cd', 'NEC - PC Engine CD - TurboGrafx-CD'],
  ['pc engine', 'NEC - PC Engine - TurboGrafx 16'],
  ['pc engine cd', 'NEC - PC Engine CD - TurboGrafx-CD'],
  // ─── SNK ─────────────────────────────────────────────────────────
  ['neo geo', 'SNK - Neo Geo'],
  ['snk neo geo', 'SNK - Neo Geo'],
  ['neo geo cd', 'SNK - Neo Geo CD'],
  ['snk neo geo cd', 'SNK - Neo Geo CD'],
  ['neo geo pocket', 'SNK - Neo Geo Pocket'],
  ['snk neo geo pocket', 'SNK - Neo Geo Pocket'],
  ['neo geo pocket color', 'SNK - Neo Geo Pocket Color'],
  ['snk neo geo pocket color', 'SNK - Neo Geo Pocket Color'],
  // ─── Sony ────────────────────────────────────────────────────────
  ['sony playstation', 'Sony - PlayStation'],
  ['playstation', 'Sony - PlayStation'],
  ['sony playstation portable', 'Sony - PlayStation Portable'],
  // ─── Misc consoles ──────────────────────────────────────────────
  ['colecovision', 'Coleco - ColecoVision'],
  ['coleco colecovision', 'Coleco - ColecoVision'],
  ['intellivision', 'Mattel - Intellivision'],
  ['mattel intellivision', 'Mattel - Intellivision'],
  ['vectrex', 'GCE - Vectrex'],
  ['gce vectrex', 'GCE - Vectrex'],
  ['3do interactive multiplayer', 'The 3DO Company - 3DO'],
  ['wonderswan', 'Bandai - WonderSwan'],
  ['bandai wonderswan', 'Bandai - WonderSwan'],
  ['wonderswan color', 'Bandai - WonderSwan Color'],
  ['bandai wonderswan color', 'Bandai - WonderSwan Color'],
  ['odyssey 2', 'Magnavox - Odyssey2'],
  ['magnavox odyssey 2', 'Magnavox - Odyssey2'],
  ['fairchild channel f', 'Fairchild - Channel F'],
]);

export type ThumbnailKind = 'box' | 'title' | 'snap';

/** Translate the kind into the libretro-thumbnails subdirectory name. */
function namedDir(kind: ThumbnailKind): string {
  switch (kind) {
    case 'box':
      return 'Named_Boxarts';
    case 'title':
      return 'Named_Titles';
    case 'snap':
      return 'Named_Snaps';
  }
}

export class LibretroThumbnailsFetcher {
  /**
   * Returns the URL of the box-art PNG for `(systemName, romName)`,
   * or null when the system isn't in the libretro-thumbnails map.
   * Whether the URL actually resolves is up to the caller — the
   * archive is sparse for some systems.
   */
  getBoxArtUrl(systemName: string, romName: string): string | null {
    return this.buildUrl(systemName, romName, 'box');
  }

  getTitleScreenUrl(systemName: string, romName: string): string | null {
    return this.buildUrl(systemName, romName, 'title');
  }

  getScreenshotUrl(systemName: string, romName: string): string | null {
    return this.buildUrl(systemName, romName, 'snap');
  }

  /** Test/inspection helper — mirrors the public methods. */
  hasSystem(systemName: string): boolean {
    return getLibretroDir(systemName) !== null;
  }

  // ─── internals ─────────────────────────────────────────────────────

  private buildUrl(
    systemName: string,
    romName: string,
    kind: ThumbnailKind,
  ): string | null {
    const dir = getLibretroDir(systemName);
    if (dir === null) return null;
    const cleanRom = sanitiseRomName(romName);
    if (cleanRom.length === 0) return null;
    const systemSegment = dir.replace(/ /g, '_');
    // encodeURIComponent leaves alphanumerics and `-_.!~*'()` as-is,
    // and turns spaces into %20 — the right thing for a path segment.
    const fileSegment = `${encodeURIComponent(cleanRom)}.png`;
    return `${BASE}/${systemSegment}/${namedDir(kind)}/${fileSegment}`;
  }
}

/**
 * Resolve an OpenVGDB-shaped system name to its libretro-thumbnails
 * directory (in canonical " - " form, pre-underscore-replacement),
 * or null when the system isn't covered.
 *
 * Round 8: extracted so the case-normalisation rule has a single
 * call site. OpenVGDB v29.0 returns title-case strings like
 * "Nintendo Game Boy Advance" / "Sega Genesis/Mega Drive"; the map
 * keys are lowercase. We normalise here so callers don't have to
 * remember.
 */
export function getLibretroDir(systemName: string): string | null {
  return SYSTEM_MAP.get(systemName.trim().toLowerCase()) ?? null;
}

/**
 * Replace the chars libretro-thumbnails strips from filenames with
 * underscores. List per RetroArch's own filename derivation:
 *   & * / : ` < > ? \ | "
 * Spaces and apostrophes stay (encodeURIComponent handles spaces).
 */
function sanitiseRomName(name: string): string {
  return name.replace(/[&*/:`<>?\\|"]/g, '_').trim();
}
