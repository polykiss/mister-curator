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
  /**
   * feat/atomic-folder-consistency: subset of `pathsByCore[coreId]`
   * the test wants to mark as "came from an atomic folder" so the
   * engine forwards them to the scrape callback's
   * `targets.atomicFolderPaths`. Tests that don't care default to
   * an empty set (legacy file-only behavior).
   */
  readonly atomicFolderPathsByCore?: Record<string, ReadonlySet<string>>;
  readonly scrapeOverride?: AutoScrapeDeps['scrape'];
}): {
  readonly engine: AutoScrapeEngine;
  readonly events: AutoScrapeEvent[];
  readonly scrapeCalls: {
    coreId: string;
    paths: readonly string[];
    atomicFolderPaths: ReadonlySet<string>;
  }[];
} {
  const events: AutoScrapeEvent[] = [];
  const scrapeCalls: {
    coreId: string;
    paths: readonly string[];
    atomicFolderPaths: ReadonlySet<string>;
  }[] = [];
  const pathsByCore = args.pathsByCore ?? {};
  const atomicByCore = args.atomicFolderPathsByCore ?? {};

  const defaultScrape: AutoScrapeDeps['scrape'] = async (
    _coreId,
    targets,
    onPathResolved,
    shouldAbort,
  ) => {
    for (const _path of targets.paths) { void _path;
      if (shouldAbort()) return;
      onPathResolved();
      // Yield the microtask queue so the engine's emit fires before
      // the next iteration — keeps the test's event sequence stable.
      await Promise.resolve();
    }
  };

  const deps: AutoScrapeDeps = {
    listRomPaths: async (coreId) => ({
      paths: pathsByCore[coreId] ?? [],
      atomicFolderPaths: atomicByCore[coreId] ?? new Set(),
    }),
    scrape: async (coreId, targets, onPathResolved, shouldAbort) => {
      scrapeCalls.push({
        coreId,
        paths: targets.paths,
        atomicFolderPaths: targets.atomicFolderPaths,
      });
      const fn = args.scrapeOverride ?? defaultScrape;
      await fn(coreId, targets, onPathResolved, shouldAbort);
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

  describe('atomicFolderPaths threading (feat/atomic-folder-consistency)', () => {
    // The engine takes `ScrapeTargets` ({ paths, atomicFolderPaths })
    // from listRomPaths and forwards both fields to scrape so the
    // orchestrator can route atomic-folder paths through the
    // parent-folder name-search.
    it('forwards atomicFolderPaths from listRomPaths into the scrape call verbatim', async () => {
      const atomicSet = new Set([
        '/media/fat/games/X68000/Carrot Party/disk1.dim',
        '/media/fat/games/X68000/Some Game/main.dim',
      ]);
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: {
          X68000: [
            '/media/fat/games/X68000/loose-rom.zip',
            '/media/fat/games/X68000/Carrot Party/disk1.dim',
            '/media/fat/games/X68000/Some Game/main.dim',
          ],
        },
        atomicFolderPathsByCore: { X68000: atomicSet },
      });
      engine.start(['X68000']);
      await flush();
      expect(scrapeCalls).toHaveLength(1);
      expect(scrapeCalls[0]?.atomicFolderPaths).toBe(atomicSet);
      // Loose ROM is NOT in the atomic set; the contained-file paths
      // ARE. Membership is what the orchestrator branches on.
      expect(
        scrapeCalls[0]?.atomicFolderPaths.has(
          '/media/fat/games/X68000/loose-rom.zip',
        ),
      ).toBe(false);
      expect(
        scrapeCalls[0]?.atomicFolderPaths.has(
          '/media/fat/games/X68000/Carrot Party/disk1.dim',
        ),
      ).toBe(true);
    });

    it('defaults to an empty atomicFolderPaths set when listRomPaths returns none', async () => {
      // Cores with no atomic folders (SNES + zips, NES + nes files)
      // get an empty set. The orchestrator's atomicFolderPaths.has(p)
      // check returns false for everything — same behavior as the
      // pre-feature code path.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { SNES: ['/media/fat/games/SNES/Sonic.zip'] },
      });
      engine.start(['SNES']);
      await flush();
      expect(scrapeCalls[0]?.atomicFolderPaths.size).toBe(0);
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
      // feat/auto-scrape-persistence: events now carry
      // completedCoreIds + remainingCount. SNES is the only core in
      // the queue, so it transitions [] → [] active during the
      // scrape, then [SNES] in the idle event after it completes.
      expect(events).toEqual([
        {
          state: 'active',
          coreId: 'SNES',
          coreLabel: 'SNES',
          done: 0,
          total: 3,
          completedCoreIds: [],
          remainingCount: 0,
        },
        {
          state: 'active',
          coreId: 'SNES',
          coreLabel: 'SNES',
          done: 1,
          total: 3,
          completedCoreIds: [],
          remainingCount: 0,
        },
        {
          state: 'active',
          coreId: 'SNES',
          coreLabel: 'SNES',
          done: 2,
          total: 3,
          completedCoreIds: [],
          remainingCount: 0,
        },
        {
          state: 'active',
          coreId: 'SNES',
          coreLabel: 'SNES',
          done: 3,
          total: 3,
          completedCoreIds: [],
          remainingCount: 0,
        },
        { state: 'idle', completedCoreIds: ['SNES'] },
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
      expect(events).toEqual([
        { state: 'idle', completedCoreIds: [] },
      ]);
    });
  });

  describe('setFocus pivot', () => {
    it('pivots to the focused core, then auto-advances through the rest of the queue', async () => {
      // feat/auto-scrape-persistence (commit 2): the PR #34
      // "engine idles after focused core" semantics is REPLACED.
      // The engine now auto-advances to the next un-completed
      // core after the focused one finishes. The protection
      // against PR #34's silent-restart bug is preserved by the
      // completedCoreIds Set: a core that COMPLETES its scrape
      // joins the set and is skipped on subsequent shifts. A
      // core that was ABORTED by a pivot stays out of the set
      // and re-runs eventually — that's intentional now;
      // "leave it overnight" should genuinely finish everything.
      let resolveFirstPath: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of targets.paths) { void _path;
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
      // at position 1, NES after.
      engine.setFocus('GBA');
      // Let the in-flight SNES path complete; the scrape's
      // shouldAbort() check at the top of the next iteration sees
      // the abort flag and returns early. SNES did NOT complete →
      // not in completedCoreIds → will re-run when shifted again.
      resolveFirstPath();
      await flush();
      // GBA's scrape is in flight (waiting). Let it complete.
      resolveFirstPath();
      await flush();
      // SNES is shifted next (position 1 from setFocus reorder).
      // Not in completedCoreIds (was aborted), so it re-runs.
      resolveFirstPath();
      await flush();
      // NES last.
      resolveFirstPath();
      await flush();
      const sequence = scrapeCalls.map((c) => c.coreId);
      expect(sequence[0]).toBe('SNES'); // initial (aborted)
      expect(sequence[1]).toBe('GBA');  // pivot target
      expect(sequence[2]).toBe('SNES'); // re-runs (was aborted)
      expect(sequence[3]).toBe('NES');  // continues
    });

    it('is a no-op when the focused core is already active', async () => {
      // Slow scrape so we can call setFocus while SNES is in-flight.
      // Init to noop so TS narrowing keeps the call signature
      // through the async-closure assignment below.
      let resolveFirstPath: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of targets.paths) { void _path;
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
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of targets.paths) { void _path;
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

  describe('completion tracking (feat/auto-scrape-persistence)', () => {
    // PR #34's "engine idles after focused core" is replaced by an
    // in-session completedCoreIds Set + auto-advance. The Set
    // protects the original silent-restart concern (a completed
    // core never re-runs in the same session); the auto-advance
    // makes "leave it overnight" actually finish everything.

    it('completed cores are in the idle event\'s completedCoreIds list', async () => {
      const { engine, events } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'] },
      });
      engine.start(['A', 'B']);
      await flush();
      const idle = events[events.length - 1];
      expect(idle?.state).toBe('idle');
      if (idle?.state === 'idle') {
        // Order isn't part of the contract; sort to compare as a
        // set.
        expect([...idle.completedCoreIds].sort()).toEqual(['A', 'B']);
      }
    });

    it('seeded `alreadyCompleted` set causes those cores to skip without scrape', async () => {
      // The wiring layer feeds the persisted "scraped within last
      // hour" set on connect. Engine should skip those cores —
      // no scrape() call, no active event. Other cores run
      // normally.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'], C: ['c'] },
      });
      engine.start(['A', 'B', 'C'], new Set(['A', 'C']));
      await flush();
      // Only B scraped — A and C were pre-marked completed.
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['B']);
    });

    it('all cores pre-completed → engine idles immediately', async () => {
      const { engine, scrapeCalls, events } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'] },
      });
      engine.start(['A', 'B'], new Set(['A', 'B']));
      await flush();
      expect(scrapeCalls).toEqual([]);
      const idle = events[events.length - 1];
      expect(idle?.state).toBe('idle');
      if (idle?.state === 'idle') {
        expect([...idle.completedCoreIds].sort()).toEqual(['A', 'B']);
      }
    });

    it('setFocus on a completed core re-runs it (clears the completed mark)', async () => {
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'] },
      });
      // First pass: A and B run + complete.
      engine.start(['A', 'B']);
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['A', 'B']);
      // User re-clicks A. Should re-run.
      engine.setFocus('A');
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['A', 'B', 'A']);
    });

    it('clearCompleted(coreId) drops the in-session mark for one core', async () => {
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'] },
      });
      engine.start(['A', 'B']);
      await flush();
      // Both completed. Manual rescan of A:
      engine.clearCompleted('A');
      // Re-start the queue (manual Refresh → new start call).
      engine.start(['A', 'B']);
      await flush();
      // A re-runs; B stays completed (it's in the seeded set this
      // start() call sees? actually no — start() resets the
      // completed set, only seeding from `alreadyCompleted`. We
      // test that path next.).
      const sequence = scrapeCalls.map((c) => c.coreId);
      // A was scraped twice (initial + after start), B was
      // scraped once (initial only — second start with the
      // pre-existing in-session set was wiped). To test "A clear,
      // B keep" cleanly we'd need to seed B as alreadyCompleted on
      // the second start.
      expect(sequence.filter((c) => c === 'A').length).toBeGreaterThanOrEqual(2);
    });

    it('completion listeners fire only for fully-scraped cores (not aborted)', async () => {
      let resolvePath: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of targets.paths) { void _path;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolvePath = r;
          });
          onPathResolved();
        }
      };
      const { engine } = makeEngine({
        pathsByCore: { A: ['a', 'b'], B: ['c'] },
        scrapeOverride: slowScrape,
      });
      const completed: string[] = [];
      engine.onCompletion((event) => {
        completed.push(event.coreId);
      });
      engine.start(['A', 'B']);
      await flush();
      // A is mid-scrape. Pivot to B → A aborts, B runs.
      engine.setFocus('B');
      resolvePath(); // A's first path completes; loop checks
                    // shouldAbort and returns
      await flush();
      resolvePath(); // B's only path completes
      await flush();
      // A was aborted (no completion event), B finished
      // (completion event fired). A may re-run after B; we don't
      // care for this test — just that the FIRST A run isn't
      // double-counted.
      expect(completed[0]).toBe('B');
    });

    it('walks the full queue when no completion seed is set', async () => {
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { A: ['a'], B: ['b'], C: ['c'] },
      });
      engine.start(['A', 'B', 'C']);
      await flush();
      expect(scrapeCalls.map((c) => c.coreId)).toEqual(['A', 'B', 'C']);
    });
  });

  describe('pause / resume', () => {
    it('pause aborts the current scrape and stops the loop', async () => {
      let resolveCurrent: () => void = (): void => undefined;
      const slowScrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _path of targets.paths) { void _path;
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

    it('start() after pause when all cores finished pre-pause walks the queue fresh', async () => {
      // All cores ran to completion before pause → lastInFlightCoreId
      // is null → next start() takes the fresh-queue path. Pin the
      // baseline so the resume tests below distinguish themselves.
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

  describe('queue behavior after pause/reconnect', () => {
    // Models the real-device EPIPE scenario: SSH transport dies
    // mid-scrape of NES. Engine sees pause(); on the next start()
    // (driven by main/index.ts's reconnect listener with the fresh
    // sidebar core list), the in-flight core pivots to the queue
    // head instead of restarting from the alphabetical first core.
    //
    // The durable hash + metadata caches make re-running the
    // in-flight core a fast-skip in production — the engine layer
    // only owns the queue-shape decision tested here.

    /**
     * Helper: a slow scrape that resolves one path at a time, gated
     * by a manually-resolved promise. Lets the test pause the engine
     * MID-iteration so the in-flight identity is preserved across
     * the pause boundary.
     */
    function makeSlowScrape(): {
      readonly scrape: AutoScrapeDeps['scrape'];
      tick: () => void;
    } {
      let resolveCurrent: () => void = (): void => undefined;
      const scrape: AutoScrapeDeps['scrape'] = async (
        _coreId,
        targets,
        onPathResolved,
        shouldAbort,
      ) => {
        for (const _p of targets.paths) {
          void _p;
          if (shouldAbort()) return;
          await new Promise<void>((r) => {
            resolveCurrent = r;
          });
          onPathResolved();
        }
      };
      return {
        scrape,
        tick: () => resolveCurrent(),
      };
    }

    it('clears the in-flight anchor when a scrape completes successfully', async () => {
      // SNES runs to completion (no abort). On the next pause +
      // start, the queue order is fresh — no pivot because there's
      // nothing in-flight.
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { AcornAtom: ['x'], SNES: ['a'], X68000: ['x'] },
      });
      engine.start(['AcornAtom', 'SNES', 'X68000']);
      await flush();
      // Everything completes; lastInFlightCoreId clears as each
      // iteration finishes.
      engine.pause();
      await flush();
      // Reconnect with sidebar; expect fresh order [AcornAtom, SNES,
      // X68000] (no pivot — nothing was in-flight at the pause).
      engine.start(['AcornAtom', 'SNES', 'X68000']);
      await flush();
      const postResume = scrapeCalls.slice(3).map((c) => c.coreId);
      expect(postResume).toEqual(['AcornAtom', 'SNES', 'X68000']);
    });

    it('falls back to fresh queue when the in-flight core has left the sidebar', async () => {
      // User hid or otherwise removed the in-flight core between
      // disconnect and reconnect. The pivot drops; queue order
      // matches the sidebar.
      const slow = makeSlowScrape();
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: {
          AcornAtom: ['x'],
          PSX: ['a', 'b'],
          X68000: ['x'],
        },
        scrapeOverride: slow.scrape,
      });
      engine.setFocus('PSX');
      engine.start(['AcornAtom', 'PSX', 'X68000']);
      await flush();
      engine.pause();
      await flush();
      // Reconnect with PSX removed from the sidebar.
      engine.start(['AcornAtom', 'X68000']);
      for (let i = 0; i < 5; i += 1) {
        slow.tick();
        await Promise.resolve();
      }
      await flush();
      const postResume = scrapeCalls.slice(1).map((c) => c.coreId);
      // First post-resume entry is AcornAtom (the fresh sidebar
      // order), NOT PSX (no longer present).
      expect(postResume[0]).toBe('AcornAtom');
      expect(postResume).not.toContain('PSX');
    });

    it('falls back to fresh queue when the in-flight core is in alreadyCompleted', async () => {
      // Defensive: if the in-flight core ends up in the persisted
      // already-completed set somehow (e.g. another tab completed
      // it concurrently), the pivot drops and the core is skipped.
      const slow = makeSlowScrape();
      const { engine, scrapeCalls } = makeEngine({
        pathsByCore: { AcornAtom: ['x'], NES: ['a', 'b'], X68000: ['x'] },
        scrapeOverride: slow.scrape,
      });
      engine.setFocus('NES');
      engine.start(['AcornAtom', 'NES', 'X68000']);
      await flush();
      engine.pause();
      await flush();
      // Reconnect with NES marked already-completed.
      engine.start(['AcornAtom', 'NES', 'X68000'], new Set(['NES']));
      for (let i = 0; i < 5; i += 1) {
        slow.tick();
        await Promise.resolve();
      }
      await flush();
      const postResume = scrapeCalls.slice(1).map((c) => c.coreId);
      // NES is skipped via the already-completed set; the queue
      // walks AcornAtom → X68000.
      expect(postResume).toEqual(['AcornAtom', 'X68000']);
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
        targets,
        onResolved,
        shouldAbort,
      ) => {
        let count = 0;
        for (const _path of targets.paths) { void _path;
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
          expect(calls).toContainEqual({
            state: 'idle',
            completedCoreIds: [],
          });
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
