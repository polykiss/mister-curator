import { describe, expect, it } from 'vitest';

import type { CoreEntry } from '@shared/types';

import { shouldFetchCoresOnEffect } from '@app/renderer/src/lib/cores-fetch-gate';

const someCore: CoreEntry = {
  id: 'NES',
  name: 'NES',
  romCount: 0,
  hiddenCount: 0,
  category: 'Console',
  rbfPaths: [],
  gamesDirExists: false,
  gamesDirHidden: false,
};

describe('shouldFetchCoresOnEffect', () => {
  it('fires the initial fetch when freshly connected with no data', () => {
    expect(shouldFetchCoresOnEffect('connected', null, false, null)).toBe(true);
  });

  it('does not fire while disconnected (renderer must not hit IPC)', () => {
    expect(shouldFetchCoresOnEffect('disconnected', null, false, null)).toBe(false);
  });

  it('does not fire during the connecting transition', () => {
    expect(shouldFetchCoresOnEffect('connecting', null, false, null)).toBe(false);
  });

  it('does not fire on the error status (manager flipped after a failed connect)', () => {
    expect(shouldFetchCoresOnEffect('error', null, false, null)).toBe(false);
  });

  it('does not fire when cores are already loaded', () => {
    expect(shouldFetchCoresOnEffect('connected', [someCore], false, null)).toBe(false);
  });

  it('does not fire when an empty (but non-null) cores list is loaded', () => {
    // Empty array is still a successful response — don't refetch.
    expect(shouldFetchCoresOnEffect('connected', [], false, null)).toBe(false);
  });

  it('does not fire while a fetch is already in flight', () => {
    expect(shouldFetchCoresOnEffect('connected', null, true, null)).toBe(false);
  });

  it('does not fire after a previous fetch failed (Round 4 retry-loop latch)', () => {
    // The crucial guard: without `coresError === null`, the post-
    // failure flip of `coresLoading` true → false would re-evaluate
    // the effect with status still appearing as 'connected' (the
    // status-change IPC event hadn't arrived yet) and re-fire
    // refresh in a tight loop. Hundreds of "not connected" errors
    // in the terminal log on a real-MiSTer benchmark.
    expect(
      shouldFetchCoresOnEffect('connected', null, false, 'Could not list cores'),
    ).toBe(false);
  });

  it('un-latches once the disconnect-reset clears the error and the next connect succeeds', () => {
    // 1. Fetch fails → error set, gate latches.
    expect(
      shouldFetchCoresOnEffect('connected', null, false, 'timed out'),
    ).toBe(false);
    // 2. Status flips to disconnected, the cores-reset effect clears
    //    cores + error.
    expect(shouldFetchCoresOnEffect('disconnected', null, false, null)).toBe(false);
    // 3. Auto-retry succeeds, status flips back to connected, error
    //    is null → gate re-opens for a single fresh fetch.
    expect(shouldFetchCoresOnEffect('connected', null, false, null)).toBe(true);
  });

  it('all four guards must hold simultaneously', () => {
    // Combinations of one-bad-guard-at-a-time should each return false.
    expect(shouldFetchCoresOnEffect('connecting', null, false, null)).toBe(false);
    expect(shouldFetchCoresOnEffect('connected', [someCore], false, null)).toBe(false);
    expect(shouldFetchCoresOnEffect('connected', null, true, null)).toBe(false);
    expect(shouldFetchCoresOnEffect('connected', null, false, 'x')).toBe(false);
    // All four happy → true.
    expect(shouldFetchCoresOnEffect('connected', null, false, null)).toBe(true);
  });
});
