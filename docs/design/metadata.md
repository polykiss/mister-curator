# Metadata (screenshots, descriptions, box art)

**Status:** Designed, not yet implemented. Targeted for v0.1.0 or v0.2.0.

## Problem

The current ROM list is a text-only table. For a curator deciding what to keep and what to hide, "Super Mario Bros 3 (USA).nes" tells you nothing about whether you actually want it. Visual identification (box art, screenshots) and context (year, genre, brief description) transform browsing from "scanning a list" into "shopping a library."

## Approach

Fetch metadata on-demand from a community database, cache aggressively, render it as an inline detail panel when a ROM is selected.

### Source

**Primary: ScreenScraper.fr.** Massive coverage, multiple regions, screenshots, box art, descriptions, genre, year. Free with rate limits (anonymous ~1 request/sec; authenticated accounts get higher limits).

**Future fallback: LaunchBox Games Database.** Cleaner data on what it covers, no account required, smaller catalog. Add later as a secondary source.

The metadata layer is built behind a `IMetadataProvider` interface so additional sources can be added without touching consumers — same pattern as `IMisterClient`.

### Authentication

Two tiers:

1. **Anonymous (default).** Works out of the box. Rate-limited; suitable for casual use.
2. **User-supplied ScreenScraper credentials.** Stored in profile settings (or globally — TBD), encrypted via `safeStorage`. Higher rate limits, recommended for users with large collections.

### Match strategy

ScreenScraper accepts multiple match keys, in order of reliability:

1. **CRC32 / MD5 / SHA1 hash** (most reliable; available once the audit engine ships)
2. **Filename + system ID** (works for No-Intro / Redump-named ROMs; brittle for renamed files)
3. **Game name + system ID** (last resort; can return wrong matches)

Until the audit engine exists, we match by filename. After audit ships, we automatically upgrade matches to hash-based.

### Caching

- **Per-profile cache file** at `app.getPath('userData')/cache/<profileId>-metadata.json`.
- **Indexed by `<coreId>:<filename>`** until hashes are available, then re-keyed by `<coreId>:<hash>`.
- **Cache entries are sticky** — once we've matched a ROM, we don't re-fetch unless the user explicitly asks for a refresh.
- **Negative caching** — if ScreenScraper returns no match, cache the miss for 30 days so we don't keep retrying.
- **Image assets** (box art, screenshots) cached as files in `<userData>/cache/media/<hash>.{jpg,png}` to avoid bloating the JSON cache.

### What we fetch

For each ROM, the minimum useful set:

- Title (canonical, region-aware)
- Year released
- Publisher / developer
- Genre (single primary genre, not the full taxonomy)
- Brief description (1-2 sentences)
- One thumbnail (box art front)
- One screenshot (in-game)

We do NOT fetch full multi-region asset packs, video previews, manuals, or alternate covers. Bloat for negligible value at this scope.

### UX surface

- ROM list rows show a small thumbnail (32×32 or similar) once metadata is loaded.
- Clicking a ROM opens a detail panel (slide-out from the right, or inline expansion) showing the full metadata: larger box art, screenshot, title, year, genre, description.
- Loading state: row shows a placeholder thumbnail; detail panel shows skeleton content.
- No-match state: row shows a generic icon; detail panel shows "No metadata found for this ROM. [Search manually]" with a link to ScreenScraper's site.
- Manual override: power users can paste a ScreenScraper game ID to force-match a stubborn ROM.

### Rate limit handling

- Queue all metadata requests through a single rate limiter (token bucket, 1 req/sec for anonymous, higher for authenticated).
- Visible cores prioritize their ROMs first; off-screen ROMs queue at lower priority.
- Backoff and retry on 429 / 503.
- A small "Fetching metadata… 47 / 230 ROMs" indicator in the top bar during initial backfill.

## What this enables

- Visual library browsing: scan thumbnails instead of filenames.
- Better collection-building: "show me everything from 1992" or "all platformers" becomes possible (filter by metadata).
- Hash-based matching once audit ships → near-perfect identification.

## Out of scope

- Editing metadata (we read; we don't write back to ScreenScraper).
- Bundled offline metadata DB (hundreds of MB; not worth shipping).
- Video previews, manuals, alternate art, music samples.
- Custom metadata sources beyond ScreenScraper / LaunchBox without explicit demand.

## Open questions for implementation phase

- ScreenScraper account credentials: per-profile or global? (Lean global — one ScreenScraper account, multiple MiSTers.)
- Image cache eviction policy: never, LRU, or size-bounded? (Lean: size-bounded with LRU once cache exceeds e.g. 500 MB.)
- Initial backfill behavior on first connect: aggressive prefetch, or strictly on-demand? (Lean on-demand for first version; revisit if it feels slow.)
