import { describe, expect, it } from 'vitest';

import {
  AutoScrapeEngine,
  type AutoScrapeDeps,
  type AutoScrapeEvent,
} from '@app/main/services/auto-scrape-engine';

/**
 * Helper: build an engine + capture all emitted events. The deps
 * default to a noop "instant warm cache" scrape — `listRomPaths`
 * returns N synthetic paths and `scrape` resolves all of them in
 * sequence with no async delays. Tests that need slower scrapes
 * (to test pivot mid-flight) override `scrape`.
 */
function makeEngine(args: {
  readonly pathsByCore?: Record<string, readonly string[]>;
  readonly scrapeOverride?: AutoScrapeDeps['scrape'];
}): {
  readonly engine: AutoScrapeEngine;
  readonly events: AutoScrapeEvent[];
  readonly scrapeCalls: { coreId: string; paths: readonly string[] }[];
} {
  const events: AutoScrapeEvent[] = [];
  const scrapeCalls: { coreId: string; paths: readonly string[] }[] = [];
  const pathsByCore = args.pathsByCore ?? {};

  const defaultScrape: AutoScrapeDeps['scrape'] = async (
    _coreId,
    paths,
    onPathResolved,
    shouldAbort,
  ) => {
    for (const _path of paths) { void _path;
      if (shouldAbort()) return;
      onPathResolved();
      // Yield the microtask queue so the engine's emit fires before
      // the next iteration — keeps the test's event sequence stable.
      await Promise.resolve();
    }
  };

  const deps: AutoScrapeDeps = {
    listRomPaths: async (coreId) => pathsByCore[coreId] ?? [],
    scrape: async (coreId, paths, onPathResolved, shouldAbort) => {
      scrapeCalls.push({ coreId, paths });
      const fn = args.scrapeOverride ?? defaultScrape;
      await fn(coreId, paths, onPathResolved, shouldAbort);
    },
  };

  const engine = new AutoScrapeEngine(deps);
  engine.onProgress((event) => events.push(event));
  return { engine, events, scrapeCalls };
}

/** Drain the microtask queue N times so async loop iterations settle. */
async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
}

describe('AutoScrapeEngine', () => {
  describe('queue ordering', () => {
    it('walks cores in the order start() was called with', async () => {
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { SNES: ['a'], NES: ['b'], GBA: ['c'] },
      });
      engine.start(['SNES', 'NES', 'GBA']);
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['SNES', 'NES', 'GBA']);
    });

    it('skips empty cores without calling scrape', async () => {
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { EMPTY: [], NES: ['b'] },
      });
      engine.start(['EMPTY', 'NES']);
      await flush();
      // EMPTY has no paths — scrape is never called for it (the
      // engine guards on `total > 0`). NES still runs.
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['NES']);
    });
  });

  describe('progress events', () => {
    it('emits one event per resolved path + a final idle event', async () => {
      const { engine, events } = makeEngine({
        pathsByCore: { SNES: ['a', 'b', 'c'] },
      });
      engine.start(['SNES']);
      await flush();
      // Expected sequence:
      //   active SNES 0/3 (start-of-core)
      //   active SNES 1/3
      //   active SNES 2/3
      //   active SNES 3/3
      //   idle
      expect(events).toEqual([
        { state: 'active', coreId: 'SNES', coreLabel: 'SNES', done: 0, total: 3 },
        { state: 'active', coreId: 'SNES', coreLabel: 'SNES', done: 1, total: 3 },
        { state: 'active', coreId: 'SNES', coreLabel: 'SNES', done: 2, total: 3 },
        { state: 'active', coreId: 'SNES', coreLabel: 'SNES', done: 3, total: 3 },
        { state: 'idle' },
      ]);
    });

    it('uses coreDisplayName so mame surfaces as "Arcade"', async () => {
      const { engine, events } = makeEngine({
        pathsByCore: { mame: ['a'] },
      });
      engine.start(['mame']);
      await flush();
      const active = events.find((e) => e.state === 'active');
      expect(active?.state === 'active' && active.coreLabel).toBe('Arcade');
    });

    it('emits idle exactly once when the queue is empty', async () => {
      const { engine, events } = makeEngine({});
      engine.start([]);
      await flush();
      expect(events).toEqual([{ state: 'idle' }]);
    });
  });

  describe('setFocus pivot', () => {
    it('pivots to the focused core, then idles after it completes (focus pin)', async () => {
      // fix/auto-scrape-pivot: pre-fix, after the focused core
      // completed the engine auto-advanced to the next queue entry
      // — which still contained the previously-active core at
      // position 1. The user's clicked-away-from core silently
      // restarted. New contract: setFocus PINS the engine to that
      // core; after it completes, the loop EXITS instead of
      // advancing.
      let resolveFirstPath: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        paths,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of paths) { void _path;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolveFirstPath = r;
          });
          onPathResolved();
        }
      };

      const { engine, scrapeCalls, events } = makeEngine({
        pathsByCore: { SNES: ['a', 'b'], NES: ['c'], GBA: ['d'] },
        scrapeOverride: slowScrape,
      });
      engine.start(['SNES', 'NES', 'GBA']);
      await flush();

      // SNES is mid-scrape (waiting on resolveFirstPath). User clicks
      // GBA. setFocus reorders the queue: GBA at head, SNES (active)
      // at position 1, NES (originally next) after — and PINS focus
      // to GBA.
      engine.setFocus('GBA');
      // Let the in-flight SNES path complete; the scrape's
      // shouldAbort() check at the top of the next iteration sees
      // the abort flag and returns early.
      resolveFirstPath();
      await flush();
      // GBA's scrape is now in flight; let its single path complete.
      resolveFirstPath();
      await flush();
      // GBA finishes. Pre-fix, SNES would have resumed here (queue
      // position 1). Post-fix, the focus pin breaks the loop.
      const sequence = scrapeCalls.map((c) => c.coreId);
      expect(sequence[0]).toBe('SNES'); // initial
      expect(sequence[1]).toBe('GBA');  // pivot target
      // No third call — SNES does NOT resume.
      expect(sequence).toHaveLength(2);
      // Engine surfaces an idle event after GBA completes.
      expect(events[events.length - 1]).toEqual({ state: 'idle' });
    });

    it('is a no-op when the focused core is already active', async () => {
      // Slow scrape so we can call setFocus while SNES is in-flight.
      // Init to noop so TS narrowing keeps the call signature
      // through the async-closure assignment below.
      let resolveFirstPath: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        paths,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of paths) { void _path;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolveFirstPath = r;
          });
          onPathResolved();
        }
      };

      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { SNES: ['a', 'b'] },
        scrapeOverride: slowScrape,
      });
      engine.start(['SNES']);
      await flush();
      // Mid-scrape, user clicks the same core. Should not abort or
      // restart — current scrape continues unaffected.
      engine.setFocus('SNES');
      resolveFirstPath();
      await flush();
      resolveFirstPath();
      await flush();
      // Only one scrape call total — the original.
      expect(scrapeCalls).toHaveLength(1);
      expect(scrapeCalls[0]?.coreId).toBe('SNES');
    });

    it('preserves the previously-active core at queue position 1', async () => {
      // Use a programmable abort: the scrape checks shouldAbort at
      // the top of each path, so as soon as setFocus fires, the
      // current path completes and the scrape returns.
      let resolveCurrent: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        paths,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of paths) { void _path;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolveCurrent = r;
          });
          onPathResolved();
        }
      };

      const { engine } = makeEngine({
        pathsByCore: { SNES: ['x'], NES: ['y'], GBA: ['z'], N64: ['w'] },
        scrapeOverride: slowScrape,
      });
      engine.start(['SNES', 'NES', 'GBA', 'N64']);
      await flush();
      // Mid-SNES (currentCoreId='SNES'). Queue is [NES, GBA, N64].
      // User clicks N64. Expected new queue: [N64, SNES, NES, GBA].
      engine.setFocus('N64');
      // Verify queue shape immediately (don't wait for scrape to
      // settle — we want to pin the queue arithmetic).
      expect(engine.__getQueueForTests()).toEqual(['N64', 'SNES', 'NES', 'GBA']);
      // Cleanup — let the slow scrape complete so the test doesn't
      // hang.
      resolveCurrent();
      await flush();
    });
  });

  describe('focus pin (fix/auto-scrape-pivot)', () => {
    // The user-reported regression sequence:
    //   [prefetch] → start coreId=mame
    //   [ipc] mister:setAutoScrapeFocus
    //   [prefetch] · aborted coreId=mame
    //   [prefetch] → start coreId=X68000
    //   [prefetch] → start coreId=X68000  (renderer re-fire, separate concern)
    //   [prefetch] → start coreId=mame    ← THIS is the bug
    // The mame restart at the end was queue auto-progression: after
    // the focused X68000 finished, the loop shifted the next queue
    // entry (mame, re-added at position 1 by setFocus). Post-fix,
    // setFocus pins the loop to that core; auto-progression skipped.

    it('engine idles after focused core completes (no auto-advance)', async () => {
      // Reproduces the exact failure trace, with mame instead of
      // X68000-vs-SNES because the failure is about the auto-
      // progression rule, not the specific cores.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { mame: ['m'], X68000: ['x'] },
      });
      engine.start(['mame', 'X68000']);
      // Pivot immediately to X68000.
      engine.setFocus('X68000');
      await flush();
      // mame ran briefly (or aborted before any path), X68000 ran.
      // Pre-fix sequence would also include a SECOND mame call after
      // X68000 — the auto-advance bug. Pin that mame appears EXACTLY
      // ONCE (the initial start, before pivot).
      const mameCalls = scrapeCalls.filter((c) => c.coreId === 'mame');
      expect(mameCalls.length).toBeLessThanOrEqual(1);
      const x68kCalls = scrapeCalls.filter((c) => c.coreId === 'X68000');
      expect(x68kCalls.length).toBe(1);
    });

    it('setFocus from idle starts the focused core (no other cores run)', async () => {
      // The engine has been idle (queue drained, loop exited). User
      // clicks a core. Focus pin re-starts the loop with ONLY that
      // core; the engine completes it and idles again.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { GBA: ['g'], NES: ['n'], SNES: ['s'] },
      });
      engine.start([]); // empty queue — engine idles immediately
      await flush();
      expect(scrapeCalls).toHaveLength(0);
      // User clicks GBA after idle.
      engine.setFocus('GBA');
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['GBA']);
    });

    it('start() clears any existing focus pin (fresh connect-time walk)', async () => {
      // Connect → engine.start(allCores). The engine should walk
      // the full queue regardless of any focus pin from the
      // previous session. Test scenario: first walk, set focus,
      // start fresh — full walk should resume.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'], C: ['c'] },
      });
      engine.start(['A']);
      engine.setFocus('A'); // pin to A
      await flush();
      // Engine completes A, idles (focus pin).
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['A']);
      // Now a "reconnect": start with the full sidebar. Focus pin
      // must clear so the engine walks B and C in order.
      engine.start(['A', 'B', 'C']);
      await flush();
      const sequence = scrapeCalls.map((c) => c.coreId);
      expect(sequence).toEqual(['A', 'A', 'B', 'C']);
    });

    it('walks the full queue when no focus has been set', async () => {
      // Pre-existing behavior preserved: a vanilla start() with no
      // setFocus walks the full queue from head to tail.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'], C: ['c'] },
      });
      engine.start(['A', 'B', 'C']);
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['A', 'B', 'C']);
    });

    it('rapid double setFocus on same core is a no-op (no duplicate scrape)', async () => {
      // Pin the contract that setFocus(X) called twice in quick
      // succession produces ONE scrape, not two. The engine's
      // currentCoreId === coreId guard handles the mid-scrape case;
      // the focus-pin idle handles the post-completion case.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'] },
      });
      engine.start(['A', 'B']);
      engine.setFocus('A'); // pin while A is being shifted
      engine.setFocus('A'); // duplicate — must NOT re-queue
      await flush();
      const aCalls = scrapeCalls.filter((c) => c.coreId === 'A');
      expect(aCalls).toHaveLength(1);
    });

    it('focus then re-focus on a different core still pins to the latest', async () => {
      // setFocus(B) → setFocus(C) before B starts. Engine should
      // run C (the latest pin), not B.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'], C: ['c'] },
      });
      engine.start([]);
      await flush();
      // Engine is idle.
      engine.setFocus('B');
      engine.setFocus('C');
      await flush();
      // Latest pin wins — C runs alone.
      const sequence = scrapeCalls.map((c) => c.coreId);
      expect(sequence[sequence.length - 1]).toBe('C');
      // No A call — engine started idle and only the focus pins
      // queued work.
      expect(sequence.includes('A')).toBe(false);
    });
  });

  describe('pause / resume', () => {
    it('pause aborts the current scrape and stops the loop', async () => {
      let resolveCurrent: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        paths,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of paths) { void _path;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolveCurrent = r;
          });
          onPathResolved();
        }
      };

      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { SNES: ['a', 'b'], NES: ['c'] },
        scrapeOverride: slowScrape,
      });
      engine.start(['SNES', 'NES']);
      await flush();
      engine.pause();
      resolveCurrent();
      await flush();
      // SNES started, NES never starts because pause stops the loop
      // before it advances.
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['SNES']);
    });

    it('start() after pause resumes by walking the queue from scratch', async () => {
      // The cache is the source of truth for "scanned" — there's no
      // engine-side resume state. Pause + start re-walks the full
      // queue; warm cores zip through (in production via the mtime
      // cache, in this test via the synchronous default scrape).
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { SNES: ['a'], NES: ['b'] },
      });
      engine.start(['SNES', 'NES']);
      await flush();
      engine.pause();
      await flush();
      engine.start(['SNES', 'NES']);
      await flush();
      // Both cores walked twice (once before pause, once after).
      expect(scrapeCalls.map((c) => c.coreId)).toEqual([
        'SNES',
        'NES',
        'SNES',
        'NES',
      ]);
    });
  });

  describe('abort flag is passed through to scrape', () => {
    it('scrape exits at the next iteration after shouldAbort returns true', async () => {
      // Pin the contract: when setFocus fires mid-scrape, the
      // current scrape's shouldAbort() check at the top of the
      // next iteration sees the flag and the scrape returns
      // without resolving any further paths. The COUNT of paths
      // resolved before the abort is the load-bearing assertion
      // (the engine subsequently re-runs SNES from queue position
      // 1, which is a separate scrape invocation we don't count
      // here).
      const firstSnesScrapePathsResolved: number[] = [];
      let setFocusFired = false;
      // Forward reference: scrape needs to call setFocus on the
      // engine, but the engine isn't constructed yet.
      let engineRef: AutoScrapeEngine | null = null;
      const scrape: AutoScrapeDeps['scrape'] = async (
        coreId,
        paths,
        onResolved,
        shouldAbort,
      ) => {
        let count = 0;
        for (const _path of paths) { void _path;
          if (shouldAbort()) {
            if (coreId === 'SNES' && firstSnesScrapePathsResolved.length === 0) {
              firstSnesScrapePathsResolved.push(count);
            }
            return;
          }
          onResolved();
          count += 1;
          // Simulate user clicking NES after 2 SNES paths complete
          // — only fires once; the SNES re-run after pivot doesn't
          // re-trigger.
          if (coreId === 'SNES' && count === 2 && !setFocusFired) {
            setFocusFired = true;
            engineRef?.setFocus('NES');
          }
        }
        if (coreId === 'SNES' && firstSnesScrapePathsResolved.length === 0) {
          firstSnesScrapePathsResolved.push(count);
        }
      };

      const { engine } = makeEngine({
        pathsByCore: { SNES: ['a', 'b', 'c', 'd', 'e'], NES: ['x'] },
        scrapeOverride: scrape,
      });
      engineRef = engine;
      engine.start(['SNES']);
      await flush();
      // First SNES scrape: resolved 2 paths, then setFocus flipped
      // the abort flag, then the next iteration's shouldAbort()
      // check returned true and the scrape returned.
      expect(firstSnesScrapePathsResolved[0]).toBe(2);
    });
  });

  describe('subscriber lifecycle', () => {
    it('returns an unsubscribe function from onProgress', () => {
      const { engine } = makeEngine({});
      const calls: AutoScrapeEvent[] = [];
      const unsub = engine.onProgress((e) => calls.push(e));
      engine.start([]);
      // start() with empty queue immediately emits idle.
      // (The async runLoop runs in microtask — flush before asserting.)
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => {
          expect(calls).toContainEqual({ state: 'idle' });
          const beforeUnsub = calls.length;
          unsub();
          engine.start([]);
          return Promise.resolve()
            .then(() => Promise.resolve())
            .then(() => {
              expect(calls.length).toBe(beforeUnsub);
            });
        });
    });
  });
});
