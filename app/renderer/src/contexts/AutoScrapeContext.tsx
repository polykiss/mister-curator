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

const DEFAULT_STATE: AutoScrapeProgressEvent = { state: 'idle' };

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
