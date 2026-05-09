import { coreDisplayName } from '@shared/core-matching';

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
 * previously-active second so it resumes after) and sets an
 * `aborted` flag. The flag is threaded through `deps.scrape` as
 * `shouldAbort()` and the orchestrator's per-path loop checks it
 * between iterations — abandons the rest of the current core and
 * returns. Maximum pivot latency = one path's wall time (cold N64
 * ~10s, cold SNES ~3s, warm anything ~200ms). The spec accepts
 * this trade-off rather than threading abort signals into the SSH
 * layer (separate refactor scope).
 *
 * Cache as source of truth: there's no separate "scanned" state
 * to persist. The metadata cache (PR #20 round 9) already records
 * every path's metadata + sentinel; on reconnect, the engine re-runs
 * the full queue and warm cores zip through in ~200ms via the
 * cache's mtime-batch fast path. So pause/resume/restart is just
 * "drop the queue, rebuild on next start" — no separate state file.
 */

/** Wire-shape event the renderer consumes. Two states only. */
export type AutoScrapeEvent =
  | {
      readonly state: 'active';
      readonly coreId: string;
      /** Display label (e.g. `mame` → "Arcade"). Renderer doesn't
       *  need to know about that mapping; the engine resolves it. */
      readonly coreLabel: string;
      readonly done: number;
      readonly total: number;
    }
  | { readonly state: 'idle' };

export type AutoScrapeListener = (event: AutoScrapeEvent) => void;

/**
 * Everything the engine needs from the outside world. Kept as a
 * narrow interface so tests pass in-memory fakes; production wires
 * `listRomPaths` to `ConnectionManager.listRoms` and `scrape` to
 * `MetadataOrchestrator.getRomsMetadata`.
 */
export interface AutoScrapeDeps {
  /** Resolve the list of ROM paths to scrape for a given core. */
  readonly listRomPaths: (coreId: string) => Promise<readonly string[]>;
  /**
   * Scrape one core. Calls `onPathResolved` after each path finishes
   * (resolved, errored, or sentinel — every terminal state counts).
   * Reads `shouldAbort()` between paths and exits early when true,
   * leaving the partial work in the cache (which is the source of
   * truth for "this path is scanned").
   */
  readonly scrape: (
    coreId: string,
    paths: readonly string[],
    onPathResolved: () => void,
    shouldAbort: () => boolean,
  ) => Promise<void>;
}

export class AutoScrapeEngine {
  private queue: string[] = [];
  private currentCoreId: string | null = null;
  private abortFlag = false;
  private isPaused = true;
  private isLoopRunning = false;
  private readonly listeners = new Set<AutoScrapeListener>();

  constructor(private readonly deps: AutoScrapeDeps) {}

  /** Subscribe to progress events. Returns an unsubscribe function. */
  onProgress(listener: AutoScrapeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Returns the current state. Useful for tests + late-subscribers. */
  getCurrentState(): AutoScrapeEvent {
    if (this.currentCoreId === null) return { state: 'idle' };
    return {
      state: 'active',
      coreId: this.currentCoreId,
      coreLabel: coreDisplayName(this.currentCoreId),
      done: 0,
      total: 0,
    };
  }

  /**
   * Reset and (re)start the engine with a fresh queue. Called on
   * connect (passing the sidebar core list in display order). Idempotent
   * — calling start while already running just rebuilds the queue.
   */
  start(coreIds: readonly string[]): void {
    this.queue = [...coreIds];
    this.isPaused = false;
    // Abort any in-flight scrape so the loop re-evaluates the new queue.
    this.abortFlag = true;
    if (!this.isLoopRunning) {
      void this.runLoop();
    }
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
   * queue and re-add the previously-active core at position 1 so it
   * resumes immediately after the focused core finishes. No-op if the
   * focused core is already the active one. Aborts the current scrape
   * (loop will re-evaluate).
   */
  setFocus(coreId: string): void {
    if (this.currentCoreId === coreId) return;
    const active = this.currentCoreId;
    const rest = this.queue.filter((c) => c !== coreId && c !== active);
    this.queue = [
      coreId,
      ...(active !== null && active !== coreId ? [active] : []),
      ...rest,
    ];
    this.abortFlag = true;
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
        this.currentCoreId = coreId;
        this.abortFlag = false;
        try {
          const paths = await this.deps.listRomPaths(coreId);
          // The path-list resolution itself can race with a setFocus —
          // re-check the abort flag here so we don't paint a stale
          // "active" event for a core the user just navigated away from.
          if (this.abortFlag || this.isPaused) {
            continue;
          }
          const total = paths.length;
          let done = 0;
          this.emit({
            state: 'active',
            coreId,
            coreLabel: coreDisplayName(coreId),
            done: 0,
            total,
          });
          if (total > 0) {
            await this.deps.scrape(
              coreId,
              paths,
              () => {
                done += 1;
                this.emit({
                  state: 'active',
                  coreId,
                  coreLabel: coreDisplayName(coreId),
                  done,
                  total,
                });
              },
              () => this.abortFlag || this.isPaused,
            );
          }
        } catch {
          // Per-core errors don't kill the engine — log + continue.
          // (No stderr noise here; main-process wiring captures errors
          // via its own diagLog hook before they reach the engine.)
        }
        this.currentCoreId = null;
      }
      this.emit({ state: 'idle' });
    } finally {
      this.isLoopRunning = false;
    }
  }
}
