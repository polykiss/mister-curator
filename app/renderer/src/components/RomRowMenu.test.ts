import { describe, expect, it } from 'vitest';

import {
  computeMenuPosition,
  VIEWPORT_PADDING,
} from '@app/renderer/src/components/RomRowMenu';

/**
 * `computeMenuPosition` is the pure positioning math for the floating
 * row menu — extracted so the flip rules are testable without jsdom.
 *
 * PR-D2 r2 c4 — round 1's naive clamp used a hardcoded 80px height
 * assumption that broke once PR-D2 added Edit + Find ScreenScraper
 * items (menu grew to ~180px). Rows near the bottom of the table
 * would render with the last item or two clipped off the viewport.
 * The fix: measure the actual rendered box, then flip upward when
 * the menu would otherwise clip the bottom.
 */

const VIEWPORT = { viewportWidth: 1920, viewportHeight: 1080 } as const;

describe('computeMenuPosition — no-flip case (menu fits below + right of anchor)', () => {
  it('returns the raw anchor coords when menu fits comfortably', () => {
    const result = computeMenuPosition({
      anchorX: 100,
      anchorY: 100,
      menuWidth: 256,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result).toEqual({ left: 100, top: 100 });
  });

  it('boundary: anchor + menu exactly hits viewport - padding (still no flip)', () => {
    // anchorY (700) + menuHeight (372) = 1072 = vh (1080) - padding (8)
    // Equality with the gate is "<= vh - padding" → no flip.
    const result = computeMenuPosition({
      anchorX: 0,
      anchorY: 700,
      menuWidth: 256,
      menuHeight: 372,
      ...VIEWPORT,
    });
    expect(result.top).toBe(700);
  });
});

describe('computeMenuPosition — bottom-edge flip', () => {
  it('flips upward when downward render would clip past viewport bottom', () => {
    // Anchor at 1000, menu 180 tall → bottom would be 1180 > 1080.
    // Flip → top = anchorY - menuHeight = 1000 - 180 = 820.
    const result = computeMenuPosition({
      anchorX: 100,
      anchorY: 1000,
      menuWidth: 256,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result.top).toBe(820);
  });

  it('falls back to padding-from-top when menu is taller than viewport', () => {
    // Pathological: menu height 1200 > viewport 1080. Even the flip
    // (anchorY - menuHeight = -200) is off-screen, so we clamp to
    // VIEWPORT_PADDING. The user sees a too-tall menu pinned to the
    // top — not great but at least visible.
    const result = computeMenuPosition({
      anchorX: 100,
      anchorY: 500,
      menuWidth: 256,
      menuHeight: 1200,
      ...VIEWPORT,
    });
    expect(result.top).toBe(VIEWPORT_PADDING);
  });

  it('flip from anchor near bottom: pinned to anchor.y - height (the recommended position)', () => {
    // The flip pivots on the ANCHOR Y, not the viewport bottom — the
    // menu should appear "above" where the user clicked, not at the
    // top of the viewport. Pin that with an anchor where both rules
    // would produce different positions.
    const result = computeMenuPosition({
      anchorX: 100,
      anchorY: 900,
      menuWidth: 256,
      menuHeight: 200,
      ...VIEWPORT,
    });
    // Flipped top = 900 - 200 = 700. Definitely not 0 (top of viewport)
    // or 880 (vh - padding - height).
    expect(result.top).toBe(700);
  });
});

describe('computeMenuPosition — right-edge clamp (no horizontal flip)', () => {
  it('shifts left when menu would overflow right edge', () => {
    // anchorX 1800 + menuWidth 256 = 2056 > 1920. Shift left to
    // vw - menuWidth - padding = 1920 - 256 - 8 = 1656.
    const result = computeMenuPosition({
      anchorX: 1800,
      anchorY: 100,
      menuWidth: 256,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result.left).toBe(1656);
  });

  it('clamps to padding-from-left when menu is wider than viewport', () => {
    const result = computeMenuPosition({
      anchorX: 100,
      anchorY: 100,
      menuWidth: 3000,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result.left).toBe(VIEWPORT_PADDING);
  });

  it('preserves anchor when menu fits horizontally (no spurious clamp)', () => {
    const result = computeMenuPosition({
      anchorX: 200,
      anchorY: 100,
      menuWidth: 256,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result.left).toBe(200);
  });
});

describe('computeMenuPosition — combined flip + clamp', () => {
  it('right-clamps AND bottom-flips when both would clip', () => {
    // Bottom-right corner anchor with a chunky menu.
    const result = computeMenuPosition({
      anchorX: 1800,
      anchorY: 1000,
      menuWidth: 256,
      menuHeight: 180,
      ...VIEWPORT,
    });
    expect(result.left).toBe(1656);
    expect(result.top).toBe(820);
  });
});

describe('VIEWPORT_PADDING', () => {
  it('is 8 — the spec-pinned default', () => {
    // Pinning the value because the bottom-flip + right-clamp tests
    // above bake it in. If someone tunes this, those tests break
    // first → forces an intentional update of all baked-in numbers.
    expect(VIEWPORT_PADDING).toBe(8);
  });
});
