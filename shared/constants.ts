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
 * operates on the first five — `_Arcade/` is enumerated so the UI
 * can show arcade cores as read-only, but it is never written to.
 *
 * `_Console (autoboot)/` (note: literal space + parentheses) holds
 * .mgl files that auto-launch a ROM at boot — "SEGA 32X.mgl",
 * "Sony PlayStation.mgl", etc. The diagnostic surfaced 10 of these
 * on the user's MiSTer; pre-PR-#11-round-2 the matcher missed them
 * entirely. They appear in the cores list as separate entries (the
 * names don't canonicalise to anything that matches a games dir, so
 * they stand alone — the user can hide them like any other rbf-only
 * core).
 */
export const MISTER_CATEGORY_DIRS: readonly {
  readonly category: CoreCategory;
  readonly dir: string;
}[] = [
  { category: 'Console', dir: '/media/fat/_Console' },
  { category: 'Console', dir: '/media/fat/_Console (autoboot)' },
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
