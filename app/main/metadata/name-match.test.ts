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
  it('returns 0.85 when 90%+ of the smaller token set overlaps', () => {
    // Both have "Metal" + "Slug" + "2" = 3 tokens. Other has all 3
    // plus "Special" + "Edition". Smaller=3, intersection=3, ratio=1.0.
    expect(
      scoreMatch('Metal Slug 2', 'Metal Slug 2 Special Edition'),
    ).toBe(0.85);
  });

  it('returns 0 when overlap is below 90%', () => {
    // 1 of 3 tokens overlap → 33% → below threshold.
    expect(scoreMatch('Metal Slug 2', 'King of Fighters 2')).toBe(0);
  });

  it('handles single-token names without crashing', () => {
    expect(scoreMatch('Castlevania', 'Castlevania Bloodlines')).toBe(0.85);
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
    // that ScreenScraper happened to rank highly.
    expect(scoreMatch('Metal Slug 2', 'Metal Slug 2 Special Edition'))
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
