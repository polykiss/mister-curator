import type { RomMetadata } from '@shared/metadata-types';

/**
 * PR-D2 (PR #29) — display-merge helpers for ROM metadata.
 *
 * Every consumer that renders a ROM row's name, year, genre, rating,
 * tags, or note MUST go through these helpers (NOT read the raw
 * `metadata.name` etc.). The helpers layer `userOverride` over the
 * source-resolved fields:
 *
 *   1. If the user explicitly set the field (via the edit modal),
 *      the override value wins.
 *   2. Otherwise, the source-resolved value (from SS / OpenVGDB)
 *      shows.
 *
 * The merge rule is "set wins" — a user-set empty string for `name`
 * still wins over the SS-resolved name. To revert, the user opens
 * the edit modal and clicks Reset (which clears `userOverride`
 * entirely; PR-D2 doesn't support per-field reset).
 *
 * Pure module — no React imports, no IPC, fully unit-testable.
 */

/**
 * The visible name on a row. Override > metadata.name. Always returns
 * a non-null string (sentinel records carry `name: '(no match)'`).
 */
export function displayName(metadata: RomMetadata): string {
  return metadata.userOverride?.name ?? metadata.name;
}

/**
 * The year for the year column. Override > metadata.year. Returns
 * null when neither is set (renders as em-dash).
 */
export function displayYear(metadata: RomMetadata): number | null {
  if (metadata.userOverride?.year !== undefined) {
    return metadata.userOverride.year;
  }
  return metadata.year;
}

/**
 * The genre for the genre column. Override > metadata.genre. Returns
 * null when neither is set. Multi-genre strings (`"Action, Adventure"`)
 * pass through verbatim — `pickPrimaryGenre` is the consumer-side
 * formatter.
 */
export function displayGenre(metadata: RomMetadata): string | null {
  if (metadata.userOverride?.genre !== undefined) {
    return metadata.userOverride.genre;
  }
  return metadata.genre;
}

/**
 * The rating for the rating column (0–10 scale). Override >
 * metadata.rating. Returns null when neither is set. The override
 * range is the same 0–10 the SS source uses; the edit modal
 * validates input within range before write.
 */
export function displayRating(metadata: RomMetadata): number | null {
  if (metadata.userOverride?.rating !== undefined) {
    return metadata.userOverride.rating;
  }
  return metadata.rating;
}

/**
 * The tags for pill rendering. Override-only (the SS sources don't
 * provide tags). Returns an empty readonly array when no tags are
 * set — callers can treat this as "no pills to render" without a
 * null check. Tag order is whatever the user wrote; deduplication
 * is the writer's responsibility.
 */
export function displayTags(metadata: RomMetadata): readonly string[] {
  return metadata.userOverride?.tags ?? [];
}

/**
 * The user's note for the row. Override-only — SS doesn't surface
 * a free-form user-note field. Returns null when no note is set.
 * Render destination is the edit modal (read-only outside it for
 * v0.1 — no inline note display in the row UI per PR-D2 scope).
 */
export function displayNote(metadata: RomMetadata): string | null {
  return metadata.userOverride?.note ?? null;
}
