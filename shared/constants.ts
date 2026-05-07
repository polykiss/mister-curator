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
