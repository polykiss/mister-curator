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
 * Phase 2 (arcade-parity-3-ui follow-up): subfolder entries are
 * suppressed when their subtree contains zero `.mra` files. The
 * arcade adapter only renders mra-driven rows, so a subfolder with
 * no mras anywhere below it (the live `cores/` directory full of
 * `.rbf` core binaries, or a user folder the user emptied) is a
 * dead-end drill target — surfacing it as a row that opens an
 * empty list is purely confusing. mra rows themselves are never
 * filtered here; the user-facing hide/unhide path stays alone.
 */
export function entriesAtDepth(
  entries: readonly ArcadeMraEntry[],
  subPath: string,
): readonly ArcadeMraEntry[] {
  const prefix = subPath === '' ? '' : `${subPath}/`;
  const atDepth = entries.filter((e) => {
    if (!e.relativePath.startsWith(prefix)) return false;
    const rest = e.relativePath.slice(prefix.length);
    if (rest === '') return false;
    return !rest.includes('/');
  });
  return atDepth.filter((e) => {
    if (e.kind === 'mra') return true;
    return subfolderHasAnyMra(entries, e.relativePath);
  });
}

/**
 * True iff `entries` contains at least one `kind === 'mra'` row
 * whose relativePath sits anywhere under `folderRelPath/`. Scans
 * the whole list rather than threading a precomputed index — for
 * a typical `_Arcade/` (~thousands of mras, a handful of folders
 * at each depth) the cost is negligible and keeping the function
 * pure + indexless makes it easy to test.
 */
function subfolderHasAnyMra(
  entries: readonly ArcadeMraEntry[],
  folderRelPath: string,
): boolean {
  const folderPrefix = `${folderRelPath}/`;
  for (const e of entries) {
    if (e.kind !== 'mra') continue;
    if (e.relativePath.startsWith(folderPrefix)) return true;
  }
  return false;
}
