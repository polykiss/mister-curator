import { MISTER_GAMES_DIR } from '@shared/constants';
import type { CoreCategory, CoreEntry, HideLedger } from '@shared/types';

/**
 * Strip the leading dot (if present) and the `.rbf` extension (if present),
 * then drop a trailing `_<8+ digits>` date version suffix. This is how we
 * collapse `NES_20240115.rbf` and `NES_20231215.rbf` to the same coreId.
 *
 * Examples:
 *   NES_20240115.rbf       → NES
 *   Atari2600_20240220.rbf → Atari2600
 *   .NES_20240115.rbf      → NES         (currently hidden)
 *   Tatung_Einstein.rbf    → Tatung_Einstein  (no date suffix; underscore preserved)
 *   MyCore.rbf             → MyCore
 *   AO486                  → AO486        (folder-shaped core)
 *   .AO486                 → AO486        (currently hidden folder)
 */
export function extractCorePrefix(filename: string): string {
  const undotted = filename.startsWith('.') ? filename.slice(1) : filename;
  const base = undotted.toLowerCase().endsWith('.rbf')
    ? undotted.slice(0, -4)
    : undotted;
  return base.replace(/_\d{8,}$/, '');
}

export interface RawRbfInput {
  readonly category: CoreCategory;
  /** Raw on-disk filename or folder name (may include leading `.`). */
  readonly filename: string;
  /** Full on-disk path (current state, including any leading `.`). */
  readonly fullPath: string;
  /** True for folder-shaped cores (e.g. `_Computer/AO486/`). */
  readonly isFolder: boolean;
}

export interface RawGamesDirInput {
  /** Raw on-disk directory name, including any leading `.`. */
  readonly rawName: string;
  readonly romCount: number;
  readonly hiddenCount: number;
}

export interface MatchInput {
  readonly rbfs: readonly RawRbfInput[];
  readonly gamesDirs: readonly RawGamesDirInput[];
}

interface MutableCoreEntry {
  id: string;
  name: string;
  romCount: number;
  hiddenCount: number;
  category: CoreCategory;
  rbfPaths: string[];
  gamesDirExists: boolean;
  gamesDirHidden: boolean;
}

/**
 * Joins enumerated rbf entries (across all category dirs) with games-dir
 * entries to produce one CoreEntry per coreId. Pure function — all
 * filesystem I/O happens upstream.
 *
 * Joining rules:
 *   - Multiple rbfs with the same prefix collapse to one CoreEntry with
 *     all paths in `rbfPaths` (older versions sitting alongside newer).
 *   - A games dir with no matching rbf produces a CoreEntry with
 *     `category: 'Unknown'` and empty `rbfPaths` — still hideable.
 *   - An rbf with no matching games dir produces a CoreEntry with
 *     `gamesDirExists: false` and `romCount: 0` — still hideable.
 *   - When an rbf prefix collides across categories (rare in practice),
 *     the first-seen non-arcade category wins. Arcade cores stay as
 *     'Arcade' so the UI can disable hide on them.
 */
export function matchRbfsToGamesDirs(input: MatchInput): CoreEntry[] {
  const byId = new Map<string, MutableCoreEntry>();

  for (const rbf of input.rbfs) {
    const prefix = extractCorePrefix(rbf.filename);
    if (prefix === '') continue;

    const existing = byId.get(prefix);
    if (existing) {
      existing.rbfPaths.push(rbf.fullPath);
      // Prefer non-arcade category if a later rbf gives us a better match.
      if (existing.category === 'Arcade' && rbf.category !== 'Arcade') {
        existing.category = rbf.category;
      }
    } else {
      byId.set(prefix, {
        id: prefix,
        name: prefix,
        romCount: 0,
        hiddenCount: 0,
        category: rbf.category,
        rbfPaths: [rbf.fullPath],
        gamesDirExists: false,
        gamesDirHidden: false,
      });
    }
  }

  for (const gd of input.gamesDirs) {
    const isHidden = gd.rawName.startsWith('.');
    const visibleName = isHidden ? gd.rawName.slice(1) : gd.rawName;
    if (visibleName === '') continue;

    const existing = byId.get(visibleName);
    if (existing) {
      existing.gamesDirExists = true;
      existing.gamesDirHidden = isHidden;
      existing.romCount = gd.romCount;
      existing.hiddenCount = gd.hiddenCount;
    } else {
      byId.set(visibleName, {
        id: visibleName,
        name: visibleName,
        romCount: gd.romCount,
        hiddenCount: gd.hiddenCount,
        category: 'Unknown',
        rbfPaths: [],
        gamesDirExists: true,
        gamesDirHidden: isHidden,
      });
    }
  }

  const out: CoreEntry[] = Array.from(byId.values()).map((e) => ({
    id: e.id,
    name: e.name,
    romCount: e.romCount,
    hiddenCount: e.hiddenCount,
    category: e.category,
    rbfPaths: [...e.rbfPaths],
    gamesDirExists: e.gamesDirExists,
    gamesDirHidden: e.gamesDirHidden,
  }));
  out.sort((a, b) => a.id.localeCompare(b.id, 'en-US', { sensitivity: 'base' }));
  return out;
}

/**
 * Returns the basename component of a slash-separated path. Mirrors
 * POSIX behavior: trailing slash is ignored.
 */
export function pathBasename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? trimmed : trimmed.slice(i + 1);
}

/**
 * Returns the directory component of a slash-separated path. Empty when
 * there is no slash.
 */
export function pathDirname(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const i = trimmed.lastIndexOf('/');
  return i < 0 ? '' : trimmed.slice(0, i);
}

/**
 * Adds a leading dot to the basename component, if not already present.
 * Idempotent. Preserves trailing slash if the input had one.
 */
export function dottedPath(path: string): string {
  const trailingSlash = path.endsWith('/') ? '/' : '';
  const trimmed = trailingSlash !== '' ? path.slice(0, -1) : path;
  const dir = pathDirname(trimmed);
  const base = pathBasename(trimmed);
  const dotted = base.startsWith('.') ? base : `.${base}`;
  return `${dir === '' ? '' : `${dir}/`}${dotted}${trailingSlash}`;
}

/**
 * Removes a leading dot from the basename component, if present. Idempotent.
 */
export function undottedPath(path: string): string {
  const trailingSlash = path.endsWith('/') ? '/' : '';
  const trimmed = trailingSlash !== '' ? path.slice(0, -1) : path;
  const dir = pathDirname(trimmed);
  const base = pathBasename(trimmed);
  const undotted = base.startsWith('.') ? base.slice(1) : base;
  return `${dir === '' ? '' : `${dir}/`}${undotted}${trailingSlash}`;
}

/**
 * True iff the user cannot see the core via the MiSTer menu — both its
 * games dir AND every matching rbf are dot-prefixed (or absent).
 */
export function isCoreHidden(core: CoreEntry): boolean {
  const hasAnyVisibleRbf = core.rbfPaths.some((p) => !pathBasename(p).startsWith('.'));
  const gamesDirVisible = core.gamesDirExists && !core.gamesDirHidden;
  return !hasAnyVisibleRbf && !gamesDirVisible;
}

export interface CoreVisibilityChange {
  readonly coreId: string;
  readonly hidden: boolean;
}

export interface CoreRename {
  readonly from: string;
  readonly to: string;
}

/**
 * Computes the per-path renames needed to flip a core's visibility. Both
 * clients (real + fake) share this so the rename semantics — including
 * "rename every matching rbf, even older versions" — are identical.
 *
 * Returns an empty list when the core is already in the requested state
 * (every games-dir + rbf path already has the desired dot-prefix). The
 * caller can then skip the SSH round-trip entirely.
 */
export function computeCoreRenames(core: CoreEntry, hidden: boolean): CoreRename[] {
  const renames: CoreRename[] = [];

  if (core.gamesDirExists) {
    const visibleDir = `${MISTER_GAMES_DIR}/${core.id}`;
    const hiddenDir = `${MISTER_GAMES_DIR}/.${core.id}`;
    const currentDir = core.gamesDirHidden ? hiddenDir : visibleDir;
    const targetDir = hidden ? hiddenDir : visibleDir;
    if (currentDir !== targetDir) {
      renames.push({ from: currentDir, to: targetDir });
    }
  }

  for (const rbfPath of core.rbfPaths) {
    const target = hidden ? dottedPath(rbfPath) : undottedPath(rbfPath);
    if (target !== rbfPath) {
      renames.push({ from: rbfPath, to: target });
    }
  }

  return renames;
}

/**
 * Diffs the on-MiSTer hide ledger against a freshly-listed cores snapshot
 * to compute which cores need to be re-hidden because the .rbf or games
 * dir has reappeared (typically after a MiSTer update). Skips cores that
 * no longer exist on the device, and never returns arcade cores — even
 * if they somehow ended up in a stale ledger.
 */
export function computeAutoReapplyChanges(
  ledger: HideLedger,
  currentCores: readonly CoreEntry[],
): CoreVisibilityChange[] {
  const changes: CoreVisibilityChange[] = [];
  const coresById = new Map(currentCores.map((c) => [c.id, c]));

  for (const ledgerEntry of ledger.hiddenCores) {
    const core = coresById.get(ledgerEntry.coreId);
    if (!core) continue;
    if (core.category === 'Arcade') continue;
    if (isCoreHidden(core)) continue;
    changes.push({ coreId: core.id, hidden: true });
  }

  return changes;
}
