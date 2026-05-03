import type { JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

export interface DensityBarProps {
  /** Current value (e.g. ROM count, file size in bytes). */
  readonly value: number;
  /** Maximum value across the visible peer rows. */
  readonly max: number;
  /** Override label for screen readers (defaults to `${value} / ${max}`). */
  readonly ariaLabel?: string;
  readonly className?: string;
}

/**
 * The single contained density indicator from SYSTEM.md §10.
 *
 * 40px × 3px track with a muted-to-accent gradient fill clipped at
 * the row's `value / max` ratio. The gradient stops are pinned to
 * the *track* coordinate space — a 25%-filled bar shows the leftmost
 * 25% of the gradient, so low-value rows read as muted and only the
 * peer-leaders read as accented. This is the only place in the
 * system where two colors mix into one fill.
 *
 * Returns `null` when the value is zero or the maximum is zero — a
 * single accent pixel on a flat row reads as a glitch.
 */
export function DensityBar({
  value,
  max,
  ariaLabel,
  className,
}: DensityBarProps): JSX.Element | null {
  if (max <= 0 || value <= 0) return null;
  const ratio = Math.min(1, value / max);
  const percent = Math.max(2, Math.round(ratio * 100)); // floor at 2% so non-zero stays visible
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? `${String(value)} / ${String(max)}`}
      className={cn(
        'relative inline-block h-[3px] w-10 shrink-0 overflow-hidden rounded-[1.5px] bg-elevated',
        className,
      )}
    >
      <span
        aria-hidden
        className="density-fill absolute inset-y-0 left-0"
        style={{ width: `${String(percent)}%` }}
      />
    </span>
  );
}
