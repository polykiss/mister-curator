/**
 * Cross-cutting metadata shapes (PR #15 + #16). The renderer doesn't
 * consume these yet — UI lands in PR #17 — but the IPC bridge is
 * already wired to return this shape, so the type has to live in
 * `shared/`.
 *
 * Schema timeline:
 *   - v1 (PR #15 round 1): ScreenScraper + TheGamesDB shape with
 *     criticScore / ageRating / players / screenshotUrls[] etc.
 *   - v2 (PR #15 round 3): pivoted to OpenVGDB + libretro. Dropped
 *     SS-specific fields; collapsed screenshotUrls → screenshotUrl.
 *   - v3 (PR #15 round 9): same shape, bump invalidates rounds 4–8
 *     boxArtUrl values that pointed at libretro's underscored folder
 *     form (now %20-encoded).
 *   - v4 (PR #16 round 2): ScreenScraper is back as primary source.
 *     Adds `players`, `rating`, `releaseDate` (SS-only fields the
 *     PR #17 detail UI will surface). The `source` field now carries
 *     `'screenscraper'` as a possible value. Bump invalidates v3
 *     entries so users upgrading get the richer SS-sourced records
 *     when creds are configured.
 */

export type MetadataSource = 'screenscraper' | 'openvgdb' | 'none';

/**
 * Every per-ROM metadata record carries the source that produced it.
 * `'none'` is a sentinel: no source returned a match, and we cache
 * the negative for `NO_MATCH_TTL_MS` so we don't repeatedly query
 * upstreams for hashes we already know none of them have.
 *
 * Sentinels expire; matched metadata doesn't, within a schema
 * version — neither OpenVGDB's snapshot nor SS's data changes
 * underneath us during a session.
 *
 * Source-priority chain (PR #16 round 2):
 *   ScreenScraper (when available) → OpenVGDB+libretro → 'none'.
 *
 * Field population by source:
 *   - `screenscraper`: every field populated when SS has it. SS
 *     uniquely surfaces `players`, `rating`, `releaseDate`.
 *   - `openvgdb`: name / system / year / genre / publisher /
 *     developer / description / boxArtUrl (via libretro). The three
 *     SS-only fields stay null.
 *   - `none`: sentinel — most fields null, `name: '(no match)'`.
 */
export interface RomMetadata {
  readonly version: 4;
  readonly hash: string;
  readonly name: string;
  readonly system: string;
  readonly year: number | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly genre: string | null;
  readonly description: string | null;
  /** SS-only: free-form ("1", "1-2", "1-4"). Null for OpenVGDB. */
  readonly players: string | null;
  /** SS-only: normalised 0–10. Null for OpenVGDB. */
  readonly rating: number | null;
  /** SS-only: raw release-date string ("YYYY-MM-DD" or "YYYY"). */
  readonly releaseDate: string | null;
  /** Box art URL — SS-hosted when source is 'screenscraper',
   * libretro-thumbnails when 'openvgdb'. Null when neither has art. */
  readonly boxArtUrl: string | null;
  readonly titleScreenUrl: string | null;
  readonly screenshotUrl: string | null;
  readonly source: MetadataSource;
  /** ISO 8601 — when the record was written to cache. Drives TTL. */
  readonly fetchedAt: string;
  /**
   * Round 9 (PR #20) — for `source: 'none'` sentinels only, records
   * whether ScreenScraper was actually available at write-time. The
   * cache-priority decision splits sentinel handling on this bit:
   *
   *   - `true`  — SS was queried and returned no match. Treat as
   *     authoritative for `SENTINEL_AUTHORITATIVE_TTL_MS` (7 days);
   *     past that, retry once.
   *   - `false` — SS was unavailable at write-time, so the sentinel
   *     is "poisoning" rather than authoritative. Refetch as soon
   *     as SS becomes available.
   *   - `undefined` — legacy record (pre-round-9) OR a non-sentinel
   *     source. For sentinels, treated as poisoned so existing v4
   *     entries get an opportunistic upgrade on first SS-available
   *     read. Optional so old v4 records still parse.
   */
  readonly ssAvailableAtWrite?: boolean;
}

/**
 * Optional hint passed to the metadata pipeline. v0 ignores both
 * fields — OpenVGDB is hash-keyed so the hash uniquely identifies
 * the ROM. Reserved for future name-search fallback if we add one.
 */
export interface MetadataHint {
  readonly name?: string;
  readonly system?: string;
}

/**
 * Backstop TTL for `source: 'none'` sentinels. Round 9 (PR #20)
 * reframed sentinel handling: poisoned sentinels (written when SS
 * was unavailable) refetch immediately on SS availability — no
 * TTL needed for the common case. This 30-day cap is the FALLBACK
 * for poisoned sentinels that NEVER see SS become available
 * (user without SS creds), so the cache doesn't pile up forever.
 * Authoritative sentinels (genuine SS misses) use the shorter
 * `SENTINEL_AUTHORITATIVE_TTL_MS` instead.
 */
export const NO_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * TTL for sentinels written WHEN SS WAS AVAILABLE (genuine no-match,
 * authoritative). Round 9 (PR #20) — 7 days balances "don't keep
 * re-asking SS for hashes it definitely doesn't know" against "do
 * eventually retry, in case SS adds the entry to its index later".
 */
export const SENTINEL_AUTHORITATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const ROM_METADATA_SCHEMA_VERSION = 4 as const;

/** One progress tick from a long-running prefetch. `done` is 1-based. */
export interface PrefetchProgress {
  readonly done: number;
  readonly total: number;
  readonly currentPath?: string;
}
