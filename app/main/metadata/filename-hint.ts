/**
 * PR-D1 (PR #27) — filename hint extraction.
 *
 * When a hash lookup misses (SS by-hash + OpenVGDB both miss), the
 * filename and parent-folder name often carry a recognizable
 * identifier we can hand to ScreenScraper's `jeuRecherche.php`
 * (name-search) endpoint. Examples this module catches:
 *
 *   • Parent-folder hint (atomic-folder shape):
 *     `Metal Slug 2 (USA)/mslug2.neo` → "Metal Slug 2 (USA)"
 *   • Paren short-name (NEOGEO MAME-style ROM names):
 *     `Metal Slug 2 (mslug2).neo` → "mslug2"
 *   • Filename stem (cartridge-format dumps with metadata in parens):
 *     `Castlevania - Symphony of the Night (USA).iso` →
 *       "Castlevania - Symphony of the Night"
 *
 * Returned in priority order — the caller tries each in turn and
 * short-circuits on the first high-confidence search hit.
 *
 * The module is purely string manipulation — no IPC, no SSH, no
 * filesystem. Tested in isolation with a wide fixture set.
 */

export interface NameHint {
  /**
   * Where the hint came from. Useful in logs to debug which signal
   * recovered a row, and so the caller can tune per-source thresholds
   * (the parent-folder hint is the strongest signal for atomic
   * folders; the paren-shortname is the strongest for arcade /
   * MAME-style names).
   */
  readonly source: 'folder' | 'paren-shortname' | 'filename-stem';
  readonly value: string;
}

/**
 * Extract every plausible name hint from a filename + optional
 * parent-folder name. Returns hints in priority order — most
 * authoritative first. The caller searches in order and stops on
 * the first high-confidence match (see `name-match.ts` for scoring).
 *
 * Empty / whitespace-only strings are dropped; duplicate values
 * across sources are NOT deduplicated (the caller may want to know
 * the source that matched even when the values agree).
 */
export function extractNameHints(args: {
  readonly filename: string;
  /** Basename of the immediate parent dir, or undefined if at core root. */
  readonly parentFolder?: string;
  /**
   * Round 2 (PR #27 round 2): true iff the parent folder is an
   * atomic single-game folder (`folder-atomic` shape — X68000-style
   * `Metal Slug 2 (USA)/mslug2.neo`). The folder name is then a
   * curated game title and is the strongest hint.
   *
   * For organizational / browsable container folders (NEOGEO's
   * `1 World A-Z/`, NES's `Hacks/`), the folder name is a category
   * grouping, not a game title — emitting it as a hint wastes API
   * calls returning no candidates.
   *
   * Default `false` (or undefined): treat the parent as
   * organizational. Caller MUST set true explicitly when it knows
   * the folder is atomic. Conservative — wrong-direction defaults
   * burn rate-limit budget; right-direction defaults silently
   * suppress a useful hint that the file-stem fallback usually
   * recovers.
   */
  readonly parentFolderIsAtomic?: boolean;
}): readonly NameHint[] {
  const hints: NameHint[] = [];

  // 1. parentFolder — strongest signal for atomic folders. The folder
  //    name is human-curated (`Metal Slug 2 (USA)`) and survives
  //    rename / re-dump cycles better than the inner file name.
  //    Round 2: gated on `parentFolderIsAtomic` so organizational
  //    folders (`1 World A-Z`, `Hacks`) don't waste API budget.
  if (args.parentFolder !== undefined && args.parentFolderIsAtomic === true) {
    const cleaned = cleanForSearch(args.parentFolder);
    if (cleaned !== '') {
      hints.push({ source: 'folder', value: cleaned });
    }
  }

  // 2. paren-shortname — captures arcade-style ROM identifiers
  //    embedded in parens at the end of the filename. Pattern:
  //    `<anything> (<short-id>).<ext>` where the short-id matches
  //    `[a-z0-9_]+` (case-sensitive lowercase, no spaces). Avoids
  //    matching region tags like `(USA)` or `(Rev 1)` because those
  //    contain uppercase letters or whitespace.
  const parenMatch = PAREN_SHORTNAME_RE.exec(args.filename);
  if (parenMatch !== null) {
    const value = parenMatch[1] ?? '';
    if (value !== '') {
      hints.push({ source: 'paren-shortname', value });
    }
  }

  // 3. filename-stem — strip extension, paren content, bracket
  //    content, normalize whitespace. Often produces the canonical
  //    game name for cartridge-format dumps.
  const stem = stemFromFilename(args.filename);
  if (stem !== '') {
    hints.push({ source: 'filename-stem', value: stem });
  }

  return hints;
}

/**
 * Lowercase short-name pattern: `<filename body> (<short-id>).<ext>`
 * where `<short-id>` is `[a-z0-9_]+`. The case-sensitivity is the
 * load-bearing bit — region tags like `(USA)`, `(Europe)`, `(Rev 1)`
 * have uppercase letters or spaces and don't match. This isolates the
 * MAME / arcade-style romset name (e.g. `mslug2`, `kof97`,
 * `samsho4`) which is what ScreenScraper's `jeuRecherche` indexes.
 */
const PAREN_SHORTNAME_RE = /\(([a-z0-9_]+)\)\.[a-z0-9]+$/;

/**
 * Strip the final extension (anything after the last `.`). Returns the
 * input verbatim when there's no `.` so directories / extension-less
 * filenames pass through.
 */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return name;
  return name.slice(0, dot);
}

/**
 * Produce the filename-stem hint: extension off, paren content out,
 * bracket content out, whitespace collapsed, surrounding whitespace
 * trimmed. Common region-tag noise (`(USA)`, `[Beta]`, `(Rev 1)`)
 * disappears so the result is closer to the canonical game name.
 */
function stemFromFilename(filename: string): string {
  return cleanForSearch(stripExtension(filename));
}

/**
 * Strip parenthesized + bracketed parts and normalize whitespace.
 * Used for both parent-folder hints and the filename-stem fallback —
 * the goal is the canonical-looking name without dump-metadata noise.
 */
function cleanForSearch(input: string): string {
  return input
    // Strip `(...)` non-greedy so multiple parens each get removed.
    .replace(/\s*\([^)]*\)/gu, '')
    // Strip `[...]` similarly.
    .replace(/\s*\[[^\]]*\]/gu, '')
    // Collapse internal whitespace runs to a single space.
    .replace(/\s+/gu, ' ')
    // Trim surrounding whitespace.
    .trim();
}
