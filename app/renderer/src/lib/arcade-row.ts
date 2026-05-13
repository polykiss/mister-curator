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
 *   • `sizeBytes = 0` — arcade .mras have no meaningful per-row size;
 *     DensityBar renders an empty strip and the eye toggle stays
 *     interactive.
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
    sizeBytes: 0,
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
 *     dropped when `includeHidden=false`.
 *   • The recursive non-empty-folder check uses the SAME filter —
 *     a subfolder whose subtree contains only hidden mras is dropped
 *     when `includeHidden=false` so the user doesn't see a folder
 *     that opens to an empty list. Flipping the "Show hidden" toggle
 *     surfaces those folders again.
 *   • mra rows themselves are still rendered/hidden by the adapter's
 *     visibility code; the suppression here is folder-only (the
 *     direct mras handle hide/show via the existing eye toggle path).
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
    return subfolderHasAnyVisibleMra(entries, e.relativePath, includeHidden);
  });
}

/**
 * True iff `entries` contains at least one visible `kind === 'mra'`
 * row whose relativePath sits anywhere under `folderRelPath/`.
 * "Visible" obeys `includeHidden`: when false, hidden mras are
 * skipped so a folder containing only hidden mras counts as empty.
 *
 * Scans the whole list rather than threading a precomputed index —
 * for a typical `_Arcade/` (~thousands of mras, a handful of folders
 * at each depth) the cost is negligible and keeping the function
 * pure + indexless makes it easy to test.
 */
function subfolderHasAnyVisibleMra(
  entries: readonly ArcadeMraEntry[],
  folderRelPath: string,
  includeHidden: boolean,
): boolean {
  const folderPrefix = `${folderRelPath}/`;
  for (const e of entries) {
    if (e.kind !== 'mra') continue;
    if (!e.relativePath.startsWith(folderPrefix)) continue;
    if (!includeHidden && e.hidden) continue;
    return true;
  }
  return false;
}
