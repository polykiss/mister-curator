/**
 * Folder-ROM classification — distinguishes "atomic" disc folders
 * (Saturn, MegaCD; the folder *is* one game) from "container" folders
 * (NEOGEO's organisational `1 World A-Z`; the folder groups many
 * playable games). The renderer uses the classification to decide
 * whether clicking a folder drills into it.
 *
 * Classification is best-effort: real MiSTers carry folders the
 * heuristic can't decide on (no disc markers, no archive extensions, no
 * subdirs). Those resolve to `unknown`. The renderer falls back to
 * `atomic` for unknown — safer than offering a drill-down on something
 * that isn't a container — but the user can override via a marks file.
 */

export type FolderClassification = 'container' | 'atomic' | 'unknown';

export interface FolderContents {
  readonly files: readonly string[];
  readonly dirs: readonly string[];
}

/**
 * Disc-image extensions. Presence of any of these inside the folder
 * pins the classification to atomic — we never treat a Saturn disc
 * folder as drillable.
 */
const DISC_EXTENSIONS: ReadonlySet<string> = new Set([
  '.cue',
  '.gdi',
  '.iso',
  '.chd',
]);

/**
 * Track-numbered file pattern. Matches `Track 01`, `Track 12`,
 * `Track01`, `track 03`, `something (Track 04).bin`, etc. Used as a
 * secondary atomic-folder signal — common in MegaCD / TurboGrafx-CD
 * dumps that don't ship a `.cue`.
 */
const TRACK_PATTERN = /\btrack\s*\d+/i;

/**
 * Cartridge / archive extensions. Used as a *fallback* signal — if the
 * folder has no disc-shape evidence, but it does have files with
 * recognisable single-cartridge names, we infer container.
 */
const CART_EXTENSIONS: ReadonlySet<string> = new Set([
  '.zip',
  '.7z',
  '.rar',
  '.sfc',
  '.smc',
  '.nes',
  '.gba',
  '.gb',
  '.gbc',
  '.md',
  '.gen',
  '.pce',
  '.lnx',
  '.col',
  '.gg',
  '.sms',
  '.a78',
  '.a26',
  '.bin',
]);

/**
 * Content-based classifier. Pure: feed it the files / dirs listing for
 * a folder, get back the call. The ordering of the rules is the spec —
 * disc markers win first because a `.bin` file inside a disc folder
 * would otherwise drag the call into "container" via the cart-ext
 * branch.
 */
export function classifyFolder(contents: FolderContents): FolderClassification {
  if (hasDiscMarker(contents.files) || hasTrackPattern(contents.files)) {
    return 'atomic';
  }
  if (hasCartExtension(contents.files)) {
    return 'container';
  }
  if (contents.dirs.length > 0) {
    return 'container';
  }
  return 'unknown';
}

/**
 * Flag-based classifier — same logic as `classifyFolder`, but driven by
 * pre-computed booleans. The real client's shell script does the heavy
 * lifting on the device (one case-statement scan) and emits flags; the
 * client side calls this to assign a classification without re-walking
 * the listing in JS.
 */
export interface FolderFlags {
  readonly hasDisc: boolean;
  readonly hasTrack: boolean;
  readonly hasCart: boolean;
  readonly hasSubdir: boolean;
}

export function classifyFromFlags(flags: FolderFlags): FolderClassification {
  if (flags.hasDisc || flags.hasTrack) return 'atomic';
  if (flags.hasCart) return 'container';
  if (flags.hasSubdir) return 'container';
  return 'unknown';
}

/**
 * Resolves the final classification with optional override layered on
 * top. `'unknown'` from the heuristic falls through to `'atomic'` so the
 * renderer always has a definite call to act on (the safer of the two —
 * we never accidentally offer a drill-down on something we can't read).
 */
export function resolveClassification(
  heuristic: FolderClassification,
  override: 'container' | 'atomic' | undefined,
): 'container' | 'atomic' {
  if (override !== undefined) return override;
  if (heuristic === 'unknown') return 'atomic';
  return heuristic;
}

function hasDiscMarker(files: readonly string[]): boolean {
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext !== '' && DISC_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function hasTrackPattern(files: readonly string[]): boolean {
  for (const f of files) {
    if (TRACK_PATTERN.test(f)) return true;
  }
  return false;
}

function hasCartExtension(files: readonly string[]): boolean {
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext !== '' && CART_EXTENSIONS.has(ext)) return true;
  }
  return false;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}
