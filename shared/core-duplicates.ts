import { MISTER_GAMES_DIR } from '@shared/constants';
import { extractCorePrefix } from '@shared/core-matching';
import type { CoreEntry, DuplicatePair } from '@shared/types';

/**
 * feat/duplicate-detect-and-restore (#40) — scan the already-loaded
 * CoreEntry list for pairs where both a dotted (hidden) and an undotted
 * (visible) form of the same file exist simultaneously.
 *
 * Pure local iteration — zero SSH calls. Reuses the `rbfPaths` array
 * populated by `matchRbfsToGamesDirs`, which already contains both forms
 * when both are present on device (the matcher deduplicates by full path,
 * not by canonical basename).
 *
 * Two pair kinds:
 *   - 'rbf'      — both `.CoreName_YYYYMMDD.rbf` and `CoreName_YYYYMMDD.rbf`
 *                  exist in the same category directory.
 *   - 'gamesDir' — both `games/CoreName` and `games/.CoreName` exist,
 *                  detected via `CoreEntry.gamesDirDuplicate` (set by
 *                  `matchRbfsToGamesDirs` when the same canonical games-dir
 *                  key is seen twice).
 */
export function detectCoreDuplicates(cores: readonly CoreEntry[]): DuplicatePair[] {
  const pairs: DuplicatePair[] = [];

  for (const core of cores) {
    // ── rbf pairs ──────────────────────────────────────────────────
    // Group rbfPaths by the undotted canonical basename of the *file*
    // portion (e.g. `NES_20240115.rbf` → canonical `nes`). When the
    // same canonical has both a dotted and an undotted path, emit a pair.
    const byCanonical = new Map<string, { dotted?: string; undotted?: string }>();

    for (const fullPath of core.rbfPaths) {
      const basename = fullPath.slice(fullPath.lastIndexOf('/') + 1);
      const isDotted = basename.startsWith('.');
      const undottedBasename = isDotted ? basename.slice(1) : basename;
      const canonical = extractCorePrefix(undottedBasename);
      if (canonical === '') continue;

      const entry = byCanonical.get(canonical) ?? {};
      if (isDotted) {
        entry.dotted = fullPath;
      } else {
        entry.undotted = fullPath;
      }
      byCanonical.set(canonical, entry);
    }

    for (const entry of byCanonical.values()) {
      if (entry.dotted !== undefined && entry.undotted !== undefined) {
        pairs.push({
          coreId: core.id,
          coreName: core.name,
          visiblePath: entry.undotted,
          hiddenPath: entry.dotted,
          kind: 'rbf',
        });
      }
    }

    // ── gamesDir pairs ─────────────────────────────────────────────
    if (core.gamesDirDuplicate === true && core.gamesDirName !== undefined) {
      pairs.push({
        coreId: core.id,
        coreName: core.name,
        visiblePath: `${MISTER_GAMES_DIR}/${core.gamesDirName}`,
        hiddenPath: `${MISTER_GAMES_DIR}/.${core.gamesDirName}`,
        kind: 'gamesDir',
      });
    }
  }

  return pairs;
}
