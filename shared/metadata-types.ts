/**
 * Cross-cutting metadata shapes (PR #15). The renderer doesn't consume
 * these yet — UI lands in PR #16/#17 — but the IPC bridge is already
 * wired to return this shape, so the type has to live in `shared/`.
 */

export type MetadataSource = 'screenscraper' | 'thegamesdb' | 'none';

/**
 * Every per-ROM metadata record carries the source that produced it.
 * `'none'` is a sentinel: neither client returned a match, and we cache
 * the negative for `NO_MATCH_TTL_MS` to avoid hammering the upstream
 * APIs on every refetch. Sentinels expire; matched metadata never does.
 */
export interface RomMetadata {
  readonly version: 1;
  readonly hash: string;
  readonly name: string;
  readonly year: number | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly genre: string | null;
  /** "1", "1-2", "1-4", etc. Free-form per upstream. */
  readonly players: string | null;
  /** Critic score normalized to 0–100. ScreenScraper's `note` is /20. */
  readonly criticScore: number | null;
  readonly ageRating: string | null;
  readonly description: string | null;
  readonly boxArtUrl: string | null;
  readonly screenshotUrls: readonly string[];
  readonly titleScreenUrl: string | null;
  readonly source: MetadataSource;
  /** ISO 8601 — when the record was written to cache. Drives TTL. */
  readonly fetchedAt: string;
}

/**
 * Optional hint passed to the metadata pipeline. Used as a tie-breaker
 * if multiple matches come back from a hash search, and as the only
 * signal at all if the hash is unknown to the upstream index. The
 * orchestrator threads it through verbatim — the clients decide
 * whether to fall back to name search.
 */
export interface MetadataHint {
  readonly name?: string;
  readonly system?: string;
}

/** TTL for `source: 'none'` sentinels. Matched metadata never expires. */
export const NO_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ROM_METADATA_SCHEMA_VERSION = 1 as const;

/** One progress tick from a long-running prefetch. `done` is 1-based. */
export interface PrefetchProgress {
  readonly done: number;
  readonly total: number;
  readonly currentPath?: string;
}
