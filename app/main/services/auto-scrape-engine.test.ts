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
    it('moves the focused core to the head of the queue', async () => {
      // Slow scrape so we can pivot mid-flight without races.
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
        pathsByCore: { SNES: ['a', 'b'], NES: ['c'], GBA: ['d'] },
        scrapeOverride: slowScrape,
      });
      engine.start(['SNES', 'NES', 'GBA']);
      await flush();

      // SNES is mid-scrape (waiting on resolveFirstPath). User clicks
      // GBA. setFocus reorders the queue: GBA at head, SNES (active)
      // at position 1, NES (originally next) after.
      engine.setFocus('GBA');
      // Let the in-flight SNES path complete; the scrape's
      // shouldAbort() check at the top of the next iteration sees the
      // abort flag and returns early.
      resolveFirstPath();
      await flush();
      // Now GBA's scrape is in flight (waiting on resolveFirstPath).
      resolveFirstPath();
      await flush();
      // SNES resumes (a-and-b again — cache makes it warm in
      // production, the engine doesn't track per-path completion
      // across pivots). For this test, we just verify the COREID
      // sequence: GBA jumped ahead of NES.
      const sequence = scrapeCalls.map((c) => c.coreId);
      // First entry: SNES (originally started). After pivot: GBA
      // (the focus target). SNES re-runs to finish what was aborted.
      expect(sequence[0]).toBe('SNES');
      expect(sequence[1]).toBe('GBA');
      // SNES queues back at position 1, so next is SNES (resumed).
      expect(sequence[2]).toBe('SNES');
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
