/**
 * Parser for the connect-time prime shell output. The shell emits one
 * combined stdout that contains the ledger, system-files marks,
 * folder classifications, and a set of witness mtimes — all in a
 * single SSH round trip (PR #12).
 *
 * Output format (one section per labelled line, ASCII-only):
 *
 *   LEDGER\n
 *   <base64 of /media/fat/.mistercurator/state.json | empty>\n
 *   MARKS\n
 *   <base64 of /media/fat/.mistercurator/system-files.json | empty>\n
 *   CLASSIFICATIONS\n
 *   <base64 of /media/fat/.mistercurator/folder-classifications.json | empty>\n
 *   WITNESSES\n
 *   <mtime> <path>\n            (one per witness; missing → mtime 0)
 *   ...
 *   END\n
 *
 * Each file payload is a single base64 line (the shell pipes through
 * `tr -d '\n'` to de-wrap whatever busybox `base64` does by default).
 * Empty payload → empty file or missing file. The decoder produces a
 * plain JSON string the existing per-domain parsers consume — they
 * already handle empty-string input gracefully.
 *
 * This module is pure and lives in `shared/` so both clients
 * (`real-mister-client`, `fake-mister-client`) can reuse it for
 * tests, and the parser surface is testable without an SSH stack.
 */

/**
 * Map of absolute-on-device-path → witness value. Two value flavours
 * coexist because different caches need different invalidation
 * granularity:
 *
 *   number — mtime epoch (seconds since 1970). Sensitive to ANY dir
 *     touch (filesystem updates parent mtime on add/remove/rename of
 *     children, AND on `touch` of the dir itself). Used by the
 *     arcade-mra-meta cache and the per-core roms caches.
 *
 *   string — 32-char hex content fingerprint, or the sentinel `'0'`
 *     for missing-on-device. Stable across pointless dir touches
 *     (downloaders / update_all bump `_Console/` mtime without
 *     actually adding an rbf — would force a 19.7s cores walk on
 *     every reconnect under the mtime regime). Used by the cores
 *     cache to drop that re-walk.
 *
 * Comparator `witnessesMatch` branches on the typeof. A cache file
 * written by an older app version (all numbers) compared against
 * fresh content-hash values (strings) fails on type mismatch and
 * self-heals into the new format on the next walk.
 */
export type WitnessMtimes = Readonly<Record<string, number | string>>;

export interface PrimeOutput {
  /** Raw JSON string for the ledger file. Empty when missing. */
  readonly ledgerJson: string;
  /** Raw JSON string for the system-files marks file. Empty when missing. */
  readonly marksJson: string;
  /** Raw JSON string for the folder-classifications file. Empty when missing. */
  readonly classificationsJson: string;
  /**
   * Content-hash digest per cores-witness path: a 32-char hex md5 of
   * the dir's .rbf/.mgl set (sorted basename+mtime, md5'd), or the
   * `'0'` sentinel for paths that aren't directories on the device.
   */
  readonly witnesses: Readonly<Record<string, string>>;
}

/** Sentinel labels in the prime output. ASCII only, never inside a base64 chunk. */
const LABEL_LEDGER = 'LEDGER';
const LABEL_MARKS = 'MARKS';
const LABEL_CLASSIFICATIONS = 'CLASSIFICATIONS';
const LABEL_WITNESSES = 'WITNESSES';
const LABEL_END = 'END';

const SECTION_LABELS: ReadonlySet<string> = new Set([
  LABEL_LEDGER,
  LABEL_MARKS,
  LABEL_CLASSIFICATIONS,
  LABEL_WITNESSES,
  LABEL_END,
]);

/** Lenient parser. Returns `null` on any structural mismatch. */
export function parsePrimeOutput(stdout: string): PrimeOutput | null {
  const lines = stdout.split('\n');
  // Index the labelled lines so we can pull the payload range for
  // each section without assuming a fixed order.
  const labelIdx = new Map<string, number>();
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (SECTION_LABELS.has(line)) {
      // First occurrence wins — defensive against duplicate labels
      // in pathological output.
      if (!labelIdx.has(line)) labelIdx.set(line, i);
    }
  }
  const idxLedger = labelIdx.get(LABEL_LEDGER);
  const idxMarks = labelIdx.get(LABEL_MARKS);
  const idxClassifications = labelIdx.get(LABEL_CLASSIFICATIONS);
  const idxWitnesses = labelIdx.get(LABEL_WITNESSES);
  const idxEnd = labelIdx.get(LABEL_END);
  if (
    idxLedger === undefined ||
    idxMarks === undefined ||
    idxClassifications === undefined ||
    idxWitnesses === undefined ||
    idxEnd === undefined
  ) {
    return null;
  }
  // Sections are written in a fixed order by the shell; bail if the
  // emitted output deviates from it (likely truncation or corruption).
  if (
    !(idxLedger < idxMarks &&
      idxMarks < idxClassifications &&
      idxClassifications < idxWitnesses &&
      idxWitnesses < idxEnd)
  ) {
    return null;
  }

  const ledgerJson = decodeBase64Chunk(lines, idxLedger + 1, idxMarks);
  const marksJson = decodeBase64Chunk(lines, idxMarks + 1, idxClassifications);
  const classificationsJson = decodeBase64Chunk(
    lines,
    idxClassifications + 1,
    idxWitnesses,
  );

  // PrimeOutput.witnesses is content-hash flavour — `buildPrimeScript`
  // emits the cores witnesses via the find/md5sum pipeline. Each value
  // is either a 32-char hex digest or the `'0'` missing sentinel.
  const witnesses: Record<string, string> = {};
  for (let i = idxWitnesses + 1; i < idxEnd; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const valueStr = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path === '') continue;
    witnesses[path] = normaliseContentHashValue(valueStr);
  }

  return {
    ledgerJson,
    marksJson,
    classificationsJson,
    witnesses,
  };
}

/**
 * Decode a single-line base64 chunk between `[startLine, endLine)`.
 * The shell emits the file payload as one line of base64 (or an
 * empty line when the file doesn't exist). Multi-line chunks are
 * concatenated before decoding — defensive against buffering edge
 * cases on the SSH stream.
 */
function decodeBase64Chunk(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): string {
  let payload = '';
  for (let i = startLine; i < endLine; i += 1) {
    payload += lines[i] ?? '';
  }
  if (payload === '') return '';
  try {
    return Buffer.from(payload, 'base64').toString('utf-8');
  } catch {
    // Bad base64 → treat as missing file (lenient: same as the
    // pre-PR-12 behavior where a corrupted JSON file → empty ledger).
    return '';
  }
}

/**
 * Build the prime shell script. Same pattern as the existing list-
 * cores script — one self-contained script the client passes to
 * `ssh.execCommand` verbatim. Caller supplies the cores witness paths
 * (typically the four hideable category dirs + the games root).
 *
 * Why base64: the JSON files we read may contain any UTF-8 byte and
 * any newline pattern. Wrapping them in base64 keeps the wire format
 * single-line ASCII, eliminating section-delimiter ambiguity entirely.
 * `tr -d '\n'` collapses whatever line wrapping busybox `base64`
 * applies (varies by version). Decoder side handles concatenated
 * lines too as belt-and-suspenders.
 */
export function buildPrimeScript(args: {
  readonly ledgerPath: string;
  readonly marksPath: string;
  readonly classificationsPath: string;
  readonly coresWitnessPaths: readonly string[];
}): string {
  const lines: string[] = [];
  // Each section: emit the label, then a single base64 line (or empty
  // line when the file is missing).
  const emitFile = (label: string, path: string): void => {
    lines.push(`echo '${label}'`);
    // `2>/dev/null || true` keeps a missing file from poisoning the
    // exit code. `tr -d '\n'` flattens base64's default 76-col wrap
    // (busybox base64 may or may not wrap — defensive).
    lines.push(
      `if [ -f ${shellSingleQuote(path)} ]; then base64 < ${shellSingleQuote(path)} 2>/dev/null | tr -d '\\n'; fi`,
    );
    lines.push('echo');
  };
  emitFile(LABEL_LEDGER, args.ledgerPath);
  emitFile(LABEL_MARKS, args.marksPath);
  emitFile(LABEL_CLASSIFICATIONS, args.classificationsPath);

  lines.push(`echo '${LABEL_WITNESSES}'`);
  for (const p of args.coresWitnessPaths) {
    // Cores cache uses CONTENT-HASH witnesses, not directory mtimes.
    // A bulk `touch` from update_all.sh would otherwise force a
    // 19.7s walk on every reconnect even though no .rbf/.mgl
    // actually changed. See `buildCoresWitnessHashShellLine` for the
    // shell shape and rationale.
    lines.push(buildCoresWitnessHashShellLine(p));
  }
  lines.push(`echo '${LABEL_END}'`);
  return lines.join('\n');
}

/**
 * Build the per-path shell statement for cores-witness content
 * hashing. Emits exactly one line of the form `<hash> <path>` where
 * `<hash>` is a 32-char hex md5 of every direct-child .rbf/.mgl
 * file's name+mtime in `<path>`, or the sentinel `0` when the path
 * isn't a directory.
 *
 * Filter details:
 *   - `-mindepth 1 -maxdepth 1` keeps the scan to immediate children
 *     (we don't care about per-core games subfolders here).
 *   - `\( -type d -name '.*' -prune \)` excludes hidden subdirs so a
 *     stray `.Scripts/` or `.cache/` doesn't pollute the digest.
 *   - `-iname '*.rbf' -o -iname '*.mgl'` are the cores-list-load-
 *     bearing files; everything else is noise.
 *   - `%P %Y` is find's basename + mtime epoch, one per line.
 *   - `sort | md5sum | cut -d' ' -f1` pins ordering and reduces to
 *     a 32-char hex digest.
 *
 * Empty dirs (no rbf/mgl files) hash to md5-of-empty
 * (`d41d8cd98f00b204e9800998ecf8427e`); two empty dirs match. The
 * `0` sentinel for missing-on-device is rejected by `witnessesMatch`
 * unconditionally, same contract as the mtime side.
 */
function buildCoresWitnessHashShellLine(path: string): string {
  const q = shellSingleQuote(path);
  return (
    `if [ -d ${q} ]; then ` +
    `printf '%s %s\\n' "$(` +
    `find ${q} -mindepth 1 -maxdepth 1 ` +
    `\\( -type d -name '.*' -prune \\) -o ` +
    `\\( -type f \\( -iname '*.rbf' -o -iname '*.mgl' \\) -printf '%P %Y\\n' \\) ` +
    `| sort | md5sum | cut -d' ' -f1)" ${q}; ` +
    `else printf '0 %s\\n' ${q}; fi`
  );
}

/**
 * Build a one-shot content-hash check script for the cores witness
 * paths. Used by write-through refreshes (after a hide/show flips a
 * .rbf basename) and by `fetchAndCacheCores`'s post-walk witness
 * capture. Same emit format as `buildPrimeScript`'s WITNESSES
 * section, so `parseWitnessOutput` (or `parseContentHashOutput`)
 * recognises it.
 */
export function buildContentHashScript(paths: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`echo '${LABEL_WITNESSES}'`);
  for (const p of paths) {
    lines.push(buildCoresWitnessHashShellLine(p));
  }
  lines.push(`echo '${LABEL_END}'`);
  return lines.join('\n');
}

/**
 * Parse the content-hash WITNESSES-only block from `buildContentHashScript`.
 * Returns `null` on truncation. Each value is either a 32-char hex
 * md5 digest or the `'0'` missing sentinel — anything that doesn't
 * match either shape coerces to `'0'` so the comparator treats it as
 * a guaranteed miss.
 */
export function parseContentHashOutput(
  stdout: string,
): Record<string, string> | null {
  const lines = stdout.split('\n');
  let inSection = false;
  const witnesses: Record<string, string> = {};
  for (const line of lines) {
    if (line === LABEL_WITNESSES) {
      inSection = true;
      continue;
    }
    if (line === LABEL_END) return witnesses;
    if (!inSection) continue;
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const valueStr = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path === '') continue;
    witnesses[path] = normaliseContentHashValue(valueStr);
  }
  // No END marker → truncated output. Caller treats null as a miss.
  return null;
}

/**
 * Coerce a content-hash field into either a 32-char hex digest or
 * the `'0'` sentinel for missing-on-device. Anything else (a stray
 * `find` warning that leaked into the WITNESSES section, a busybox
 * `md5sum` quirk) clamps to `'0'`: the comparator rejects `'0'`
 * unconditionally, so a malformed line forces a cold walk rather
 * than serving uncertain cache data.
 */
function normaliseContentHashValue(raw: string): string {
  if (/^[0-9a-f]{32}$/.test(raw)) return raw;
  return '0';
}

/**
 * fix/count-and-status-indicator commit 4 — size + mtime batch.
 *
 * The hash-cache v3→v4 lazy migration needs both `stat -c '%s'`
 * (wrapper bytes; the new `diskSizeBytes` field) and `stat -c '%Y'`
 * (mtime; validates the v3 entry's hash is still good) in one SSH
 * round-trip. `buildWitnessScript` returns mtime alone; this
 * variant emits a 3-field line per path.
 *
 * Output line format: `<size>\t<mtime>\t<path>\n`. Missing paths
 * emit `0\t0\t<path>` so the parser can distinguish "couldn't stat"
 * from "I never asked." Tab separator (not space) so paths
 * containing spaces don't fragment.
 */
export function buildSizeAndMtimeScript(paths: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`echo '${LABEL_SIZE_MTIME}'`);
  for (const p of paths) {
    lines.push(
      `if [ -f ${shellSingleQuote(p)} ]; then ` +
        `stat -c '%s\t%Y\t%n' ${shellSingleQuote(p)} 2>/dev/null || ` +
        `printf '0\\t0\\t%s\\n' ${shellSingleQuote(p)}; ` +
        `else printf '0\\t0\\t%s\\n' ${shellSingleQuote(p)}; fi`,
    );
  }
  lines.push(`echo '${LABEL_END}'`);
  return lines.join('\n');
}

const LABEL_SIZE_MTIME = 'SIZE_MTIME';

export interface SizeAndMtime {
  readonly size: number;
  readonly mtime: number;
}

/**
 * Parse the SIZE_MTIME block. Returns null when the END marker is
 * absent (truncated output) so callers treat the response as a
 * cache miss rather than wrong data.
 *
 * Path may contain tabs (rare but legal POSIX). The two leading
 * numeric fields are split on the first two tabs; everything after
 * the second tab is the path verbatim.
 */
export function parseSizeAndMtimeOutput(
  stdout: string,
): Record<string, SizeAndMtime> | null {
  const out: Record<string, SizeAndMtime> = {};
  let inSection = false;
  for (const line of stdout.split('\n')) {
    if (line === LABEL_SIZE_MTIME) {
      inSection = true;
      continue;
    }
    if (line === LABEL_END) return out;
    if (!inSection) continue;
    if (line === '') continue;
    const t1 = line.indexOf('\t');
    if (t1 < 0) continue;
    const t2 = line.indexOf('\t', t1 + 1);
    if (t2 < 0) continue;
    const sizeStr = line.slice(0, t1);
    const mtimeStr = line.slice(t1 + 1, t2);
    const path = line.slice(t2 + 1);
    if (path === '') continue;
    const size = Number.parseInt(sizeStr, 10);
    const mtime = Number.parseInt(mtimeStr, 10);
    out[path] = {
      size: Number.isFinite(size) && size >= 0 ? size : 0,
      mtime: Number.isFinite(mtime) && mtime >= 0 ? mtime : 0,
    };
  }
  return null;
}

/**
 * Build a one-shot witness-check script for the given paths. Used by
 * `listRoms` cache validation and write-through stat refreshes.
 */
export function buildWitnessScript(paths: readonly string[]): string {
  const lines: string[] = [];
  lines.push(`echo '${LABEL_WITNESSES}'`);
  for (const p of paths) {
    lines.push(
      `if [ -e ${shellSingleQuote(p)} ]; then stat -c '%Y %n' ${shellSingleQuote(p)} 2>/dev/null || echo "0 ${p}"; else echo "0 ${p}"; fi`,
    );
  }
  lines.push(`echo '${LABEL_END}'`);
  return lines.join('\n');
}

/**
 * Parse the `WITNESSES`-only output from `buildWitnessScript`. Same
 * delimiter pattern as the prime parser; just no file payloads.
 */
export function parseWitnessOutput(
  stdout: string,
): Record<string, number> | null {
  const lines = stdout.split('\n');
  let inSection = false;
  const witnesses: Record<string, number> = {};
  for (const line of lines) {
    if (line === LABEL_WITNESSES) {
      inSection = true;
      continue;
    }
    if (line === LABEL_END) {
      return witnesses;
    }
    if (!inSection) continue;
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const mtimeStr = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path === '') continue;
    const mtime = Number.parseInt(mtimeStr, 10);
    witnesses[path] = Number.isFinite(mtime) ? mtime : 0;
  }
  // No END marker → likely truncated output. Conservatively return
  // null so the caller treats it as a miss (re-fetch from network).
  return null;
}

/**
 * POSIX-safe single-quote escape: wraps in single quotes and escapes
 * any embedded single quote via the `'\''` idiom. Mirrors the
 * `shellQuote` helper in `app/main/clients/shell.ts`; defined here
 * to keep this module dependency-free for shared/.
 */
function shellSingleQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}
