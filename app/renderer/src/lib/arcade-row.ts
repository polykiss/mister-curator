import {
  ARCADE_VIRTUAL_CORE_ID,
  type ArcadeMraEntry,
} from '@shared/arcade-mra';
import type { Rom } from '@shared/types';

/**
 * feat/arcade-parity-3-ui — pure helpers for adapting ArcadeMraEntry
 * into the Rom shape the shared RomMetadataCells + rom-sort code
 * consumes. Lives outside arcade-adapter.tsx so the unit test imports
 * it without dragging the renderer's React graph along.
 */

export function stripMraExtension(name: string): string {
  return name.toLowerCase().endsWith('.mra')
    ? name.slice(0, -'.mra'.length)
    : name;
}

/**
 * Synthesise a Rom-shape from an ArcadeMraEntry so the row can flow
 * through the same RomMetadataCells primitives + rom-sort comparators
 * RomsPane uses.
 *
 * Decisions:
 *   • `coreId = ARCADE_VIRTUAL_CORE_ID` — disambiguates the virtual
 *     arcade context from any real core when downstream code branches
 *     on coreId.
 *   • `filename = relativePath` — bijective with the entry, so a
 *     `Map<filename, entry>` round-trips after sort.
 *   • `displayName` strips `.mra` for mras so the title reads cleanly;
 *     subfolder entries keep their displayName as-is.
 *   • `kind = 'file'` for mras and `'folder-container'` for
 *     subfolders. The latter pins to the top of the sort via
 *     `isPinnedRow` in `rom-sort.ts`, matching RomsPane's container-
 *     folder behavior.
 *   • `sizeBytes = entry.primaryZipSizeBytes ?? 0`. feat/arcade-polish-
 *     context-menu plumbed the primary zip's on-disk size through from
 *     the playability scan. Mras with a stat'd primary zip drive the
 *     DensityBar the same way ROM rows do; .mras whose primary zip is
 *     missing/noRomsNeeded / subfolder rows get 0, rendering an empty
 *     bar (matching how ROMs with unknown size render).
 *   • `path` is a best-effort visualisation of the on-device path;
 *     not used for navigation in this PR but populated for coherence
 *     with downstream diagnostics that log `rom.path`.
 */
export function makeArcadeRom(entry: ArcadeMraEntry): Rom {
  const isMra = entry.kind === 'mra';
  const displayName = isMra
    ? stripMraExtension(entry.displayName)
    : entry.displayName;
  return {
    coreId: ARCADE_VIRTUAL_CORE_ID,
    filename: entry.relativePath,
    displayName,
    sizeBytes: isMra ? (entry.primaryZipSizeBytes ?? 0) : 0,
    hidden: entry.hidden,
    path: `/media/fat/_Arcade/${entry.relativePath}`,
    kind: isMra ? 'file' : 'folder-container',
  };
}

/**
 * Filter ArcadeMraEntry list to those at the current drill depth.
 * A row qualifies when its relativePath starts with `<subPath>/` AND
 * the remaining path has no further slash. Top-level entries qualify
 * at the root (subPath = '').
 *
 * Visibility filter (`includeHidden`):
 *   • Hidden mras and hidden subfolders at the current depth are
 *     dropped when `includeHidden=false` (covers both user-hidden and
 *     auto-hidden mras — both result in a dot-prefixed file, which
 *     `parseArcadeMraEntries` translates into `entry.hidden = true`).
 *   • The recursive non-empty-folder check applies the SAME predicate
 *     and only descends through drill-reachable subfolder entries:
 *     a folder is kept iff `entriesAtDepth(folder, includeHidden)`
 *     would itself return something. This is the "two paths can't
 *     disagree" rule: if drilling shows zero rows, the parent row
 *     also shouldn't surface as a drill target.
 *   • mra rows themselves are not filtered further by the adapter
 *     after this — the eye toggle path operates on individual mras
 *     independently of this listing.
 */
export function entriesAtDepth(
  entries: readonly ArcadeMraEntry[],
  subPath: string,
  includeHidden: boolean,
): readonly ArcadeMraEntry[] {
  const prefix = subPath === '' ? '' : `${subPath}/`;
  const atDepth = entries.filter((e) => {
    if (!e.relativePath.startsWith(prefix)) return false;
    const rest = e.relativePath.slice(prefix.length);
    if (rest === '') return false;
    if (rest.includes('/')) return false;
    if (!includeHidden && e.hidden) return false;
    return true;
  });
  return atDepth.filter((e) => {
    if (e.kind === 'mra') return true;
    return subfolderHasAnyVisibleContent(entries, e.relativePath, includeHidden);
  });
}

/**
 * True iff drilling into `folderRelPath` would surface at least one
 * row under the same visibility filter the drill render applies.
 *
 * Recursion mirrors what the renderer can actually reach:
 *   • Direct-child visible mra at `folderRelPath/x.mra` → true.
 *   • Direct-child visible subfolder at `folderRelPath/sub/` that
 *     itself satisfies this check → true (drilling into the parent
 *     surfaces the subfolder as a clickable row).
 *
 * Mras nested two levels deep without an intermediate subfolder
 * entry (e.g. `_alternatives/X/Game.mra` when `_alternatives/X` isn't
 * in the listing) are NOT counted — the renderer can't reach them
 * from the parent folder, so treating their existence as "this folder
 * has content" would resurface the bug this function is meant to
 * fix: a row that drills into an empty list.
 *
 * For a typical `_Arcade/` (~thousands of mras, a handful of
 * subfolders per level) the recursion bottoms out quickly; keeping
 * the function pure + indexless keeps it test-friendly.
 */
function subfolderHasAnyVisibleContent(
  entries: readonly ArcadeMraEntry[],
  folderRelPath: string,
  includeHidden: boolean,
): boolean {
  const folderPrefix = `${folderRelPath}/`;
  for (const e of entries) {
    if (!e.relativePath.startsWith(folderPrefix)) continue;
    const rest = e.relativePath.slice(folderPrefix.length);
    if (rest === '') continue;
    if (rest.includes('/')) continue;
    if (!includeHidden && e.hidden) continue;
    if (e.kind === 'mra') return true;
    if (subfolderHasAnyVisibleContent(entries, e.relativePath, includeHidden)) {
      return true;
    }
  }
  return false;
}
