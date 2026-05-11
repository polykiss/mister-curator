import type { CSSProperties, JSX } from 'react';

import { cn } from '@app/renderer/src/lib/cn';

/**
 * fix/count-and-status-indicator commit 2 — scrape-progress indicator.
 *
 * Replaces the static green ✓ checkmark with a filled circle whose
 * color and glow encode progress. Cold/inactive renders dark blue
 * with no glow; hot/done renders signal-green (the same `--accent`
 * token density-bar uses) with a halo of the same hue.
 *
 * Three placement contexts (each carries a different `sizePx`):
 *   - Sidebar core row     ~16px before the core name. Always
 *                          rendered — cold blue when the core hasn't
 *                          been scraped yet, mid-gradient while the
 *                          engine works on it, full green with halo
 *                          once `completedCoreIds` includes the core.
 *   - Footer status bar    ~14px next to "Scraping <core> (n/total)".
 *                          Live-updates the active core's progress so
 *                          the user can watch the indicator brighten.
 *   - Per-row in listings  ~12px on each ROM row. Binary state for
 *                          this commit (cold blue if no metadata yet,
 *                          full green with halo once metadata
 *                          resolves) — same shape, simpler state
 *                          machine. Per-rom in-flight progress would
 *                          be a follow-up.
 *
 * Color and glow helpers are exported so tests can pin the gradient
 * end-points and the halo curve without spinning up a DOM.
 */

export interface StatusIndicatorProps {
  /** Progress in [0, 1]. Clamped at the boundaries. */
  readonly progress: number;
  /** Pixel diameter of the circle. */
  readonly sizePx: number;
  /** Override for the screen-reader label. */
  readonly ariaLabel?: string;
  readonly className?: string;
}

export function StatusIndicator({
  progress,
  sizePx,
  ariaLabel,
  className,
}: StatusIndicatorProps): JSX.Element {
  const p = clamp01(progress);
  const fill = statusIndicatorFillColor(p);
  const glowPx = statusIndicatorGlowSpread(p);
  const style: CSSProperties = {
    width: `${String(sizePx)}px`,
    height: `${String(sizePx)}px`,
    backgroundColor: fill,
    // Halo of the same fill color so the glow reads as the
    // indicator radiating its own light, not a separate accent ring.
    boxShadow: glowPx > 0 ? `0 0 ${String(glowPx)}px ${fill}` : undefined,
    transition: 'background-color 200ms ease, box-shadow 200ms ease',
  };
  return (
    <span
      role="img"
      aria-label={ariaLabel ?? `progress ${String(Math.round(p * 100))}%`}
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={style}
    />
  );
}

/**
 * Cold endpoint — dark blue, low chroma, blue hue. Picked over a
 * brightened sidebar grey so the indicator reads as a meaningful
 * "not yet" state rather than a disabled icon. Per-core scrape that
 * hasn't started yet always shows this.
 */
const INDICATOR_COLD = 'oklch(0.25 0.08 250)';
/**
 * Hot endpoint — the same `--accent` token density-bar uses, so a
 * full-progress indicator next to a full-density bar reads as the
 * same hue. CSS resolves `hsl(var(--accent))` against the active
 * theme.
 */
const INDICATOR_HOT = 'hsl(var(--accent))';

/**
 * Maximum halo spread in pixels at full progress. Tuned to read as
 * "glowing" without bleeding into the neighbouring row at typical
 * sidebar row heights (40px).
 */
export const STATUS_INDICATOR_MAX_GLOW_PX = 6;

/**
 * Fill color expression for `progress` in [0, 1]. At the extremes we
 * emit the plain endpoint (no `color-mix`) so the browser can't
 * mis-mix the same token with itself; in between we use
 * `color-mix(in oklch, …)` for perceptually-uniform interpolation
 * (mirrors `densityFillColor`'s pattern).
 */
export function statusIndicatorFillColor(progress: number): string {
  const p = clamp01(progress);
  if (p === 0) return INDICATOR_COLD;
  if (p === 1) return INDICATOR_HOT;
  const coldPct = ((1 - p) * 100).toFixed(2);
  const hotPct = (p * 100).toFixed(2);
  return `color-mix(in oklch, ${INDICATOR_COLD} ${coldPct}%, ${INDICATOR_HOT} ${hotPct}%)`;
}

/**
 * Halo spread in pixels for `progress` in [0, 1]. Quadratic curve so
 * the glow ramps slowly through the cold half and grows visibly as
 * the core approaches done. Returns 0 at progress 0 (no halo) and
 * `STATUS_INDICATOR_MAX_GLOW_PX` at progress 1.
 */
export function statusIndicatorGlowSpread(progress: number): number {
  const p = clamp01(progress);
  return Math.round(p * p * STATUS_INDICATOR_MAX_GLOW_PX);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
