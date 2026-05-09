import { describe, expect, it } from 'vitest';

import {
  AUTO_BIND_THRESHOLD,
  scoreMatch,
} from '@app/main/metadata/name-match';

/**
 * scoreMatch: tier-based confidence on a 0.0–1.0 scale.
 * Auto-bind threshold = 0.9 — the load-bearing decision.
 */

describe('scoreMatch — exact match (1.0)', () => {
  it('returns 1.0 for identical strings', () => {
    expect(scoreMatch('Metal Slug 2', 'Metal Slug 2')).toBe(1);
  });

  it('returns 1.0 for case-insensitive match', () => {
    expect(scoreMatch('metal slug 2', 'Metal Slug 2')).toBe(1);
    expect(scoreMatch('METAL SLUG 2', 'Metal Slug 2')).toBe(1);
  });

  it('returns 1.0 after whitespace normalization', () => {
    expect(scoreMatch('Metal  Slug   2', 'Metal Slug 2')).toBe(1);
    expect(scoreMatch(' Metal Slug 2 ', 'Metal Slug 2')).toBe(1);
  });

  it('preserves punctuation distinctions', () => {
    // Different punctuation → not exact. Drops to a lower tier.
    const score = scoreMatch('Star Wars Rogue Squadron', 'Star Wars: Rogue Squadron');
    expect(score).toBeLessThan(1);
  });
});

describe('scoreMatch — leading-prefix tier (round 2 — 0.95)', () => {
  // Live ScreenScraper data ranks the longer form as the top result
  // for the short search term. The prefix-relationship gate restores
  // auto-bind for these cases. All examples are real PR #27 round 1
  // misses captured from the diag log.

  it('"Kizuna Encounter" → "Kizuna Encounter : Super Tag Battle" → 0.95', () => {
    expect(
      scoreMatch('Kizuna Encounter', 'Kizuna Encounter : Super Tag Battle'),
    ).toBe(0.95);
  });

  it('"Minasan no Okagesamadesu!" → "Minasan no Okagesamadesu! Dai Sugoroku Taikai" → 0.95', () => {
    expect(
      scoreMatch(
        'Minasan no Okagesamadesu!',
        'Minasan no Okagesamadesu! Dai Sugoroku Taikai',
      ),
    ).toBe(0.95);
  });

  it('"Neo Drift Out" → "Neo Drift Out : New Technology" → 0.95', () => {
    expect(
      scoreMatch('Neo Drift Out', 'Neo Drift Out : New Technology'),
    ).toBe(0.95);
  });

  it('"Ninja Master\'s" → "Ninja Master\'s: Hao Ninpo Cho" → 0.95 (no space before colon)', () => {
    expect(
      scoreMatch("Ninja Master's", "Ninja Master's: Hao Ninpo Cho"),
    ).toBe(0.95);
  });

  it('"Bobs" → "Bobsleigh" does NOT prefix-match (no separator) — falls to lower tiers', () => {
    // Without the separator gate, this would false-positive. With it,
    // the prefix tier doesn't fire; Levenshtein distance of 5 keeps
    // the score at 0.
    expect(scoreMatch('Bobs', 'Bobsleigh')).toBe(0);
  });

  it('"Quiz Daisousa Sen part 2" suffix in "...Quiz Daisousa Sen part 2" — NOT prefix → falls to lower tiers', () => {
    // Search appears at the END of the candidate, not the start.
    // Prefix tier doesn't fire; token overlap is high but the
    // candidate has many extra tokens — token overlap is computed
    // against the smaller set so this DOES hit 0.85 token tier
    // (intersection 4/4 = 100%). Below auto-bind threshold (0.9).
    const score = scoreMatch(
      'Quiz Daisousa Sen part 2',
      'Quiz Meitantei Neo&Geo - Quiz Daisousa Sen part 2',
    );
    expect(score).toBe(0.85);
    // Critically: NOT >= 0.9 (no auto-bind for ambiguous matches).
    expect(score).toBeLessThan(0.9);
  });

  it('exact match still wins over prefix tier', () => {
    expect(scoreMatch('Metal Slug 2', 'Metal Slug 2')).toBe(1);
  });
});

describe('scoreMatch — Levenshtein tiers (0.95 / 0.9)', () => {
  it('returns 0.95 for distance ≤ 1 (single char insert / delete / sub)', () => {
    expect(scoreMatch('Metal Slug', 'Metal Slugs')).toBe(0.95);
    expect(scoreMatch('Metal Slug 2', 'Metal Slug 3')).toBe(0.95);
    expect(scoreMatch('Castlevania', 'Catlevania')).toBe(0.95);
  });

  it('returns 0.9 for distance ≤ 2', () => {
    // 2-char difference: drop "ia" suffix.
    expect(scoreMatch('Castlevania', 'Castlevan')).toBe(0.9);
    // 2-char substitution.
    expect(scoreMatch('mslug2', 'mslug21')).toBe(0.95); // distance 1
    expect(scoreMatch('mslug', 'mslug42')).toBe(0.9); // distance 2
  });

  it('returns 0 for distance > 2 with no token overlap', () => {
    expect(scoreMatch('mslug2', 'kof97')).toBe(0);
  });
});

describe('scoreMatch — token overlap tier (0.85)', () => {
  it('returns 0.85 when 90%+ of the smaller token set overlaps and prefix tier doesn\'t fire', () => {
    // Round 2 (PR #27 round 2): the prefix tier promoted the
    // previous fixture ("Metal Slug 2" → "Metal Slug 2 Special
    // Edition") to 0.95 because the search term is a leading
    // prefix. To test the 0.85 token tier specifically, use a
    // candidate whose extra tokens come BEFORE the search-term
    // tokens — no leading prefix → falls through Levenshtein →
    // hits token-overlap.
    expect(
      scoreMatch('Metal Slug', 'Awesome Edition - Metal Slug'),
    ).toBe(0.85);
  });

  it('returns 0 when overlap is below 90%', () => {
    // 1 of 3 tokens overlap → 33% → below threshold.
    expect(scoreMatch('Metal Slug 2', 'King of Fighters 2')).toBe(0);
  });

  it('handles single-token names without crashing (suffix-not-prefix)', () => {
    // Round 2 (PR #27 round 2): the previous fixture ("Castlevania"
    // → "Castlevania Bloodlines") now hits the prefix tier at
    // 0.95. Using a suffix shape so the prefix tier doesn't fire
    // and the test exercises the single-token-overlap path.
    expect(scoreMatch('Castlevania', 'The Castlevania')).toBe(0.85);
  });
});

describe('scoreMatch — empty / edge cases', () => {
  it('returns 0 for empty search term', () => {
    expect(scoreMatch('', 'Metal Slug 2')).toBe(0);
  });

  it('returns 0 for empty candidate name', () => {
    expect(scoreMatch('Metal Slug 2', '')).toBe(0);
  });

  it('returns 0 for both empty', () => {
    expect(scoreMatch('', '')).toBe(0);
  });

  it('returns 0 for whitespace-only inputs', () => {
    expect(scoreMatch('   ', 'Metal Slug 2')).toBe(0);
    expect(scoreMatch('Metal Slug 2', '   ')).toBe(0);
  });
});

describe('AUTO_BIND_THRESHOLD', () => {
  it('is exactly 0.9 — the spec-pinned auto-bind cutoff', () => {
    expect(AUTO_BIND_THRESHOLD).toBe(0.9);
  });

  it('exact match clears the threshold', () => {
    expect(scoreMatch('Metal Slug', 'Metal Slug')).toBeGreaterThanOrEqual(
      AUTO_BIND_THRESHOLD,
    );
  });

  it('1-char Levenshtein clears the threshold', () => {
    expect(scoreMatch('mslug', 'mslugs')).toBeGreaterThanOrEqual(
      AUTO_BIND_THRESHOLD,
    );
  });

  it('2-char Levenshtein clears the threshold', () => {
    expect(scoreMatch('mslug', 'mslug42')).toBeGreaterThanOrEqual(
      AUTO_BIND_THRESHOLD,
    );
  });

  it('token-overlap (0.85) does NOT clear the threshold', () => {
    // Token-overlap is tracked but not auto-bound — the row stays
    // blank rather than risk binding to a longer / shorter variant
    // that ScreenScraper happened to rank highly. Round 2 (PR #27
    // round 2): use a suffix-shape candidate so the new prefix
    // tier doesn't promote it — the test still pins that
    // token-overlap-only matches stay below auto-bind.
    expect(scoreMatch('Metal Slug', 'Awesome Edition - Metal Slug'))
      .toBeLessThan(AUTO_BIND_THRESHOLD);
  });
});

describe('scoreMatch — real-world fixtures', () => {
  it('mslug2 paren-shortname matches "Metal Slug 2 (mslug2)" candidate via Levenshtein', () => {
    // ScreenScraper might return "mslug2" as the candidate (it
    // sometimes uses the romset name). Distance 0 → exact.
    expect(scoreMatch('mslug2', 'mslug2')).toBe(1);
  });

  it('"Metal Slug 2" folder-hint matches "Metal Slug 2" candidate exactly', () => {
    expect(scoreMatch('Metal Slug 2', 'Metal Slug 2')).toBe(1);
  });

  it('regional variant "Metal Slug II" vs "Metal Slug 2" loses confidence', () => {
    // 2 → II is 2-char substitution → distance 2 → 0.9.
    expect(scoreMatch('Metal Slug 2', 'Metal Slug II')).toBe(0.9);
  });

  it('completely different names score 0', () => {
    expect(scoreMatch('Mario Kart', 'Final Fantasy')).toBe(0);
  });
});
