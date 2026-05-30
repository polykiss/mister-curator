import type { CoreEntry } from '@shared/types';

export interface CoreAuditResult {
  readonly missingCoreFile: readonly CoreEntry[];
  readonly noRomsForCore: readonly CoreEntry[];
}

/**
 * ROM folders consumed by per-game `.mra` arcade cores — not installable
 * cores in the MiSTer sense. They'll never have a matching `.rbf` and
 * correctly showing them as "missing" would be misleading.
 */
const ARCADE_INFRA_IDS = new Set(['MAME', 'mame', 'hbmame', 'HBMame']);

/**
 * Games-dir names that don't match their corresponding `.rbf` prefix.
 * When a games dir with one of these IDs has no matching rbf, check
 * whether a rbf for any of the listed aliases is installed before
 * reporting the core as missing.
 *
 * For example: `/games/TGFX16` is played by `TurboGrafx16_YYYYMMDD.rbf`.
 * If that rbf is present, TGFX16 is not "missing" a core file.
 */
const CORE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  TGFX16: ['TurboGrafx16'],
  'TGFX16-CD': ['TurboGrafx16'],
  PCE: ['TurboGrafx16'],
  Amiga: ['Minimig'],
};

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

    // MAME/hbmame are arcade ROM infrastructure — not installable cores.
    if (ARCADE_INFRA_IDS.has(core.id) || ARCADE_INFRA_IDS.has(core.gamesDirName ?? '')) continue;

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
      // Check whether a known alias rbf covers this games dir.
      const aliases = CORE_ALIASES[core.id] ?? CORE_ALIASES[core.gamesDirName ?? ''] ?? [];
      const coveredByAlias = aliases.some((alias) =>
        cores.some(
          (c) =>
            c.id === alias &&
            c.rbfPaths.some((p) => !p.slice(p.lastIndexOf('/') + 1).startsWith('.')),
        ),
      );
      if (coveredByAlias) continue;
      missingCoreFile.push(core);
    } else if (hasRbf && !hasGamesDir) {
      noRomsForCore.push(core);
    }
  }

  return { missingCoreFile, noRomsForCore };
}
