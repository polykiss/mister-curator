import { LayoutGrid, LayoutList, List } from 'lucide-react';
import type { JSX } from 'react';

import type { ViewMode } from '@app/renderer/src/lib/roms-view-props';
import { cn } from '@app/renderer/src/lib/cn';

interface ViewModeToggleProps {
  readonly value: ViewMode;
  readonly onChange: (next: ViewMode) => void;
}

const MODES: readonly { readonly mode: ViewMode; readonly label: string; readonly Icon: typeof List }[] = [
  { mode: 'list', label: 'List view', Icon: List },
  { mode: 'detailed', label: 'Detailed list', Icon: LayoutList },
  { mode: 'poster', label: 'Poster grid', Icon: LayoutGrid },
];

/**
 * Three-button segmented toggle for ROM/arcade pane view modes.
 * Persisted per-host + per-pane by the parent adapter.
 */
export function ViewModeToggle({ value, onChange }: ViewModeToggleProps): JSX.Element {
  return (
    <div
      className="flex items-center rounded border border-subtle bg-surface"
      role="group"
      aria-label="View mode"
    >
      {MODES.map(({ mode, label, Icon }, i) => (
        <button
          key={mode}
          type="button"
          aria-label={label}
          aria-pressed={value === mode}
          title={label}
          onClick={() => onChange(mode)}
          className={cn(
            'flex items-center justify-center px-2 py-1.5 transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
            i === 0 && 'rounded-l',
            i === MODES.length - 1 && 'rounded-r',
            i > 0 && 'border-l border-subtle',
            value === mode
              ? 'bg-overlay text-fg'
              : 'text-fg-muted hover:text-fg hover:bg-overlay/60',
          )}
        >
          <Icon className="size-3.5" strokeWidth={1.5} aria-hidden />
        </button>
      ))}
    </div>
  );
}
