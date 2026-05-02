/**
 * Heuristic-based detection of system files (BIOSes, configs, palette
 * sets) inside a games directory. Used to suppress noise from cores like
 * NEOGEO whose `games/` dir mixes 12 BIOS/config files with the actual
 * ROM folders.
 *
 * The rules are intentionally conservative — false positives (real ROMs
 * marked as system) are worse than false negatives. To extend: add to
 * `SYSTEM_FILE_PATTERNS` for files or `SYSTEM_FOLDER_NAMES` for folders.
 * See docs/architecture.md for the rationale and snapshot reference.
 */

/**
 * File-level rules. A name matches if it satisfies any pattern. Names
 * are matched case-insensitively against the lowercase basename.
 *
 * Patterns:
 *   - prefix matches via `startsWith` for boot/bios/the named bioses
 *     whose tail varies (e.g. `boot.rom`, `boot1.rom`, `boot.v2.rom`)
 *   - exact matches for fixed BIOS filenames
 *   - extension matches for ".xml" / ".ini" config files
 */
const SYSTEM_FILE_EXACT: ReadonlySet<string> = new Set([
  // Neo Geo / Neo Geo CD system stack — see snapshot's NEOGEO listing.
  'cd_bios.rom',
  'neocd.bin',
  'top-sp1.bin',
  'uni-bioscd.rom',
  'uni-bios.rom',
]);

const SYSTEM_FILE_PREFIXES: readonly string[] = [
  // BIOS / boot / Neo Geo system blobs whose suffix varies between dumps.
  'boot.',
  'boot1.',
  'boot2.',
  'bios.',
  'bios_',
  'neo-epo.sp1',
  'sfix.sfix',
  'sp-s2.sp1',
  '000-lo.lo',
];

const SYSTEM_FILE_EXTENSIONS: readonly string[] = [
  // Plain config files anywhere under a games dir are not ROMs.
  '.xml',
  '.ini',
];

/**
 * Folder-level rules. Top-level subfolders that match the case-
 * insensitive set are treated as system content (palettes, overlays,
 * filter packs, MiSTer's `old/` rotation dir).
 */
const SYSTEM_FOLDER_NAMES: ReadonlySet<string> = new Set([
  'palettes',
  'overlays',
  'filters',
  'old',
]);

export interface SystemFileCandidate {
  /** On-disk basename (any case). May start with `.` for hidden entries. */
  readonly filename: string;
  readonly kind: 'file' | 'folder';
}

/**
 * True iff the candidate looks like a system file or folder rather than
 * a user-installed ROM. The leading-dot (hidden) form of the same name
 * is treated identically — a hidden BIOS is still a BIOS.
 */
export function isSystemFile(candidate: SystemFileCandidate): boolean {
  const name = candidate.filename.startsWith('.')
    ? candidate.filename.slice(1)
    : candidate.filename;
  if (name === '') return false;
  const lower = name.toLowerCase();

  if (candidate.kind === 'folder') {
    return SYSTEM_FOLDER_NAMES.has(lower);
  }

  if (SYSTEM_FILE_EXACT.has(lower)) return true;
  for (const prefix of SYSTEM_FILE_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  for (const ext of SYSTEM_FILE_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}
