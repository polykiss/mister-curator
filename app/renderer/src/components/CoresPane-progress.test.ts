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

  it('returns 0 when the engine is active on a different core', () => {
    expect(
      progressForCore('NES', active({ coreId: 'SNES', done: 50, total: 100 })),
    ).toBe(0);
  });

  it('returns 0 for an idle engine and a non-completed core', () => {
    expect(progressForCore('SNES', idle)).toBe(0);
  });

  it('completedCoreIds wins over an active branch (already-done sticks)', () => {
    // If the engine has moved past SNES (it's in completedCoreIds)
    // and is now scraping NES, SNES still reads as 1.0 — done is
    // done.
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
