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
