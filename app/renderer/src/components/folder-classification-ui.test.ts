import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-string regression for PR #13's tri-state folder-classification
 * UI. Vitest is `node` env in this project (no jsdom), so this test
 * inspects the JSX source as a proxy for behavior — same pattern as
 * `right-edge-stack.test.ts` and `cores-context-cache-intent.test.ts`.
 *
 * What it pins down:
 *   - RomRowMenu reserves a leading checkmark column when ANY item
 *     has `checked` defined, and renders the Check glyph on items
 *     where `checked === true`.
 *   - RomsPane's folder-row menu produces three items — Treat as ROM,
 *     Treat as folder of ROMs, Treat as system — each with `checked`
 *     wired to the row's current state.
 *   - RomsPane's toolbar exposes three bulk-action buttons that
 *     fire `setFolderClassifications` (the batched IPC) so a 600-
 *     folder X68000 sweep is a single device round trip.
 */

const ROM_ROW_MENU = readFileSync(
  resolve(__dirname, 'RomRowMenu.tsx'),
  'utf8',
);
const ROMS_PANE = readFileSync(
  resolve(__dirname, 'RomsPane.tsx'),
  'utf8',
);

describe('RomRowMenu — checkmark slot (PR #13)', () => {
  it('exposes `checked?: boolean` on RomRowMenuItem', () => {
    expect(ROM_ROW_MENU).toMatch(/readonly\s+checked\??:\s*boolean/);
  });

  it('renders the Check glyph when an item is checked', () => {
    // The component imports Check from lucide-react and uses it
    // inside a leading icon column. The column appears only when
    // some item has `checked` defined, so single-state menus
    // (file-row mark/unmark) keep their pre-PR-13 layout.
    expect(ROM_ROW_MENU).toContain("import { Check } from 'lucide-react'");
    expect(ROM_ROW_MENU).toMatch(/items\.some\(\(i\)\s*=>\s*i\.checked\s*!==\s*undefined\)/);
    expect(ROM_ROW_MENU).toMatch(/<Check\s/);
  });

  it('passes aria-checked through to the menu button', () => {
    // Accessibility: a screen reader needs to know the current
    // selection state of the tri-state. `aria-checked` is the
    // attribute for menuitemcheckbox / menuitemradio semantics.
    expect(ROM_ROW_MENU).toContain('aria-checked={item.checked');
  });
});

describe('RomsPane — folder-row tri-state menu (PR #13)', () => {
  it('imports FolderClassificationUpdateWire for the bulk IPC payload', () => {
    expect(ROMS_PANE).toContain(
      "import type { FolderClassificationUpdateWire } from '@shared/preload-api'",
    );
  });

  it('consumes setFolderClassifications from the cores context', () => {
    expect(ROMS_PANE).toMatch(/setFolderClassifications\s*,/);
  });

  it("emits three menu items for folder rows: 'Treat as ROM' / 'Treat as folder of ROMs' / 'Treat as system'", () => {
    // The folder branch of buildMenuItems builds three labels in
    // order. Order matters for keyboard nav predictability.
    expect(ROMS_PANE).toContain("label: 'Treat as ROM'");
    expect(ROMS_PANE).toContain("label: 'Treat as folder of ROMs'");
    expect(ROMS_PANE).toContain("label: 'Treat as system'");
  });

  it('wires the checkmark on each tri-state item to the active classification', () => {
    // The active state is computed locally as:
    //   - isMarkedSystem: user-mark wins
    //   - isAtomic: rom.kind === 'folder-atomic' AND not system-marked
    //   - isContainer: rom.kind === 'folder-container' AND not system-marked
    // Each menu item passes its boolean into `checked`.
    expect(ROMS_PANE).toMatch(/checked:\s*isAtomic/);
    expect(ROMS_PANE).toMatch(/checked:\s*isContainer/);
    expect(ROMS_PANE).toMatch(/checked:\s*isMarkedSystem/);
  });

  it('routes each menu pick through onSetClassification with the correct value', () => {
    // The onSelect handlers fire onSetClassification(rom, value)
    // where value matches the menu item. Tri-state in, tri-state out.
    expect(ROMS_PANE).toMatch(/onSetClassification\(rom,\s*'atomic'\)/);
    expect(ROMS_PANE).toMatch(/onSetClassification\(rom,\s*'container'\)/);
    expect(ROMS_PANE).toMatch(/onSetClassification\(rom,\s*'system'\)/);
  });
});

describe('RomsPane — bulk classification toolbar (PR #13)', () => {
  it('exposes selectedFolderRows derived from the table selection', () => {
    // Bulk-action candidates: only folder rows in the user's
    // selection. Files in the selection are ignored — the bulk
    // classification axis is folder-only.
    expect(ROMS_PANE).toContain('const selectedFolderRows =');
    expect(ROMS_PANE).toMatch(/r\.kind\s*!==\s*'file'/);
  });

  it("toolbar renders three bulk buttons: 'Treat as ROM' / 'Treat as folder' / 'Treat as system'", () => {
    expect(ROMS_PANE).toContain('Treat as ROM ({selectedFolderRows.length})');
    expect(ROMS_PANE).toContain('Treat as folder ({selectedFolderRows.length})');
    expect(ROMS_PANE).toContain('Treat as system ({selectedFolderRows.length})');
  });

  it('bulk handler builds an updates array and fires setFolderClassifications', () => {
    // The handler builds `updates: FolderClassificationUpdateWire[]`
    // from selectedFolderRows then calls setFolderClassifications —
    // the batched IPC. Looping over the single-folder API would be
    // 600 × 2 = 1200 device writes for X68000; the batched form is 2.
    expect(ROMS_PANE).toMatch(/const onBulkClassify = async/);
    expect(ROMS_PANE).toMatch(
      /updates:\s*FolderClassificationUpdateWire\[\]\s*=\s*targets\.map/,
    );
    expect(ROMS_PANE).toMatch(/setFolderClassifications\(core\.id,\s*updates\)/);
  });

  it('bulk buttons disable when no folder is selected', () => {
    // The disabled gate prevents accidental no-op calls and keeps
    // the button states aligned with what the underlying handler
    // would actually do.
    expect(ROMS_PANE).toMatch(
      /disabled=\{!canMutate\s*\|\|\s*selectedFolderRows\.length\s*===\s*0\}/,
    );
  });
});
