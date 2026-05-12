import type { JSX } from 'react';

import { ItemListPane } from '@app/renderer/src/components/ItemListPane';
import { useArcadeAdapter } from '@app/renderer/src/components/arcade-adapter';

/**
 * feat/arcade-refactor-1-adapter — thin wrapper around ItemListPane.
 * All ArcadeMraPane logic lives in `arcade-adapter.tsx`'s
 * `useArcadeAdapter` hook; this file's only job is to route the
 * hook's output through ItemListPane.
 *
 * Existing callers (BrowserScreen) keep importing `ArcadeMraPane`
 * from this module path unchanged.
 */
export function ArcadeMraPane(): JSX.Element {
  const adapter = useArcadeAdapter();
  return <ItemListPane adapter={adapter} />;
}
