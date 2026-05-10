/**
 * Classification-aware Rom enumeration.
 *
 * Background: `listRoms` returns one `Rom` per top-level entry with a
 * `kind` discriminator (`'file'`, `'folder-atomic'`, `'folder-container'`)
 * — `classifyFolder` (in `folder-rom.ts`) decides which. Downstream
 * consumers (the auto-scrape engine, the renderer's per-row metadata
 * lookup, and any future bulk enumerator) need the SAME view: one
 * row-level entry per atomic folder, NOT one per contained file.
 *
 * Pre-helper, the auto-scrape engine read `listRecursiveRomFiles`
 * (every launchable file in the games dir, no classification awareness)
 * and queued each contained file individually — for X68000 with ~647
 * atomic floppy folders × 2.25 disks each, that's ~1455 paths queued
 * instead of ~647. Every disk got hashed separately + the same
 * folder-name search ran 2-4 times per game. The renderer's per-row
 * metadata lookup also reinvented the same `kind === 'folder-atomic'
 * → use containedRomPath` ternary at every call site.
 *
 * `enumerateRomEntries(roms)` is the single source of truth: feed it
 * the `Rom[]` from `listRoms`, get back a flat `RomEntry[]` where:
 *   - file rows pass through (`path` = file path, `kind` = `'file'`)
 *   - folder-atomic rows collapse to ONE entry (`path` = the folder's
 *     `containedRomPath`, `kind` = `'atomic-folder'`, `displayName` =
 *     the folder's display name — used as the SS name-search query)
 *   - folder-container rows are NOT emitted; the caller drills into
 *     them via `listRoms(coreId, container.relativePath)` and runs
 *     this helper again on the inner level
 *   - atomic folders without a `containedRomPath` (defensive: empty
 *     atomic folder) are skipped — there's nothing to scrape or hash
 */

import type { Rom } from '@shared/types';

/**
 * The kind discriminator on `Rom` is FILESYSTEM-shape oriented (file
 * vs folder vs container); `RomEntryKind` is the SCRAPE-pipeline view
 * (file vs atomic-folder representation). The two collapse on
 * `'file'`; `'folder-atomic'` becomes `'atomic-folder'`; container
 * folders don't appear in the entry stream at all.
 */
export type RomEntryKind = 'file' | 'atomic-folder';

export interface RomEntry {
  /**
   * The on-device path the scrape pipeline + renderer use as the
   * metadata-cache lookup key. For files, this is the file's full
   * path. For atomic folders, this is the contained primary file's
   * full path (`Rom.containedRomPath`) — same shape as the file
   * branch, so the cache stays md5-keyed without a schema change.
   */
  readonly path: string;
  readonly kind: RomEntryKind;
  /**
   * What the user sees on the row + what gets passed to the SS
   * name-search as the query string. For atomic folders this is the
   * FOLDER name (without extension stripping — folders don't have
   * meaningful extensions); for files it's the file's
   * `Rom.displayName` (extension already stripped by the client).
   */
  readonly displayName: string;
  /**
   * The original `Rom.path` — distinct from `path` for atomic folders
   * (where `path` points at the contained file). Callers use this
   * for hide/show ops + folder-level bulk actions (which operate on
   * the directory, not the contained file).
   */
  readonly rowPath: string;
}

/**
 * Convert a `Rom[]` (one entry per row from `listRoms`) into the
 * scrape-pipeline view. Pure — no IPC, no SSH, no async.
 *
 * Container folders are filtered out: callers that want their
 * contents recurse via `listRoms(coreId, container.relativePath)` and
 * call this helper on each inner level. Empty atomic folders (no
 * `containedRomPath`) are skipped — they have no file to hash and no
 * meaningful name-search target beyond the folder name itself, so
 * they fall through to the `source: 'none'` sentinel naturally if a
 * caller decides to enumerate them separately.
 */
export function enumerateRomEntries(
  roms: readonly Rom[],
): readonly RomEntry[] {
  const out: RomEntry[] = [];
  for (const r of roms) {
    if (r.kind === 'file') {
      out.push({
        path: r.path,
        kind: 'file',
        displayName: r.displayName,
        rowPath: r.path,
      });
    } else if (r.kind === 'folder-atomic') {
      if (r.containedRomPath === undefined) continue;
      out.push({
        path: r.containedRomPath,
        kind: 'atomic-folder',
        displayName: r.displayName,
        rowPath: r.path,
      });
    }
    // folder-container: caller recurses; not emitted here.
  }
  return out;
}

/**
 * Subset of `enumerateRomEntries` that just returns the path strings
 * — the shape `listRecursiveRomFiles` returns and the auto-scrape
 * engine queues. Convenience over `enumerateRomEntries(...).map(e =>
 * e.path)` because it's the dominant call shape.
 */
export function enumerateScrapePaths(
  roms: readonly Rom[],
): readonly string[] {
  return enumerateRomEntries(roms).map((e) => e.path);
}

/**
 * Per-row metadata-cache lookup path. The renderer calls this in
 * several places (row-menu, prefetch builder, sort key) where it
 * needs the SAME path the orchestrator uses to key the cache —
 * which for atomic folders is the contained file's path, NOT the
 * folder path. Returns `null` for container rows (callers should
 * never look up metadata directly on a container) and for atomic
 * folders without a `containedRomPath` (defensive empty-folder case).
 *
 * Pre-helper this was an inline ternary at every call site;
 * extracting it kills the drift risk if the policy changes (e.g.
 * future "use folder path as key for atomic folders" schema change
 * — one place to update).
 */
export function metadataLookupPathFor(rom: Rom): string | null {
  if (rom.kind === 'file') return rom.path;
  if (rom.kind === 'folder-atomic') {
    return rom.containedRomPath ?? null;
  }
  return null;
}

/**
 * Combine a recursive launchable-path list (from
 * `listRecursiveRomFiles` — every launchable file under the games
 * dir, classification-blind) with a set of TOP-LEVEL atomic folders
 * (from `listRoms`) to produce the auto-scrape's deduped target list.
 *
 * For each top-level atomic folder:
 *   1. Drop every recursive path that lives inside the folder's
 *      subtree (matches the prefix `${folder.path}/`).
 *   2. Add the folder's `containedRomPath` as the single
 *      representative path.
 *
 * The result: contained files are scraped exactly ONCE per atomic
 * folder, and the folder representative carries the parent-folder
 * name-search hint (via the orchestrator's `atomicFolderPaths` set).
 * For X68000 with ~647 atomic floppy folders × 2.25 disks = ~1455
 * paths reduces to ~647 — every disk no longer hashes individually
 * + the same folder-name search no longer runs 2-4 times per game.
 *
 * Nested classification (atomic folders INSIDE a top-level container)
 * is out of scope: top-level container contents pass through verbatim
 * exactly as they did pre-fix. Doing nested classification properly
 * would need recursive `listRoms` calls per container, which is
 * follow-up work.
 *
 * Pure: no IPC, no SSH, no async. Extracted from
 * `ConnectionManager.listAllRomPathsForCore` so the merge logic is
 * testable without spinning up a real client.
 */
export function mergeRecursivePathsWithAtomicFolders(args: {
  readonly recursivePaths: readonly string[];
  readonly topLevelRoms: readonly Rom[];
}): {
  readonly paths: readonly string[];
  readonly atomicFolderPaths: ReadonlySet<string>;
} {
  // Subtree-poison set: EVERY top-level atomic folder, regardless of
  // whether it has a `containedRomPath`. The empty-atomic-folder case
  // (no launchable inside) STILL poisons its subtree — junk files
  // shouldn't sneak past as scrape targets just because the folder
  // has no representative. The "with representative" subset is
  // computed separately below.
  const allAtomic = args.topLevelRoms.filter(
    (r) => r.kind === 'folder-atomic',
  );
  const atomicFolderRoots = allAtomic.map((r) => `${r.path}/`);
  const filtered = args.recursivePaths.filter((p) => {
    for (const root of atomicFolderRoots) {
      if (p.startsWith(root)) return false;
    }
    return true;
  });
  // Representatives: only atomic folders WITH a `containedRomPath`
  // contribute a representative path (per `enumerateRomEntries`'s
  // skip-empty-atomic-folder rule). Empty atomic folders poison
  // their subtree but add nothing back.
  const atomicEntries = enumerateRomEntries(allAtomic);
  const atomicPaths = atomicEntries.map((e) => e.path);
  return {
    paths: [...filtered, ...atomicPaths],
    atomicFolderPaths: atomicFolderPathsFromRoms(allAtomic),
  };
}

/**
 * Subset of atomic-folder paths from a `Rom[]`. The orchestrator's
 * `getRomsMetadata` accepts an `atomicFolderPaths` set so it can
 * route those paths' name-search through the parent folder name (the
 * strongest hint when hash misses). Returns the SAME paths
 * `enumerateRomEntries` returns for atomic-folder entries — i.e. the
 * `containedRomPath`, NOT the folder path itself, so the orchestrator
 * can match on the path it already has.
 */
export function atomicFolderPathsFromRoms(
  roms: readonly Rom[],
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const r of roms) {
    if (r.kind === 'folder-atomic' && r.containedRomPath !== undefined) {
      out.add(r.containedRomPath);
    }
  }
  return out;
}
