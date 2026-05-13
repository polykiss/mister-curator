import { ChevronDown, ChevronUp } from 'lucide-react';
import type { JSX } from 'react';

import type { SortKey, SortState } from '@app/renderer/src/lib/rom-sort';

import { TableHead } from '@app/renderer/src/components/ui/table';
import { cn } from '@app/renderer/src/lib/cn';

/**
 * Clickable column header. Active column shows a chevron indicating
 * direction; inactive columns show no chevron (kept clean per spec —
 * "your call, just be consistent"). The underlying `<th>` becomes a
 * button so keyboard activation works.
 *
 * feat/arcade-parity-3-ui — extracted out of roms-adapter.tsx so the
 * arcade adapter can reuse the same primitive without inverting the
 * dependency (arcade-adapter ⇢ roms-adapter would drag the entire
 * RomsPane chrome into the arcade module graph). The shape, classes,
 * and aria attributes are unchanged from the pre-extract original.
 */
export function SortableHeader(props: {
  readonly label: string;
  readonly sortKey: SortKey;
  readonly sortState: SortState;
  readonly onSort: (key: SortKey) => void;
  readonly align?: 'left' | 'right';
  readonly className?: string;
}): JSX.Element {
  const { label, sortKey, sortState, onSort, align = 'left', className } = props;
  const active = sortState.key === sortKey;
  const dir = active ? sortState.dir : null;
  return (
    <TableHead className={cn(align === 'right' && 'text-right', className)}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          'inline-flex items-center gap-1 text-inherit transition-colors hover:text-fg',
          align === 'right' && 'flex-row-reverse',
          active && 'text-fg',
        )}
        aria-label={`Sort by ${label}${active ? ` (currently ${dir})` : ''}`}
        aria-sort={
          active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
        }
      >
        <span>{label}</span>
        {active ? (
          dir === 'asc' ? (
            <ChevronUp
              className="size-3 shrink-0"
              strokeWidth={1.5}
              aria-hidden
            />
          ) : (
            <ChevronDown
              className="size-3 shrink-0"
              strokeWidth={1.5}
              aria-hidden
            />
          )
        ) : null}
      </button>
    </TableHead>
  );
}
