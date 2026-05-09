import { MISTER_GAMES_DIR } from '@shared/constants';
import { emit, type DiagnosticsCollector } from '@shared/diag';
import { classifyFolder, isLaunchableRomExtension } from '@shared/folder-rom';
import {
  isAutoDetectedSystemFile,
  isAutoDetectedSystemFolder,
  shouldCountAsRom,
} from '@shared/system-files';
import { isMarked } from '@shared/system-files-marks';
import type {
  CoreCategory,
  CoreEntry,
  HideLedger,
  SystemFilesMarks,
} from '@shared/types';

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
 * Reduce a name (rbf prefix or games-dir basename) to its canonical
 * form by lowercasing and stripping every non-alphanumeric character.
 * This is what the matcher uses as the key when joining rbfs to games
 * dirs — `"Atari 2600"`, `"Atari2600"`, and `".Atari 2600.mgl"` (after
 * extractCorePrefix) all canonicalise to `"atari2600"` and merge into
 * one CoreEntry.
 *
 * Examples:
 *   "Atari 2600"               -> "atari2600"
 *   "Atari2600"                -> "atari2600"   (matches above)
 *   "Game Gear"                -> "gamegear"
 *   "GameGear"                 -> "gamegear"    (matches above)
 *   "Pocket Challenge V2"      -> "pocketchallengev2"
 *   "Mega Duck"                -> "megaduck"
 *   "Sord M5"                  -> "sordm5"
 *   "Super_Vision_8000"        -> "supervision8000"
 *   "WonderSwan Color"         -> "wonderswancolor"
 *   "TI-99_4A"                 -> "ti994a"
 *   "GBC"                      -> "gbc"          (does NOT match
 *                                                  "GameboyColor"
 *                                                  -> "gameboycolor"
 *                                                  — synonyms are out
 *                                                  of scope; users can
 *                                                  consolidate manually)
 */
export function canonicalize(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Synthetic id used for the single placeholder row that represents the
 * Arcade category in the cores list. Real arcade core ids never use this
 * prefix (real ids come from filename parsing).
 */
/**
 * Render a user-facing label for a core. Default returns the coreId
 * verbatim. The override case maps `mame` → `Arcade` so the user's
 * actual MAME core surfaces in the sidebar under the friendlier
 * arcade label (since the v0.1 build deliberately stopped emitting
 * a separate `_Arcade/` placeholder row).
 *
 * Internal coreId stays unchanged — IPC calls (`listRoms`,
 * `prefetchRomsMetadata`, etc.), ledger entries, classification
 * overrides, and system-id resolution all key off the real
 * coreId. This helper is the single seam for a future user-
 * renaming feature; if that lands it'll plug in here, reading from
 * a per-profile rename map.
 */
export function coreDisplayName(coreId: string): string {
  if (coreId === 'mame') return 'Arcade';
  return coreId;
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
  /** Top-level files inside this games dir (basenames, may be dot-prefixed). */
  readonly files: readonly string[];
  /** Top-level subdirectories (basenames, may be dot-prefixed). */
  readonly dirs: readonly string[];
  /**
   * One level deeper than `dirs`: per top-level subfolder, the
   * immediate children plus pre-computed recursive file counts. The
   * matcher uses this to derive `recursiveRomCount` — atomic folders
   * (Saturn discs, MegaCD games) count as 1, container folders
   * (NEOGEO's `1 World A-Z`) contribute their `recursiveFileCount`.
   *
   * Optional: clients that don't supply it (e.g. legacy tests) yield a
   * matcher result whose `recursiveRomCount` mirrors `romCount`. The
   * cores list falls back to a single-number display in that case.
   */
  readonly subFolders?: readonly RawSubFolderInput[];
}

/**
 * One level deeper than the games-dir top level. Used by the matcher
 * to compute approximate recursive ROM counts for container-shaped
 * folders. The flag scan happens upstream — here we only need the raw
 * file/dir lists for `classifyFolder` plus the recursive totals.
 */
export interface RawSubFolderInput {
  /** Basename of the top-level subfolder, may be dot-prefixed. */
  readonly name: string;
  /** Immediate-child files inside this subfolder. */
  readonly files: readonly string[];
  /** Immediate-child dir basenames inside this subfolder. */
  readonly dirs: readonly string[];
  /**
   * Total file count beneath this subfolder, including all nested
   * subdirs. Used as the approximate ROM count for container folders.
   * For atomic folders (disc dumps) this is ignored — atomic always
   * counts as 1. When undefined the matcher falls back to immediate
   * file + dir count.
   */
  readonly recursiveFileCount?: number;
  /**
   * Recursive count of dot-prefixed files anywhere beneath this
   * subfolder. Used for the hidden subset of `recursiveRomCount`.
   */
  readonly recursiveHiddenFileCount?: number;
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
  /**
   * Optional user-marked system-files list. When supplied, files and
   * folders that the user has marked as system for a given core are
   * excluded from `romCount` / `hiddenCount` exactly like auto-detected
   * BIOSes. Auto-detection of folders is unchanged (Saturn-shape disc
   * folders are never auto-filtered); marks layer over both files and
   * folders.
   */
  readonly systemFilesMarks?: SystemFilesMarks;
  /**
   * Optional observer for the matcher's internal decisions. When set,
   * the matcher emits one record per rbf, games dir, system-file
   * filter check, recursive-count walk step, dedupe group, and final
   * core entry. The matcher's LOGIC is unchanged — diagnostics are
   * pure side-channel observation for PR #11. Off in production.
   */
  readonly diagnostics?: DiagnosticsCollector;
}

interface MutableCoreEntry {
  id: string;
  name: string;
  romCount: number;
  hiddenCount: number;
  recursiveRomCount: number;
  recursiveHiddenCount: number;
  category: CoreCategory;
  rbfPaths: string[];
  gamesDirExists: boolean;
  gamesDirHidden: boolean;
  gamesDirName?: string;
}

/**
 * Joins enumerated rbf entries (across all category dirs) with games-dir
 * entries to produce one CoreEntry per logical core. Pure function — all
 * filesystem I/O happens upstream.
 *
 * Joining rules (PR #11 round 2):
 *   - Both rbf prefix and games-dir basename are reduced to a canonical
 *     form via `canonicalize()` (lowercase + strip non-alphanumerics)
 *     and that form is the dedupe key. `"Atari 2600"`, `"Atari2600"`,
 *     and `"Atari-2600"` all canonicalise to `"atari2600"` and merge.
 *     This replaces the old "literal id, post-pass dedupe by lowercase"
 *     scheme that left `Atari 2600` and `Atari2600` as two phantom
 *     entries on the user's MiSTer.
 *   - When BOTH a games dir and an rbf exist for the same canonical
 *     key, the games-dir basename wins as the display id (Round 5
 *     spec: "named whichever the games dir was"). The rbf prefix's
 *     casing is forgotten; the operational `gamesDirName` already
 *     preserves the on-disk basename for renames.
 *   - Multiple rbfs with the same canonical key collapse to one
 *     CoreEntry with all paths in `rbfPaths` (older versions sitting
 *     alongside newer).
 *   - A games dir with no matching rbf produces a CoreEntry with
 *     `category: 'Unknown'` — kept ONLY when it has countable ROMs
 *     (orphan filter, Round 2 Change 4).
 *   - An rbf with no matching games dir produces a CoreEntry with
 *     `gamesDirExists: false` and `romCount: 0` — always kept; the
 *     core is still launchable from the MiSTer menu and the user
 *     might want to hide it.
 *   - When an rbf prefix collides across categories (rare in
 *     practice), the first-seen non-arcade category wins. Arcade
 *     cores stay as 'Arcade' so the UI can disable hide on them.
 *
 * `shouldCountAsRom` is the single source of truth for which entries
 * count toward `romCount` and `recursiveRomCount`. Both this matcher
 * AND `RealMisterClient.listRoms` call the same function so the two
 * paths can never disagree (the Vectrex/Overlays mystery from PR #11
 * round 1).
 */
export function matchRbfsToGamesDirs(input: MatchInput): CoreEntry[] {
  const diag = input.diagnostics;
  const marks = input.systemFilesMarks;
  const byKey = new Map<string, MutableCoreEntry>();

  for (const rbf of input.rbfs) {
    const prefix = extractCorePrefix(rbf.filename);
    emit(diag, {
      kind: 'rbf',
      category: rbf.category,
      type: rbf.isFolder ? 'dir' : 'file',
      filename: rbf.filename,
      fullPath: rbf.fullPath,
      extractedPrefix: prefix,
      hasLeadingDot: rbf.filename.startsWith('.'),
    });
    const key = canonicalize(prefix);
    if (prefix === '' || key === '') continue;

    const existing = byKey.get(key);
    if (existing) {
      if (!existing.rbfPaths.includes(rbf.fullPath)) {
        existing.rbfPaths.push(rbf.fullPath);
      }
      // Prefer non-arcade category if a later rbf gives us a better match.
      if (existing.category === 'Arcade' && rbf.category !== 'Arcade') {
        existing.category = rbf.category;
      }
    } else {
      byKey.set(key, {
        id: prefix,
        name: prefix,
        romCount: 0,
        hiddenCount: 0,
        recursiveRomCount: 0,
        recursiveHiddenCount: 0,
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
    emit(diag, {
      kind: 'games-dir',
      rawName: gd.rawName,
      visibleName,
      isHidden,
      fileCount: gd.files.length,
      dirCount: gd.dirs.length,
    });
    const key = canonicalize(visibleName);
    if (visibleName === '' || key === '') continue;

    // Single-source-of-truth filter: shouldCountAsRom decides whether
    // each top-level entry contributes to the cores-list count.
    // Same function listRoms uses, so the two paths can't drift apart.
    //
    // PR-B (PR #24): top-level FILES additionally require a
    // launchable ROM extension (.nes/.smc/.cue/...). The negative
    // shouldCountAsRom filter alone let .nfo / .pdf / .dat at the
    // top level inflate counts. Folders (filteredDirs below) keep
    // shouldCountAsRom-only — atomic-vs-container classification
    // happens later in computeRecursiveRomCount and decides
    // whether the folder contributes 1 (one game) or its filtered
    // recursive file count (NEOGEO-shape container).
    const filteredFiles = gd.files.filter((f) => {
      const passesSystemFilter = shouldCountAsRom({
        relPath: f,
        isDirectory: false,
        coreId: visibleName,
        marks,
      });
      const counted = passesSystemFilter && isLaunchableRomExtension(f);
      emit(diag, {
        kind: 'system-filter',
        coreId: visibleName,
        path: f,
        entryType: 'file',
        isAutoSystem: isAutoDetectedSystemFile({ filename: f, kind: 'file' }),
        isMarkedSystem: marks ? isMarked(marks, visibleName, f) : false,
        decision: counted ? 'kept' : 'filtered',
      });
      return counted;
    });
    const filteredDirs = gd.dirs.filter((d) => {
      const counted = shouldCountAsRom({
        relPath: d,
        isDirectory: true,
        coreId: visibleName,
        marks,
      });
      emit(diag, {
        kind: 'system-filter',
        coreId: visibleName,
        path: d,
        entryType: 'dir',
        isAutoSystem: isAutoDetectedSystemFolder(d),
        isMarkedSystem: marks ? isMarked(marks, visibleName, d) : false,
        decision: counted ? 'kept' : 'filtered',
      });
      return counted;
    });
    const romCount = filteredFiles.length + filteredDirs.length;
    const hiddenCount =
      filteredFiles.filter((f) => f.startsWith('.')).length +
      filteredDirs.filter((d) => d.startsWith('.')).length;

    const { recursiveRomCount, recursiveHiddenCount } = computeRecursiveRomCount(
      filteredFiles,
      filteredDirs,
      gd.subFolders,
      visibleName,
      diag,
    );

    const existing = byKey.get(key);
    if (existing) {
      existing.gamesDirExists = true;
      existing.gamesDirHidden = isHidden;
      existing.gamesDirName = visibleName;
      existing.romCount = romCount;
      existing.hiddenCount = hiddenCount;
      existing.recursiveRomCount = recursiveRomCount;
      existing.recursiveHiddenCount = recursiveHiddenCount;
      // Games-dir name wins as display id when both an rbf and a
      // games dir exist for the same canonical key — Round 5
      // spec: "named whichever the games dir was". The rbf prefix's
      // case (e.g. "Vectrex") is forgotten in favor of the on-disk
      // basename (e.g. "VECTREX"). Operations target gamesDirName.
      existing.id = visibleName;
      existing.name = visibleName;
    } else {
      byKey.set(key, {
        id: visibleName,
        name: visibleName,
        romCount,
        hiddenCount,
        recursiveRomCount,
        recursiveHiddenCount,
        category: 'Unknown',
        rbfPaths: [],
        gamesDirExists: true,
        gamesDirHidden: isHidden,
        gamesDirName: visibleName,
      });
    }
  }

  // Match-attempt records: one per canonical-key bucket, showing
  // how rbfs and games dirs lined up. `kept-singleton` = either a
  // rbf-only or a games-dir-only entry (no merge); `merged` = both
  // sides contributed.
  for (const [k, entry] of byKey.entries()) {
    const hasRbf = entry.rbfPaths.length > 0;
    const hasGamesDir = entry.gamesDirExists;
    const groupIds = [
      ...entry.rbfPaths.map((p) => extractCorePrefix(pathBasename(p))),
      ...(hasGamesDir && entry.gamesDirName ? [entry.gamesDirName] : []),
    ];
    const dedupedGroupIds = Array.from(new Set(groupIds));
    emit(diag, {
      kind: 'match-attempt',
      key: entry.id,
      lowerKey: k,
      groupSize: dedupedGroupIds.length,
      groupIds: dedupedGroupIds,
      outcome:
        hasRbf && hasGamesDir
          ? 'merged'
          : 'kept-singleton',
      winnerId: hasRbf && hasGamesDir ? entry.id : undefined,
    });
  }

  // Hard invariant (PR #11 round 3 / Bug 1): every CoreEntry's `id`
  // MUST be the on-disk games-dir basename when a games dir exists,
  // and MUST be the rbf prefix otherwise. Operational paths
  // (`listRoms`, `setRomVisibility`, `hideCore`) join `<coreId>` to
  // the games-dir prefix; if `id` drifts from the on-disk basename,
  // those paths target a non-existent directory and silently return
  // empty.
  //
  // The games-dir loop already overrides `id = visibleName` whenever
  // it processes a games dir, but defensive enforcement here makes
  // the invariant unconditional and survives future edits to either
  // loop. The rbf-only branch has nothing to enforce — `id = prefix`
  // is set at insertion and never reassigned.
  for (const e of byKey.values()) {
    if (e.gamesDirExists && e.gamesDirName !== undefined) {
      e.id = e.gamesDirName;
      e.name = e.gamesDirName;
    }
  }

  const allRaw: CoreEntry[] = Array.from(byKey.values()).map((e) => ({
    id: e.id,
    name: e.name,
    romCount: e.romCount,
    hiddenCount: e.hiddenCount,
    recursiveRomCount: e.recursiveRomCount,
    recursiveHiddenCount: e.recursiveHiddenCount,
    category: e.category,
    rbfPaths: [...e.rbfPaths],
    gamesDirExists: e.gamesDirExists,
    gamesDirHidden: e.gamesDirHidden,
    gamesDirName: e.gamesDirName,
  }));

  // Orphan filter (Round 2 Change 4): a games-dir-only core (no
  // matching rbf) is kept only when it has countable ROMs after the
  // shouldCountAsRom filter. Real-MiSTer cleanup: drops stale empty
  // leftovers like `games/Adam/`, `games/PC8801/` that have no
  // installed content and would otherwise show up as `0`-count rows.
  // Cores with at least one rbf are ALWAYS kept (they're launchable
  // from the MiSTer menu, hide-able through this app).
  const filtered = allRaw.filter((c) => {
    if (c.category === 'Arcade') return true;
    if (c.rbfPaths.length > 0) return true;
    if (!c.gamesDirExists) return false;
    const recursive = c.recursiveRomCount ?? c.romCount;
    return c.romCount > 0 && recursive > 0;
  });

  // PR-A item 1: drop the synthetic Arcade placeholder. The v0.1
  // build ships with the actual `mame` core surfacing as "Arcade" in
  // the sidebar (via `coreDisplayName`), so the placeholder row is
  // redundant noise. The `_Arcade/` directory's `.mra` files stay
  // visible to the MiSTer firmware unchanged — this app simply
  // doesn't enumerate them.
  //
  // `arcadeDirExists` stays on `MatchInput` (it's still computed by
  // the device-scan layer) but the matcher no longer reads it.
  const nonArcade = filtered.filter((c) => c.category !== 'Arcade');

  // Sort by display label so any rename via `coreDisplayName` (today
  // just `mame` → `Arcade`) lands in its alphabetical slot rather
  // than the coreId's. Stable across the rest of the list — no other
  // overrides apply.
  nonArcade.sort((a, b) =>
    coreDisplayName(a.id).localeCompare(coreDisplayName(b.id), 'en-US', {
      sensitivity: 'base',
    }),
  );

  for (const c of nonArcade) {
    const hasAnyVisibleRbf = c.rbfPaths.some(
      (p) => !pathBasename(p).startsWith('.'),
    );
    emit(diag, {
      kind: 'core-entry',
      coreId: c.id,
      name: c.name,
      category: c.category,
      romCount: c.romCount,
      hiddenCount: c.hiddenCount,
      recursiveRomCount: c.recursiveRomCount,
      recursiveHiddenCount: c.recursiveHiddenCount,
      gamesDirExists: c.gamesDirExists,
      gamesDirHidden: c.gamesDirHidden,
      gamesDirName: c.gamesDirName,
      hasAnyVisibleRbf,
      rbfPaths: c.rbfPaths,
    });
  }

  return nonArcade;
}

/**
 * Single source of truth for "is this a core the app may operate on?".
 *
 * Used by every code path that mutates state — single hide/show, bulk
 * hide/show, "Hide empty cores", "Unhide all", auto-reapply on
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
 * Apply a hide / unhide to a single CoreEntry, returning a NEW entry
 * that matches the post-rename state. Both rbf paths and the
 * games-dir flag flip — `isCoreHidden` reads from either side, so a
 * row's visual state only switches cleanly when both are updated
 * together.
 *
 * Used by the renderer's optimistic update path AND by
 * ConnectionManager's in-memory `coresCache` so a subsequent
 * `lookupCore` after a hide doesn't return stale rbfPaths to the
 * client (which would compute the wrong rename targets).
 */
export function applyCoreVisibilityChange(
  core: CoreEntry,
  hidden: boolean,
): CoreEntry {
  const targetRbfPaths = core.rbfPaths.map((p) => {
    const slash = p.lastIndexOf('/');
    const dir = slash < 0 ? '' : p.slice(0, slash);
    const base = slash < 0 ? p : p.slice(slash + 1);
    const undotted = base.startsWith('.') ? base.slice(1) : base;
    const target = hidden ? `.${undotted}` : undotted;
    return dir === '' ? target : `${dir}/${target}`;
  });
  return {
    ...core,
    rbfPaths: targetRbfPaths,
    gamesDirHidden: core.gamesDirExists ? hidden : core.gamesDirHidden,
  };
}

/**
 * True iff the core reads as hidden in the cores list — either its
 * games directory is dot-prefixed, OR any of its rbf/mgl files are.
 *
 * Round 5 simplified the model to two states: hidden or visible. Our
 * own hide flow renames both sides atomically so they always agree;
 * the asymmetric cases (rbf visible + games dir hidden, or vice
 * versa, all dating to MiSTer setups predating this app) read as
 * hidden so the user can act on them with a single Unhide click.
 *
 * Synthetic placeholder rows (no rbfs and no games dir — only the
 * Arcade placeholder) are NOT hidden; the cores list has its own
 * placeholder rendering path that doesn't depend on this signal.
 */
export function isCoreHidden(core: CoreEntry): boolean {
  if (core.rbfPaths.length === 0 && !core.gamesDirExists) return false;
  const hasHiddenRbf = core.rbfPaths.some((p) => pathBasename(p).startsWith('.'));
  const hasHiddenGamesDir = core.gamesDirExists && core.gamesDirHidden;
  return hasHiddenRbf || hasHiddenGamesDir;
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
 * Approximates the total ROM count for a games dir, walking into
 * container folders and treating atomic disc folders as a single ROM.
 *
 * Rules (matches the Round 3 spec):
 *   - Non-system top-level files: each counts 1.
 *   - Non-system top-level folders, classified via `classifyFolder`:
 *       atomic / unknown → 1 (the folder is the unit; Saturn discs,
 *         MegaCD games, single-medium folders).
 *       container         → walk inside; sum the recursive file count
 *         the client computed (`recursiveFileCount`). Auto-detected
 *         system files NESTED inside containers are NOT excluded —
 *         the recursive count is intentionally cheap. The "~" in the
 *         display covers this approximation.
 *   - When `subFolders` is undefined (legacy callers, simple unit
 *     tests), the function falls back to the top-level count so the
 *     matcher still produces a number rather than `undefined`.
 *
 * Hidden subset: dot-prefixed top-level files contribute to
 * `recursiveHiddenCount` directly; for container folders, the
 * client's `recursiveHiddenFileCount` is added.
 */
function computeRecursiveRomCount(
  topLevelFiles: readonly string[],
  topLevelDirs: readonly string[],
  subFolders: readonly RawSubFolderInput[] | undefined,
  coreId: string,
  diag: DiagnosticsCollector | undefined,
): { recursiveRomCount: number; recursiveHiddenCount: number } {
  let total = 0;
  let totalHidden = 0;

  for (const f of topLevelFiles) {
    total += 1;
    const hidden = f.startsWith('.') ? 1 : 0;
    if (hidden) totalHidden += 1;
    emit(diag, {
      kind: 'recursive-count',
      coreId,
      topLevelEntry: f,
      entryType: 'file',
      contributesCount: 1,
      contributesHiddenCount: hidden,
      reason: 'top-level file counts as 1',
    });
  }

  if (!subFolders) {
    // No deep info — treat each top-level dir as 1 (the matcher's
    // pre-Round-3 behavior). Keeps legacy unit tests passing.
    for (const d of topLevelDirs) {
      total += 1;
      const hidden = d.startsWith('.') ? 1 : 0;
      if (hidden) totalHidden += 1;
      emit(diag, {
        kind: 'recursive-count',
        coreId,
        topLevelEntry: d,
        entryType: 'folder',
        classification: 'no-info',
        contributesCount: 1,
        contributesHiddenCount: hidden,
        reason: 'no subFolders payload — fall back to atomic (1)',
      });
    }
    return { recursiveRomCount: total, recursiveHiddenCount: totalHidden };
  }

  const subByName = new Map(subFolders.map((s) => [s.name, s]));
  for (const d of topLevelDirs) {
    const sub = subByName.get(d);
    const dirIsHidden = d.startsWith('.');
    if (!sub) {
      // Subfolder info missing — fall back to atomic (1).
      total += 1;
      const hidden = dirIsHidden ? 1 : 0;
      if (dirIsHidden) totalHidden += 1;
      emit(diag, {
        kind: 'recursive-count',
        coreId,
        topLevelEntry: d,
        entryType: 'folder',
        classification: 'no-info',
        contributesCount: 1,
        contributesHiddenCount: hidden,
        reason: 'subFolder bucket missing — fall back to atomic (1)',
      });
      continue;
    }
    // Classify using just this subfolder's immediate contents — the
    // same `classifyFolder` heuristic the renderer uses for the drill-
    // in decision, so the cores-list count and the ROMs-list view stay
    // aligned. `unknown` collapses to `atomic` here too.
    const classification = classifyFolder({ files: sub.files, dirs: sub.dirs });
    if (classification === 'container') {
      // Container folder: contribute the recursive file count. Falls
      // back to immediate file + dir count when the client didn't
      // supply a precomputed total.
      //
      // PR-B (PR #24): the fallback now filters `sub.files` by
      // `isLaunchableRomExtension` so it stays in sync with the
      // F-line aggregation upstream (which applies the same filter).
      // Without this, a subfolder whose F-lines all got filtered
      // out (.png-only ScreenShots/, .ips-only Hacks/) would report
      // `recursiveFileCount === undefined`, the fallback would fire,
      // and the unfiltered SE-line `files.length` would re-introduce
      // the inflation. `dirs.length` is kept unfiltered — every dir
      // is still treated as a contributing entry (1 ROM each via the
      // atomic-vs-container heuristic when its turn comes around).
      const recursive =
        sub.recursiveFileCount ??
        sub.files.filter(isLaunchableRomExtension).length + sub.dirs.length;
      const recursiveHidden = sub.recursiveHiddenFileCount ?? 0;
      total += recursive;
      let hiddenContribution: number;
      let reason: string;
      if (dirIsHidden) {
        // The whole container is hidden — every ROM under it is
        // effectively hidden too.
        totalHidden += recursive;
        hiddenContribution = recursive;
        reason =
          'container; whole subfolder dot-prefixed → all recursive files hidden';
      } else {
        totalHidden += recursiveHidden;
        hiddenContribution = recursiveHidden;
        reason = 'container; recursive file count from subFolder.recursiveFileCount';
      }
      emit(diag, {
        kind: 'recursive-count',
        coreId,
        topLevelEntry: d,
        entryType: 'folder',
        classification: 'container',
        contributesCount: recursive,
        contributesHiddenCount: hiddenContribution,
        reason,
      });
    } else {
      // Atomic or unknown — folder IS one ROM.
      total += 1;
      const hidden = dirIsHidden ? 1 : 0;
      if (dirIsHidden) totalHidden += 1;
      emit(diag, {
        kind: 'recursive-count',
        coreId,
        topLevelEntry: d,
        entryType: 'folder',
        classification,
        contributesCount: 1,
        contributesHiddenCount: hidden,
        reason: `${classification} folder counts as 1`,
      });
    }
  }

  return { recursiveRomCount: total, recursiveHiddenCount: totalHidden };
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
