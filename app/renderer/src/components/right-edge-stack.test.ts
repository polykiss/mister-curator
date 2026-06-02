import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-string regression for the density+eye "right-edge stack" that
 * sits at the far right of every cores-pane and ROMs-pane row. The
 * design contract (SYSTEM.md §10): density rectangle full row height,
 * eye icon immediately to its right, no gap between them, the whole
 * stack pinned to the row's right edge.
 *
 * This test runs in vitest's node environment — there's no jsdom in
 * this project — so it asserts JSX-source properties as a proxy for a
 * DOM-shape test. The properties checked here are the same ones that
 * would render correctly OR incorrectly in a browser:
 *
 *   - the wrapper around DensityBar + the eye Button has `flex` and
 *     `items-stretch` and NO gap-/space-/mx- spacing utility classes
 *   - DensityBar is immediately followed by the Button (no spacer
 *     element between them)
 *   - the eye Button uses `group-hover/row` (row-hover) not plain
 *     `hover:` (button-self hover) so both panes match
 *
 * PR #11 round 5 added the ROMs-pane assertions after a live test
 * showed visible whitespace between density and eye on the ROMs pane.
 *
 * PR #23 round 4 extracted the ROMs-pane density+eye cell into
 * `RomMetadataCells.tsx` (as `RomDensityEyeCell`) so this test now
 * scans that file for the ROMs-pane assertions; the stronger,
 * exported-constant contract lives in `RomMetadataCells.test.ts`.
 * The cores-pane density+eye stays inline in `CoresPane.tsx`.
 */

// Round 4: the ROMs-pane density+eye cell lives in RomMetadataCells,
// not RomsPane. Source assertions targeting that cell scan here.
const ROMS_DENSITY_EYE_SOURCE = readFileSync(
  resolve(__dirname, 'RomMetadataCells.tsx'),
  'utf8',
);
// refactor/extract-rom-list-view — the table JSX moved from
// roms-adapter.tsx into RomListView.tsx. All table structure
// assertions now scan RomListView.tsx directly.
const ROM_LIST_VIEW = readFileSync(
  resolve(__dirname, 'RomListView.tsx'),
  'utf8',
);
const CORES_PANE = readFileSync(
  resolve(__dirname, 'CoresPane.tsx'),
  'utf8',
);

/** Pulls the JSX block enclosing DensityBar + the eye Button. Anchors
 * on `items-stretch` to disambiguate the right-edge stack's wrapper
 * from the outer pane container (which is also a flex but never has
 * `items-stretch`). */
function findRightEdgeStackWrapperClasses(source: string): string {
  // Only the right-edge stack wrapper carries items-stretch in these
  // panes. Find such a wrapper that has a DensityBar inside it.
  const re =
    /<div\s+className=["']([^"']*\bitems-stretch\b[^"']*)["'][^>]*>[\s\S]*?<DensityBar/;
  const match = re.exec(source);
  if (match === null) {
    throw new Error('right-edge stack wrapper not found');
  }
  return match[1] ?? '';
}

describe('Right-edge stack — density + eye structure (PR #11 round 5)', () => {
  it('cores pane wrapper: flex + items-stretch, no spacing classes', () => {
    const cls = findRightEdgeStackWrapperClasses(CORES_PANE);
    expect(cls).toContain('flex');
    expect(cls).toContain('items-stretch');
    // No horizontal/vertical spacing between density and eye.
    expect(cls).not.toMatch(/\bgap-\d/);
    expect(cls).not.toMatch(/\bspace-x-\d/);
    expect(cls).not.toMatch(/\bspace-y-\d/);
    expect(cls).not.toMatch(/\bmx-\d/);
  });

  it('roms pane wrapper: flex + items-stretch, no spacing classes', () => {
    const cls = findRightEdgeStackWrapperClasses(ROMS_DENSITY_EYE_SOURCE);
    expect(cls).toContain('flex');
    expect(cls).toContain('items-stretch');
    expect(cls).not.toMatch(/\bgap-\d/);
    expect(cls).not.toMatch(/\bspace-x-\d/);
    expect(cls).not.toMatch(/\bspace-y-\d/);
    expect(cls).not.toMatch(/\bmx-\d/);
  });

  it('roms pane wrapper uses absolute positioning to fill the row height', () => {
    // PR #23 round 4: hardcoded `h-10` (round 1/2) and percentage
    // `h-full` on the `<td>` (round 3) both failed live — the bar
    // either left a gap or rendered at 0px. Round 4 wraps the
    // density+eye stack in `position: absolute; inset: 0` inside a
    // `position: relative` `<td>` so the wrapper fills the cell's
    // actual rendered bounds regardless of how percentage heights
    // resolve. Pin against re-introduction of the previous failed
    // approaches.
    const cls = findRightEdgeStackWrapperClasses(ROMS_DENSITY_EYE_SOURCE);
    expect(cls).toContain('absolute');
    expect(cls).toContain('inset-0');
    expect(cls).not.toMatch(/\bh-\d+\b/);
    expect(cls).not.toMatch(/\bh-full\b/);
  });

  it('roms pane MoreHorizontal cell uses py-0 to keep the row at h-10', () => {
    // The icon button is h-8 (32px). TableCell's default py-2 (16px
    // total vertical padding) would push cell content to 48px and
    // force the row past its h-10 design height — the visible
    // symptom was 4px of bg-elevated above and below the density
    // rectangle in the right-edge cell.
    // refactor/extract-rom-list-view: the cell now lives in RomListView.tsx.
    expect(ROM_LIST_VIEW).toMatch(/<TableCell\s+className="w-10\s+py-0"/);
  });

  it('roms pane eye button uses group-hover/row (row-hover, matching cores pane)', () => {
    // Both panes wrap rows in `group/row`. The eye button on cores
    // pane uses `group-hover/row:opacity-100` so hovering anywhere
    // on the row lifts the eye to full opacity. ROMs pane was using
    // plain `hover:opacity-100` (button-self hover only) — visually
    // inconsistent. Round 4: the ROMs eye button moved into
    // RomMetadataCells (RomDensityEyeCell) so scan there.
    expect(ROMS_DENSITY_EYE_SOURCE).toContain('group-hover/row:opacity-100');
  });

  it('DensityBar is the immediate prior sibling of the eye Button (no spacer between)', () => {
    // The JSX between `<DensityBar` and the next `<Button` should
    // not contain any element tag, just a closing `/>` and the
    // ternary boilerplate. A literal `<span>` or `<div>` between
    // them would create the very gap this test guards against.
    //
    // Exception: branches of the ternary that gate on a *mutually
    // exclusive* row state (system file → "read-only" copy span;
    // arcade placeholder → ARCADE_TOOLTIP span; mid-rename → loading
    // spinner span; feat/arcade-sidebar-alignment → arcade eye-slot
    // spacer). These never render alongside the eye Button at
    // runtime — JSX renders one branch of the ternary, not all
    // three. Detect them by their gate text or aria-label.
    const ALLOWED_BRANCH_MARKERS = /(read-only|ARCADE_TOOLTIP|aria-label=\{\s*isHiddenCore|role="status"|data-arcade-eye-slot)/;
    for (const [name, source] of [
      ['cores pane', CORES_PANE],
      ['roms pane', ROMS_DENSITY_EYE_SOURCE],
    ] as const) {
      const idx = source.indexOf('<DensityBar');
      expect(idx, `${name}: DensityBar not found`).toBeGreaterThan(-1);
      const buttonIdx = source.indexOf('<Button', idx);
      expect(buttonIdx, `${name}: <Button after DensityBar not found`).toBeGreaterThan(-1);
      const between = source.slice(idx, buttonIdx);
      const spanMatches = [...between.matchAll(/<span\b[^>]*>/g)];
      for (const m of spanMatches) {
        // Look at the first ~250 chars of the span so we can spot a
        // gating marker (a "read-only" / arcade / pending branch).
        const after = between.slice(m.index ?? 0, (m.index ?? 0) + 250);
        expect(
          ALLOWED_BRANCH_MARKERS.test(after),
          `${name}: unexpected <span> between DensityBar and Button (not a gated mutually-exclusive branch): ${m[0]}`,
        ).toBe(true);
      }
    }
  });
});
