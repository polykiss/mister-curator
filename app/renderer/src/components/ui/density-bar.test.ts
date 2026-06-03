import type { ReactElement } from 'react';

import { describe, expect, it } from 'vitest';

import {
  DENSITY_CURVE_EXPONENT,
  DensityBar,
  densityFillColor,
  densityRatio,
} from '@app/renderer/src/components/ui/density-bar';

describe('densityRatio', () => {
  it('returns 0 when value or max is zero', () => {
    expect(densityRatio(0, 100)).toBe(0);
    expect(densityRatio(50, 0)).toBe(0);
  });

  it('returns 1 when value equals max', () => {
    expect(densityRatio(100, 100)).toBe(1);
  });

  it('applies the power-0.4 curve to in-range values', () => {
    // Anchors: 0 → 0, 1 → 1 (boundary special-cases).
    expect(densityRatio(0, 100)).toBe(0);
    expect(densityRatio(100, 100)).toBe(1);

    // Mid-range follows the curve. 0.5^0.4 ≈ 0.7579, well above the
    // pre-Round-3 linear 0.5 — that's the whole point of the curve.
    expect(densityRatio(50, 100)).toBeCloseTo(Math.pow(0.5, 0.4), 5);
    expect(densityRatio(25, 100)).toBeCloseTo(Math.pow(0.25, 0.4), 5);
    expect(densityRatio(75, 100)).toBeCloseTo(Math.pow(0.75, 0.4), 5);
  });

  it('matches the Round 3 worked example with mame=633 (real MiSTer)', () => {
    // From the Round 3 spec: with mame=633 as max, the curve lifts
    // mid-range cores into the visible band. Tolerance ±2% — the
    // spec's "~38% / ~26% / ~9%" anchors are illustrative; the
    // assertions below pin the actual `(value/max)^0.4` outputs.
    expect(densityRatio(633, 633)).toBe(1);
    expect(densityRatio(61, 633) * 100).toBeGreaterThan(36);
    expect(densityRatio(61, 633) * 100).toBeLessThan(42);
    expect(densityRatio(25, 633) * 100).toBeGreaterThan(24);
    expect(densityRatio(25, 633) * 100).toBeLessThan(30);
    expect(densityRatio(2, 633) * 100).toBeGreaterThan(7);
    expect(densityRatio(2, 633) * 100).toBeLessThan(12);
  });

  it('is monotonic — strictly increases as value increases', () => {
    const max = 1000;
    let prev = densityRatio(0, max);
    for (const v of [1, 2, 5, 10, 25, 50, 100, 250, 500, 750, 999, 1000]) {
      const r = densityRatio(v, max);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('boundary values: 0, 0.5*max, max', () => {
    expect(densityRatio(0, 200)).toBe(0);
    expect(densityRatio(100, 200)).toBeCloseTo(Math.pow(0.5, 0.4), 5);
    expect(densityRatio(200, 200)).toBe(1);
  });

  it('exposes DENSITY_CURVE_EXPONENT at the agreed value', () => {
    // Locked-in tuning value — change here only with a design-pass
    // update because every cores-list / ROMs-list surface inherits it.
    expect(DENSITY_CURVE_EXPONENT).toBe(0.4);
  });

  it('clamps negative values to 0', () => {
    expect(densityRatio(-10, 100)).toBe(0);
  });

  it('clamps values above max to 1', () => {
    expect(densityRatio(150, 100)).toBe(1);
  });

  it('treats negative max as invalid → 0', () => {
    expect(densityRatio(50, -10)).toBe(0);
  });

  it('treats NaN / Infinity inputs as 0', () => {
    expect(densityRatio(Number.NaN, 100)).toBe(0);
    expect(densityRatio(50, Number.NaN)).toBe(0);
    expect(densityRatio(Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(densityRatio(50, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('densityFillColor', () => {
  // D6 (rev. 2): `floor` arg removed — ramp is now fixed teal→green via
  // --density-fill-low / --density-fill-high tokens.

  it('returns the teal floor token at ratio 0', () => {
    expect(densityFillColor(0)).toBe('hsl(var(--density-fill-low))');
  });

  it('returns the high (accent) token at ratio 1', () => {
    expect(densityFillColor(1)).toBe('hsl(var(--density-fill-high))');
  });

  it('returns a color-mix(in oklch, …) expression at the perceptual midpoint', () => {
    const result = densityFillColor(0.5);
    expect(result).toContain('color-mix(in oklch,');
    expect(result).toContain('hsl(var(--density-fill-low)) 50.00%');
    expect(result).toContain('hsl(var(--density-fill-high)) 50.00%');
  });

  it('uses the fixed teal floor token in the mix expression at 0.25', () => {
    const result = densityFillColor(0.25);
    expect(result).toContain('hsl(var(--density-fill-low)) 75.00%');
    expect(result).toContain('hsl(var(--density-fill-high)) 25.00%');
  });

  it('clamps a negative ratio to the teal floor token', () => {
    expect(densityFillColor(-0.5)).toBe('hsl(var(--density-fill-low))');
  });

  it('clamps a ratio above 1 to the high (accent) token', () => {
    expect(densityFillColor(2)).toBe('hsl(var(--density-fill-high))');
  });

  it('produces percentages that sum to 100 for any in-range ratio', () => {
    for (const r of [0.1, 0.33, 0.5, 0.67, 0.9]) {
      const result = densityFillColor(r);
      const matches = [...result.matchAll(/(\d+\.\d+)%/g)].map((m) =>
        Number.parseFloat(m[1]!),
      );
      expect(matches).toHaveLength(2);
      expect(matches[0]! + matches[1]!).toBeCloseTo(100, 1);
    }
  });

  it('uses the OKLCH color space for interpolation, not RGB', () => {
    // Guards against a regression where someone "simplifies" the helper
    // to a default `color-mix(...)` (which mixes in sRGB and produces
    // a muddy midpoint). The point of this indicator is perceptual
    // uniformity — see SYSTEM.md §10.
    expect(densityFillColor(0.5)).toMatch(/in oklch/);
  });
});

describe('DensityBar — render shape (PR-A item 9)', () => {
  // The component is small enough to render directly without a DOM.
  // Calling it as a function returns the JSX element it produces;
  // we read `props.className` to assert the layout intent. Saves
  // pulling in @testing-library/react just for two assertions.
  function classNameFor(): string {
    const result = DensityBar({
      value: 50,
      max: 100,
      floor: 'bg-surface',
    }) as ReactElement<{ readonly className: string }>;
    return result.props.className;
  }

  it('uses h-full so the indicator fills the row height edge-to-edge', () => {
    const cn = classNameFor();
    expect(cn).toContain('h-full');
    // Pre-PR-A item 9 the height was hardcoded to h-10 (40px) which
    // left a visible gap when the row grew (PR #20 round 1 bumped
    // the row past 40px to fit the thumbnail). Pin that we no
    // longer hardcode that.
    expect(cn).not.toMatch(/\bh-10\b/);
  });

  it('has no vertical padding or margin on the indicator container', () => {
    const cn = classNameFor();
    // Tailwind escapes for vertical spacing utilities. Any of these
    // would re-introduce the gap above/below the bar.
    expect(cn).not.toMatch(/\b[mp][ytb]-\d/);
  });

  it('keeps the D6 width: 24px wide (w-6), shrink-0', () => {
    // D6 (rev. 2, final mockup): bar finalized at w-6 (24px) —
    // identical width in the cores sidebar and the ROM list.
    const cn = classNameFor();
    expect(cn).toContain('w-6');
    expect(cn).not.toContain('w-10');
    expect(cn).toContain('shrink-0');
  });

  it('caller-supplied height className overrides the default h-full', () => {
    // Contract test on `cn` / tailwind-merge: a caller-passed
    // height utility wins over the default `h-full`. Round 2 used
    // this override on the ROM row to dodge a height-propagation
    // bug; round 3 reverted to the default after fixing the parent
    // chain (TableCell `relative` + inner `absolute inset-0`), so
    // no production callsite uses this anymore. The test stays as
    // a regression guard: if `cn` ever stops merging height
    // utilities, callers losing the ability to override would be
    // a silent surprise.
    const result = DensityBar({
      value: 50,
      max: 100,
      floor: 'bg-elevated',
      className: 'h-10',
    }) as ReactElement<{ readonly className: string }>;
    const cn = result.props.className;
    expect(cn).toContain('h-10');
    expect(cn).not.toContain('h-full');
  });
});
