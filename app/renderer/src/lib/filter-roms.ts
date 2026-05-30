import { metadataLookupPathFor } from '@shared/rom-enumeration';
import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

/**
 * feat/filter-as-you-type (#21) — case-insensitive substring filter
 * over the already-loaded ROM list. Zero IPC. Pure function: testable
 * in isolation, memoised by the caller (useMemo + useDeferredValue).
 *
 * Haystack per row:
 *   • rom.displayName — always present
 *   • metadata.name, publisher, genre — when loaded (null fields skipped)
 *   For folder-atomic rows the metadata lookup follows the
 *   `metadataLookupPathFor` rule (containedRomPath), matching the
 *   same path the adapter uses for box-art and detail-dialog.
 *   folder-container rows have no metadata path (they're navigation
 *   entries) so only displayName is matched.
 */
export function filterRoms(
  roms: readonly Rom[],
  query: string,
  metadataByPath: Record<string, { readonly metadata: RomMetadata | null } | undefined>,
): readonly Rom[] {
  const q = query.trim().toLowerCase();
  if (!q) return roms;

  return roms.filter((rom) => {
    const lookupPath = metadataLookupPathFor(rom);
    const meta = lookupPath !== null ? metadataByPath[lookupPath]?.metadata : null;
    const haystack = (
      rom.displayName +
      (meta?.name != null ? ' ' + meta.name : '') +
      (meta?.publisher != null ? ' ' + meta.publisher : '') +
      (meta?.genre != null ? ' ' + meta.genre : '')
    ).toLowerCase();
    return haystack.includes(q);
  });
}
