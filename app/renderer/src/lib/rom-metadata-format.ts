/**
 * Pure formatters for RomMetadata fields displayed in list rows.
 * Extracted from `RomMetadataCells.tsx` so the formatting rules stay
 * unit-testable without spinning up a React render context.
 */

/**
 * Pick the first token from a comma- or slash-separated genre list.
 * SS / OpenVGDB ship multi-genre strings like
 * `"Platform, Action / Adventure"`; the collapsed list row shows
 * only the lead. Returns null when the input is empty / null /
 * collapses to whitespace after splitting.
 */
export function pickPrimaryGenre(genre: string | null): string | null {
  if (genre === null || genre.length === 0) return null;
  const first = genre.split(/[,/]/)[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/**
 * Render a /10 rating for the row. Whole numbers drop the trailing
 * `.0` ("9/10" reads cleaner than "9.0/10"); fractions render to one
 * decimal place to preserve the half-point precision SS uses
 * (`note: '19'` → 19/20 → 9.5/10). Null in → null out.
 */
export function formatRating(rating: number | null): string | null {
  if (rating === null) return null;
  const trimmed = Number.isInteger(rating)
    ? String(rating)
    : rating.toFixed(1);
  return `${trimmed}/10`;
}
