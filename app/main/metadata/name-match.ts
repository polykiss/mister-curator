/**
 * PR-D1 (PR #27) — name-match confidence scoring.
 *
 * After ScreenScraper's `jeuRecherche.php` returns ranked candidates
 * for a search term (filename / folder hint), we need to decide
 * whether the top result is trustworthy enough to bind as
 * authoritative metadata, or whether to fall through to the sentinel
 * write (and let PR-D2's manual-override modal surface it later).
 *
 * Auto-bind threshold: 0.9. Below that, the row stays blank — better
 * to leave a row empty than to bind to the wrong game. The threshold
 * IS the load-bearing decision; the score function below is a tiered
 * heuristic that produces predictable values across the common cases.
 *
 * Pure logic — no IPC, no SS calls. Tested in isolation.
 */

/** The auto-bind threshold callers should compare scores against. */
export const AUTO_BIND_THRESHOLD = 0.9;

/**
 * Score how well a candidate game name matches a search term, on a
 * 0.0–1.0 scale. The tiers are deliberately coarse rather than
 * continuous — the goal is "should the auto-binder trust this?",
 * not a fine-grained ranking. Ranking is ScreenScraper's job; we
 * only make the bind/no-bind decision.
 *
 * Tiers (highest score wins):
 *   • 1.0   exact match after normalization (case + whitespace)
 *   • 0.95  Levenshtein distance ≤ 1 on normalized strings
 *   • 0.9   Levenshtein distance ≤ 2 on normalized strings
 *   • 0.85  90%+ token-overlap (intersection size / union size)
 *   • 0.0   anything else
 *
 * Auto-bind is gated at ≥ 0.9 — exact, near-exact, and high-overlap
 * matches qualify; loose token overlap does not. The 0.85 tier is
 * tracked so that future tuning + diag logs have a useful signal
 * even though the auto-binder ignores it.
 */
export function scoreMatch(searchTerm: string, candidateName: string): number {
  const a = normalizeForMatch(searchTerm);
  const b = normalizeForMatch(candidateName);
  if (a === '' || b === '') return 0;

  // Round 2 (PR #27 round 2): digit-mismatch hard rejection. Numbers
  // in titles distinguish sequels and DLC ("Real Bout Fatal Fury 2"
  // vs "Real Bout Fatal Fury", "Mega Man X3" vs "Mega Man X"). Round
  // 1 wrong-bound the former at 0.9 because token-overlap treated
  // the missing "2" as one absent token among five (4/5 = 80%, then
  // boosted to 0.9 by some downstream rule).
  //
  // Hard rule: if the search term contains arabic digit groups, the
  // candidate MUST contain every one of them (as a subset; extra
  // digits in the candidate are fine — `Galaga 88` matches
  // `Galaga '88`). Returns 0 immediately on any missing digit group.
  //
  // Roman numerals are NOT handled — Samurai Shodown IV will
  // continue to miss against an arabic-digit candidate, which is
  // the conservative choice. PR-D2's manual override is the
  // recovery path.
  if (!digitsAreCompatible(a, b)) return 0;

  if (a === b) return 1;

  // Round 2 (PR #27 round 2): leading-prefix tier. The search term
  // appears at the START of the candidate, followed by a separator
  // (colon, dash, paren, etc.) — meaning the candidate is a longer
  // form of the search ("Kizuna Encounter" → "Kizuna Encounter :
  // Super Tag Battle"). Live ScreenScraper data ranks these as the
  // top result for the short search term; the scorer needs to credit
  // the prefix relationship even when token overlap maxes out at
  // 0.85.
  //
  // Sits ABOVE Levenshtein because a 2-word search prefixing a 6-word
  // candidate has Levenshtein distance ~30 — the typo tier doesn't
  // apply, but the match is still authoritative.
  if (isLeadingPrefixWithSeparator(a, b)) return 0.95;

  // Levenshtein tier — typo / region-suffix / minor-variant tolerance.
  const dist = levenshtein(a, b);
  if (dist <= 1) return 0.95;
  if (dist <= 2) return 0.9;

  // Token-overlap tier — Jaccard similarity on word sets. Catches
  // cases where the candidate name has extra words ("Metal Slug 2"
  // vs "Metal Slug 2 Special Edition") that Levenshtein would
  // penalize too harshly. Threshold ≥ 0.9 of the smaller set
  // intersection so the match is genuinely close.
  const tokensA = a.split(' ').filter((t) => t.length > 0);
  const tokensB = b.split(' ').filter((t) => t.length > 0);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setA) if (setB.has(t)) intersection += 1;
  const smaller = Math.min(setA.size, setB.size);
  const overlapRatio = intersection / smaller;
  if (overlapRatio >= 0.9) return 0.85;

  return 0;
}

/**
 * Normalize a string for matching: lowercase, collapse whitespace,
 * trim. Punctuation is preserved (the candidate names ScreenScraper
 * returns include hyphens and colons that meaningfully distinguish
 * games — "Star Wars" vs "Star Wars: Rogue Squadron" should NOT be
 * collapsed).
 */
function normalizeForMatch(input: string): string {
  return input.toLowerCase().replace(/\s+/gu, ' ').trim();
}

/**
 * Round 2 (PR #27 round 2): true iff every arabic digit group in
 * `a` (the search term) also appears in `b` (the candidate). Extra
 * digit groups in `b` are fine — the rule is one-directional. An
 * empty digit set in `a` always passes (no constraint to enforce).
 *
 * Examples:
 *   • "Real Bout Fatal Fury 2" → ["2"] vs "Real Bout Fatal Fury" → []
 *     → "2" missing in candidate → false (REJECT)
 *   • "Galaga 88" → ["88"] vs "Galaga '88" → ["88"] → true (ALLOW)
 *   • "Final Fantasy III" → [] vs "Final Fantasy II" → [] → true
 *     (Roman numerals not extracted; falls through to other tiers)
 */
function digitsAreCompatible(a: string, b: string): boolean {
  const aDigits = extractDigitGroups(a);
  if (aDigits.length === 0) return true;
  const bDigits = new Set(extractDigitGroups(b));
  for (const g of aDigits) {
    if (!bDigits.has(g)) return false;
  }
  return true;
}

function extractDigitGroups(s: string): readonly string[] {
  return s.match(/\d+/g) ?? [];
}

/**
 * Round 2 (PR #27 round 2): true iff `searchTerm` is a leading
 * prefix of `candidate` followed by a separator (colon, dash,
 * paren, semicolon, or whitespace) OR end-of-string. Both inputs
 * must already be normalized (lowercase + whitespace-collapsed).
 *
 * The separator gate avoids false positives like "Bobs" matching
 * "Bobsleigh" (no separator after the prefix → not a hierarchical
 * extension). A genuine extended-form has its discriminator after
 * a separator: "Kizuna Encounter : Super Tag Battle".
 *
 * Empty / equal strings return false here — those cases are handled
 * by the exact-match tier above this check.
 */
function isLeadingPrefixWithSeparator(
  searchTerm: string,
  candidate: string,
): boolean {
  if (searchTerm.length === 0 || searchTerm.length >= candidate.length) {
    return false;
  }
  if (!candidate.startsWith(searchTerm)) return false;
  const next = candidate.charAt(searchTerm.length);
  // Allowed separator chars: whitespace, colon, semicolon, dash,
  // open paren, open bracket. End-of-string is impossible here
  // (searchTerm.length < candidate.length, checked above).
  return /[\s:;\-(\[]/.test(next);
}

/**
 * Iterative Levenshtein distance — string a → string b. O(a.length *
 * b.length) time, O(min(a.length, b.length)) space. Used in the
 * 0.95 / 0.9 tiers as a typo / minor-variant signal.
 *
 * Implementation note: the two-row trick (vs full matrix) keeps memory
 * bounded for long names without changing the result. We only check
 * `dist <= 2`, so we COULD short-circuit when the row's minimum
 * exceeds 2 — kept simple here because game names are short
 * (typically <50 chars) and the cost is negligible.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Make `a` the shorter string so the row buffer is small.
  if (a.length > b.length) {
    const tmp = a;
    a = b;
    b = tmp;
  }

  let prev = new Array<number>(a.length + 1);
  let next = new Array<number>(a.length + 1);
  for (let i = 0; i <= a.length; i += 1) prev[i] = i;

  for (let j = 1; j <= b.length; j += 1) {
    next[0] = j;
    for (let i = 1; i <= a.length; i += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      next[i] = Math.min(
        next[i - 1]! + 1, // insertion
        prev[i]! + 1, // deletion
        prev[i - 1]! + cost, // substitution
      );
    }
    const swap = prev;
    prev = next;
    next = swap;
  }

  return prev[a.length]!;
}
