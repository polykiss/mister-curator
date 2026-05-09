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

  if (a === b) return 1;

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
