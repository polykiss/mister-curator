import { Minus, Plus } from 'lucide-react';
import type { JSX } from 'react';

import type { ViewSize } from '@app/renderer/src/lib/roms-view-props';
import { cn } from '@app/renderer/src/lib/cn';

const SIZE_ORDER: readonly ViewSize[] = ['S', 'M', 'L', 'XL'];

interface SizeControlProps {
  readonly value: ViewSize;
  readonly onChange: (next: ViewSize) => void;
}

/**
 * Segmented (− M +) control for adjusting tile/row size in Detailed
 * and Poster view modes. Hidden in List mode by the parent adapter.
 */
export function SizeControl({ value, onChange }: SizeControlProps): JSX.Element {
  const idx = SIZE_ORDER.indexOf(value);
  const canDecrease = idx > 0;
  const canIncrease = idx < SIZE_ORDER.length - 1;

  const buttonCls = cn(
    'flex items-center justify-center px-1.5 py-1.5 transition-colors',
    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
    'text-fg-muted hover:text-fg hover:bg-overlay/60 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-fg-muted',
  );

  return (
    <div
      className="flex items-center rounded border border-subtle bg-surface"
      role="group"
      aria-label="View size"
    >
      <button
        type="button"
        className={cn(buttonCls, 'rounded-l')}
        aria-label="Decrease size"
        title="Decrease size"
        disabled={!canDecrease}
        onClick={() => { if (canDecrease) onChange(SIZE_ORDER[idx - 1]!); }}
      >
        <Minus className="size-3" strokeWidth={1.5} aria-hidden />
      </button>
      <span
        className="min-w-[1.75rem] border-x border-subtle bg-overlay px-1.5 py-1.5 text-center font-mono text-caption text-fg"
        aria-live="polite"
        aria-label={`Current size: ${value}`}
      >
        {value}
      </span>
      <button
        type="button"
        className={cn(buttonCls, 'rounded-r')}
        aria-label="Increase size"
        title="Increase size"
        disabled={!canIncrease}
        onClick={() => { if (canIncrease) onChange(SIZE_ORDER[idx + 1]!); }}
      >
        <Plus className="size-3" strokeWidth={1.5} aria-hidden />
      </button>
    </div>
  );
}
