import { createContext, useContext, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { AutoScrapeProgressEvent } from '@shared/preload-api';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

/**
 * PR-C (PR #26) — Auto-scrape progress context.
 *
 * Subscribes to the main-process engine's `autoScrapeProgress` events
 * and exposes the latest snapshot to consumers (the StatusBar footer
 * is the only consumer in this PR). Defaults to `{ state: 'idle' }`
 * before the first event lands.
 *
 * The context is intentionally narrow — just one piece of state. If
 * the engine grows more knobs (per-core toggle, multi-core parallel,
 * etc.), this context can extend. For now, single source of truth
 * for the footer's "<core> · <done>/<total>" rendering.
 *
 * fix/status-bar-recovery — extends the push-only event stream with
 * an on-demand `getAutoScrapeState` pull keyed to connection status.
 * Pre-fix: on a disconnect → reconnect cycle, the engine emits
 * `'idle'` during pause(), then the post-reconnect `engine.start()`
 * path is supposed to re-emit `'active'`. If anything in that path
 * fails silently (the `listAllCoresWithFiles` catch arm in
 * `app/main/index.ts` swallowed errors pre-fix), the renderer is
 * stuck on `'idle'` and the footer's `autoScrapeMessageFor` returns
 * null — the user sees an empty footer-left even though work is
 * (or should be) underway. Re-syncing on every transition into
 * `'connected'` closes the gap regardless of the event-stream
 * reliability.
 */

const DEFAULT_STATE: AutoScrapeProgressEvent = {
  state: 'idle',
  completedCoreIds: [],
};

const AutoScrapeContext = createContext<AutoScrapeProgressEvent>(DEFAULT_STATE);

export function AutoScrapeProvider({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  const [progress, setProgress] = useState<AutoScrapeProgressEvent>(DEFAULT_STATE);
  const { status } = useConnection();

  useEffect(() => {
    // Subscribe to engine events. The preload bridge returns an
    // unsubscribe function; React's effect cleanup runs it on
    // unmount or hot-reload.
    const unsubscribe = window.mister.onAutoScrapeProgress((event) => {
      setProgress(event);
    });
    return unsubscribe;
  }, []);

  // fix/status-bar-recovery — pull ground truth from the engine on
  // every transition into `'connected'`. Covers (a) initial mount,
  // when the renderer hadn't subscribed yet so any pre-mount
  // engine events were lost, and (b) post-reconnect, where the
  // last seen event might be a stale `'idle'` from the disconnect-
  // pause emission and the supposed `'active'` re-emit never
  // landed (silently-failed engine.start in the main process).
  // Cancelled requests are tolerated via a stale-flag closure so
  // a rapid reconnect cycle doesn't apply a superseded snapshot.
  useEffect(() => {
    if (status !== 'connected') return;
    let cancelled = false;
    void window.mister
      .getAutoScrapeState()
      .then((snapshot) => {
        if (!cancelled) setProgress(snapshot);
      })
      .catch(() => {
        // IPC failed (renderer/main mismatch, etc.) — keep the
        // previous progress state; the live event stream still
        // works in the steady-state path.
      });
    return () => {
      cancelled = true;
    };
  }, [status]);

  return (
    <AutoScrapeContext.Provider value={progress}>
      {children}
    </AutoScrapeContext.Provider>
  );
}

export function useAutoScrapeProgress(): AutoScrapeProgressEvent {
  return useContext(AutoScrapeContext);
}

/**
 * feat/auto-scrape-persistence: convenience hook for the sidebar
 * checkmark decorator. Returns the in-session completed Set as a
 * stable Set<string> so sidebar rows can check membership in O(1).
 */
export function useScrapedCoreIds(): ReadonlySet<string> {
  const event = useContext(AutoScrapeContext);
  return new Set(event.completedCoreIds);
}

/**
 * fix/count-and-status-indicator commit 2 — per-core scrape progress
 * for the StatusIndicator gradient. Returns the progress in [0, 1]:
 *
 *   - 1.0 if `coreId` is in `completedCoreIds` (already done).
 *   - `done / total` if the engine is actively scraping `coreId`.
 *   - 0 otherwise (not started).
 *
 * Pure derivation against the latest event — no extra subscriptions.
 */
export function useCoreScrapeProgress(coreId: string): number {
  const event = useContext(AutoScrapeContext);
  if (event.completedCoreIds.includes(coreId)) return 1;
  if (event.state === 'active' && event.coreId === coreId) {
    if (event.total <= 0) return 0;
    return Math.max(0, Math.min(1, event.done / event.total));
  }
  return 0;
}

/**
 * Progress of the currently-scraping core, or null when the engine
 * is idle. Powers the StatusBar footer indicator.
 */
export function useActiveScrapeProgress(): number | null {
  const event = useContext(AutoScrapeContext);
  if (event.state !== 'active') return null;
  if (event.total <= 0) return 0;
  return Math.max(0, Math.min(1, event.done / event.total));
}
