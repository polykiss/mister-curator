/**
 * feat/arcade-playability-data (PR 1/2) — pure parser for the
 * load-bearing slice of a `.mra` XML head: the rbf, setname, and
 * the zip attrs across every `<rom ... zip="...">` block.
 *
 * Why a hand-rolled regex parser rather than an XML library:
 *   • The format is well-bounded — we only need four pieces of
 *     information, and they all live within the first ~100 lines.
 *   • Real .mra files in the wild use both `"double"` and `'single'`
 *     quoted attribute values (e.g. `_alternatives/_ASO/Alpha
 *     Mission.mra` uses `zip='alphamis.zip|aso.zip'`). A tiny regex
 *     handles both; pulling in xml2js or sax just to read four tags
 *     is overkill for a hot prefetch path.
 *   • We want byte-for-byte parity with the server-side awk that
 *     produces the same TSV — keeping both sides regex/sed-shaped
 *     means the parity is auditable in one glance.
 *
 * Caller passes the raw text head of one .mra (head -c ~4KB is
 * enough — the load-bearing tags are all in the first lines) plus
 * the `relativePath` known from the listing. The parser only
 * looks at the XML; the relativePath is plumbed straight through
 * so `displayName` + `hidden` can be set the same way
 * `parseArcadeMraEntries` does.
 *
 * PR-2 will consume `requiredZips` against an in-memory zip-set
 * derived from `listArcadeZipBasenames` to decide playability.
 */

export interface ArcadeMraMeta {
  /**
   * Path relative to `MISTER_ARCADE_DIR`. Top-level entries are
   * just the basename (`Galaga.mra`); nested entries use slash
   * (`_Konami/TMNT.mra`). Matches the `relativePath` shape from
   * `parseArcadeMraEntries`.
   */
  readonly relativePath: string;
  /** Filename without any leading-dot hide marker. */
  readonly displayName: string;
  /** True iff the basename starts with `.` (the hide convention). */
  readonly hidden: boolean;
  /**
   * Zip-attr values grouped by `<rom>` block in document order.
   * Outer list = one entry per `<rom ... zip="...">` block that
   * actually carries a zip attr (no-zip blocks are dropped).
   * Inner list = the pipe-fallback alternatives from one attr,
   * split on `|`. So
   *   `zip="galaga.zip|galagamw.zip"`
   * becomes
   *   `[['galaga.zip', 'galagamw.zip']]`
   * and a two-block ST-V .mra becomes
   *   `[['stvbios.zip'], ['astrass.zip']]`.
   *
   * An empty outer list means the .mra references no zips at all
   * (a TTL / discrete-logic game like `Computer Space.mra`).
   */
  readonly requiredZips: readonly (readonly string[])[];
  /** The base core `.rbf` (e.g. `'galaga'`). Empty if absent. */
  readonly rbf: string;
  /**
   * MAME short name (`<setname>`). Undefined for .mras without a
   * setname tag or with an empty one (Computer Space ships an
   * empty `<setname></setname>` — we collapse that to undefined
   * so the field has a single semantically-empty representation).
   */
  readonly setname?: string;
}

/**
 * Parse the raw text head of one .mra into the load-bearing slice
 * we need for playability scanning.
 *
 * Robustness notes:
 *   • Tolerates both `"..."` and `'...'` attribute quoting.
 *   • Tolerates extra whitespace inside the opening tag.
 *   • Empty `<setname></setname>` collapses to `undefined`.
 *   • `<rom>` blocks without a `zip="..."` attr are dropped (their
 *     parts are embedded hex inside the .mra; they don't impose
 *     a zip dependency on the user's disk).
 *   • The leading `<misterromdescription>` wrapper isn't required —
 *     we just scan for the tags we care about.
 */
export function parseArcadeMra(
  rawHead: string,
  relativePath: string,
): ArcadeMraMeta {
  const lastSlash = relativePath.lastIndexOf('/');
  const basename =
    lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
  const hidden = basename.startsWith('.');
  const displayName = hidden ? basename.slice(1) : basename;
  return {
    relativePath,
    displayName,
    hidden,
    requiredZips: extractRequiredZips(rawHead),
    rbf: extractTagValue(rawHead, 'rbf'),
    setname: emptyToUndefined(extractTagValue(rawHead, 'setname')),
  };
}

/**
 * Decode one TSV row produced by `parseArcadeMrasOnDevice` (the
 * server-side awk extraction). The on-device awk emits the same
 * fields this parser computes — keep the two in lock-step.
 *
 * Format (tab-separated, four fields, in this order):
 *   relativePath \t zipAttrs \t rbf \t setname
 *
 * `zipAttrs` joins one entry per `<rom>` block with `\x1f` (the
 * ASCII Unit Separator, never present in zip filenames). Each
 * entry is the raw pipe-fallback list (`galaga.zip|galagamw.zip`)
 * which this decoder splits.
 *
 * Returns `null` if the line is malformed (wrong field count,
 * empty relativePath) so the caller can skip + log.
 */
export function decodeArcadeMraTsv(line: string): ArcadeMraMeta | null {
  // Split on tab; we want exactly four fields. extra trailing tabs
  // (e.g. if a future field is added at the end and the awk writes
  // an empty value) are tolerated by truncating to 4.
  const parts = line.split('\t');
  if (parts.length < 4) return null;
  const relativePath = parts[0]!;
  const zipAttrsBlob = parts[1]!;
  const rbf = parts[2]!;
  const setnameRaw = parts[3]!;
  if (relativePath === '') return null;
  const lastSlash = relativePath.lastIndexOf('/');
  const basename =
    lastSlash === -1 ? relativePath : relativePath.slice(lastSlash + 1);
  const hidden = basename.startsWith('.');
  const displayName = hidden ? basename.slice(1) : basename;
  const requiredZips =
    zipAttrsBlob === ''
      ? []
      : zipAttrsBlob.split(ZIP_BLOCK_SEP).map((entry) => entry.split('|'));
  return {
    relativePath,
    displayName,
    hidden,
    requiredZips,
    rbf,
    setname: emptyToUndefined(setnameRaw),
  };
}

/**
 * Pure rule: a .mra is playable iff at least one zip referenced
 * anywhere in it (across all `<rom>` blocks, all pipe-fallback
 * alternatives) exists in the supplied basename set.
 *
 * .mras with no zip references (TTL / discrete-logic games)
 * count as `'no-roms-needed'` — they're always playable.
 */
export type Playability = 'playable' | 'missing' | 'no-roms-needed';

export function computePlayability(
  meta: ArcadeMraMeta,
  zipBasenames: ReadonlySet<string>,
): Playability {
  if (meta.requiredZips.length === 0) return 'no-roms-needed';
  for (const block of meta.requiredZips) {
    for (const candidate of block) {
      if (zipBasenames.has(candidate)) return 'playable';
    }
  }
  return 'missing';
}

/**
 * Separator byte used to join multiple `<rom>` blocks inside the
 * server-side TSV output. ASCII Unit Separator (0x1F) — never
 * appears in zip filenames, shell pipelines, or XML, so it's a
 * safe sentinel without needing to escape anything.
 */
export const ZIP_BLOCK_SEP = '\x1f';

// ─── internals ───────────────────────────────────────────────────

const ATTR_VALUE_RE = /=\s*(?:"([^"]*)"|'([^']*)')/;

function extractRequiredZips(raw: string): readonly (readonly string[])[] {
  // Match the OPENING tag of each <rom ...> block. Self-closing
  // `<rom .../>` blocks count too — they're rare but the regex
  // doesn't care. We only inspect the opening-tag attrs; nested
  // <part> content is irrelevant for zip-dependency tracking.
  const openTagRe = /<rom\b[^>]*>/g;
  const out: string[][] = [];
  for (const match of raw.matchAll(openTagRe)) {
    const openTag = match[0];
    const zipAttr = extractAttrFromOpenTag(openTag, 'zip');
    if (zipAttr === null || zipAttr === '') continue;
    out.push(zipAttr.split('|'));
  }
  return out;
}

function extractAttrFromOpenTag(openTag: string, attr: string): string | null {
  // Search for ` attr=` (preceded by whitespace OR the tag name).
  // The leading word-boundary keeps `xxzip="..."` from matching
  // `zip`. We don't need a global regex — the same attr never
  // appears twice in a valid opening tag.
  const re = new RegExp(`\\b${attr}${ATTR_VALUE_RE.source}`);
  const m = re.exec(openTag);
  if (m === null) return null;
  return m[1] ?? m[2] ?? '';
}

function extractTagValue(raw: string, tag: string): string {
  // Match `<tag>value</tag>` OR self-closing `<tag/>` (which carries
  // no value). Tolerate attribute-bearing variants for safety even
  // though the four tags we care about (rbf, setname) don't take
  // attrs in any .mra we've seen.
  const selfClosing = new RegExp(`<${tag}\\b[^/>]*\\/>`);
  if (selfClosing.test(raw)) return '';
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const m = re.exec(raw);
  if (m === null) return '';
  return m[1]!.trim();
}

function emptyToUndefined(s: string): string | undefined {
  return s === '' ? undefined : s;
}
