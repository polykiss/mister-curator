/**
 * Heuristic-based detection of system files (BIOSes, configs, palette
 * sets) inside a games directory. Used to suppress noise from cores like
 * NEOGEO whose `games/` dir mixes 12 BIOS/config files with the actual
 * ROM folders.
 *
 * The rules are intentionally conservative — false positives (real ROMs
 * marked as system) are worse than false negatives. The auto-detector
 * is intentionally narrow; the long tail of system-y files (palette
 * tables, BIOS variants, mod tools) is handled by the user-marks layer
 * that lives alongside it. To extend the heuristic: add to
 * `SYSTEM_FILE_PATTERNS` for files or `SYSTEM_FOLDER_NAMES` for folders.
 * See docs/architecture.md for the rationale and snapshot reference.
 */

import { isMarked } from '@shared/system-files-marks';
import type { SystemFilesMarks } from '@shared/types';

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
 * Suffix matches catch the very common BIOS naming convention used by
 * many cores: `<core-prefix>boot.<ext>` and `<core-prefix>bios.<ext>`.
 * Real-world examples that motivated this rule:
 *   - lynxboot.img    (AtariLynx)
 *   - sega_bios.rom   (Saturn)
 *   - gba_bios.bin    (GBA)
 *   - ngp_bios.ngp    (Neo Geo Pocket)
 *
 * False-positive risk is low: real ROM names rarely end with
 * `boot.<ext>` or `bios.<ext>`. If we get bitten, we'll narrow.
 */
const SYSTEM_FILE_SUFFIXES: readonly string[] = [
  'boot.img',
  'boot.bin',
  'boot.rom',
  'bios.img',
  'bios.bin',
  'bios.rom',
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
 * Optional layer over the auto-detector heuristic: a user-maintained
 * marks list combined with the relevant `coreId`. When supplied, a
 * `(coreId, filename)` pair found in `marks` is treated as system
 * regardless of whether the heuristic flags it.
 */
export interface SystemFileOptions {
  readonly marks?: SystemFilesMarks;
  readonly coreId?: string;
}

/**
 * True iff the candidate looks like a system file or folder rather than
 * a user-installed ROM. Two layers:
 *
 *   1. Auto-detector heuristic — the rules in this file (BIOS prefix /
 *      suffix / extension / folder-name).
 *   2. User-maintained marks — when `options.marks` and `options.coreId`
 *      are provided, the function also returns true for any file the
 *      user has explicitly marked as system for this core.
 *
 * The leading-dot (hidden) form of the same name is treated identically
 * for the auto-detector — a hidden BIOS is still a BIOS. The marks list
 * stores raw filenames as the user marked them (the renderer marks the
 * visible name; both clients store/read it verbatim).
 */
export function isSystemFile(
  candidate: SystemFileCandidate,
  options: SystemFileOptions = {},
): boolean {
  if (isAutoDetectedSystemFile(candidate)) return true;
  if (options.marks && options.coreId !== undefined) {
    return isMarked(options.marks, options.coreId, candidate.filename);
  }
  return false;
}

/**
 * Auto-detector layer in isolation. Used by the UI to decide whether a
 * "Mark as system file" / "Unmark" action is available — auto-detected
 * files cannot be unmarked because they're heuristic, not stored.
 */
export function isAutoDetectedSystemFile(
  candidate: SystemFileCandidate,
): boolean {
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
  for (const suffix of SYSTEM_FILE_SUFFIXES) {
    if (lower.endsWith(suffix)) return true;
  }
  return false;
}
