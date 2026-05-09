import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import {
  displayGenre as displayGenreOf,
  displayName as displayNameOf,
  displayRating as displayRatingOf,
  displayYear as displayYearOf,
} from '@app/renderer/src/lib/metadata-display';

import {
  formatRating,
  pickPrimaryGenre,
} from '@app/renderer/src/lib/rom-metadata-format';

/**
 * PR-A item 8 — sortable list-view columns.
 *
 * Folder rows pin to the top of the list, alphabetical by display
 * name, immune to whatever sort the user chose for the file rows.
 * File rows below them follow the user's active sort.
 *
 * Sort state lives per-pane (per RomsPane mount) and is intentionally
 * NOT persisted across app restarts — that's a later round. Switching
 * cores resets to default (`name asc`).
 */

export type SortKey = 'name' | 'year' | 'genre' | 'rating';
export type SortDir = 'asc' | 'desc';

export interface SortState {
  readonly key: SortKey;
  readonly dir: SortDir;
}

export const DEFAULT_SORT: SortState = { key: 'name', dir: 'asc' };

/**
 * Cycle the active sort: per spec, click cycles `asc → desc → asc`
 * for the active column. Clicking a different column resets that
 * column to `asc`.
 */
export function nextSortState(current: SortState, key: SortKey): SortState {
  if (current.key !== key) return { key, dir: 'asc' };
  return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
}

/**
 * True iff the row should pin to the top regardless of user sort.
 *
 * Round 3 part 2 narrowed this from `kind !== 'file'` to
 * `kind === 'folder-container'`. Folder-atomic rows ARE single-game
 * folders (the X68000 `<game>/<game>.zip` shape) — the user thinks of
 * them as "the game", not "a folder", so they sort INTO the games
 * list by display name rather than pinning to the top. Only multi-game
 * / nested folders (`folder-container`, the explorable kind) still
 * pin, so drill-in targets stay grouped at the top.
 */
export function isPinnedRow(rom: Rom): boolean {
  return rom.kind === 'folder-container';
}

/**
 * Locale-aware string sort, dropping leading articles ("The ", "A ",
 * "An ") so "The Legend of Zelda" sorts under L.
 */
const ARTICLE_RE = /^(the|a|an)\s+/i;
function stripLeadingArticle(name: string): string {
  return name.replace(ARTICLE_RE, '');
}

/**
 * Display name fallback chain — metadata's authoritative name when
 * present, else the on-disk display name (filename stripped of
 * leading dot for hidden files).
 *
 * PR-D2 (PR #29): when a metadata record exists, route through the
 * display-merge helper so userOverride.name wins over the source
 * name. Sort order tracks the visible name — if the user renames a
 * row to "Aaa", it sorts at the top.
 */
function resolveName(rom: Rom, metadata: RomMetadata | null | undefined): string {
  if (metadata !== null && metadata !== undefined) {
    return displayNameOf(metadata);
  }
  return rom.displayName;
}

/**
 * Per-spec: ROMs without a value for the active sort field land at
 * the END regardless of asc/desc direction. The comparator returns
 * `null` for "no value here"; the wrapper sandwiches nulls to the
 * end before flipping for desc.
 */
type Extracted =
  | { readonly kind: 'value'; readonly s: string; readonly n?: number }
  | { readonly kind: 'missing' };

function extractFor(
  key: SortKey,
  rom: Rom,
  metadata: RomMetadata | null | undefined,
): Extracted {
  switch (key) {
    case 'name':
      // Always present (rom.displayName is the on-disk floor); strip
      // leading articles for natural ordering.
      return {
        kind: 'value',
        s: stripLeadingArticle(resolveName(rom, metadata)).toLocaleLowerCase(),
      };
    case 'year': {
      // PR-D2 (PR #29): user-override wins via displayYearOf.
      const year = metadata ? displayYearOf(metadata) : null;
      if (year === null) return { kind: 'missing' };
      return { kind: 'value', s: String(year), n: year };
    }
    case 'genre': {
      const g = pickPrimaryGenre(metadata ? displayGenreOf(metadata) : null);
      if (g === null) return { kind: 'missing' };
      return { kind: 'value', s: g.toLocaleLowerCase() };
    }
    case 'rating': {
      const r = metadata ? displayRatingOf(metadata) : null;
      if (r === null) return { kind: 'missing' };
      return { kind: 'value', s: formatRating(r) ?? String(r), n: r };
    }
  }
}

/**
 * Pure sort: returns a new array, doesn't mutate the input. Pinned
 * rows (folders) always come first, alphabetical-asc by display name,
 * regardless of `state`. File rows follow, ordered by `state`.
 *
 * Missing values for the active sort key sandwich to the end of the
 * file-rows section regardless of `state.dir`, so an asc rating sort
 * shows highest-rated → lowest-rated → no-rating, and a desc sort
 * shows lowest-rated → highest-rated → no-rating.
 */
export function sortRoms(
  rows: readonly { readonly rom: Rom; readonly metadata: RomMetadata | null | undefined }[],
  state: SortState,
): { readonly rom: Rom; readonly metadata: RomMetadata | null | undefined }[] {
  const folders: typeof rows[number][] = [];
  const files: typeof rows[number][] = [];
  for (const r of rows) {
    if (isPinnedRow(r.rom)) folders.push(r);
    else files.push(r);
  }

  // Folder block: alphabetical asc by display name, immune to user
  // sort. Use the metadata-aware resolveName for consistency, even
  // though folders rarely have metadata.
  folders.sort((a, b) => {
    const aName = stripLeadingArticle(
      resolveName(a.rom, a.metadata),
    ).toLocaleLowerCase();
    const bName = stripLeadingArticle(
      resolveName(b.rom, b.metadata),
    ).toLocaleLowerCase();
    return aName.localeCompare(bName, undefined, { sensitivity: 'base' });
  });

  // File block: split into "has value" and "missing" first; only
  // sort within "has value". "Missing" rows go to the end with their
  // input order preserved (stable enough for the no-info case).
  const present: typeof rows[number][] = [];
  const missing: typeof rows[number][] = [];
  for (const r of files) {
    const ex = extractFor(state.key, r.rom, r.metadata);
    if (ex.kind === 'missing') missing.push(r);
    else present.push(r);
  }
  present.sort((a, b) => {
    const ax = extractFor(state.key, a.rom, a.metadata);
    const bx = extractFor(state.key, b.rom, b.metadata);
    if (ax.kind !== 'value' || bx.kind !== 'value') return 0;
    let cmp: number;
    if (ax.n !== undefined && bx.n !== undefined) {
      cmp = ax.n - bx.n;
    } else {
      cmp = ax.s.localeCompare(bx.s, undefined, { sensitivity: 'base' });
    }
    return state.dir === 'asc' ? cmp : -cmp;
  });

  return [...folders, ...present, ...missing];
}
