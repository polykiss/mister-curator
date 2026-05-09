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
  // PR-B (PR #24) additions: cartridge / disk formats observed in
  // real-MiSTer libraries that the original cart list missed and
  // that the cores-list count needs to recognize. The wider
  // `isLaunchableRomExtension` filter in this module is what
  // surfaces these — `classifyFolder` also picks them up but the
  // additions don't change folder-classification outcomes in
  // practice (single-cart folders already classified atomic via
  // the unknown→atomic fallback).
  '.d64', // Commodore 64 disk image
  '.t64', // Commodore 64 tape archive
  '.crt', // Commodore 64 cartridge
  '.prg', // Commodore 64 program
  '.rom', // Generic ROM extension (BIOS-shaped names still
          // filtered by `shouldCountAsRom`'s SYSTEM_FILE_SUFFIXES
          // — `bios.rom` / `boot.rom` etc.)
  '.fds', // Famicom Disk System
  '.unf', // NES UNIF format
  '.unif',// NES UNIF format (long extension)
  '.vhd', // Apple II / various computer hard disk
  '.do',  // Apple II DOS disk image
  '.po',  // Apple II ProDOS disk image
  '.atr', // Atari 8-bit disk image
  '.atx', // Atari 8-bit disk image (extended)
  '.xex', // Atari 8-bit executable
]);

/**
 * Floppy / disk-image extensions for computer cores (X68000, Amiga,
 * Atari ST, Apple II, C64, Amstrad CPC, Spectrum, BBC Micro …).
 *
 * fix/floppy-folder-classification — a multi-disk computer game lives
 * in a folder with 2-4 (or sometimes more) disk-image files plus
 * occasionally a manual / saves subdir. Pre-fix:
 *   • 2-4 files → no rule fired → unknown → atomic via fallback (OK)
 *   • 5+ files of one extension (rare, but exists) → many-same rule
 *     fired → container → user had to drill in to load anything (BUG)
 *   • 2-4 floppy files + a `Manuals/` subdir → dirs.length > 0 rule
 *     fired → container → same drill-in friction (BUG)
 *
 * Wired into `classifyFolder` rule 1 (the same precedence as
 * `hasDiscMarker`): ANY floppy file in the folder pins the
 * classification to atomic, overriding both the many-same-extension
 * rule and the subdirs-mean-container rule. Reasoning matches the
 * disc rule — if there's a disc image (or a floppy image) sitting
 * loose in the folder, that file IS the game; subdirs are
 * companions, not distinct games.
 *
 * Some entries (`.dsk`, `.adf`, `.hdf`, `.st`, `.msa`, `.do`,
 * `.po`, `.d64`, `.t64`) are also in `CART_EXTENSIONS` from earlier
 * rounds. Keeping them in BOTH sets is intentional: CART_EXTENSIONS
 * is the "single file = one game" lookup for `isLaunchableRomExtension`
 * + the round-4 cart-shape atomic check, while FLOPPY_EXTENSIONS is
 * the override-priority atomic signal. Overlap is harmless — Set
 * membership is the same regardless of which set fires first.
 *
 * `.dsk` is overloaded across X68000 / Apple II / Amstrad CPC / etc.
 * — that's fine, the rule applies uniformly.
 */
const FLOPPY_EXTENSIONS: ReadonlySet<string> = new Set([
  // X68000
  '.dim',
  '.d88',
  '.xdf',
  '.hdm',
  '.2hd',
  '.2dd',
  // Amiga
  '.adf',
  '.adz',
  '.ipf',
  '.hdf',
  // Atari ST
  '.st',
  '.msa',
  '.stx',
  // Apple II
  '.nib',
  '.woz',
  '.po',
  '.do',
  '.2mg',
  // C64
  '.d64',
  '.d71',
  '.d81',
  '.g64',
  '.t64',
  // Amstrad CPC / X68000 / Apple II / many — the shared one
  '.dsk',
  // Spectrum (TR-DOS)
  '.trd',
  '.scl',
  // BBC Micro
  '.ssd',
  '.dsd',
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
 *   1. Disc markers / track patterns / floppy-disk images → atomic
 *      (a `.cue` folder full of `.bin`s is the Saturn shape; a
 *      multi-disk X68000 game is `<name>/disk1.dim` + `disk2.dim` +
 *      …; both pin to atomic so the rule-2/3 container signals don't
 *      drag a multi-disk game into drillable). Floppy precedence
 *      added in fix/floppy-folder-classification.
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
  if (
    hasDiscMarker(contents.files) ||
    hasTrackPattern(contents.files) ||
    hasFloppyExtension(contents.files)
  ) {
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

function hasFloppyExtension(files: readonly string[]): boolean {
  for (const f of files) {
    const ext = extensionOf(f);
    if (ext !== '' && FLOPPY_EXTENSIONS.has(ext)) return true;
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

/**
 * PR-B (PR #24) — positive launchable-extension filter for the cores-
 * list ROM count. The existing `shouldCountAsRom` in
 * `shared/system-files.ts` is a NEGATIVE filter: it excludes files
 * inside system folders (`Palettes`, `Overlays`, `Filters`, `old`)
 * and BIOS-named files, but doesn't check that the leaf extension is
 * something the MiSTer can actually launch. The result was visible
 * in the sidebar: NES counted ~680 ROMs because `.png` screenshots
 * inside `Hacks/`, `.ips` patches, `.nfo` notes, etc. all passed
 * through (the parent folder isn't in the system-folder list, the
 * file extension isn't BIOS-shaped).
 *
 * This helper layers a POSITIVE filter on top: a file counts only if
 * its extension is a known launchable cartridge / archive format
 * (`CART_EXTENSIONS`) or a disc image (`DISC_EXTENSIONS`). Both lists
 * already exist in this module — `classifyFolder` uses them — and
 * cover the full set of formats the project enumerates today.
 *
 * Returns `false` for files with no extension, files whose extension
 * isn't in either set, and dot-prefixed-only names (like `.DS_Store`).
 * The check is case-insensitive (`extensionOf` lowercases). Combine
 * with `shouldCountAsRom` at the count call sites — see
 * `app/main/clients/real-mister-client.ts` (F-line aggregation) and
 * `shared/core-matching.ts` (top-level file filter).
 */
export function isLaunchableRomExtension(filename: string): boolean {
  const ext = extensionOf(filename);
  if (ext === '') return false;
  return (
    CART_EXTENSIONS.has(ext) ||
    DISC_EXTENSIONS.has(ext) ||
    FLOPPY_EXTENSIONS.has(ext)
  );
}
