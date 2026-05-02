/**
 * Display-only name normalisation for ROM entries. Pure: never touched
 * by SSH, never persisted — the on-disk basename always wins for any
 * operation that targets the file.
 *
 * Today the only transformation is stripping a trailing archive
 * extension (`.zip` / `.7z` / `.rar`, case-insensitive). MiSTer cores
 * read straight out of these archives, so the user thinks of the file
 * as the game name without the archive wrapper. Showing
 * "Advanced Wars GBA" reads better than "Advanced Wars GBA.zip".
 *
 * The leading-dot prefix used for hide/show is stripped upstream by the
 * clients. This function operates on the already-visible name.
 */

const ARCHIVE_EXTENSIONS: readonly string[] = ['.zip', '.7z', '.rar'];

/**
 * Returns the user-facing display string for a ROM whose dot-prefix has
 * already been removed. Strips a trailing archive extension if present;
 * otherwise returns the input unchanged.
 *
 * Examples:
 *   "Advanced Wars GBA.zip"   → "Advanced Wars GBA"
 *   "Castlevania.7z"          → "Castlevania"
 *   "Castlevania.RAR"         → "Castlevania"
 *   "Super Mario.zip.bak"     → "Super Mario.zip.bak"   (suffix is .bak)
 *   "Super Mario.sfc"         → "Super Mario.sfc"       (.sfc isn't an archive)
 *   ""                        → ""
 */
export function displayRomName(filename: string): string {
  if (filename === '') return '';
  const lower = filename.toLowerCase();
  for (const ext of ARCHIVE_EXTENSIONS) {
    if (lower.endsWith(ext) && filename.length > ext.length) {
      return filename.slice(0, -ext.length);
    }
  }
  return filename;
}
