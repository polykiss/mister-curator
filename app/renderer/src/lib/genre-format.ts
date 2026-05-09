/**
 * PR-C round 2 (PR #26) — genre abbreviation map.
 *
 * ScreenScraper returns full English genre names like
 * "Role Playing Game" and "First Person Shooter" that overflow the
 * Genre column (`w-28` = 112px) in the ROMs list. PR #25 truncates
 * with ellipsis as a fallback, but for the common offenders the
 * accepted abbreviation reads better than a partial-word ellipsis.
 *
 * The map is intentionally tight — only well-recognized
 * abbreviations make the cut. An unmapped genre passes through
 * verbatim and the table-fixed truncation handles overflow as a
 * safety net. Don't widen the genre column to fit unabbreviated
 * names; abbreviation IS the fix.
 *
 * Render-side `title=` attribute carries the full pre-abbreviated
 * form so hovering surfaces the original — same pattern PR #25
 * uses for the truncated ROM name cell.
 */

const GENRE_ABBREVIATIONS: Record<string, string> = {
  'Role Playing Game': 'RPG',
  'Action Role Playing': 'Action RPG',
  'First Person Shooter': 'FPS',
  'Third Person Shooter': 'TPS',
  'Real Time Strategy': 'RTS',
  'Turn Based Strategy': 'TBS',
  'Massively Multiplayer Online': 'MMO',
  'Action Adventure': 'Action-Adv',
  // The "'em up" forms — Shmup is the established short, Beat 'em
  // up has no established short and stays as-is (it's already
  // borderline-fitting; truncation handles overflow).
  "Shoot 'em up": 'Shmup',
  "Beat 'em up": "Beat 'em up",
  'Survival Horror': 'Survival',
  // Sport variants — the full "Sports X" form is redundant when X
  // is already a sport name.
  'Sports Football': 'Football',
  'Sports Basketball': 'Basketball',
  'Sports Baseball': 'Baseball',
  'Sports Hockey': 'Hockey',
  'Sports Soccer': 'Soccer',
};

/**
 * Returns the abbreviated form for known long-genre offenders, or the
 * input verbatim. Empty / null / undefined collapses to '' so the
 * caller doesn't have to guard.
 */
export function abbreviateGenre(
  genre: string | null | undefined,
): string {
  if (genre === null || genre === undefined || genre === '') return '';
  return GENRE_ABBREVIATIONS[genre] ?? genre;
}

/**
 * chore/search-and-filter-cleanup commit 3: clean a multi-language /
 * duplicated genre string.
 *
 * SS sometimes serves a single genre as a slash-joined list of
 * synonym forms ("RPG / Role-Playing Game") or surfaces the same
 * concept twice across different language entries ("Action / Action").
 * `formatGenreList` splits on " / ", abbreviates each part, dedupes
 * case-insensitively, and re-joins. Comma-separated content is left
 * inside a single slash-token (commas separate distinct genres at the
 * record level — `"Action, Adventure"` is two genres but one
 * slash-token).
 *
 * The full-string output is what the edit modal + hover-tooltip
 * surface; the row cell still calls `pickPrimaryGenre` afterward to
 * pick the lead.
 *
 * Note: the root fix for non-English genres is the
 * `pickGenreNameEnglishFirst` change in `screenscraper-service.ts`
 * (commit 3). Records cached before that fix landed still need a
 * refresh to drop their non-English entries.
 */
export function formatGenreList(
  genre: string | null | undefined,
): string {
  if (genre === null || genre === undefined || genre === '') return '';
  const parts = genre
    .split(/\s*\/\s*/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const abbreviated = parts.map((p) => abbreviateGenre(p));
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of abbreviated) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique.join(' / ');
}
