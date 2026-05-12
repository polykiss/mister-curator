import type { JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';
import type { ItemListAdapter } from '@app/renderer/src/components/item-list-adapter';

/**
 * feat/arcade-refactor-1-adapter — generic shell for ROM-list-style
 * panes (RomsPane, ArcadeMraPane). Provides ONLY the outer flex-
 * column container shared by both panes; adapters fill in the
 * `content` slot with their full chrome (header, body, etc.).
 *
 * See `item-list-adapter.ts` for the rationale on shell depth.
 *
 * IMPORTANT: this component MUST produce output pixel-identical to
 * the prior hand-rolled outer containers in RomsPane and
 * ArcadeMraPane. The class set composed here matches each pane's
 * pre-refactor outer `<div>` exactly: `'flex h-full flex-col'`
 * shared, plus the adapter-supplied accent (`'bg-elevated'` for
 * RomsPane, `'bg-canvas'` for ArcadeMraPane). Snapshot tests pin
 * both panes against their pre-refactor output.
 */
export function ItemListPane({
  adapter,
}: {
  readonly adapter: ItemListAdapter;
}): JSX.Element {
  return (
    <>
      <div className={cn('flex h-full flex-col', adapter.containerClassName)}>
        {adapter.content}
      </div>
      {adapter.extras}
    </>
  );
}
