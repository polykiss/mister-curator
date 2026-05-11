/**
 * fix/mtime-tolerance — ±2-second mtime tolerance for cache hit
 * decisions.
 *
 * The MiSTer's data partition is commonly rebuilt onto exFAT or
 * FAT32, both of which store mtime at 2-second resolution. An rsync
 * from an ext4 backup → exFAT destination rounds each mtime to the
 * nearest even-second value on write, drifting cached entries from
 * the (now sub-second-quantised) stat output by up to 1 second.
 * Pre-fix the strict-equality `cached === fresh` check treated every
 * such entry as stale and forced a full re-hash on every reconnect.
 *
 * ±2 seconds covers the rsync rounding envelope ([−1, +1]s in
 * theory) with one second of headroom for pathological cases
 * (timezone DST boundaries, mildly skewed clocks, non-conformant
 * rsync builds). Tighter would re-introduce the bug on edge cases;
 * wider widens the false-positive window for genuine mid-edit
 * stat coincidences with no compensating benefit.
 *
 * The 0-sentinel ("file missing on device") is preserved across
 * the tolerance: `mtimesMatch(0, 0)` returns `false`, same as
 * `witnessesMatch`'s pre-fix behavior. A path that's gone is never
 * a hit, regardless of what either side recorded.
 *
 * Not applied to `findCacheKeyByMtime` (rename-aware recovery) —
 * `mv` preserves mtime exactly; tolerance there would only widen
 * the false-match window with no benefit. See Phase 1 investigation
 * notes.
 */

export const MTIME_TOLERANCE_SECONDS = 2;

/**
 * True iff `a` and `b` describe the same file's mtime within the
 * tolerance window. Returns false when either operand is `0` (the
 * missing-file sentinel) so a vanished path never matches anything,
 * not even another vanished path.
 *
 * Pure: no side effects, no rounding mode dependencies. Both inputs
 * are epoch seconds (integer).
 */
export function mtimesMatch(a: number, b: number): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) <= MTIME_TOLERANCE_SECONDS;
}
