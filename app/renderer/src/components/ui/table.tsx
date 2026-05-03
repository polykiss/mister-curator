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
    return (
      <div className="relative w-full overflow-auto">
        <table
          ref={ref}
          className={cn('w-full text-body text-fg', className)}
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
      className={cn(
        'sticky top-0 z-[1] bg-elevated [&_tr]:border-b [&_tr]:border-subtle',
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
      className={cn(
        'h-9 px-3 text-left align-middle font-medium uppercase tracking-[0.08em] text-caption text-fg-muted [&:has([role=checkbox])]:pr-0',
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
