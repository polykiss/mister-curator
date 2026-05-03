/**
 * Pure helpers for the ROMs-pane breadcrumb. The renderer turns these
 * structures into clickable segments + a back row; everything that
 * involves a path lives here so it can be unit-tested without
 * spinning up React.
 *
 * Convention: `subPath` is the renderer's current drill location
 * inside a core, slash-joined and *visible* (no leading dots —
 * RomsPane strips the dot before drilling). Empty string is the core
 * root. Each segment in the breadcrumb has a `depth`:
 *
 *   depth 0 → core root (always the first segment, the core name)
 *   depth 1 → first folder
 *   depth N → Nth folder
 *
 * `subPathAtDepth(subPath, n)` returns the subPath that *would* be
 * current if the user navigated to depth `n`. depth 0 yields ''.
 */

import { displayRomName } from '@shared/display';

export interface BreadcrumbSegment {
  /** User-facing label. Already runs through `displayRomName`. */
  readonly label: string;
  /** 0 = core root; 1 = first folder; … */
  readonly depth: number;
  /** True for the last/current segment. The renderer renders this one
   *  un-clickable (you're already there). */
  readonly current: boolean;
}

/**
 * Build the breadcrumb segment list for `(coreName, subPath)`. The
 * first segment is always the core name; subsequent segments come
 * from splitting the subPath. Folder labels are passed through
 * `displayRomName` so a container called `Stuff.zip` (rare, but
 * possible) reads cleanly as `Stuff`.
 */
export function computeBreadcrumb(
  coreName: string,
  subPath: string,
): readonly BreadcrumbSegment[] {
  const parts = splitSubPath(subPath);
  const out: BreadcrumbSegment[] = [
    { label: coreName, depth: 0, current: parts.length === 0 },
  ];
  for (let i = 0; i < parts.length; i += 1) {
    out.push({
      label: displayRomName(parts[i]!),
      depth: i + 1,
      current: i === parts.length - 1,
    });
  }
  return out;
}

/**
 * Returns the subPath that should be active after the user clicks the
 * breadcrumb segment at `depth`. depth 0 → core root (empty string);
 * depth 1 → the first folder only; etc.
 *
 * Out-of-range `depth` is clamped to the available segment count, so
 * navigating to depth 99 in a depth-2 path silently lands at depth 2
 * (idempotent — the user's current location).
 */
export function subPathAtDepth(subPath: string, depth: number): string {
  if (depth <= 0) return '';
  const parts = splitSubPath(subPath);
  return parts.slice(0, depth).join('/');
}

/**
 * Description of the file-browser-style back row that sits above the
 * ROM list when the user is drilled in. `parentLabel` is the
 * breadcrumb-friendly name of the level the row navigates to:
 *
 *   at depth 1 → parent is the core, label is the core name
 *   at depth N → parent is the (N-1)-th segment, displayName-stripped
 *
 * Returns null at the core root (no back row to show).
 */
export interface BackRow {
  /** Where clicking the row should take us — the parent's subPath. */
  readonly targetSubPath: string;
  /** Human label for the parent, used inside ".. (Back to <label>)". */
  readonly parentLabel: string;
}

export function computeBackRow(
  coreName: string,
  subPath: string,
): BackRow | null {
  const parts = splitSubPath(subPath);
  if (parts.length === 0) return null;
  const parentDepth = parts.length - 1;
  const parentSlice = parts.slice(0, parentDepth);
  const parentLabel =
    parentDepth === 0 ? coreName : displayRomName(parts[parentDepth - 1]!);
  return {
    targetSubPath: parentSlice.join('/'),
    parentLabel,
  };
}

function splitSubPath(subPath: string): readonly string[] {
  if (subPath === '') return [];
  return subPath.split('/');
}
