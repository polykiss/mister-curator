import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * PR-D2 round 2 commit 2 — "Find on ScreenScraper..." menu entry must
 * be available on every row regardless of metadata state.
 *
 * Round-1 (PR #29) shipped this entry with `disabled: !hasMetadata`,
 * which made the entry greyed-out on exactly the rows that NEEDED it
 * — the source='none' rows where the auto-binder missed.
 *
 * The buildMenuItems function is a closure over RomsPane state, so a
 * source-string scan is the right test pattern here (RomsPane has no
 * jsdom-based test infra). The contract is small: the menu push for
 * "Find on ScreenScraper" must NOT carry a `disabled:` key.
 */

// feat/arcade-refactor-1-adapter — RomsPane.tsx is now a thin
// wrapper that routes through ItemListPane; the actual menu-build /
// detail-modal / cell-render logic moved to roms-adapter.tsx
// (preserving the same code, just with a different return shape).
// refactor/extract-rom-list-view — row JSX (click handlers, cell
// rendering, cursor-pointer) moved from roms-adapter.tsx to
// RomListView.tsx. State declarations and dialog mounts stay in
// roms-adapter.tsx. Assertions scan whichever file holds the impl.
const SOURCE = readFileSync(
  resolve(__dirname, 'roms-adapter.tsx'),
  'utf8',
);
const ROM_LIST_VIEW_SOURCE = readFileSync(
  resolve(__dirname, 'RomListView.tsx'),
  'utf8',
);

describe('RomsPane — Find on ScreenScraper menu entry (PR-D2 r2 c2)', () => {
  it('"Find on ScreenScraper" menu push has no disabled: key', () => {
    // Capture the items.push({...}) block whose label starts with the
    // exact "Find on ScreenScraper" string (matches both with and
    // without the ★ prefix wrapper since the prefix is dynamic).
    const blockMatch = SOURCE.match(
      /items\.push\(\{[^}]*Find on ScreenScraper[^}]*\}\)/s,
    );
    expect(blockMatch).not.toBeNull();
    const block = blockMatch![0];
    // No disabled: key in this block — the entry must always be
    // clickable. (A disabled key is the regression we just fixed.)
    expect(block).not.toMatch(/\bdisabled:/);
  });

  it('label includes a ★ recommended prefix for source=none / missing-metadata rows', () => {
    // The prefix is the surfaced affordance — without it, the user has
    // no UI signal that this menu entry is the right next step for an
    // unmatched row. Pin it as a contract.
    expect(SOURCE).toContain('★ Find on ScreenScraper...');
  });

  it('isUnmatched gate fires on no-metadata OR source==="none"', () => {
    // The two states that mean "auto-binder didn't bind this row":
    // (a) the prefetch hasn't landed yet → no metadata at all; or
    // (b) the prefetch ran and explicitly returned no match (source='none').
    expect(SOURCE).toMatch(/sourceState === 'none'/);
    expect(SOURCE).toMatch(/!hasMetadata \|\| sourceState === 'none'/);
  });
});

/**
 * feat/metadata-detail-modal — wiring for the new detail dialog.
 * Same source-string scan pattern.
 *
 * The structural contract here is:
 *   1. `detailDialogFor` state is declared and follows the same
 *      shape as the other two row-scoped modal states.
 *   2. The name TableCell's onClick handler routes by `rom.kind`:
 *      folder-container drills (unchanged); file + folder-atomic
 *      with metadata opens the detail modal.
 *   3. The `RomDetailDialog` instance is mounted alongside the
 *      existing two modals.
 *   4. The detail modal's onEdit / onSearch callbacks hand off to
 *      the existing edit / search modal state setters — they do
 *      NOT duplicate the modal logic.
 */
describe('RomsPane — single-click → detail modal (feat/metadata-detail-modal)', () => {
  it('declares detailDialogFor state', () => {
    expect(SOURCE).toMatch(
      /const \[detailDialogFor, setDetailDialogFor\] = useState/,
    );
  });

  it('imports RomDetailDialog', () => {
    expect(SOURCE).toContain(
      "import { RomDetailDialog } from '@app/renderer/src/components/RomDetailDialog'",
    );
  });

  it('name-cell click handler preserves folder-container drill semantics', () => {
    // The folder-container drill case must hit FIRST and `return`
    // before any detail-modal branch — otherwise a clicked
    // folder-container would also try to open the detail modal.
    // refactor/extract-rom-list-view: click handler moved to RomListView.
    expect(ROM_LIST_VIEW_SOURCE).toMatch(
      /if \(rom\.kind === 'folder-container' && !rom\.hidden\) \{\s*e\.preventDefault\(\);\s*onRowActivate\(rom\);\s*return;\s*\}/,
    );
  });

  it('name-cell click handler opens detail modal for file / folder-atomic regardless of metadata state', () => {
    // The detail-modal branch fires for ANY file / folder-atomic
    // row — the modal's empty-state branch handles the no-record
    // case so unmatched / source=none rows are still clickable
    // (the modal becomes the single discovery point + offers
    // "Find on ScreenScraper" as the primary action).
    // refactor/extract-rom-list-view: click handler moved to RomListView.
    expect(ROM_LIST_VIEW_SOURCE).toMatch(
      /rom\.kind === 'file' \|\|\s*rom\.kind === 'folder-atomic'/,
    );
    expect(SOURCE).toMatch(/setDetailDialogFor\(\{/);
  });

  it('detail modal renders for any detailDialogFor — metadata passed through nullable', () => {
    // No defensive null-gate on the mount (unlike the edit modal,
    // which requires a populated record). The dialog accepts a
    // nullable `metadata` prop and renders an empty state when
    // none has landed.
    expect(SOURCE).toMatch(
      /metadata=\{metadataByPath\[detailDialogFor\.path\]\?\.metadata \?\? null\}/,
    );
  });

  it('onEdit hand-off sets the edit-modal state (no duplicate modal logic)', () => {
    // The detail modal's Edit button must reuse the existing
    // edit-metadata modal. Pin that the callback calls the same
    // setter the menu uses — not a new modal of its own.
    expect(SOURCE).toMatch(
      /onEdit=\{\(\) => \{\s*setEditMetadataFor\(\{[\s\S]*?path: detailDialogFor\.path/,
    );
  });

  it('onSearch hand-off sets the search-modal state', () => {
    expect(SOURCE).toMatch(
      /onSearch=\{\(\) => \{\s*setSearchScreenScraperFor\(\{[\s\S]*?path: detailDialogFor\.path/,
    );
  });

  it('cursor-pointer is applied to file / folder-atomic name cells unconditionally', () => {
    // The cursor change is the affordance. Applied to every file /
    // folder-atomic row regardless of metadata state — they're all
    // clickable (the modal handles the no-record case).
    // refactor/extract-rom-list-view: className logic moved to RomListView.
    expect(ROM_LIST_VIEW_SOURCE).toMatch(
      /\(rom\.kind === 'file' \|\|\s*rom\.kind === 'folder-atomic'\) &&\s*'cursor-pointer'/,
    );
  });
});
