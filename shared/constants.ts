import type { CoreCategory } from '@shared/types';

export const MISTER_FAT_DIR = '/media/fat';
export const MISTER_GAMES_DIR = '/media/fat/games';
export const MISTER_AGENT_DIR = '/tmp/mistercurator';
export const MISTER_LEDGER_DIR = '/media/fat/.mistercurator';
export const MISTER_LEDGER_PATH = '/media/fat/.mistercurator/state.json';
export const MISTER_SYSTEM_FILES_PATH =
  '/media/fat/.mistercurator/system-files.json';
export const MISTER_FOLDER_CLASSIFICATIONS_PATH =
  '/media/fat/.mistercurator/folder-classifications.json';

/**
 * Core category dirs under `/media/fat/`. The hide-core feature only
 * operates on the first four — `_Arcade/` is enumerated so the UI
 * can show arcade cores as read-only, but it is never written to.
 *
 * `_Console (autoboot)/` (note: literal space + parentheses) is
 * intentionally NOT enumerated. The .mgl files inside —
 * "SEGA 32X.mgl", "Sony PlayStation.mgl", "Nintendo 64.mgl", etc. —
 * are firmware autoboot shortcuts that launch existing cores
 * (S32X.rbf, PSX.rbf, N64.rbf) at boot. They are NOT independent
 * cores. PR #11 round 2 enumerated them and surfaced 10 phantom
 * rows whose names ("Sony PlayStation", "Nintendo 64") didn't
 * canonicalise to anything matching the user's actual games dirs
 * ("PSX", "N64"). Round 3 drops them.
 */
export const MISTER_CATEGORY_DIRS: readonly {
  readonly category: CoreCategory;
  readonly dir: string;
}[] = [
  { category: 'Console', dir: '/media/fat/_Console' },
  { category: 'Computer', dir: '/media/fat/_Computer' },
  { category: 'Other', dir: '/media/fat/_Other' },
  { category: 'Utility', dir: '/media/fat/_Utility' },
  { category: 'Arcade', dir: '/media/fat/_Arcade' },
];

export const HIDEABLE_CATEGORIES: ReadonlySet<CoreCategory> = new Set([
  'Console',
  'Computer',
  'Other',
  'Utility',
  'Unknown',
]);

/**
 * Witness paths the cores-cache (cores.json) validates against on
 * each connect. Mtime changes on any of these mean a rename or new
 * core — exactly what `listAllCoresWithFiles` would surface
 * differently. Notably absent: `_Arcade` (read-only, mutations are
 * rare and the placeholder row doesn't carry user data) and per-core
 * `games/<coreId>` (those are the listRoms cache's witnesses, not
 * the cores cache's).
 *
 * Documented staleness: a ROM added inside an existing core's games
 * dir via SFTP changes `games/<coreId>` mtime but NOT `games/`
 * mtime. The cores list's romCount field will read stale until the
 * user clicks Refresh. Acceptable for v0; the listRoms cache picks
 * up the same change correctly when the user drills in. See PR #12
 * description for the design rationale.
 */
export const CORES_CACHE_WITNESS_PATHS: readonly string[] = [
  '/media/fat/_Console',
  '/media/fat/_Computer',
  '/media/fat/_Other',
  '/media/fat/_Utility',
  MISTER_GAMES_DIR,
];

/**
 * Build the listRoms cache witness path for a given (coreId, subPath).
 * Top-level → `/media/fat/games/<coreId>`. Drilled-in → that path
 * with the subPath joined on. The on-disk basename includes the
 * leading dot when the games dir is hidden — callers must pass the
 * resolved on-disk basename (the `.NES` form), not the canonical id.
 */
export function romsCacheWitnessPath(
  onDiskGamesDirBasename: string,
  subPath: string,
): string {
  if (subPath === '') {
    return `${MISTER_GAMES_DIR}/${onDiskGamesDirBasename}`;
  }
  return `${MISTER_GAMES_DIR}/${onDiskGamesDirBasename}/${subPath}`;
}
