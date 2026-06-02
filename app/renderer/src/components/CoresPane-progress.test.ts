import { describe, expect, it } from 'vitest';

import type { AutoScrapeProgressEvent } from '@shared/preload-api';

import { progressForCore } from '@app/renderer/src/components/CoresPane';

/**
 * fix/count-and-status-indicator commit 2 — pin the per-core scrape
 * progress derivation. The StatusIndicator's gradient state machine
 * comes from this one function, so each branch maps directly to one
 * visual state (cold blue / mid-gradient / full-green-with-halo).
 */

const idle: AutoScrapeProgressEvent = {
  state: 'idle',
  completedCoreIds: [],
};

function active(overrides: {
  readonly coreId: string;
  readonly done: number;
  readonly total: number;
  readonly completedCoreIds?: readonly string[];
}): AutoScrapeProgressEvent {
  return {
    state: 'active',
    coreId: overrides.coreId,
    coreLabel: overrides.coreId,
    done: overrides.done,
    total: overrides.total,
    completedCoreIds: overrides.completedCoreIds ?? [],
    remainingCount: 0,
    totalCoreCount: (overrides.completedCoreIds?.length ?? 0) + 1,
    processedCoreCount: overrides.completedCoreIds?.length ?? 0,
  };
}

function discovering(coreId: string): AutoScrapeProgressEvent {
  return {
    state: 'discovering',
    coreId,
    coreLabel: coreId,
    completedCoreIds: [],
    remainingCount: 0,
    totalCoreCount: 1,
    processedCoreCount: 0,
  };
}

describe('progressForCore', () => {
  it('returns 1.0 when the core is in completedCoreIds (already done)', () => {
    const event: AutoScrapeProgressEvent = {
      state: 'idle',
      completedCoreIds: ['SNES', 'NES', 'X68000'],
    };
    expect(progressForCore('SNES', event)).toBe(1);
    expect(progressForCore('X68000', event)).toBe(1);
  });

  it('returns done/total when the engine is actively scraping the core', () => {
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: 50, total: 100 })),
    ).toBe(0.5);
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: 75, total: 100 })),
    ).toBe(0.75);
  });

  it('returns 1 (green) when done=0 — active core is in mtime-batch validation phase', () => {
    // fix/validation-not-scraping: the engine fires an initial active
    // event with done=0 before any per-path work. Keep the dot green
    // during that window so pure cache-validation passes look healthy.
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: 0, total: 100 })),
    ).toBe(1);
  });

  // ── Regression guard: optimistic green for non-active cores ─────────
  // fix/validation-not-scraping + restores PR #122 intent.
  // When the engine fires any non-idle event, every core that is NOT
  // the currently-active one must default to 1 (green), not 0 (cold
  // blue). The `return 0` fallback was missing #122's `return 1`
  // change (branched off pre-#122 main) — this set of tests pins it.

  it('returns 1 (green) for a non-active core when an active event targets a different core', () => {
    // Pre-fix: returned 0 (cold blue), snapping all 59 other dots blue
    // the moment the engine began processing the first core.
    expect(
      progressForCore('NES', active({ coreId: 'SNES', done: 50, total: 100 })),
    ).toBe(1);
  });

  it('returns 1 (green) for a non-active core during the engine idle state', () => {
    // Pre-fix: idle also returned 0. Dots were cold blue at rest.
    expect(progressForCore('SNES', idle)).toBe(1);
  });

  it('returns 1 (green) for a non-active core during a discovering event on a different core', () => {
    // The discovering state fires before active — same optimistic rule applies.
    expect(progressForCore('NES', discovering('SNES'))).toBe(1);
  });

  it('completedCoreIds wins over an active branch (already-done sticks)', () => {
    // If the engine has moved past SNES (it's in completedCoreIds)
    // and is now scraping NES, SNES still reads as 1.0 — done is done.
    const event = active({
      coreId: 'NES',
      done: 5,
      total: 50,
      completedCoreIds: ['SNES'],
    });
    expect(progressForCore('SNES', event)).toBe(1);
    expect(progressForCore('NES', event)).toBe(0.1);
  });

  it('clamps division-by-zero (total=0) to 0', () => {
    // done=0 guard fires first and returns 1, so only test done>0 + total=0.
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: 5, total: 0 })),
    ).toBe(0);
  });

  it('clamps out-of-range done values into [0, 1]', () => {
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: -5, total: 10 })),
    ).toBe(0);
    expect(
      progressForCore('SNES', active({ coreId: 'SNES', done: 50, total: 10 })),
    ).toBe(1);
  });
});
