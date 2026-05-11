/**
 * Games-dir aliases — fold one games directory's content into another
 * core's sidebar entry because a single .rbf services both shapes.
 *
 * NeoGeo-CD is the motivating case: the firmware's `NeoGeo` core
 * loads both cartridge ROMs (`games/NEOGEO/`) and CD images
 * (`games/NeoGeo-CD/`). Pre-fix, NeoGeo-CD/ surfaced as its own
 * orphan sidebar row (no matching .rbf, kept by the orphan filter
 * because it had countable ROMs). Two rows for one playable core is
 * the bug — the user wants one "NeoGeo" entry whose count totals
 * both directories and whose drill-in lets them pick from either.
 *
 * The map is keyed by canonical-form so the lookup is case- and
 * separator-insensitive (`NeoGeo-CD` / `neogeocd` / `neo geo cd` all
 * collapse to the same key). Values are the canonical-form of the
 * primary core to fold into.
 */

import { canonicalize } from '@shared/core-matching';

/**
 * canonical(aliased games-dir basename) → canonical(primary core).
 * The matcher applies this once per games-dir in
 * `matchRbfsToGamesDirs`. Add new entries here when a future core
 * exhibits the same dual-dir shape.
 */
const GAMES_DIR_ALIASES: Readonly<Record<string, string>> = {
  neogeocd: 'neogeo',
};

/**
 * If `gamesDirName`'s canonical form is an alias source, returns the
 * canonical form of the primary core to fold into. Otherwise null.
 *
 * Pure: callers pass the device-side basename ("NeoGeo-CD") and use
 * the returned canonical key to find the primary CoreEntry bucket
 * (which stores the on-disk basename under `gamesDirName`).
 */
export function aliasPrimaryCanonical(gamesDirName: string): string | null {
  const key = canonicalize(gamesDirName);
  return GAMES_DIR_ALIASES[key] ?? null;
}

/**
 * True iff this primary coreId has any aliased games dirs folded
 * into it (the primary's own sidebar row also exposes those dirs'
 * contents via drill-in). Reverse lookup over the alias map.
 */
export function hasAliasGamesDirs(primaryCoreId: string): boolean {
  const key = canonicalize(primaryCoreId);
  for (const target of Object.values(GAMES_DIR_ALIASES)) {
    if (target === key) return true;
  }
  return false;
}
