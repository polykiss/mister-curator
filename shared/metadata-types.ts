/**
 * Cross-cutting metadata shapes (PR #15). The renderer doesn't consume
 * these yet — UI lands in PR #16/#17 — but the IPC bridge is already
 * wired to return this shape, so the type has to live in `shared/`.
 *
 * Round 3: v2 schema. Pivoted from ScreenScraper + TheGamesDB to
 * OpenVGDB + libretro-thumbnails. Dropped fields that the new sources
 * don't carry (`criticScore`, `ageRating`, `players`); kept the
 * descriptive fields all sources had in common; collapsed the
 * `screenshotUrls` array into a single `screenshotUrl` (libretro
 * exposes one snap per ROM).
 */

export type MetadataSource = 'openvgdb' | 'none';

/**
 * Every per-ROM metadata record carries the source that produced it.
 * `'none'` is a sentinel: no source returned a match, and we cache
 * the negative for `NO_MATCH_TTL_MS` so we don't repeatedly query
 * OpenVGDB for hashes we already know it doesn't have. Sentinels
 * expire; matched metadata never does — the OpenVGDB snapshot
 * doesn't change underneath us within a session.
 */
export interface RomMetadata {
  readonly version: 2;
  readonly hash: string;
  readonly name: string;
  readonly system: string;
  readonly year: number | null;
  readonly publisher: string | null;
  readonly developer: string | null;
  readonly genre: string | null;
  readonly description: string | null;
  /** From libretro-thumbnails. Null when the system isn't covered. */
  readonly boxArtUrl: string | null;
  readonly titleScreenUrl: string | null;
  readonly screenshotUrl: string | null;
  readonly source: MetadataSource;
  /** ISO 8601 — when the record was written to cache. Drives TTL. */
  readonly fetchedAt: string;
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

/** TTL for `source: 'none'` sentinels. Matched metadata never expires. */
export const NO_MATCH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ROM_METADATA_SCHEMA_VERSION = 2 as const;

/** One progress tick from a long-running prefetch. `done` is 1-based. */
export interface PrefetchProgress {
  readonly done: number;
  readonly total: number;
  readonly currentPath?: string;
}
