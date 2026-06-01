/**
 * Cross-filesystem-detritus filter. Drops the OS-metadata sidecars
 * that show up on a MiSTer when ROMs are copied from macOS or
 * Windows machines — files like `._castlevania.chd` (AppleDouble),
 * `.DS_Store` (Finder), `Thumbs.db` (Windows), `desktop.ini` — and
 * the corresponding metadata directories (`.AppleDouble/`,
 * `.Spotlight-V100/`, `$RECYCLE.BIN/`, etc.).
 *
 * Distinct concern from `system-files.ts`: that module classifies
 * BIOS / config / palette files that legitimately live in a games
 * tree but aren't ROMs. This module classifies files that don't
 * belong on the device at all — they were never part of the user's
 * ROM library, just a transfer artifact.
 *
 * Both helpers are pure case-insensitive checks. They sit upstream
 * of the hash pipeline (wired into `shouldCountAsRom`) so junk
 * filenames never produce wasted SSH/hash work or fill the metadata
 * cache with `source: 'none'` sentinels.
 *
 * Deletion of detected junk is out of scope here; that's GitHub
 * issue #18's surface (a separate PR with a review-and-confirm UI).
 */

/**
 * Files matched by exact lowercase basename. The leading dot (when
 * present) is part of the match — `DS_Store` without the dot is a
 * legitimate filename.
 */
const OS_METADATA_FILE_EXACT: ReadonlySet<string> = new Set([
  '.ds_store',
  'thumbs.db',
  'desktop.ini',
  '.directory',
]);

/**
 * Directories matched by exact lowercase basename. Treated as
 * scan-poison: any path with one of these as an ancestor segment
 * never enters the hash pipeline, regardless of leaf name.
 */
const OS_METADATA_DIR_EXACT: ReadonlySet<string> = new Set([
  '.appledouble',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '$recycle.bin',
  'lost+found',
  'system volume information', // Windows FAT32 artifact on SD cards
  '.git',                      // git repos synced to SD card
]);

/**
 * True iff `filename` is an OS-metadata sidecar file. Match is
 * case-insensitive.
 *
 * Two layers:
 *   - macOS AppleDouble prefix (`._<anything>`) — by far the most
 *     common case. The dot-underscore prefix carries Finder metadata
 *     for the file with the matching tail; created on every
 *     cross-filesystem copy from macOS.
 *   - Exact basename match against the well-known set (`.DS_Store`,
 *     `Thumbs.db`, `desktop.ini`, `.directory`).
 */
export function isOsMetadataFile(filename: string): boolean {
  if (filename.startsWith('._')) return true;
  return OS_METADATA_FILE_EXACT.has(filename.toLowerCase());
}

/** True iff `dirname` is a well-known OS-metadata directory. */
export function isOsMetadataDir(dirname: string): boolean {
  return OS_METADATA_DIR_EXACT.has(dirname.toLowerCase());
}
