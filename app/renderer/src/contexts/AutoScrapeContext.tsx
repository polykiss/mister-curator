import { createContext, useContext, useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { AutoScrapeProgressEvent } from '@shared/preload-api';

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

  useEffect(() => {
    // Subscribe to engine events. The preload bridge returns an
    // unsubscribe function; React's effect cleanup runs it on
    // unmount or hot-reload.
    const unsubscribe = window.mister.onAutoScrapeProgress((event) => {
      setProgress(event);
    });
    return unsubscribe;
  }, []);

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
