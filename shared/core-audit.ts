import type { CoreEntry } from '@shared/types';

export interface CoreAuditResult {
  readonly missingCoreFile: readonly CoreEntry[];
  readonly noRomsForCore: readonly CoreEntry[];
}

/**
 * feature/core-audit (#38) — scan the already-loaded CoreEntry list for two
 * categories of mismatch between installed cores and ROM directories:
 *
 *   missingCoreFile — a games dir exists (with ROMs) but no .rbf is installed.
 *                     The user has ROMs but the core can't launch them.
 *                     Suggested fix: run update_all.sh on the MiSTer.
 *
 *   noRomsForCore   — a .rbf is installed but no games dir exists.
 *                     The core clutters the MiSTer menu without anything to play.
 *                     Suggested fix: add ROMs or hide the core.
 *
 * Pure local iteration — zero SSH calls. Results re-derive automatically
 * whenever the caller's CoreEntry list changes (e.g. after hide/show or Refresh).
 */
export function auditCores(cores: readonly CoreEntry[]): CoreAuditResult {
  const missingCoreFile: CoreEntry[] = [];
  const noRomsForCore: CoreEntry[] = [];

  for (const core of cores) {
    // Arcade uses a different model (.mra files, no per-core games dir).
    if (core.category === 'Arcade') continue;

    const hasRbf = core.rbfPaths.length > 0;
    const hasGamesDir = core.gamesDirExists;

    // Fully hidden: every rbf path is dot-prefixed AND the games dir is
    // hidden (or absent). This is an intentional user action — don't flag it.
    if (hasRbf) {
      const allRbfsDotted = core.rbfPaths.every((p) => {
        const basename = p.slice(p.lastIndexOf('/') + 1);
        return basename.startsWith('.');
      });
      if (allRbfsDotted && (!hasGamesDir || core.gamesDirHidden)) continue;
    }

    if (!hasRbf && hasGamesDir) {
      missingCoreFile.push(core);
    } else if (hasRbf && !hasGamesDir) {
      noRomsForCore.push(core);
    }
  }

  return { missingCoreFile, noRomsForCore };
}
