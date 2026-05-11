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

/** Map of absolute-on-device-path → mtime epoch (seconds since 1970). */
export type WitnessMtimes = Readonly<Record<string, number>>;

export interface PrimeOutput {
  /** Raw JSON string for the ledger file. Empty when missing. */
  readonly ledgerJson: string;
  /** Raw JSON string for the system-files marks file. Empty when missing. */
  readonly marksJson: string;
  /** Raw JSON string for the folder-classifications file. Empty when missing. */
  readonly classificationsJson: string;
  /**
   * Mtime epoch (seconds) per witness path. Missing or absent paths
   * appear in this map with value 0 — the parser preserves the path
   * key so the caller can tell "I asked but it wasn't there" apart
   * from "I never asked." `witnessesMatch` already treats 0 as a
   * mismatch.
   */
  readonly witnesses: WitnessMtimes;
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

  const witnesses: Record<string, number> = {};
  for (let i = idxWitnesses + 1; i < idxEnd; i += 1) {
    const line = lines[i] ?? '';
    if (line === '') continue;
    // Format: `<mtime> <path>` — mtime is decimal digits, path is the
    // rest. Split on the FIRST space only (paths can't contain it on
    // a real MiSTer but let's be defensive about busybox quirks).
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const mtimeStr = line.slice(0, space);
    const path = line.slice(space + 1);
    if (path === '') continue;
    const mtime = Number.parseInt(mtimeStr, 10);
    witnesses[path] = Number.isFinite(mtime) ? mtime : 0;
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
    // `stat -c '%Y %n'` emits epoch + path. Falls through to a
    // synthetic `0 <path>` line when the path doesn't exist so the
    // parser can tell apart "missing on device" from "I never asked."
    lines.push(
      `if [ -e ${shellSingleQuote(p)} ]; then stat -c '%Y %n' ${shellSingleQuote(p)} 2>/dev/null || echo "0 ${p}"; else echo "0 ${p}"; fi`,
    );
  }
  lines.push(`echo '${LABEL_END}'`);
  return lines.join('\n');
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
export function parseWitnessOutput(stdout: string): WitnessMtimes | null {
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
