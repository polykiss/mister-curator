import type { CoreEntry } from '@shared/types';

export interface CoreAuditResult {
  readonly missingCoreFile: readonly CoreEntry[];
  readonly noRomsForCore: readonly CoreEntry[];
  /**
   * feat/arcade-orphan-detect (#46) — zip basenames found in
   * games/mame/ or games/hbmame/ that are not referenced by any
   * .mra launcher. These are taking up disk space but can't be
   * launched from the MiSTer menu.
   */
  readonly orphanArcadeRoms: readonly string[];
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
 *
 * The inverse direction matters for noRomsForCore: if Minimig has no
 * games dir, but Amiga does, Minimig is not "romless" — its ROMs live
 * under the alias name. See REVERSE_CORE_ALIASES.
 */
const CORE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  TGFX16: ['TurboGrafx16'],
  'TGFX16-CD': ['TurboGrafx16'],
  PCE: ['TurboGrafx16'],
  Amiga: ['Minimig'],
};

/**
 * Reverse of CORE_ALIASES: rbf-name → all games-dir names whose ROMs it plays.
 * E.g. `{ Minimig: ['Amiga'], TurboGrafx16: ['TGFX16', 'TGFX16-CD', 'PCE'] }`.
 * Used in noRomsForCore: if any of the aliasing cores has a visible games dir,
 * the rbf core is not truly romless.
 */
const REVERSE_CORE_ALIASES: Readonly<Record<string, readonly string[]>> = (() => {
  const out: Record<string, string[]> = {};
  for (const [gamesDir, rbfNames] of Object.entries(CORE_ALIASES)) {
    for (const rbf of rbfNames) {
      (out[rbf] ??= []).push(gamesDir);
    }
  }
  return out;
})();

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
export function auditCores(
  cores: readonly CoreEntry[],
  orphanArcadeRoms: readonly string[] = [],
): CoreAuditResult {
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
      // Check whether an alias games dir covers this rbf. E.g. Minimig is
      // served by the Amiga games dir — if that dir exists and is visible,
      // Minimig is not romless.
      const aliasDirIds = REVERSE_CORE_ALIASES[core.id] ?? [];
      const coveredByAliasDir = aliasDirIds.some((aliasId) =>
        cores.some((c) => c.id === aliasId && c.gamesDirExists && !c.gamesDirHidden),
      );
      if (coveredByAliasDir) continue;
      noRomsForCore.push(core);
    }
  }

  return { missingCoreFile, noRomsForCore, orphanArcadeRoms };
}
