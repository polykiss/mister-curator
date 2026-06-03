import { ChevronDown, ChevronUp } from 'lucide-react';
import type { JSX } from 'react';

import type { SortKey, SortState } from '@app/renderer/src/lib/rom-sort';

const SORT_OPTIONS: readonly { readonly key: SortKey; readonly label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'year', label: 'Year' },
  { key: 'genre', label: 'Genre' },
  { key: 'rating', label: 'Rating' },
  { key: 'size', label: 'Size' },
];

interface SortDropdownProps {
  readonly value: SortState;
  /**
   * D13: wired to the same `onSortChange` the list `SortableHeader`s
   * use — selecting a new key resets direction to asc; selecting the
   * active key toggles asc↔desc (mirrors `nextSortState` semantics).
   */
  readonly onChange: (key: SortKey) => void;
}

/**
 * Poster-mode Sort-by control. Rendered in the ROMs-pane toolbar only
 * when `viewMode === 'poster'` (list/detailed sort via column headers,
 * which the poster grid lacks). Wired to the same `sortState` /
 * `onSortChange` the list headers use — no new sort logic.
 *
 * Two parts in a single bordered group:
 *   - `<select>` for the sort key (Name/Year/Genre/Rating/Size)
 *   - chevron button to toggle asc↔desc for the active key
 */
export function SortDropdown({ value, onChange }: SortDropdownProps): JSX.Element {
  const activeLabel =
    SORT_OPTIONS.find((o) => o.key === value.key)?.label ?? 'Name';

  return (
    <div
      className="flex items-center rounded border border-subtle bg-surface"
      role="group"
      aria-label="Sort by"
    >
      <select
        value={value.key}
        onChange={(e) => { onChange(e.target.value as SortKey); }}
        className="h-8 cursor-pointer rounded-l bg-transparent pl-2 pr-1 text-caption text-fg outline-none"
        aria-label={`Sort by ${activeLabel}, currently ${value.dir}`}
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.key} value={o.key} className="bg-overlay text-fg">
            {o.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => { onChange(value.key); }}
        className="flex h-8 items-center rounded-r border-l border-subtle px-1.5 text-caption text-fg-muted transition-colors hover:bg-overlay/60 hover:text-fg"
        aria-label={`Toggle sort direction, currently ${value.dir === 'asc' ? 'ascending' : 'descending'}`}
        title="Toggle sort direction"
      >
        {value.dir === 'asc' ? (
          <ChevronUp className="size-3" strokeWidth={1.5} aria-hidden />
        ) : (
          <ChevronDown className="size-3" strokeWidth={1.5} aria-hidden />
        )}
      </button>
    </div>
  );
}
