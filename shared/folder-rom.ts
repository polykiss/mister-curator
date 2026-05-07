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
 * Cartridge / archive / single-medium extensions. PR #11 round 5: a
 * folder containing a cart-shape file with no other container evidence
 * (no subdirs, fewer than `SAME_EXTENSION_THRESHOLD` files of one
 * extension) classifies as **atomic** — the folder *is* one game. This
 * matches the X68000 shape (`<game-name>/<game>.zip`, optional manual
 * companion file) which is the dominant single-game-folder layout on
 * real MiSTers; before this round, every such folder rendered as a
 * drillable container, forcing a useless extra click to reach the .zip.
 *
 * Container detection now relies on stronger signals: subdirectories
 * (organisational tree like `_/Region/Game/`) or many same-extension
 * files (NEOGEO's `1 World A-Z/` with 30+ `.zip` files). False
 * positives — a folder with multiple distinct cart-format files we
 * misclassify as a single game — are recoverable via the row-menu
 * "Treat as container" override, the same way pre-round-5 false
 * positives in the other direction were.
 */
const CART_EXTENSIONS: ReadonlySet<string> = new Set([
  // Cartridge ROMs (originally enumerated)
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
  // Round 9 additions — formats we observed misclassified on real
  // MiSTers (e.g. NEOGEO/.neo, Atari Jaguar/.j64).
  '.neo', // NeoGeo native cartridge
  '.j64', // Atari Jaguar
  '.jag', // Atari Jaguar
  '.32x', // Sega 32X
  '.int', // Intellivision
  '.vec', // Vectrex
  '.ws',  // WonderSwan
  '.wsc', // WonderSwan Color
  // Computer-format media — same role: one file per game.
  '.tap', // Multiple computer formats (cassette)
  '.tzx', // ZX Spectrum
  '.dsk', // Multiple computer disk format
  '.cdt', // Amstrad CPC
  '.cas', // Multiple computer cassette
  '.cdi', // Sega Dreamcast / multiple
  '.adf', // Amiga disk format
  '.adz', // Compressed Amiga disk format
  '.hdf', // Amiga hard disk
  '.st',  // Atari ST disk
  '.msa', // Atari ST magic shadow archive
  '.uef', // BBC Micro / Acorn cassette
  '.cdx', // Multiple
  '.bbc', // BBC
]);

/**
 * Threshold for the "many similar files" rule. Folders with this many
 * non-disc files sharing a single extension are treated as container —
 * the extension list above is non-exhaustive, and this catches the
 * long tail (`.neo`, `.<future-format>`, …) without playing whack-a-
 * mole every time a new core ships.
 *
 * Five chosen because:
 *   - Disc atomic folders are typically `.cue` + many `.bin` (caught
 *     by the earlier disc-marker rule, never reaches here).
 *   - Single-game folders rarely have 5+ files of the same extension.
 *   - Container folders (organisational ROM groupings) almost always
 *     do.
 */
const SAME_EXTENSION_THRESHOLD = 5;

/**
 * Content-based classifier. Pure: feed it the files / dirs listing for
 * a folder, get back the call. Rule order matters; PR #11 round 5
 * reorders the rules so the X68000 single-game-folder shape
 * (`<game>/<game>.zip`) classifies atomic instead of container:
 *
 *   1. Disc markers / track patterns → atomic (a `.cue` folder full of
 *      `.bin`s is the Saturn shape; the disc rule wins so the `.bin`s
 *      don't drag us into a different branch).
 *   2. Has subdirectories → container (likely an organisational tree;
 *      the user expects to drill in).
 *   3. Many files share a single extension → container. Catches NEOGEO
 *      (30+ `.zip` files in `1 World A-Z/`) and the long tail of
 *      formats we haven't enumerated (`.neo` was the original
 *      motivator).
 *   4. Known cart / archive extension → atomic. The folder is one
 *      game whose ROM is a single archive/cart file; companion files
 *      (manuals, art) sit alongside.
 *   5. Otherwise → unknown (resolves to atomic for safety).
 */
export function classifyFolder(contents: FolderContents): FolderClassification {
  if (hasDiscMarker(contents.files) || hasTrackPattern(contents.files)) {
    return 'atomic';
  }
  if (contents.dirs.length > 0) {
    return 'container';
  }
  if (hasManySameExtension(contents.files)) {
    return 'container';
  }
  if (hasCartExtension(contents.files)) {
    return 'atomic';
  }
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

/**
 * True iff at least `SAME_EXTENSION_THRESHOLD` files share a single
 * (case-insensitive) extension. Files without an extension don't
 * count; case is normalised inside `extensionOf`. Short-circuits as
 * soon as any extension hits the threshold, so a 10000-file folder
 * stops counting after the fifth match.
 */
function hasManySameExtension(files: readonly string[]): boolean {
  const counts = new Map<string, number>();
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext === '') continue;
    const next = (counts.get(ext) ?? 0) + 1;
    if (next >= SAME_EXTENSION_THRESHOLD) return true;
    counts.set(ext, next);
  }
  return false;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return '';
  return name.slice(dot).toLowerCase();
}
