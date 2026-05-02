import { MISTER_GAMES_DIR } from '@shared/constants';
import type { CoreCategory, CoreEntry, HideLedger } from '@shared/types';

/**
 * Strip the leading dot (if present), the `.rbf` or `.mgl` extension (if
 * present), then drop a trailing `_<8+ digits>` date version suffix. This
 * is how we collapse `NES_20240115.rbf` and `NES_20231215.rbf` to the same
 * coreId.
 *
 * Real MiSTers ship many cores as `.mgl` (XML pointer) files instead of
 * `.rbf` — `.mgl` cores are treated identically to `.rbf` for matching,
 * hiding, and showing. The XML is never parsed; we just rename the file.
 *
 * Examples:
 *   NES_20251013.rbf            → NES
 *   Atari2600_20240220.rbf      → Atari2600
 *   .NES_20240115.rbf           → NES                     (currently hidden)
 *   Tatung_Einstein.rbf         → Tatung_Einstein         (no date; underscore preserved)
 *   MyCore.rbf                  → MyCore
 *   AO486                       → AO486                   (folder-shaped core)
 *   .AO486                      → AO486                   (hidden folder)
 *   Game Gear.mgl               → Game Gear               (.mgl, with space)
 *   Atari 2600.mgl              → Atari 2600
 *   Mega Duck.mgl               → Mega Duck
 *   Pocket Challenge V2.mgl     → Pocket Challenge V2
 *   GameboyColor.mgl            → GameboyColor
 */
export function extractCorePrefix(filename: string): string {
  const undotted = filename.startsWith('.') ? filename.slice(1) : filename;
  const lower = undotted.toLowerCase();
  const base =
    lower.endsWith('.rbf') || lower.endsWith('.mgl')
      ? undotted.slice(0, -4)
      : undotted;
  return base.replace(/_\d{8,}$/, '');
}

/**
 * True when the on-disk filename is something this app treats as a core
 * file — either an `.rbf` (synthesized core) or an `.mgl` (XML pointer
 * core). Case-insensitive.
 */
export function isCoreFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return lower.endsWith('.rbf') || lower.endsWith('.mgl');
}

/**
 * Synthetic id used for the single placeholder row that represents the
 * Arcade category in the cores list. Real arcade core ids never use this
 * prefix (real ids come from filename parsing).
 */
export const ARCADE_PLACEHOLDER_ID = '__mister:arcade_placeholder__';

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
  /**
   * True when `/media/fat/_Arcade/` exists on the device, regardless of
   * what's inside it. Real MiSTers populate `_Arcade/` with `.mra` files
   * and subfolders rather than `.rbf` or `.mgl` cores, so we can't infer
   * arcade presence from the rbfs list — the placeholder row needs an
   * explicit signal. Defaults to false; the production clients always
   * pass an explicit value.
   */
  readonly arcadeDirExists?: boolean;
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
  gamesDirName?: string;
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
      existing.gamesDirName = visibleName;
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
        gamesDirName: visibleName,
      });
    }
  }

  const allRaw: CoreEntry[] = Array.from(byId.values()).map((e) => ({
    id: e.id,
    name: e.name,
    romCount: e.romCount,
    hiddenCount: e.hiddenCount,
    category: e.category,
    rbfPaths: [...e.rbfPaths],
    gamesDirExists: e.gamesDirExists,
    gamesDirHidden: e.gamesDirHidden,
    gamesDirName: e.gamesDirName,
  }));

  // Dedupe by lowercase id. Real MiSTers carry case-mismatched siblings —
  // e.g. `_Computer/.Apogee_*.rbf` next to `games/.APOGEE`. Both refer to
  // the same logical core; we collapse them and remember the on-disk
  // `gamesDirName` so renames target the correct path.
  const all = dedupeByLowercaseId(allRaw);

  // Collapse arcade into a single placeholder row. Arcade is out of scope
  // for the hide feature (per AGENTS.md), but users still expect to see
  // "Arcade" in the cores list. The placeholder is emitted whenever the
  // device has an `_Arcade/` directory at all — most real MiSTers populate
  // it with `.mra` files, not `.rbf` / `.mgl`, so we can't infer presence
  // from the rbfs list.
  const nonArcade = all.filter((c) => c.category !== 'Arcade');
  const arcadeFromRbfs = all.some((c) => c.category === 'Arcade');
  if (input.arcadeDirExists === true || arcadeFromRbfs) {
    nonArcade.push({
      id: ARCADE_PLACEHOLDER_ID,
      name: 'Arcade',
      romCount: 0,
      hiddenCount: 0,
      category: 'Arcade',
      rbfPaths: [],
      gamesDirExists: false,
      gamesDirHidden: false,
    });
  }

  nonArcade.sort((a, b) => a.id.localeCompare(b.id, 'en-US', { sensitivity: 'base' }));
  return nonArcade;
}

export function isArcadePlaceholder(core: CoreEntry): boolean {
  return core.id === ARCADE_PLACEHOLDER_ID;
}

/**
 * Collapse case-duplicate CoreEntries (e.g. `Apogee` from a `.rbf` and
 * `APOGEE` from a games dir) into one logical entry per lowercase id.
 *
 * Rules (from the closeout spec):
 *   - One visible + (any number of) hidden → the visible one wins. Fields
 *     from the hidden sibling that the visible one lacks are merged in
 *     (notably `gamesDirName` for the case-mismatch case).
 *   - Multiple visible (rare) → canonical one wins. We pick the entry
 *     that has a games dir over one that doesn't, then tie-break
 *     alphabetically. Same merge.
 *   - Multiple hidden (no visible) → MiSTer's leftover internal state.
 *     Drop the entire group.
 *   - Single entry → keep as-is.
 *
 * The result preserves operational paths: `gamesDirName` is the exact
 * on-disk basename of the games dir (preserving its case), `rbfPaths`
 * are the exact on-disk paths from the rbf entries.
 */
function dedupeByLowercaseId(entries: readonly CoreEntry[]): CoreEntry[] {
  const groups = new Map<string, CoreEntry[]>();
  for (const e of entries) {
    if (e.category === 'Arcade') {
      // Arcade entries are collapsed downstream into the placeholder;
      // skip the case-dedupe step for them.
      const key = `__arcade__:${e.id}`;
      const existing = groups.get(key);
      if (existing) existing.push(e);
      else groups.set(key, [e]);
      continue;
    }
    const key = e.id.toLowerCase();
    const existing = groups.get(key);
    if (existing) existing.push(e);
    else groups.set(key, [e]);
  }

  const out: CoreEntry[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]!);
      continue;
    }

    const visible = group.filter((c) => !isCoreHidden(c));

    if (visible.length === 0) {
      // All siblings are hidden. Per spec, treat as MiSTer leftover and
      // drop the whole group.
      continue;
    }

    // Pick a winner from the visible side: prefer one that has a games
    // dir (more useful), then alphabetical first.
    const sorted = [...visible].sort((a, b) => {
      if (a.gamesDirExists !== b.gamesDirExists) {
        return a.gamesDirExists ? -1 : 1;
      }
      return a.id.localeCompare(b.id, 'en-US');
    });
    const winner = sorted[0]!;
    const losers = group.filter((c) => c !== winner);
    out.push(mergeAliases(winner, losers));
  }

  return out;
}

/**
 * Merge fields from `losers` (case-duplicate siblings) into `winner` so
 * operations on the winner reach the right paths. `gamesDirName` from
 * the loser is preserved when the winner doesn't have a games dir of
 * its own; `rbfPaths` are unioned (de-duplicated by string equality).
 */
function mergeAliases(winner: CoreEntry, losers: readonly CoreEntry[]): CoreEntry {
  let gamesDirExists = winner.gamesDirExists;
  let gamesDirHidden = winner.gamesDirHidden;
  let gamesDirName = winner.gamesDirName;
  let romCount = winner.romCount;
  let hiddenCount = winner.hiddenCount;
  const rbfPaths = [...winner.rbfPaths];

  for (const loser of losers) {
    for (const p of loser.rbfPaths) {
      if (!rbfPaths.includes(p)) rbfPaths.push(p);
    }
    if (!gamesDirExists && loser.gamesDirExists) {
      gamesDirExists = true;
      gamesDirHidden = loser.gamesDirHidden;
      gamesDirName = loser.gamesDirName;
      romCount = loser.romCount;
      hiddenCount = loser.hiddenCount;
    }
  }

  return {
    ...winner,
    rbfPaths,
    gamesDirExists,
    gamesDirHidden,
    gamesDirName,
    romCount,
    hiddenCount,
  };
}

/**
 * Single source of truth for "is this a core the app may operate on?".
 *
 * Used by every code path that mutates state — single hide/show, bulk
 * hide/show, "Hide empty cores", "Show all hidden", auto-reapply on
 * connect — so a user-created organisational folder under a category
 * dir (e.g. `_Console/_hidden`, `_Arcade/_Organized`) can never slip
 * through to an `mv` command. Defense-in-depth on top of the matcher's
 * enumeration filter.
 *
 * A CoreEntry is a real core iff it has at least one `.rbf`/`.mgl`
 * (file or folder-shaped) OR a games directory. The synthetic Arcade
 * placeholder is never a real core; arcade is out of scope until a
 * later release.
 */
export function isRealCore(entry: CoreEntry): boolean {
  if (entry.category === 'Arcade') return false;
  return entry.rbfPaths.length > 0 || entry.gamesDirExists;
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
    // Use the on-disk basename when known so case-mismatched siblings
    // (e.g. games/.APOGEE while id is 'Apogee') still target the right
    // path. Falls back to the id when gamesDirName isn't populated
    // (legacy callers / synthetic test entries).
    const baseName = core.gamesDirName ?? core.id;
    const visibleDir = `${MISTER_GAMES_DIR}/${baseName}`;
    const hiddenDir = `${MISTER_GAMES_DIR}/.${baseName}`;
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
