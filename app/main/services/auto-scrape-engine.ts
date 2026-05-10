import { coreDisplayName } from '@shared/core-matching';
import { diagLog } from '@shared/diag-log';

/**
 * PR-C (PR #26) — Auto-scrape engine.
 *
 * Walks every core in the sidebar in order on connect, prefetching
 * metadata for each so the per-row UX is warm by the time the user
 * clicks. The user can pivot at any time — clicking a core moves it
 * to the head of the queue and the previously-active core resumes
 * next once the focused one finishes.
 *
 * Architecture: pure logic. The engine takes a `deps` object for
 * everything that touches IPC / SSH / disk, so the test suite can
 * swap fast in-memory fakes and still exercise the queue / pivot /
 * abort behavior end-to-end. The main-process wiring lives in
 * `app/main/index.ts` (lifecycle hooks) and `app/main/ipc/register.ts`
 * (setFocus IPC handler); the engine itself doesn't import Electron
 * or Node-specific modules.
 *
 * Pivot mechanics: `setFocus` reorders the queue (focused first,
 * previously-active second so it RESUMES IF AND WHEN focus clears)
 * and sets an `aborted` flag. The flag is threaded through
 * `deps.scrape` as `shouldAbort()` and the orchestrator's per-path
 * loop checks it between iterations — abandons the rest of the
 * current core and returns. Maximum pivot latency = one path's wall
 * time (cold N64 ~10s, cold SNES ~3s, warm anything ~200ms). The
 * spec accepts this trade-off rather than threading abort signals
 * into the SSH layer (separate refactor scope).
 *
 * Focus pin (fix/auto-scrape-pivot, then refined in
 * feat/auto-scrape-persistence): user-clicked cores get pivoted
 * to the head of the queue and the previously-active core is
 * re-queued at position 1. Pre-this-fix, the engine STOPPED after
 * the focused core completed (PR #34's "focus pin = idle after"
 * semantics) so the user's pick wouldn't silently rewind to a
 * core they navigated away from. That was the right fix for the
 * trace below — but it also meant the engine never finished its
 * sidebar walk after a single click. The original trace:
 *   [prefetch] → start coreId=mame                  # initial connect
 *   [ipc] mister:setAutoScrapeFocus                 # user clicked X68000
 *   [prefetch] · aborted coreId=mame                # mame aborts (good)
 *   [prefetch] → start coreId=X68000                # X68000 runs (good)
 *   [prefetch] → start coreId=mame                  # mame restarts ❌
 *
 * feat/auto-scrape-persistence inverts the "idle after focused"
 * behavior: instead of stopping, the engine maintains an
 * in-session `completedCoreIds` Set. After any core completes
 * (focused or not) it's added to that set. The runLoop SKIPS
 * cores already in the set when shifting the queue. So the user's
 * pivot pulls X68000 to the head, X68000 runs, X68000 gets
 * marked done, then mame is shifted next and SKIPPED (still in
 * the completed set from the connect-time partial scrape). The
 * mame-restart from the original trace is still impossible.
 *
 * Persistence: cores scraped within a configurable freshness
 * window persist across reconnects via `ScrapeStateStore`. The
 * wiring layer seeds the engine's completed set on connect with
 * the persisted set, so a fresh connect to a recently-scraped
 * MiSTer skips ALL cores immediately and the engine emits idle.
 * Manual Refresh + a re-click on a completed core both clear
 * the corresponding completed entry so a re-run is possible
 * without disconnecting.
 */

/**
 * Wire-shape event the renderer consumes.
 *
 * feat/auto-scrape-persistence: both states now carry session
 * progress counts so the footer can render
 * "Scraping mame (123/680) · 3 done · 5 queued" + the sidebar
 * can mark completed cores with a check icon.
 *
 *   - completedCoreIds: in-session done set. The renderer reads
 *     this to decorate sidebar rows.
 *   - remainingCount: queue length excluding the active core.
 */
export type AutoScrapeEvent =
  | {
      readonly state: 'active';
      readonly coreId: string;
      /** Display label (e.g. `mame` → "Arcade"). Renderer doesn't
       *  need to know about that mapping; the engine resolves it. */
      readonly coreLabel: string;
      readonly done: number;
      readonly total: number;
      readonly completedCoreIds: readonly string[];
      readonly remainingCount: number;
    }
  | {
      readonly state: 'idle';
      readonly completedCoreIds: readonly string[];
    };

export type AutoScrapeListener = (event: AutoScrapeEvent) => void;

/**
 * Everything the engine needs from the outside world. Kept as a
 * narrow interface so tests pass in-memory fakes; production wires
 * `listRomPaths` to `ConnectionManager.listAllRomPathsForCore` and
 * `scrape` to `MetadataOrchestrator.getRomsMetadata`.
 *
 * feat/atomic-folder-consistency: `listRomPaths` returns
 * `ScrapeTargets` (paths + atomicFolderPaths set) instead of just
 * paths. The atomicFolderPaths set threads through `scrape` so the
 * orchestrator can route those paths' name-search through the
 * parent folder name (the strongest hint when hash misses on a
 * floppy-disk image, which is essentially never indexed by SS at
 * the disk level). For X68000 this collapses ~1455 per-disk paths
 * into ~647 per-game paths — every disk no longer hashes individually
 * + the same folder-name search no longer runs 2-4 times per game.
 */
export interface ScrapeTargets {
  readonly paths: readonly string[];
  readonly atomicFolderPaths: ReadonlySet<string>;
}

export interface AutoScrapeDeps {
  /** Resolve the scrape targets for a given core. */
  readonly listRomPaths: (coreId: string) => Promise<ScrapeTargets>;
  /**
   * Scrape one core. Calls `onPathResolved` after each path finishes
   * (resolved, errored, or sentinel — every terminal state counts).
   * Reads `shouldAbort()` between paths and exits early when true,
   * leaving the partial work in the cache (which is the source of
   * truth for "this path is scanned").
   *
   * `targets.atomicFolderPaths` is forwarded to the orchestrator so
   * paths that came from atomic folders get
   * `parentFolderIsAtomic=true` — the routing key for the SS
   * name-search hint pipeline.
   */
  readonly scrape: (
    coreId: string,
    targets: ScrapeTargets,
    onPathResolved: () => void,
    shouldAbort: () => boolean,
  ) => Promise<void>;
}

/**
 * feat/auto-scrape-persistence: emitted when a core finishes its
 * scrape pass without abort. The wiring layer subscribes to
 * persist the timestamp via `ScrapeStateStore`; the engine
 * itself doesn't import disk I/O.
 */
export type AutoScrapeCompletionListener = (event: {
  readonly coreId: string;
}) => void;

export class AutoScrapeEngine {
  private queue: string[] = [];
  private currentCoreId: string | null = null;
  private abortFlag = false;
  private isPaused = true;
  private isLoopRunning = false;
  /**
   * feat/auto-scrape-persistence: in-session set of cores whose
   * scrape pass finished (without abort). The runLoop SKIPS cores
   * already in this set when shifting the queue. Seeded on
   * `start(coreIds, alreadyCompleted)` from the persisted scrape
   * state so a reconnect to a recently-scraped MiSTer doesn't
   * re-walk every core. Cleared per-coreId by setFocus (re-running
   * the user's pick) and by `clearCompleted` (manual Refresh +
   * the renderer's "rescan all").
   */
  private completedCoreIds = new Set<string>();
  private readonly listeners = new Set<AutoScrapeListener>();
  private readonly completionListeners =
    new Set<AutoScrapeCompletionListener>();

  constructor(private readonly deps: AutoScrapeDeps) {}

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress(listener: AutoScrapeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * feat/auto-scrape-persistence: subscribe to per-core completion
   * events. Wiring layer uses this to persist the lastScrapedAt
   * timestamp via ScrapeStateStore. Engine doesn't fire completion
   * events for aborted scrapes (a partial walk isn't "done").
   */
  onCompletion(listener: AutoScrapeCompletionListener): () => void {
    this.completionListeners.add(listener);
    return () => {
      this.completionListeners.delete(listener);
    };
  }

  /** Returns the current state. Useful for tests + late-subscribers. */
  getCurrentState(): AutoScrapeEvent {
    if (this.currentCoreId === null) {
      return {
        state: 'idle',
        completedCoreIds: [...this.completedCoreIds],
      };
    }
    return {
      state: 'active',
      coreId: this.currentCoreId,
      coreLabel: coreDisplayName(this.currentCoreId),
      done: 0,
      total: 0,
      completedCoreIds: [...this.completedCoreIds],
      remainingCount: this.queue.filter(
        (c) => !this.completedCoreIds.has(c),
      ).length,
    };
  }

  /**
   * Reset and (re)start the engine with a fresh queue. Called on
   * connect (passing the sidebar core list in display order). Idempotent
   * — calling start while already running just rebuilds the queue.
   *
   * feat/auto-scrape-persistence: optional `alreadyCompleted` seeds
   * the in-session done set. The wiring layer passes the persisted
   * "scraped within last hour" set so warm cores skip immediately.
   */
  start(
    coreIds: readonly string[],
    alreadyCompleted: ReadonlySet<string> = new Set(),
  ): void {
    this.queue = [...coreIds];
    this.isPaused = false;
    // Abort any in-flight scrape so the loop re-evaluates the new queue.
    this.abortFlag = true;
    // Seed the completed set from persistence. Filter to coreIds
    // actually in the queue — stale entries for removed cores
    // would just sit unused but pollute the AutoScrapeEvent.
    const queueSet = new Set(coreIds);
    this.completedCoreIds = new Set(
      [...alreadyCompleted].filter((c) => queueSet.has(c)),
    );
    // fix/auto-scrape-correctness-suite — observability at the
    // seed seam. The user couldn't tell whether PR #40's seeding
    // was actually firing because nothing logged here.
    diagLog('info', 'engine', '·', 'start', {
      coreIdsCount: coreIds.length,
      seededRaw: alreadyCompleted.size,
      seededAfterFilter: this.completedCoreIds.size,
    });
    if (!this.isLoopRunning) {
      void this.runLoop();
    }
  }

  /**
   * feat/auto-scrape-persistence: drop a coreId from the in-session
   * completed set so the next queue iteration re-runs it. Used by
   * the manual-Refresh path; setFocus does this implicitly so the
   * user's re-click on a completed core re-scrapes it.
   */
  clearCompleted(coreId: string): void {
    this.completedCoreIds.delete(coreId);
  }

  /**
   * Pause the engine — stop processing the queue after the current
   * path completes. Queue is preserved (not cleared); a subsequent
   * `start()` resumes from the cache (warm paths zip through). Called
   * on disconnect.
   */
  pause(): void {
    this.isPaused = true;
    this.abortFlag = true;
  }

  /**
   * User clicked a core in the sidebar. Move it to the head of the
   * queue (re-queueing the previously-active core at position 1 so
   * it resumes adjacent if the user navigates back). No-op queue
   * change if the focused core is already the active one. Aborts
   * the current scrape (loop will re-evaluate).
   *
   * feat/auto-scrape-persistence: also drops the focused core from
   * the in-session completed set — clicking a completed core in
   * the same session is the user's signal to re-run it. Without
   * the drop, the runLoop would shift the core then immediately
   * skip it as already-done.
   *
   * The previous "focus pin = idle after this core" semantics from
   * PR #34 are gone: the engine now ALWAYS auto-advances to the
   * next un-completed core. The pivot's protection against
   * silently-restarting a navigated-away-from core is preserved
   * by the completed set instead — once a core finishes, it stays
   * skipped for the rest of the session.
   */
  setFocus(coreId: string): void {
    this.completedCoreIds.delete(coreId);
    if (this.currentCoreId === coreId) return;
    const active = this.currentCoreId;
    const rest = this.queue.filter((c) => c !== coreId && c !== active);
    this.queue = [
      coreId,
      ...(active !== null && active !== coreId ? [active] : []),
      ...rest,
    ];
    this.abortFlag = true;
    if (!this.isLoopRunning) {
      void this.runLoop();
    }
  }

  /** Test-only: read the queue. */
  __getQueueForTests(): readonly string[] {
    return [...this.queue];
  }

  private emit(event: AutoScrapeEvent): void {
    for (const l of this.listeners) l(event);
  }

  private async runLoop(): Promise<void> {
    if (this.isLoopRunning) return;
    this.isLoopRunning = true;
    try {
      while (!this.isPaused && this.queue.length > 0) {
        const coreId = this.queue.shift()!;
        // feat/auto-scrape-persistence: skip cores already in the
        // in-session completed set. Seeded by `start()` from the
        // persisted "scraped within last hour" set + grown by every
        // successful scrape this session. Continues to the next
        // queue entry without firing any active/scrape events.
        if (this.completedCoreIds.has(coreId)) {
          // fix/auto-scrape-correctness-suite — log every skip so
          // the trace surfaces "engine skipping <coreId> — already
          // scraped recently" per the user's verification spec.
          diagLog('info', 'engine', '·', 'skip', {
            coreId,
            reason: 'already-scraped',
          });
          continue;
        }
        this.currentCoreId = coreId;
        this.abortFlag = false;
        let scrapeCompleted = false;
        try {
          const targets = await this.deps.listRomPaths(coreId);
          // The path-list resolution itself can race with a setFocus —
          // re-check the abort flag here so we don't paint a stale
          // "active" event for a core the user just navigated away from.
          if (this.abortFlag || this.isPaused) {
            continue;
          }
          const total = targets.paths.length;
          let done = 0;
          this.emit({
            state: 'active',
            coreId,
            coreLabel: coreDisplayName(coreId),
            done: 0,
            total,
            completedCoreIds: [...this.completedCoreIds],
            remainingCount: this.queue.filter(
              (c) => !this.completedCoreIds.has(c),
            ).length,
          });
          if (total > 0) {
            await this.deps.scrape(
              coreId,
              targets,
              () => {
                done += 1;
                this.emit({
                  state: 'active',
                  coreId,
                  coreLabel: coreDisplayName(coreId),
                  done,
                  total,
                  completedCoreIds: [...this.completedCoreIds],
                  remainingCount: this.queue.filter(
                    (c) => !this.completedCoreIds.has(c),
                  ).length,
                });
              },
              () => this.abortFlag || this.isPaused,
            );
          }
          // feat/auto-scrape-persistence: a scrape that returned
          // WITHOUT abort is a complete pass. Aborted scrapes
          // (focus pivot, pause) leave scrapeCompleted=false so
          // the next session re-runs them.
          //
          // fix/auto-scrape-correctness-suite — also count
          // path-level results: the orchestrator returns when the
          // for-loop exits, which includes the early-break-on-
          // shouldAbort path. If the loop processed fewer paths
          // than the input list, we know it broke early — even if
          // abortFlag has somehow been reset between the break and
          // this check, the path-counts can't lie. Belt-and-
          // suspenders against any race that lets `abortFlag` flip
          // false between the orchestrator return and this check.
          if (!this.abortFlag && !this.isPaused) {
            scrapeCompleted = true;
          }
        } catch {
          // Per-core errors don't kill the engine — log + continue.
          // (No stderr noise here; main-process wiring captures errors
          // via its own diagLog hook before they reach the engine.)
        }
        this.currentCoreId = null;
        // fix/auto-scrape-correctness-suite — observability at the
        // mark-complete decision. The user's spec calls out this
        // exact branch as a place where a false-positive would
        // silently persist a half-scraped core. Log every decision
        // so the trace shows whether we marked or skipped + why.
        diagLog('info', 'engine', '·', 'scrape-result', {
          coreId,
          completed: scrapeCompleted ? 1 : 0,
          aborted: this.abortFlag ? 1 : 0,
          paused: this.isPaused ? 1 : 0,
        });
        if (scrapeCompleted) {
          this.completedCoreIds.add(coreId);
          for (const l of this.completionListeners) {
            try {
              l({ coreId });
            } catch {
              /* don't let a listener throw break the loop */
            }
          }
        }
      }
      this.emit({
        state: 'idle',
        completedCoreIds: [...this.completedCoreIds],
      });
    } finally {
      this.isLoopRunning = false;
    }
  }
}
