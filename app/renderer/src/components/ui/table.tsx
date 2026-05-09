import { forwardRef } from 'react';
import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from 'react';

import { cn } from '@app/renderer/src/lib/cn';

// The Table primitive is consumed by the ROMs pane only. Densities
// match SYSTEM.md §4: 40px rows, 16px horizontal padding, no default
// row fill — separation comes from a 1px border-subtle on each row.
// Round 2: the ROMs pane sits on `bg-elevated` (one step up from the
// cores pane's `bg-surface`), so hover bumps one tier further up to
// `bg-overlay` to stay visible against the pane surface.

export const Table = forwardRef<HTMLTableElement, HTMLAttributes<HTMLTableElement>>(
  function Table({ className, ...props }, ref) {
    // PR #23 round 5 commit 2: the wrapper used to carry
    // `overflow-auto`, which made it a scroll context. That broke the
    // sticky header on `<thead>` — sticky resolves against the
    // *nearest* scroll ancestor, so the header would have been pinned
    // to a wrapper that itself isn't scrolling (the actual scrolling
    // happens in the outer `<div className="scroll-themed flex-1
    // overflow-auto">` in RomsPane). Dropping `overflow-auto` here
    // collapses the nested scroll context so sticky resolves against
    // the outer pane scroll, which is what the user sees moving.
    // Tables in this app never exceed the pane width (columns are
    // sized to fit), so we don't lose useful horizontal-scroll
    // behavior. `relative` stays as a positioning anchor for any
    // future absolute descendants.
    // PR #25: `table-fixed` is what makes per-cell width constraints
    // (`w-N` on TableHead cells) AND `truncate` on the name cell
    // actually apply. With the default `table-auto`, cells grow to
    // fit their content — so a 100-char ROM title pushes the name
    // column past its allotted space and shoves Year / Genre /
    // Rating / Actions / Density / Eye off the visible area. Fixed
    // layout pins each column to its declared width and the name
    // column (the only cell with no explicit width on its TableHead)
    // gets the remainder, where `max-w-0` + `truncate` on the body
    // cell turn long titles into ellipses instead of overflow.
    return (
      <div className="relative w-full">
        <table
          ref={ref}
          className={cn('w-full table-fixed text-body text-fg', className)}
          {...props}
        />
      </div>
    );
  },
);

export const TableHeader = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableHeader({ className, ...props }, ref) {
  return (
    <thead
      ref={ref}
      // Header sits on `bg-elevated` to match the ROMs pane surface
      // (the only consumer of this Table primitive) so it doesn't
      // create a seam at the sticky edge.
      // PR #23 round 5 commit 2: `sticky top-0` on `<thead>` works in
      // recent Chromium; the per-`<th>` `sticky` in `TableHead`
      // below is the defensive belt-and-braces layer. `z-10` lifts
      // the header above scrolling row content (rows have no z) but
      // stays well below modal layers.
      className={cn(
        'sticky top-0 z-10 bg-elevated [&_tr]:border-b [&_tr]:border-subtle',
        className,
      )}
      {...props}
    />
  );
});

export const TableBody = forwardRef<
  HTMLTableSectionElement,
  HTMLAttributes<HTMLTableSectionElement>
>(function TableBody({ className, ...props }, ref) {
  return (
    <tbody
      ref={ref}
      className={cn('[&_tr:last-child]:border-0', className)}
      {...props}
    />
  );
});

export const TableRow = forwardRef<
  HTMLTableRowElement,
  HTMLAttributes<HTMLTableRowElement>
>(function TableRow({ className, ...props }, ref) {
  return (
    <tr
      ref={ref}
      className={cn(
        'group/row h-10 border-b border-subtle transition-colors hover:bg-overlay data-[state=selected]:bg-overlay',
        className,
      )}
      {...props}
    />
  );
});

export const TableHead = forwardRef<
  HTMLTableCellElement,
  ThHTMLAttributes<HTMLTableCellElement>
>(function TableHead({ className, ...props }, ref) {
  return (
    <th
      ref={ref}
      // PR #23 round 5 commit 2: `sticky top-0 bg-elevated` on each
      // `<th>` is the defensive layer — `position: sticky` on
      // `<thead>` is reliable in recent Chromium but per-cell sticky
      // is the safest fallback (it's what shadcn/ui recommends in
      // their sticky-header pattern). `bg-elevated` here also
      // guarantees each cell paints its own opaque background so
      // scrolling row content can't bleed through the header even
      // if the `<thead>`-level `bg-elevated` is treated as
      // transparent by some renderer path.
      className={cn(
        'sticky top-0 z-10 h-9 bg-elevated px-3 text-left align-middle font-medium uppercase tracking-[0.08em] text-caption text-fg-muted [&:has([role=checkbox])]:pr-0',
        className,
      )}
      {...props}
    />
  );
});

export const TableCell = forwardRef<
  HTMLTableCellElement,
  TdHTMLAttributes<HTMLTableCellElement>
>(function TableCell({ className, ...props }, ref) {
  return (
    <td
      ref={ref}
      className={cn('px-3 py-2 align-middle [&:has([role=checkbox])]:pr-0', className)}
      {...props}
    />
  );
});
