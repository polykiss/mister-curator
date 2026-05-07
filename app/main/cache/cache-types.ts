import type { WitnessMtimes } from '@shared/prime-parse';
import type { CoreEntry, Rom } from '@shared/types';

export type { WitnessMtimes } from '@shared/prime-parse';

/**
 * On-disk cache types for PR #12. These are private to the main
 * process — never exposed through IPC. The renderer interacts with
 * the cache only indirectly, via the existing list / refresh IPC
 * channels.
 *
 * Schema versioning: bump `CACHE_SCHEMA_VERSION` when the on-disk
 * shape changes incompatibly. The parser refuses to load anything at
 * a different version (it returns `null`, treated as a cache miss),
 * so a forward-incompatible upgrade silently invalidates instead of
 * corrupting.
 *
 * Cache files live at `<userData>/cache/<sanitisedHost>/`:
 *
 *   cores.json                — list-all-cores output + 5 witnesses
 *   roms/<sanitisedCoreId>.json
 *                             — Rom[] per (coreId, subPath) keyed
 *                               on the inner `bySubPath` map. One
 *                               file per core, multiple slots inside.
 *
 * `<sanitisedHost>` and `<sanitisedCoreId>` strip any character that
 * could escape the cache directory or collide on case-insensitive
 * filesystems (Windows/macOS). See `sanitiseFsSegment`.
 */
export const CACHE_SCHEMA_VERSION = 1 as const;

export interface CoresCacheEntry {
  readonly version: typeof CACHE_SCHEMA_VERSION;
  readonly host: string;
  readonly cachedAt: string;
  readonly witnesses: WitnessMtimes;
  readonly data: readonly CoreEntry[];
}

/**
 * One slot inside a per-core `roms/<coreId>.json` file. The empty
 * subPath is the top-level listing; slash-joined keys are sub-folder
 * drills (`'1 World A-Z'`, etc.).
 */
export interface RomsCacheSlot {
  readonly cachedAt: string;
  readonly witnesses: WitnessMtimes;
  readonly data: readonly Rom[];
}

export interface RomsCacheFile {
  readonly version: typeof CACHE_SCHEMA_VERSION;
  readonly host: string;
  readonly coreId: string;
  /** subPath → cached slot. Top-level uses the empty string key. */
  readonly bySubPath: Readonly<Record<string, RomsCacheSlot>>;
}

/**
 * LRU bookkeeping target — the cache evicts oldest-first when the
 * count of `roms/<coreId>.json` files for a single host exceeds this.
 * Picked at the spec boundary: ~1-2KB typical per core, ~50KB for
 * X68000, so 100 files ≈ 5MB worst case per host.
 */
export const ROMS_CACHE_FILE_BUDGET = 100;

/**
 * Strip any character that could escape the cache directory or
 * collide on case-insensitive filesystems. Replaces `/`, `\`, `..`,
 * NUL, and a handful of platform-reserved characters with `_`. Keeps
 * the result printable so the cache is grepable when a user is
 * diagnosing why a stale entry didn't invalidate.
 *
 * NOT a security boundary on its own — the caller (CacheManager)
 * also constructs paths via `path.join` against the cache root, so
 * even a missed sanitisation can't leave the cache directory.
 */
export function sanitiseFsSegment(input: string): string {
  if (input === '' || input === '.' || input === '..') return '_';
  // Replace anything outside [a-zA-Z0-9._-] with `_`. Hostnames are
  // typically ASCII-safe; coreIds are too. UTF-8 in either is rare
  // but possible — we'd rather have a stable filename than risk a
  // path traversal.
  let result = input.replace(/[^a-zA-Z0-9._-]/g, '_');
  // Collapse leading dots so a coreId starting with '.' doesn't
  // produce a hidden file on the host filesystem.
  result = result.replace(/^\.+/, '_');
  return result;
}

/**
 * True iff `cached` and `fresh` describe the same set of paths and
 * each path's mtime matches exactly. Path order doesn't matter; key
 * presence does. A path missing from `fresh` (mtime 0 or omitted)
 * counts as a mismatch — the resource on the device went away.
 */
export function witnessesMatch(
  cached: WitnessMtimes,
  fresh: WitnessMtimes,
): boolean {
  const cachedKeys = Object.keys(cached);
  const freshKeys = Object.keys(fresh);
  if (cachedKeys.length !== freshKeys.length) return false;
  for (const k of cachedKeys) {
    const a = cached[k];
    const b = fresh[k];
    if (a === undefined || b === undefined) return false;
    if (a !== b) return false;
    // mtime 0 is our "MISSING" sentinel — treat it as a mismatch even
    // if both sides happen to agree on it. A path that's gone is
    // never a hit.
    if (a === 0) return false;
  }
  return true;
}

export type CacheEventKind =
  | 'hit'
  | 'miss'
  | 'stale'
  | 'write'
  | 'invalidate'
  | 'evict';

export interface CacheEvent {
  readonly kind: CacheEventKind;
  /** Which surface the event applies to. */
  readonly surface: 'cores' | 'roms';
  readonly host: string;
  /** Set when `surface === 'roms'`. */
  readonly coreId?: string;
  /** Set when `surface === 'roms'`. Empty string = top-level listing. */
  readonly subPath?: string;
  /** Set on `evict` to indicate which core's file was dropped. */
  readonly evictedCoreId?: string;
  /** Optional extra context (e.g. which witness mismatched). */
  readonly note?: string;
}
