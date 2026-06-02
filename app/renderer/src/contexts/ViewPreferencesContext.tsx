import { createContext, useCallback, useContext, useMemo } from 'react';
import type { JSX, ReactNode } from 'react';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { usePersistedString } from '@app/renderer/src/lib/use-persisted-string';
import type { ViewMode, ViewSize } from '@app/renderer/src/lib/roms-view-props';

/**
 * Shared view-mode and view-size preferences for the ROM and arcade
 * panes. Provided once at the BrowserScreen level so both panes read
 * from and write to the same React state — changing the view in one
 * pane immediately updates the other.
 *
 * Persisted to localStorage keyed by host so each connected MiSTer
 * remembers its own preference.
 */
interface ViewPreferencesContextValue {
  readonly viewMode: ViewMode;
  readonly setViewMode: (next: ViewMode) => void;
  readonly viewSize: ViewSize;
  readonly setViewSize: (next: ViewSize) => void;
}

const ViewPreferencesContext =
  createContext<ViewPreferencesContextValue | null>(null);

export function ViewPreferencesProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const { currentProfile } = useConnection();
  const host = currentProfile?.host ?? 'default';

  const [viewMode, setViewModeRaw] = usePersistedString<ViewMode>(
    `mistercurator.viewMode.${host}`,
    'list',
    ['list', 'poster'],
  );
  const [viewSize, setViewSizeRaw] = usePersistedString<ViewSize>(
    `mistercurator.viewSize.${host}`,
    'S',
    ['S', 'M', 'L', 'XL'],
  );

  const setViewMode = useCallback((next: ViewMode) => setViewModeRaw(next), [setViewModeRaw]);
  const setViewSize = useCallback((next: ViewSize) => setViewSizeRaw(next), [setViewSizeRaw]);

  const value = useMemo(
    () => ({ viewMode, setViewMode, viewSize, setViewSize }),
    [viewMode, setViewMode, viewSize, setViewSize],
  );

  return (
    <ViewPreferencesContext.Provider value={value}>
      {children}
    </ViewPreferencesContext.Provider>
  );
}

export function useViewPreferences(): ViewPreferencesContextValue {
  const ctx = useContext(ViewPreferencesContext);
  if (ctx === null) {
    throw new Error(
      'useViewPreferences must be used within a ViewPreferencesProvider.',
    );
  }
  return ctx;
}
