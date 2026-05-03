import type { CSSProperties, JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

/** Tokens that this indicator can sit on top of — see SYSTEM.md §10. */
export type DensityFloor = 'bg-surface' | 'bg-elevated';

export interface DensityBarProps {
  /** Current value (e.g. ROM count, file size in bytes). */
  readonly value: number;
  /** Maximum value across the visible peer rows. */
  readonly max: number;
  /**
   * The CSS background token of the row this rectangle sits on.
   * At ratio 0 the rectangle blends invisibly into this surface; at
   * ratio 1 it becomes full signal-green.
   */
  readonly floor: DensityFloor;
  /** Override label for screen readers (defaults to `${value} / ${max}`). */
  readonly ariaLabel?: string;
  readonly className?: string;
}

/**
 * The single contained density indicator — see SYSTEM.md §10.
 *
 * Round 2 redesign: a solid-filled rectangle pinned to the right of
 * each list row whose **color** (not width) carries `value / max`.
 * Width is half the row height (~20px on a 40px row), height is full
 * row height, no border-radius. The fill is an OKLCH `color-mix()`
 * between the floor token and `accent`, so the perceptual midpoint
 * reads as a midpoint rather than a muddy RGB lerp through grey.
 *
 * The component is purely visual. The rectangle itself is always
 * present; an effectively-invisible "ratio 0" rectangle reads as
 * negative space. Callers should opt out (return null upstream) for
 * row kinds that should not carry a density tint at all — system
 * files, the arcade placeholder, etc.
 */
export function DensityBar({
  value,
  max,
  floor,
  ariaLabel,
  className,
}: DensityBarProps): JSX.Element {
  const ratio = densityRatio(value, max);
  const style: CSSProperties = { backgroundColor: densityFillColor(ratio, floor) };
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? `intensity ${String(Math.round(ratio * 100))}%`}
      className={cn(
        // 40px tall (matches the row-height design token §4) × 20px
        // wide (half the row height per §10). `<td>` containers don't
        // propagate `h-full` to children without an explicit flex
        // bridge, so the height is hardcoded — change here if the row
        // density target ever shifts.
        'block h-10 w-5 shrink-0',
        className,
      )}
      style={style}
    />
  );
}

/**
 * Clamps `value / max` into `[0, 1]`. Defensive against zero/negative
 * denominators, NaNs, and out-of-range values — those all produce 0
 * (the visually-invisible end of the scale) so a corrupt feed can't
 * paint a row signal-green by accident.
 */
export function densityRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max)) return 0;
  if (max <= 0) return 0;
  if (value <= 0) return 0;
  if (value >= max) return 1;
  return value / max;
}

/**
 * The CSS color expression used to fill the rectangle. At the
 * extremes we emit a plain `hsl(var(--…))` so the browser can't
 * mis-mix the same token with itself; in between we emit the
 * `color-mix(in oklch, …)` form for perceptually-uniform
 * interpolation. The percentages sum to 100 so `color-mix` resolves
 * to a deterministic single color regardless of browser defaults.
 */
export function densityFillColor(ratio: number, floor: DensityFloor): string {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  if (r === 0) return `hsl(var(--${floor}))`;
  if (r === 1) return `hsl(var(--accent))`;
  const floorPct = ((1 - r) * 100).toFixed(2);
  const accentPct = (r * 100).toFixed(2);
  return `color-mix(in oklch, hsl(var(--${floor})) ${floorPct}%, hsl(var(--accent)) ${accentPct}%)`;
}
