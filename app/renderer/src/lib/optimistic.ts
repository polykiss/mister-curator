import { MISTER_GAMES_DIR } from '@shared/constants';
import type { Core, Rom } from '@shared/types';

export interface VisibilityChange {
  readonly filename: string;
  readonly hidden: boolean;
}

/**
 * Apply a single visibility change to the ROM list, returning a NEW array.
 * The change updates the row's `filename`, `hidden`, `displayName`, and `path`
 * fields to match the post-rename state. If the file is already in the
 * desired state (or isn't found), the original list is returned unchanged.
 */
export function applyVisibilityChange(roms: readonly Rom[], change: VisibilityChange): Rom[] {
  let changed = false;
  const next = roms.map((rom) => {
    if (rom.filename !== change.filename) return rom;
    const visibleName = rom.filename.startsWith('.')
      ? rom.filename.slice(1)
      : rom.filename;
    const targetName = change.hidden ? `.${visibleName}` : visibleName;
    if (targetName === rom.filename) return rom;
    changed = true;
    return {
      ...rom,
      filename: targetName,
      displayName: visibleName,
      hidden: change.hidden,
      path: `${MISTER_GAMES_DIR}/${rom.coreId}/${targetName}`,
    };
  });
  return changed ? next : [...roms];
}

/**
 * Apply many visibility changes at once. Each change is applied to the
 * accumulated list, so rows renamed by one change can still be referenced by
 * later changes (though typically each change targets a different file).
 */
export function applyBulkVisibilityChange(
  roms: readonly Rom[],
  changes: readonly VisibilityChange[],
): Rom[] {
  let next: Rom[] = [...roms];
  for (const change of changes) {
    next = applyVisibilityChange(next, change);
  }
  return next;
}

/**
 * Recompute the parent core's romCount and hiddenCount from the current ROM
 * list. Used to keep the left-pane counts in sync after a visibility change
 * without a full server refetch.
 */
export function recountCore(core: Core, roms: readonly Rom[]): Core {
  let hiddenCount = 0;
  for (const rom of roms) {
    if (rom.hidden) hiddenCount += 1;
  }
  return { ...core, romCount: roms.length, hiddenCount };
}
