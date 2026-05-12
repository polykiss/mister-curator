import type { ReactNode } from 'react';

/**
 * feat/arcade-refactor-1-adapter — common shell for ROM-list-style
 * panes (RomsPane, ArcadeMraPane). The two panes have drifted in
 * chrome details (different toolbar contents, different toggle
 * defaults, different default visibility of "Show hidden", different
 * loading visualization, different empty-state messages, AND
 * structurally different headers — RomsPane has a breadcrumb + count
 * paragraph + button row + toggle row stack; ArcadeMraPane has a
 * title h2 + bulk buttons + toggles all in one row).
 *
 * The spec calls for a seam where future arcade work (PR B metadata
 * pipeline, PR C UI parity) can attach at the adapter layer instead
 * of duplicating render logic.
 *
 * Depth choice for THIS PR: thin shell. ItemListPane provides ONLY
 * the outer flex-column container; each adapter renders its full
 * chrome (header, body, table, modals) into the `content` slot.
 * Extras (modals rendered as siblings of the pane root) get their
 * own slot.
 *
 * RATIONALE: a deeper shell — one that owns the header layout, the
 * toolbar slots, the toggle list, the body fallback states, etc. —
 * requires the two panes to already share that structure. They
 * don't. RomsPane's header is a 4-row vertical stack (breadcrumb /
 * count paragraph / button row / toggle row) with `space-y-3`
 * spacing on an `bg-elevated` container; ArcadeMraPane's header is
 * a 2-row flex column (h2-plus-count-chip / button-plus-toggle row)
 * with `flex flex-col gap-3` and `bg-chrome` styling. The spec's
 * hard rule was "zero user-visible change, pixel-identical output."
 * Trying to unify those structures here would either change the
 * output OR require so many adapter-supplied classNames and slot
 * orderings that the shell would just be a different shape of
 * boilerplate.
 *
 * PR B (metadata pipeline) doesn't depend on shell depth — that
 * work lives behind the cache and the IPC. PR C (UI parity) is
 * where shell depth pays off: as ArcadeMraPane grows columns,
 * sort, modals, etc., its chrome will converge toward RomsPane's
 * stack-of-rows shape. At that point a deeper shell pays for
 * itself. Until then, the thin shell delivers the seam at near-
 * zero behavioral risk.
 *
 * The `kind` discriminator is here for type-narrowing in future
 * cross-cutting code (e.g. analytics counting pane-mount events).
 * The shell itself never branches on it.
 */
export interface ItemListAdapter {
  readonly kind: 'roms' | 'arcade';
  /**
   * Accent classes on the outer flex-column container. ItemListPane
   * composes `'flex h-full flex-col'` with this — RomsPane uses
   * `'bg-elevated'`, ArcadeMraPane uses `'bg-canvas'`. Keeping the
   * accent strings adapter-controlled preserves each pane's
   * existing surface tone (SYSTEM.md §4 pane elevation).
   */
  readonly containerClassName: string;
  /** Entire pane content — header, body, table, scroll region. */
  readonly content: ReactNode;
  /**
   * Modals / portals rendered as siblings of the pane container.
   * RomsPane mounts three (detail, edit-metadata, search-SS);
   * ArcadeMraPane mounts zero today.
   */
  readonly extras?: ReactNode;
}
