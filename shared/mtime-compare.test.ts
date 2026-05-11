import { describe, expect, it } from 'vitest';

import {
  MTIME_TOLERANCE_SECONDS,
  mtimesMatch,
} from '@shared/mtime-compare';

/**
 * fix/mtime-tolerance — pin the truth table from the Phase 2 spec.
 * The constants and the helper are the load-bearing surface for the
 * SD-rebuild fix; anything that drifts here drifts the downstream
 * cache-hit decision across hash-service and witnessesMatch.
 */

describe('mtime-compare', () => {
  it('pins the tolerance window to ±2 seconds', () => {
    // Other modules read this constant when documenting cache-hit
    // behavior. Bump only with intent — see the long comment in
    // shared/mtime-compare.ts for the exFAT / rsync rationale.
    expect(MTIME_TOLERANCE_SECONDS).toBe(2);
  });

  describe('mtimesMatch — missing-file sentinel preserved', () => {
    it('(0, 0) → false (both sides report missing; never a hit)', () => {
      expect(mtimesMatch(0, 0)).toBe(false);
    });

    it('(0, 100) → false (one side missing)', () => {
      expect(mtimesMatch(0, 100)).toBe(false);
    });

    it('(100, 0) → false (other side missing)', () => {
      expect(mtimesMatch(100, 0)).toBe(false);
    });
  });

  describe('mtimesMatch — exact equality + tolerance window', () => {
    it('(500, 500) → true (exact)', () => {
      expect(mtimesMatch(500, 500)).toBe(true);
    });

    it('(500, 501) → true (+1s inside window)', () => {
      expect(mtimesMatch(500, 501)).toBe(true);
    });

    it('(500, 499) → true (−1s inside window)', () => {
      expect(mtimesMatch(500, 499)).toBe(true);
    });

    it('(500, 502) → true (+2s at window edge)', () => {
      expect(mtimesMatch(500, 502)).toBe(true);
    });

    it('(500, 498) → true (−2s at window edge)', () => {
      expect(mtimesMatch(500, 498)).toBe(true);
    });

    it('(500, 503) → false (+3s past window)', () => {
      expect(mtimesMatch(500, 503)).toBe(false);
    });

    it('(500, 497) → false (−3s past window)', () => {
      expect(mtimesMatch(500, 497)).toBe(false);
    });

    it('(500, 1000) → false (far outside window)', () => {
      expect(mtimesMatch(500, 1000)).toBe(false);
    });
  });
});
