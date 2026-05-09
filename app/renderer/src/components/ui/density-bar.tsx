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
        // PR-A item 9: full row-height edge-to-edge, right-bleed
        // flush. `h-full` works because the parent `<td>` uses
        // `flex h-full items-stretch` (the bridge ROMs / Cores
        // panes already provide). 20px wide preserves the §10
        // ratio against whatever the actual row height is —
        // PR #20 round 1 grew the row past 40px to fit a 48px
        // thumbnail, and the previous hardcoded `h-10` left a
        // visible gap above and below the bar. `block` keeps the
        // self-stretch behaviour consistent across browsers.
        'block h-full w-5 shrink-0',
        className,
      )}
      style={style}
    />
  );
}

/**
 * Power-curve exponent applied to the raw `value / max` ratio. Round 3
 * tuning: linear normalization is dominated by outliers — on a real
 * MiSTer, mame at 633 ROMs paints full-bright while everything else
 * (GBA at 61, MegaCD at 25, Intellivision at 2) clusters near the
 * floor and reads as "all empty". Exponentiating by 0.4 lifts the mid
 * and lower ranges so peer differences become visually scannable while
 * the top still tops out at 100%. Examples (max=633): GBA(61)→~38%,
 * MegaCD(25)→~26%, Intellivision(2)→~9%.
 */
export const DENSITY_CURVE_EXPONENT = 0.4;

/**
 * Maps `value / max` into `[0, 1]` after applying the Round 3 power-0.4
 * curve. Defensive against zero/negative denominators, NaNs, and
 * out-of-range values — those all produce 0 (the visually-invisible
 * end of the scale) so a corrupt feed can't paint a row signal-green
 * by accident.
 *
 * The curve is monotonic, anchored at (0, 0) and (1, 1), and applied
 * only to in-range values — the boundaries return exactly 0 / 1 so a
 * row at the peer max always reads as full signal.
 */
export function densityRatio(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max)) return 0;
  if (max <= 0) return 0;
  if (value <= 0) return 0;
  if (value >= max) return 1;
  return Math.pow(value / max, DENSITY_CURVE_EXPONENT);
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
