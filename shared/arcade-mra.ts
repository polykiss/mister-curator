/**
 * feat/arcade-mra-management Phase 1 — pure helpers for enumerating
 * `.mra` files in `/media/fat/_Arcade/`.
 *
 * Background: the MiSTer arcade menu is driven by `.mra` files in
 * `_Arcade/`, NOT by the `.zip` ROMs in `games/mame/`. MiSTerCurator
 * already manages the zips (which is what `mame` core surfaces) but
 * those don't affect what shows in the firmware's arcade menu.
 * Phase 1 lands the listing + classification + a hide/unhide
 * pathway that reuses the existing dot-prefix rename convention.
 *
 * Phase 1 scope (this PR):
 *   • Pure shared helpers — `parseArcadeMraEntries(rawListing)` —
 *     so both clients (Real + Fake) and tests can share the
 *     filtering + classification rule set.
 *   • Filter `._` AppleDouple sidecars + OS metadata
 *     (delegates to `library-filter.ts`).
 *   • Filter to `.mra` files only — `.rbf` cores live in
 *     `_Arcade/cores/` and don't surface as rows.
 *   • Recognise the dot-prefix hide convention.
 *
 * Phase 1.5 follow-up (separate PR): IPC + renderer integration
 * (sidebar entry, RomsPane reuse, hide/unhide buttons). The IPC
 * surface is small once the data shape is settled.
 *
 * Phase 2 follow-up: parse the .mra XML for game name +
 * manufacturer + year + region; link to `games/mame/<short>.zip`
 * for hash-based scraping.
 */

import { isOsMetadataDir, isOsMetadataFile } from '@shared/library-filter';

/**
 * feat/arcade-phase-1.5 — id of the synthetic CoreEntry the
 * renderer prepends to the sidebar to surface the `_Arcade/`
 * listing as a navigable row. Distinct from the `mame` core
 * (which manages .zip ROMs in `/media/fat/games/mame/`); this
 * row navigates to the .mra file management view.
 *
 * The double-underscore prefix is reserved namespace — passes
 * `assertSafeSegment` (no `/`, no `..`) but no real core uses it.
 */
export const ARCADE_VIRTUAL_CORE_ID = '__arcade__';

export type ArcadeMraEntryKind =
  | 'mra'
  /** `cores/` is the firmware's per-game .rbf stash inside _Arcade. */
  | 'cores-subfolder'
  /** Any other top-level directory under _Arcade (e.g. `_Konami/`). */
  | 'subfolder';

export interface ArcadeMraEntry {
  /**
   * Path relative to `MISTER_ARCADE_DIR`. For top-level entries
   * this is the basename (`Metal Slug.mra`); for nested entries
   * the slash-joined path (`_Konami/TMNT.mra`).
   */
  readonly relativePath: string;
  /**
   * Filename WITHOUT the hide-marker dot. The renderer surfaces
   * this; the leading dot (if any) lives in `relativePath`.
   * `.Metal Slug.mra` → display `Metal Slug.mra` (extension
   * stripping happens at the render layer if desired).
   */
  readonly displayName: string;
  readonly kind: ArcadeMraEntryKind;
  /**
   * True iff the file basename starts with `.` (hidden from the
   * MiSTer firmware's arcade menu via the standard dot-prefix
   * convention). Subfolders also follow this convention.
   */
  readonly hidden: boolean;
}

const MRA_EXTENSION = '.mra';

/**
 * Parse a flat listing of `_Arcade/` paths into typed entries.
 *
 * Input shape: relative paths from `_Arcade/` itself (NOT absolute
 * `/media/fat/_Arcade/...`). The listing is the SSH `find _Arcade
 * -mindepth 1 -printf '%y\\t%P\\n'` output split by client; each
 * caller (Real / Fake) parses and feeds the {type, relPath} pairs
 * here.
 *
 * Filter rules:
 *   • Drop `._` AppleDouple sidecars (any segment).
 *   • Drop OS-metadata directories (`.AppleDouble/`, `.Spotlight-
 *     V100/`, etc.) and any file inside them.
 *   • Keep `.mra` files at any depth.
 *   • Surface `cores/` as a top-level subfolder marked
 *     `cores-subfolder` so the renderer can hide it by default
 *     (it's firmware-managed; not user-curatable).
 *   • Surface other directories as `subfolder` — they're the
 *     `_Konami/` / `_Capcom/` user-organisational folders.
 *   • Drop everything else (`.rbf` files inside `cores/`, README
 *     files, etc.) — Phase 1 only manages `.mra` and the
 *     containers users navigate through.
 *
 * `cores/` is treated specially because it lives at every MiSTer
 * with arcade content and exists for every user — a single
 * dedicated row keeps the listing readable. User-organisational
 * subfolders (`_Konami/` / etc.) get the generic `subfolder`
 * treatment so the renderer can offer drill-in.
 */
export function parseArcadeMraEntries(
  raw: readonly { readonly type: 'f' | 'd'; readonly relPath: string }[],
): readonly ArcadeMraEntry[] {
  const out: ArcadeMraEntry[] = [];
  for (const item of raw) {
    if (item.relPath === '') continue;
    const segments = item.relPath.split('/').filter((s) => s !== '');
    if (segments.length === 0) continue;

    // Drop OS-metadata directory subtrees (any segment).
    let osJunk = false;
    for (const seg of segments) {
      if (isOsMetadataDir(seg)) {
        osJunk = true;
        break;
      }
    }
    if (osJunk) continue;
    const leaf = segments[segments.length - 1]!;
    if (item.type === 'f' && isOsMetadataFile(leaf)) continue;

    // Top-level entries decide kind. The `cores/` directory is
    // special-cased; everything else routes by the leaf type.
    if (segments.length === 1 && item.type === 'd') {
      const isCoresStash = leaf.toLowerCase() === 'cores';
      out.push({
        relativePath: leaf,
        displayName: stripLeadingDot(leaf),
        kind: isCoresStash ? 'cores-subfolder' : 'subfolder',
        hidden: leaf.startsWith('.'),
      });
      continue;
    }

    // Files: only .mra wins through. Skip .rbf, .nfo, etc.
    if (item.type !== 'f') continue;
    if (!hasMraExtension(leaf)) continue;
    out.push({
      relativePath: item.relPath,
      displayName: stripLeadingDot(leaf),
      kind: 'mra',
      hidden: leaf.startsWith('.'),
    });
  }
  return out;
}

/**
 * Convenience: count totals from a parsed entry list. Used by the
 * sidebar count enrichment + the bulk-hide preview.
 */
export interface ArcadeMraCounts {
  readonly totalMras: number;
  readonly hiddenMras: number;
  readonly subfolders: number;
}

export function countArcadeMraEntries(
  entries: readonly ArcadeMraEntry[],
): ArcadeMraCounts {
  let totalMras = 0;
  let hiddenMras = 0;
  let subfolders = 0;
  for (const e of entries) {
    if (e.kind === 'mra') {
      totalMras += 1;
      if (e.hidden) hiddenMras += 1;
    } else if (e.kind === 'subfolder') {
      // `cores-subfolder` is firmware-managed and isn't surfaced as
      // a user organisational unit — exclude from the count.
      subfolders += 1;
    }
  }
  return { totalMras, hiddenMras, subfolders };
}

function stripLeadingDot(name: string): string {
  return name.startsWith('.') ? name.slice(1) : name;
}

function hasMraExtension(name: string): boolean {
  if (name.length < MRA_EXTENSION.length) return false;
  return (
    name.toLowerCase().slice(-MRA_EXTENSION.length) === MRA_EXTENSION
  );
}
