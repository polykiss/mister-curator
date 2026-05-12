import type { JSX } from 'react';

import { ItemListPane } from '@app/renderer/src/components/ItemListPane';
import {
  useRomsAdapter,
  type RomsAdapterProps,
} from '@app/renderer/src/components/roms-adapter';

/**
 * feat/arcade-refactor-1-adapter — thin wrapper around ItemListPane.
 * All RomsPane logic lives in `roms-adapter.tsx`'s `useRomsAdapter`
 * hook; this file's only job is to route the hook's output through
 * ItemListPane.
 *
 * Existing callers (BrowserScreen, tests) keep importing `RomsPane`
 * from this module path unchanged.
 */
export type RomsPaneProps = RomsAdapterProps;

export function RomsPane(props: RomsPaneProps): JSX.Element {
  const adapter = useRomsAdapter(props);
  return <ItemListPane adapter={adapter} />;
}
