import type { ReactElement } from 'react';

import { describe, expect, it } from 'vitest';

import {
  StatusIndicator,
  STATUS_INDICATOR_MAX_GLOW_PX,
  statusIndicatorFillColor,
  statusIndicatorGlowSpread,
} from '@app/renderer/src/components/ui/status-indicator';

/**
 * fix/count-and-status-indicator commit 2 — pin the gradient end-points,
 * the OKLCH interpolation form, and the halo curve. The component
 * is render-shape simple enough to walk as a function call rather
 * than mounting through a renderer.
 */

describe('statusIndicatorFillColor — gradient end-points + interpolation form', () => {
  it('progress 0 returns the cold blue endpoint exactly (no color-mix)', () => {
    expect(statusIndicatorFillColor(0)).toBe('oklch(0.25 0.08 250)');
  });

  it('progress 1 returns the hot accent endpoint exactly (no color-mix)', () => {
    expect(statusIndicatorFillColor(1)).toBe('hsl(var(--accent))');
  });

  it('progress 0.5 emits a color-mix(in oklch, …) at the perceptual midpoint', () => {
    const result = statusIndicatorFillColor(0.5);
    expect(result).toContain('color-mix(in oklch,');
    expect(result).toContain('oklch(0.25 0.08 250)');
    expect(result).toContain('hsl(var(--accent))');
    // Both pct slots should be non-zero (real interpolation, not a
    // disguised endpoint).
    expect(result).toMatch(/50\.00%/);
  });

  it('uses OKLCH interpolation, not RGB lerp', () => {
    // The whole point of the spec: the indicator must NOT lerp
    // through a muddy mid-grey in RGB space. Pin the color space
    // token explicitly so a future style refactor that swaps to
    // `color-mix(in srgb, …)` trips this assertion.
    expect(statusIndicatorFillColor(0.5)).toMatch(/in oklch/);
    expect(statusIndicatorFillColor(0.25)).toMatch(/in oklch/);
    expect(statusIndicatorFillColor(0.75)).toMatch(/in oklch/);
  });

  it('clamps out-of-range progress (0 for negatives, 1 for >1, 0 for NaN)', () => {
    expect(statusIndicatorFillColor(-0.5)).toBe('oklch(0.25 0.08 250)');
    expect(statusIndicatorFillColor(1.5)).toBe('hsl(var(--accent))');
    expect(statusIndicatorFillColor(Number.NaN)).toBe('oklch(0.25 0.08 250)');
  });
});

describe('statusIndicatorGlowSpread — halo curve grows toward 100%', () => {
  it('progress 0 returns 0px (no glow)', () => {
    expect(statusIndicatorGlowSpread(0)).toBe(0);
  });

  it('progress 1 returns the full STATUS_INDICATOR_MAX_GLOW_PX value', () => {
    expect(statusIndicatorGlowSpread(1)).toBe(STATUS_INDICATOR_MAX_GLOW_PX);
  });

  it('quadratic curve — 0.5 maps to 25% of the max, not 50%', () => {
    // p^2 at p=0.5 is 0.25 → 25% of 6 = 1.5, rounds to 2.
    // The slow ramp is intentional: the indicator reads as "still
    // working" most of the way through and only visibly brightens
    // approaching done.
    expect(statusIndicatorGlowSpread(0.5)).toBe(
      Math.round(0.25 * STATUS_INDICATOR_MAX_GLOW_PX),
    );
  });

  it('higher progress → larger or equal glow (monotonic)', () => {
    let prev = -1;
    for (const p of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const glow = statusIndicatorGlowSpread(p);
      expect(glow).toBeGreaterThanOrEqual(prev);
      prev = glow;
    }
  });

  it('clamps out-of-range progress', () => {
    expect(statusIndicatorGlowSpread(-1)).toBe(0);
    expect(statusIndicatorGlowSpread(2)).toBe(STATUS_INDICATOR_MAX_GLOW_PX);
    expect(statusIndicatorGlowSpread(Number.NaN)).toBe(0);
  });
});

describe('StatusIndicator — render shape', () => {
  function callIndicator(
    progress: number,
    sizePx: number,
  ): ReactElement<{
    readonly className: string;
    readonly style: { readonly width: string; readonly height: string; readonly backgroundColor: string; readonly boxShadow?: string };
    readonly 'aria-label': string;
  }> {
    return StatusIndicator({ progress, sizePx }) as ReactElement<{
      readonly className: string;
      readonly style: {
        readonly width: string;
        readonly height: string;
        readonly backgroundColor: string;
        readonly boxShadow?: string;
      };
      readonly 'aria-label': string;
    }>;
  }

  it('0% indicator: cold blue fill, no boxShadow', () => {
    const el = callIndicator(0, 16);
    expect(el.props.style.backgroundColor).toBe('oklch(0.25 0.08 250)');
    expect(el.props.style.boxShadow).toBeUndefined();
  });

  it('50% indicator: mid-gradient OKLCH color, partial glow', () => {
    const el = callIndicator(0.5, 16);
    expect(el.props.style.backgroundColor).toContain('color-mix(in oklch,');
    // 0.5 progress → 0.25 * 6 = 1.5 → 2px glow
    expect(el.props.style.boxShadow).toMatch(/0 0 2px /);
  });

  it('100% indicator: hot accent fill, full glow halo', () => {
    const el = callIndicator(1, 16);
    expect(el.props.style.backgroundColor).toBe('hsl(var(--accent))');
    expect(el.props.style.boxShadow).toMatch(
      /0 0 6px hsl\(var\(--accent\)\)/,
    );
  });

  it('respects the sizePx prop (sidebar=16, footer=14, per-row=12)', () => {
    expect(callIndicator(0, 16).props.style.width).toBe('16px');
    expect(callIndicator(0, 14).props.style.height).toBe('14px');
    expect(callIndicator(1, 12).props.style.width).toBe('12px');
  });

  it('default aria-label exposes the percentage', () => {
    expect(callIndicator(0, 16).props['aria-label']).toBe('progress 0%');
    expect(callIndicator(0.5, 14).props['aria-label']).toBe('progress 50%');
    expect(callIndicator(1, 12).props['aria-label']).toBe('progress 100%');
  });

  it('renders a circle (rounded-full) regardless of size', () => {
    expect(callIndicator(0.5, 16).props.className).toContain('rounded-full');
  });
});
