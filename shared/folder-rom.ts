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
  /**
   * fix/count-and-status-indicator commit 1: optional basename of the
   * folder being classified. Enables the "folder name appears as a
   * prefix in every child filename → atomic" branch of the
   * shared-prefix rule. Optional for back-compat — fixtures and
   * legacy callers that don't supply it skip just that branch; the
   * length-based shared-prefix branch still fires.
   */
  readonly folderName?: string;
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
 * fix/scrape-and-count-correctness commit 3: above this many
 * distinct game-groups (after `.cue + .bin` grouping), a disc-marker
 * folder flips from atomic to container — the user is looking at a
 * collection (PSX `_translations/` with 30 `.iso` files, MegaCD
 * `Romhacks/` with many discs), not one game. Same numeric threshold
 * as `SAME_EXTENSION_THRESHOLD` for consistency.
 *
 * One Saturn dump = 1 group (the .cue claims its bins) → atomic.
 * A multi-disc release = 2-4 groups → atomic.
 * A collection with 6+ discs → container.
 */
const DISC_COLLECTION_THRESHOLD = 5;

/**
 * fix/count-and-status-indicator commit 1 — shared-prefix-atomic rule.
 *
 * X68000 single-game folders look like
 *   `Akumajou Dracula (Konami)/Akumajou Dracula [FD].zip`
 *   `Akumajou Dracula (Konami)/Akumajou Dracula [HD].zip`
 *   `Akumajou Dracula (Konami)/Akumajou Dracula (cheat menu 3) [FD].zip`
 *   …
 * — 8 .zip variants of the SAME game (region/format/extras splits the
 * dump community ships separately). Pre-fix the
 * `hasManySameExtension` rule fired on the 5+ .zip count and pinned
 * those folders to container, inflating the sidebar from 4 visible
 * games to 1155 individual file rows.
 *
 * The shared-prefix rule pins to atomic when:
 *   - All filenames (stems, lowercased) share a longest-common-prefix
 *     of at least `SHARED_PREFIX_MIN_LENGTH` characters, OR
 *   - The LCP covers at least `SHARED_PREFIX_MIN_RATIO` of the
 *     shortest stem (catches short-titled games like "Lagoon" where a
 *     6-char absolute LCP misses the absolute floor but is the entire
 *     game name), OR
 *   - The folder's basename (case-insensitive) is itself a prefix of
 *     every child filename's stem ("Final Fantasy VII/" containing
 *     "Final Fantasy VII (Disc 1).chd" + "Final Fantasy VII (Disc 2).chd"
 *     etc).
 *
 * The rule needs to fire BEFORE both `hasManySameExtension` (rule 5
 * pre-fix) AND the disc-collection refinement (rule 2's >5-groups
 * branch) so a folder of multi-disc releases doesn't accidentally
 * flip to container.
 */
const SHARED_PREFIX_MIN_LENGTH = 10;
const SHARED_PREFIX_MIN_RATIO = 0.4;
/**
 * Even on the ratio path, the LCP must be at least this many
 * characters. Without this floor a folder of `g1.zip` / `g2.zip` /
 * `g3.zip` would qualify (1-char LCP, ratio 0.5) — synthetic
 * test-ish naming the rule isn't meant to catch. Real-world
 * shared-prefix folders ("Lagoon (FD).zip" etc) clear 3 chars
 * comfortably.
 */
const SHARED_PREFIX_RATIO_MIN_LENGTH = 3;

/**
 * Content-based classifier. Pure: feed it the files / dirs listing for
 * a folder, get back the call. Rule order matters; PR #11 round 5
 * reorders the rules so the X68000 single-game-folder shape
 * (`<game>/<game>.zip`) classifies atomic instead of container:
 *
 *   1. Disc markers / track patterns / floppy-disk images → atomic
 *      UNLESS the folder is a flat disc collection (commit 3
 *      refinement). A `.cue` folder full of `.bin`s is the Saturn
 *      shape; a multi-disk X68000 game is `<name>/disk1.dim` +
 *      `disk2.dim` + …; both pin to atomic. But a flat folder with
 *      6+ distinct disc-image groups (PSX `_translations/` shape)
 *      flips to container so the user can drill in to pick a game.
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
  // Floppy precedence (fix/floppy-folder-classification): any floppy
  // disk image pins to atomic, regardless of count. Multi-disk
  // computer games are still one game per folder.
  if (hasFloppyExtension(contents.files)) {
    return 'atomic';
  }
  // fix/count-and-status-indicator commit 1: shared-prefix-atomic
  // fires AHEAD of the many-same-extension and disc-collection rules
  // so X68000-shape folders ("Akumajou Dracula (Konami)/" with 8
  // variant .zip files all sharing the game name) classify atomic
  // instead of container. Multi-disc releases ("Final Fantasy VII/"
  // with 3 .chd discs) also catch this rule via the folder-name
  // branch and stay atomic regardless of the disc-collection count.
  if (hasSharedPrefixAtomic(contents.files, contents.folderName)) {
    return 'atomic';
  }
  // Disc-marker / track-pattern: atomic in the typical Saturn /
  // MegaCD shape, container when the folder is a flat collection
  // (commit 3). The threshold check uses `countRomGroups` so a
  // single `.cue + .bin` set counts as one group, not many.
  if (hasDiscMarker(contents.files) || hasTrackPattern(contents.files)) {
    if (
      contents.dirs.length === 0 &&
      countRomGroups(contents.files) > DISC_COLLECTION_THRESHOLD
    ) {
      return 'container';
    }
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

/**
 * fix/scrape-and-count-correctness commit 2 — disc-set grouping.
 *
 * One game is one row. A multi-track Saturn / MegaCD / PCE-CD dump
 * lives as a `<stem>.cue` plus several `<stem>...bin` siblings —
 * the user sees one game, not a `.cue` row plus six `.bin` rows.
 * Container counts (sidebar recursive total, drill-in row count)
 * collapse those siblings into the one row the user thinks about.
 *
 * Rule (precedence top to bottom):
 *   1. Each `.cue` file claims sibling `.bin` files whose basename
 *      starts with the cue's stem at a name boundary (the next
 *      character is not alphanumeric — `Game.cue` claims
 *      `Game (Track 01).bin` but not `Gameboy.bin`).
 *   2. The longest matching cue stem wins when several could claim
 *      the same `.bin` (`Game Disc 2.cue` beats `Game.cue` for
 *      `Game Disc 2 (Track 01).bin`).
 *   3. `.bin` files no cue claims are their own group (one per
 *      file — typically a standalone track dump).
 *   4. Every other file is its own group, regardless of extension —
 *      `.iso`, `.chd`, `.gdi`, `.zip`, `.dim`, `.nes` etc. all
 *      contribute one group per file. Multi-disk floppy games
 *      (`Game Disk 1.dim` + `Game Disk 2.dim`) DO NOT collapse at
 *      this layer; the atomic-folder classifier handles those by
 *      treating the whole folder as one game (1 by definition).
 */
export interface RomGroup {
  /**
   * The "first" file in the group as encountered in input order.
   * For a `.cue+.bin` set this is the `.cue` (cues are emitted
   * before their members during the assignment pass).
   */
  readonly representative: string;
  readonly files: readonly string[];
}

export function groupRomFiles(files: readonly string[]): readonly RomGroup[] {
  // Pass 1: collect cue stems, longest first so `Game Disc 2.cue`
  // beats `Game.cue` when both could claim the same `.bin`.
  const cueStems: { stem: string; key: string }[] = [];
  for (const f of files) {
    if (extensionOf(f) === '.cue') {
      const stem = stemOf(f).toLowerCase();
      cueStems.push({ stem, key: `cue:${f.toLowerCase()}` });
    }
  }
  cueStems.sort((a, b) => b.stem.length - a.stem.length);

  // Pass 2: assign each file to a group. Map preserves insertion
  // order so the result is stable for tests and the user's visual
  // expectation (cues before their members; standalone files in the
  // order they appeared).
  const groups = new Map<string, string[]>();
  const addTo = (key: string, file: string): void => {
    const list = groups.get(key);
    if (list) list.push(file);
    else groups.set(key, [file]);
  };

  for (const f of files) {
    const ext = extensionOf(f);
    if (ext === '.cue') {
      addTo(`cue:${f.toLowerCase()}`, f);
      continue;
    }
    if (ext === '.bin') {
      const lower = f.toLowerCase();
      const claim = cueStems.find((c) =>
        boundaryStartsWith(lower, c.stem),
      );
      if (claim) {
        addTo(claim.key, f);
        continue;
      }
    }
    addTo(`file:${f.toLowerCase()}`, f);
  }

  const out: RomGroup[] = [];
  for (const list of groups.values()) {
    out.push({ representative: list[0]!, files: list });
  }
  return out;
}

/**
 * Group-count without materializing the groups themselves. Equivalent
 * to `groupRomFiles(files).length` but skips the array-of-arrays
 * allocation — the matcher's recursive walk calls this hot for every
 * parent bucket across thousands of files.
 */
export function countRomGroups(files: readonly string[]): number {
  return groupRomFiles(files).length;
}

function stemOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? filename : filename.slice(0, dot);
}

/**
 * fix/count-and-status-indicator commit 1 — shared-prefix detector.
 *
 * Returns true when the folder's filename pattern looks like
 * "variants of one game" rather than "a collection of games":
 *   - Folder name (case-insensitive) is a prefix of every child
 *     filename's stem (`Final Fantasy VII/` containing
 *     `Final Fantasy VII (Disc 1).chd` etc).
 *   - LCP across all stems (lowercased, extension-stripped) is at
 *     least `SHARED_PREFIX_MIN_LENGTH` characters.
 *   - LCP covers at least `SHARED_PREFIX_MIN_RATIO` of the shortest
 *     stem (lifts short-titled games like "Lagoon" whose absolute
 *     LCP is ~6 chars but is the entire game name).
 *
 * Single-file folders skip this rule — the existing cart-ext branch
 * handles "1 cart file = atomic". Two or more files required.
 */
function hasSharedPrefixAtomic(
  files: readonly string[],
  folderName: string | undefined,
): boolean {
  // Filter out OS junk and non-launchable noise so a stray .DS_Store
  // or a manual.txt can't poison the shared-prefix calc by dragging
  // the LCP to empty. Same launchable filter the count rule uses.
  const candidates = files.filter((f) => isLaunchableRomExtension(f));
  if (candidates.length < 2) return false;

  const stems = candidates.map((f) => stemOf(f).toLowerCase());

  if (folderName !== undefined && folderName.length > 0) {
    const fNorm = folderName.toLowerCase();
    if (stems.every((s) => s.startsWith(fNorm))) {
      return true;
    }
  }

  const lcp = longestCommonPrefix(stems);
  if (lcp.length === 0) return false;

  if (lcp.length >= SHARED_PREFIX_MIN_LENGTH) return true;

  if (lcp.length < SHARED_PREFIX_RATIO_MIN_LENGTH) return false;

  let shortest = stems[0]!.length;
  for (let i = 1; i < stems.length; i += 1) {
    if (stems[i]!.length < shortest) shortest = stems[i]!.length;
  }
  if (shortest > 0 && lcp.length >= shortest * SHARED_PREFIX_MIN_RATIO) {
    return true;
  }

  return false;
}

/**
 * Longest common prefix across the input strings. Empty when any
 * string is empty or the strings disagree from the first character.
 */
function longestCommonPrefix(strings: readonly string[]): string {
  if (strings.length === 0) return '';
  let prefix = strings[0]!;
  for (let i = 1; i < strings.length; i += 1) {
    const s = strings[i]!;
    while (prefix.length > 0 && !s.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
    if (prefix.length === 0) return '';
  }
  return prefix;
}

/**
 * True iff `name` starts with `prefix` AND the next character (if
 * any) is a name boundary — i.e. not `[a-z0-9]`. Both arguments are
 * already lowercase per the call site. Prevents `Game.cue`'s stem
 * `game` from claiming `Gameboy.bin` (which starts with `game` but
 * extends into another alphanumeric token, so it's not a sibling
 * track).
 */
function boundaryStartsWith(name: string, prefix: string): boolean {
  if (!name.startsWith(prefix)) return false;
  if (name.length === prefix.length) return true;
  const c = name.charCodeAt(prefix.length);
  const isAlphaNumeric =
    (c >= 48 && c <= 57) || (c >= 97 && c <= 122);
  return !isAlphaNumeric;
}
