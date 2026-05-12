import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';

/**
 * feat/arcade-parity-2-metadata — resolve the "primary zip" basename
 * for an arcade `.mra` entry: the first zip referenced by the
 * entry's `requiredZips` that exists in the snapshot's
 * zip-basename union (the `mame/` + `hbmame/` walk performed by
 * `listArcadeZipBasenames`).
 *
 * Returns the basename only (e.g. `'dkong.zip'`). The caller
 * promotes it to a full path by stat'ing the candidates in both
 * MAME zip dirs — the snapshot doesn't preserve per-dir membership,
 * and the playability scan's existing behavior (flat union) doesn't
 * need to change for this PR.
 *
 * Iteration order matches the spec ("the primary zip is the first
 * entry in requiredZips that resolves to an existing file"):
 *   1. Outer blocks in document order.
 *   2. Within each block, fallback alternatives in pipe order.
 * The first basename present in `zipBasenames` wins. Returns `null`
 * when nothing in any block exists — that entry is `missing`-
 * classified and shouldn't be passed in by upstream.
 */
export function resolvePrimaryZipBasename(
  entry: ArcadeMraMeta,
  zipBasenames: ReadonlySet<string>,
): string | null {
  for (const block of entry.requiredZips) {
    for (const candidate of block) {
      if (zipBasenames.has(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Group `.mra` entries by their resolved primary zip basename. The
 * dedupe shape is one bucket per unique zip basename, with the list
 * of `.mras` that share it.
 *
 * Multiple `.mras` regularly reference the same zip (parent + clones,
 * a hack of a parent, etc). Hashing the zip once and reusing the
 * resulting SS metadata across every `.mra` mapped to it is the
 * load-bearing optimisation here — `parseArcadeMras` on a typical
 * MiSTer lists 500–700 `.mras` against ~300 unique zips.
 *
 * Entries whose primary zip can't be resolved (no alternative
 * exists in the user's zip dirs) are dropped — the caller should
 * filter to `playable` upstream anyway.
 *
 * Buckets and within-bucket `.mra` arrays are both sorted for
 * determinism — the prefetch event order should be stable across
 * runs so the renderer's progress UI doesn't visibly reshuffle.
 */
export interface ArcadeZipGroup {
  /** Basename only (e.g. `'dkong.zip'`); orchestrator resolves to a path. */
  readonly zipBasename: string;
  /** `.mra` entries that map to this zip, sorted by relativePath. */
  readonly mras: readonly ArcadeMraMeta[];
}

export function groupByPrimaryZipBasename(
  playableEntries: readonly ArcadeMraMeta[],
  zipBasenames: ReadonlySet<string>,
): readonly ArcadeZipGroup[] {
  const byZip = new Map<string, ArcadeMraMeta[]>();
  for (const entry of playableEntries) {
    const zipBasename = resolvePrimaryZipBasename(entry, zipBasenames);
    if (zipBasename === null) continue;
    const bucket = byZip.get(zipBasename);
    if (bucket === undefined) {
      byZip.set(zipBasename, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  const out: ArcadeZipGroup[] = [];
  const zipBasenamesSorted = [...byZip.keys()].sort();
  for (const zipBasename of zipBasenamesSorted) {
    const mras = [...byZip.get(zipBasename)!].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath),
    );
    out.push({ zipBasename, mras });
  }
  return out;
}
