/**
 * Display-only name normalisation for ROM entries. Pure: never touched
 * by SSH, never persisted — the on-disk basename always wins for any
 * operation that targets the file.
 *
 * Two transformations, both done in the same pass:
 *
 *   1. Strip a trailing archive extension (`.zip` / `.7z` / `.rar`).
 *      MiSTer cores read straight out of these wrappers; the user
 *      thinks of the file as the game name, not the archive.
 *   2. Strip a trailing cartridge / native-format extension (`.neo`,
 *      `.nes`, `.sfc`, …). The core context already tells the user
 *      the format — repeating it on every row is noise.
 *
 * Disc-track and disc-image extensions (`.bin`, `.cue`, `.iso`,
 * `.chd`, `.gdi`) are NOT stripped: inside a disc folder the format
 * identity matters (which file is the manifest, which are tracks),
 * and the name on a track ROM is otherwise meaningless without the
 * extension.
 *
 * The leading-dot prefix used for hide/show is stripped upstream by
 * the clients. This function operates on the already-visible name.
 */

const STRIPPABLE_EXTENSIONS: readonly string[] = [
  // Archive wrappers (round 7).
  '.zip',
  '.7z',
  '.rar',
  // Cartridge / native-format extensions (round 11). Each one is the
  // canonical extension for one core; the core name in the cores
  // pane already conveys the platform.
  '.neo', // NeoGeo
  '.nes', // NES
  '.sfc', // Super Famicom
  '.smc', // Super Magicom (alt SNES)
  '.gba', // Game Boy Advance
  '.gb', // Game Boy
  '.gbc', // Game Boy Color
  '.md', // Mega Drive
  '.gen', // Genesis (alt MD)
  '.pce', // PC Engine / TG-16
  '.lnx', // Atari Lynx
  '.col', // ColecoVision
  '.int', // Intellivision
  '.vec', // Vectrex
  '.ws', // WonderSwan
  '.wsc', // WonderSwan Color
  '.a78', // Atari 7800
  '.a26', // Atari 2600
  '.32x', // Sega 32X
  '.j64', // Atari Jaguar
  '.jag', // Atari Jaguar (alt)
  '.sms', // Master System
  '.gg', // Game Gear
];

/**
 * Returns the user-facing display string for a ROM whose dot-prefix has
 * already been removed. Strips a trailing strippable extension if
 * present; otherwise returns the input unchanged.
 *
 * Examples:
 *   "Advanced Wars GBA.zip"            → "Advanced Wars GBA"
 *   "Castlevania.7z"                   → "Castlevania"
 *   "Castlevania.RAR"                  → "Castlevania"
 *   "2020 Super Baseball.neo"          → "2020 Super Baseball"
 *   "Castlevania (USA, Europe).nes"    → "Castlevania (USA, Europe)"
 *   "Track 01.bin"                     → "Track 01.bin"  (.bin preserved)
 *   "Game.cue"                         → "Game.cue"      (.cue preserved)
 *   "Super Mario.zip.bak"              → "Super Mario.zip.bak"  (.bak isn't strippable)
 *   ""                                 → ""
 */
export function displayRomName(filename: string): string {
  if (filename === '') return '';
  const lower = filename.toLowerCase();
  for (const ext of STRIPPABLE_EXTENSIONS) {
    if (lower.endsWith(ext) && filename.length > ext.length) {
      return filename.slice(0, -ext.length);
    }
  }
  return filename;
}
