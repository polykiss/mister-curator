# Caching

**Status:** Designed, not yet implemented. Targeted for v0.1.0.

## Problem

`listCores()` against a real MiSTer takes ~7 seconds (124 cores × `find` operations on slow SD card storage). On every connect, the user stares at a blank UI until the call completes. ROM lists per-core are fast (~40ms) but still re-fetched on every navigation.

## Approach: stale-while-revalidate, per-profile

On connect, the app immediately renders the last-known cores list from a local cache. In the background, it re-fetches fresh data and swaps the UI when it arrives. The user sees their library in milliseconds; freshness arrives a few seconds later without blocking.

### Cache scope and location

- **Local on the user's machine, per profile.** Stored at `app.getPath('userData')/cache/<profileId>.json`.
- **Not on the MiSTer.** The MiSTer is the source of truth for what files exist; the cache is purely a local performance layer.
- **Deleted with the profile.** Profile delete cascades to cache delete.

### Cache shape

```json
{
  "schemaVersion": 1,
  "lastSyncedAt": "ISO8601",
  "cores": [ /* CoreEntry[] */ ],
  "roms": {
    "<coreId>": { "fetchedAt": "ISO8601", "items": [ /* Rom[] */ ] }
  }
}
```

ROM lists are cached per-core lazily — only cores the user has actually clicked into get cached.

### Invalidation rules

- Any successful write operation (`setRomVisibility`, `setBulkRomVisibility`, `hideCore`, `showCore`, `setBulkCoreVisibility`) invalidates the relevant cache entry and triggers a refresh.
- The "Refresh" button always re-fetches and overwrites the cache.
- Auto-reapply on connect (from the hide-cores feature) invalidates the cores cache because it modifies state.
- ROM list cache for a core has a soft TTL of "this session" — clears on disconnect.
- Cores list cache has no TTL. The "Last synced" timestamp is shown in the UI so the user knows how stale it is and can refresh manually.

### UX surface

- A subtle "Last synced 3m ago" line in the top bar.
- "Refresh" button always visible.
- During background refresh, a thin progress indicator (spinner or progress bar) at the top of the cores pane. Non-blocking — user can interact while it's running.
- When background refresh completes and the data has changed, a brief toast: "Cores list updated."

## What this enables

- Switching profiles feels instant (cache hits immediately).
- Reconnecting to the same MiSTer feels instant.
- Lays groundwork for the metadata cache (same mechanism, different content).

## Out of scope

- Server-pushed change notifications (MiSTer doesn't have an inotify-over-SSH story worth the complexity).
- Multi-device cache sync (each Mac/PC running the app has its own cache; that's fine).
- Cache versioning beyond `schemaVersion` (we'll bump and invalidate when we change the shape).
