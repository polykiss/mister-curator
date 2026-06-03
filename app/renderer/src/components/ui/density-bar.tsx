import type { CSSProperties, JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

/**
 * Tokens that this indicator can sit on top of. Kept for API/test
 * compatibility — see the note on `floor` below.
 */
export type DensityFloor = 'bg-surface' | 'bg-elevated';

export interface DensityBarProps {
  /** Current value (e.g. ROM count, file size in bytes). */
  readonly value: number;
  /** Maximum value across the visible peer rows. */
  readonly max: number;
  /**
   * The CSS background token of the row this rectangle sits on.
   *
   * D6 (rev. 2): the bar is now a solid teal→green block — it no
   * longer fades into the row surface at low ratios — so `floor` no
   * longer drives the fill color. Retained so existing call sites and
   * tests keep compiling; safe to remove in a later cleanup once all
   * callers stop passing it.
   */
  readonly floor?: DensityFloor;
  /** Override label for screen readers (defaults to `${value} / ${max}`). */
  readonly ariaLabel?: string;
  readonly className?: string;
}

/**
 * The single contained density indicator — see SYSTEM.md §10 (rev. 2).
 *
 * A solid-filled rectangle pinned to the right of each list row whose
 * **color** (not width) carries `value / max`, mapped along a fixed
 * **teal → signal-green** ramp. Full row height; **24px wide** (`w-6`,
 * identical in the cores sidebar and the ROM list); no border-radius.
 * The mix happens in OKLCH so the perceptual midpoint reads as a midpoint.
 *
 * Even a zero-value row shows the teal floor (a visible block), so the
 * density column always reads as a continuous scannable lane. Callers
 * still opt out (return null upstream) for row kinds that carry no
 * density at all — system files, the arcade placeholder, etc.
 */
export function DensityBar({
  value,
  max,
  ariaLabel,
  className,
}: DensityBarProps): JSX.Element {
  const ratio = densityRatio(value, max);
  const style: CSSProperties = { backgroundColor: densityFillColor(ratio) };
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? `intensity ${String(Math.round(ratio * 100))}%`}
      // D6: `w-6` (24px) — identical width in the cores sidebar and the
      // ROM list. `h-full` fills the row's actual height via the parent's
      // `flex h-full items-stretch`. `block` keeps the self-stretch
      // behaviour consistent across browsers.
      className={cn('block h-full w-6 shrink-0', className)}
      style={style}
    />
  );
}

/**
 * Power-curve exponent applied to the raw `value / max` ratio. Round 3
 * tuning: linear normalization is dominated by outliers — exponentiating
 * by 0.4 lifts the mid and lower ranges so peer differences become
 * visually scannable while the top still tops out at 100%.
 */
export const DENSITY_CURVE_EXPONENT = 0.4;

/**
 * Maps `value / max` into `[0, 1]` after applying the power-0.4 curve.
 * Defensive against zero/negative denominators, NaNs, and out-of-range
 * values — those all produce 0 (the teal floor) so a corrupt feed can't
 * paint a row signal-green by accident. Monotonic, anchored at (0,0)
 * and (1,1).
 */
export function densityRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max)) return 0;
  if (max <= 0) return 0;
  if (value <= 0) return 0;
  if (value >= max) return 1;
  return Math.pow(value / max, DENSITY_CURVE_EXPONENT);
}

/**
 * The CSS color expression used to fill the rectangle (D6, rev. 2).
 * Interpolates the fixed **teal → signal-green** ramp defined by the
 * `--density-fill-low` (teal) and `--density-fill-high` (accent) tokens
 * in index.css. At the extremes we emit a plain `hsl(var(--…))` so the
 * browser can't mis-mix a token with itself; in between we emit the
 * `color-mix(in oklch, …)` form for perceptually-uniform interpolation.
 * Percentages sum to 100 so `color-mix` resolves deterministically.
 */
export function densityFillColor(ratio: number): string {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  if (r === 0) return `hsl(var(--density-fill-low))`;
  if (r === 1) return `hsl(var(--density-fill-high))`;
  const lowPct = ((1 - r) * 100).toFixed(2);
  const highPct = (r * 100).toFixed(2);
  return `color-mix(in oklch, hsl(var(--density-fill-low)) ${lowPct}%, hsl(var(--density-fill-high)) ${highPct}%)`;
}
