import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/**
 * feat/cache-path-rename — `<userData>/cache/` collided with
 * Chromium's HTTP cache directory (`<userData>/Cache/`) on macOS's
 * case-insensitive APFS volume. Both names resolve to the same
 * inode, so the dirs coexist physically. Chromium's HTTP cache
 * manager wipes foreign subdirs from its directory during fresh
 * startup, which silently deleted our per-host cache subdirs
 * between every app launch — manifesting as `cache.miss` with
 * `note='enoent'` on connect 2 despite a successful write on
 * connect 1. PR #59 surfaced the cause; this PR moves us off the
 * collision path entirely by renaming our cache root.
 *
 * Use the constant everywhere — never reach for the literal
 * `'mister-cache'` string elsewhere in the codebase. The collision
 * audit (`findElectronCollisions`) prevents reintroducing the bug
 * with a future name choice.
 */
export const MISTER_CACHE_DIR_NAME = 'mister-cache';

/**
 * Pre-rename location. Kept only for the one-shot migration step in
 * `migrateOldCacheDirIfNeeded` — production code should never read
 * or write to this path again.
 */
export const OLD_CACHE_DIR_NAME = 'cache';

/**
 * Every userData subdir / file MiSTerCurator owns. Drives the
 * collision-audit test in `userdata-paths.test.ts`. Add an entry
 * here when adding a new userData-rooted path; the test will
 * cross-check it against the Electron/Chromium reserved list.
 *
 * Top-level files (`profiles.json`, `secrets.json`) are included
 * even though they can't shadow a directory — collision-on-FS is
 * a hazard regardless of path type, and Chromium can and does
 * create files with arbitrary names.
 */
export const MISTERCURATOR_USERDATA_NAMES: readonly string[] = [
  MISTER_CACHE_DIR_NAME,
  'metadata',
  'scrape-state',
  'profiles.json',
  'secrets.json',
];

/**
 * Names Electron / Chromium routinely creates under userData. A
 * case-insensitive collision with any of these on macOS APFS or
 * NTFS would put our files in a directory Chromium thinks it
 * owns — see the `cache` / `Cache` incident this PR is fixing.
 *
 * Drawn from the observed contents of a real session's userData
 * directory plus the well-known Chromium HTTP cache / IndexedDB /
 * service worker locations. Comparisons are case-insensitive.
 */
export const ELECTRON_RESERVED_USERDATA_NAMES: readonly string[] = [
  'blob_storage',
  'Cache',
  'Code Cache',
  'Cookies',
  'Cookies-journal',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'IndexedDB',
  'Local Storage',
  'Network',
  'Network Persistent State',
  'Preferences',
  'Service Worker',
  'Session Storage',
  'Shared Dictionary',
  'SharedStorage',
  'SharedStorage-wal',
  'Trust Tokens',
  'Trust Tokens-journal',
];

/**
 * Return the subset of `ourNames` that case-insensitively match a
 * known Electron/Chromium reserved name. Used as both a unit test
 * assertion (we never collide) and a regression pin (the file is
 * the single source of truth — any future rename has to update it).
 */
export function findElectronCollisions(
  ourNames: readonly string[],
  reserved: readonly string[] = ELECTRON_RESERVED_USERDATA_NAMES,
): string[] {
  const reservedLower = new Set(reserved.map((n) => n.toLowerCase()));
  return ourNames.filter((n) => reservedLower.has(n.toLowerCase()));
}

/**
 * Marker filenames that identify a per-host MiSTerCurator cache
 * subdir. Used by the migration to tell our subdirs apart from
 * Chromium's siblings (`Cache_Data/`, `index`, `data_0`, etc.)
 * when both live in the case-collided `<userData>/cache|Cache/`
 * directory. If a subdir contains ANY of these, it's ours.
 */
const OUR_SUBDIR_MARKERS: readonly string[] = [
  'cores.json',
  'arcade-mra-meta.json',
  'roms',
];

async function subdirIsOurs(subdirPath: string): Promise<boolean> {
  for (const marker of OUR_SUBDIR_MARKERS) {
    try {
      await fs.access(join(subdirPath, marker));
      return true;
    } catch {
      // marker not found, keep looking
    }
  }
  return false;
}

export interface CacheMigrationResult {
  /** Subdir basenames that were moved from the old location to the new. */
  readonly moved: readonly string[];
  /**
   * Subdirs that LOOKED like ours (markers present) but couldn't be
   * moved because the new location already had an entry of the same
   * name. The user has hit a back-and-forth across app versions
   * — we prefer the newer location's data and leave the old in
   * place for the user to delete manually.
   */
  readonly skippedDestinationExists: readonly string[];
}

/**
 * If `<userDataDir>/cache/` contains host-keyed MiSTerCurator
 * subdirs (identified by `cores.json`, `arcade-mra-meta.json`, or
 * `roms/` markers), move those subdirs to `<userDataDir>/mister-cache/`.
 *
 * Critically does NOT touch sibling entries — on macOS the OLD
 * `<userDataDir>/cache/` is the SAME inode as Chromium's `Cache/`,
 * so a wholesale rename would move Chromium's HTTP cache data too.
 * The migration is scoped to entries that carry our marker files.
 *
 * Idempotent and safe to call on every app launch:
 *   - If the old dir doesn't exist (fresh install), no-op.
 *   - If the old dir exists but contains no ours-markers (every
 *     subdir is Chromium's), no-op.
 *   - If the new dir already has an entry with the same name,
 *     leaves the old in place rather than overwriting newer data.
 *
 * Best-effort: a per-entry rename failure (EXDEV across volumes,
 * EACCES, etc.) is logged via `console.warn` and the loop continues.
 * The next attempt will retry the unmoved entries. Worst case, the
 * cache misses next session and rebuilds.
 */
export async function migrateOldCacheDirIfNeeded(
  userDataDir: string,
): Promise<CacheMigrationResult> {
  const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
  const newPath = join(userDataDir, MISTER_CACHE_DIR_NAME);
  let entries: string[];
  try {
    entries = await fs.readdir(oldPath);
  } catch (err) {
    if (isENOENT(err) || isENOTDIR(err)) return { moved: [], skippedDestinationExists: [] };
    throw err;
  }
  const moved: string[] = [];
  const skipped: string[] = [];
  let newPathEnsured = false;
  for (const entry of entries) {
    const fromPath = join(oldPath, entry);
    const stat = await fs.stat(fromPath).catch(() => null);
    if (stat === null || !stat.isDirectory()) continue;
    if (!(await subdirIsOurs(fromPath))) continue;
    const toPath = join(newPath, entry);
    const destExists = await fs
      .access(toPath)
      .then(() => true)
      .catch(() => false);
    if (destExists) {
      skipped.push(entry);
      continue;
    }
    if (!newPathEnsured) {
      await fs.mkdir(newPath, { recursive: true });
      newPathEnsured = true;
    }
    try {
      await fs.rename(fromPath, toPath);
      moved.push(entry);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[cache] migration: failed to move ${fromPath} → ${toPath}`,
        err,
      );
    }
  }
  return { moved, skippedDestinationExists: skipped };
}

function isENOENT(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

function isENOTDIR(err: unknown): boolean {
  return (
    err instanceof Error &&
    'code' in err &&
    (err as NodeJS.ErrnoException).code === 'ENOTDIR'
  );
}
