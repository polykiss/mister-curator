import type { ArcadeMraEntry } from '@shared/arcade-mra';
import type { RomMetadata } from '@shared/metadata-types';

/**
 * feat/filter-as-you-type (#21) — case-insensitive substring filter
 * over the arcade MRA list at the current drill depth.
 *
 * Haystack per .mra row:
 *   displayName + relativePath + metadata.name + metadata.publisher
 *
 * Subfolder/cores-subfolder rows are included when:
 *   a) Their own displayName or relativePath matches, OR
 *   b) Any descendant .mra anywhere in `allEntries` matches — so
 *      "_Konami" surfaces even when querying a game inside it.
 *
 * `allEntries` is the full flat list of all arcade entries (all
 * depths); `presentable` is the already depth- and visibility-filtered
 * slice that the pane renders. The two-pass approach pre-computes
 * matching .mra paths once (O(n) over allEntries) then applies the
 * subfolder rule in a second O(m) pass over presentable.
 */
export function filterArcadeEntries(
  presentable: readonly ArcadeMraEntry[],
  query: string,
  metadataByMra: Record<string, RomMetadata | null>,
  allEntries: readonly ArcadeMraEntry[],
): readonly ArcadeMraEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return presentable;

  // Pass 1: collect relative paths of all matching .mra entries across
  // ALL depths (so subfolder rows can be matched by their children).
  const matchingMraPaths = new Set<string>();
  for (const e of allEntries) {
    if (e.kind !== 'mra') continue;
    const meta = metadataByMra[e.relativePath] ?? null;
    const haystack = (
      e.displayName +
      ' ' + e.relativePath +
      (meta?.name != null ? ' ' + meta.name : '') +
      (meta?.publisher != null ? ' ' + meta.publisher : '')
    ).toLowerCase();
    if (haystack.includes(q)) matchingMraPaths.add(e.relativePath);
  }

  // Pass 2: filter presentable entries. .mra rows are kept iff their
  // path is in matchingMraPaths; subfolder rows are kept iff their own
  // name/path matches OR a descendant .mra matches.
  return presentable.filter((entry) => {
    if (entry.kind === 'mra') {
      return matchingMraPaths.has(entry.relativePath);
    }
    // Subfolder/cores-subfolder: match own name/path first (fast path).
    const ownHaystack = (entry.displayName + ' ' + entry.relativePath).toLowerCase();
    if (ownHaystack.includes(q)) return true;
    // Slow path: check whether any matching .mra lives under this folder.
    const prefix = entry.relativePath + '/';
    for (const mraPath of matchingMraPaths) {
      if (mraPath.startsWith(prefix)) return true;
    }
    return false;
  });
}
