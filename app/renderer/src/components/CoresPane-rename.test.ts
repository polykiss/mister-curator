import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for the sidebar-logos-and-naming additions in
 * CoresPane (#30 PR-3).
 *
 * Source-string scanning (same pattern as CoresPane-context-menu.test.ts).
 */
const SOURCE = readFileSync(resolve(__dirname, 'CoresPane.tsx'), 'utf8');

describe('CoresPane — sidebar logos and naming', () => {
  it('imports PlatformBadge (D11: replaced CoreLogo in the sidebar row)', () => {
    expect(SOURCE).toContain("import { PlatformBadge }");
    expect(SOURCE).toContain("from '@app/renderer/src/components/PlatformBadge'");
  });

  it('imports CoreRenameDialog', () => {
    expect(SOURCE).toContain("import { CoreRenameDialog }");
    expect(SOURCE).toContain("from '@app/renderer/src/components/CoreRenameDialog'");
  });

  it('imports useCoreCustomNames', () => {
    expect(SOURCE).toContain("import { useCoreCustomNames }");
    expect(SOURCE).toContain("from '@app/renderer/src/lib/use-core-custom-names'");
  });

  it('calls useCoreCustomNames hook in component body', () => {
    expect(SOURCE).toContain('useCoreCustomNames()');
  });

  it('declares renameFor state', () => {
    expect(SOURCE).toContain('renameFor');
    expect(SOURCE).toContain('setRenameFor');
  });

  it('loads catalog with bounded retry pattern', () => {
    expect(SOURCE).toContain('getSystemCatalog');
    expect(SOURCE).toContain('MAX_CATALOG_ATTEMPTS');
    expect(SOURCE).toContain('CATALOG_RETRY_MS');
    // retries on connection transitions, not on menuFor
    expect(SOURCE).not.toContain('menuFor !== null && systemCatalog === null');
  });

  it('sorts visibleCores by resolved display name (custom → SS → technical)', () => {
    // Sort must use the three-tier name so renaming a core re-positions it
    expect(SOURCE).toContain('localeCompare');
    expect(SOURCE).toContain('sensitivity');
    expect(SOURCE).toMatch(/customNames\.customName.*systemCatalog.*\?.*\[.*\].*displayName.*coreDisplayName/s);
  });

  it('includes customNames and systemCatalog in visibleCores useMemo deps', () => {
    expect(SOURCE).toMatch(/\[cores.*customNames.*systemCatalog|customNames.*systemCatalog.*cores/s);
  });

  it('threads catalog through RenderArgs', () => {
    expect(SOURCE).toContain('catalog: systemCatalog');
    expect(SOURCE).toMatch(/readonly catalog:.*SystemCatalogWireEntry/s);
  });

  it('threads customNames through RenderArgs', () => {
    expect(SOURCE).toContain('customNames,');
    expect(SOURCE).toMatch(/readonly customNames:/s);
  });

  it('uses h-14 for the loading skeleton', () => {
    expect(SOURCE).toContain('h-14 w-full');
  });

  it('uses h-14 for the row li element', () => {
    // D11: row is now items-stretch (grid layout), not items-center gap-3.
    expect(SOURCE).toMatch(/h-14.*items-stretch.*border-b|group\/row.*h-14/s);
  });

  it('renders PlatformBadge with catalogEntry?.logoUrl (D11: replaces CoreLogo)', () => {
    expect(SOURCE).toMatch(/<PlatformBadge\b/);
    expect(SOURCE).toContain('catalogEntry?.logoUrl');
  });

  it('computes three-tier displayName (custom → SS → technical)', () => {
    expect(SOURCE).toContain('customName ?? catalogEntry?.displayName ?? technicalId');
  });

  it('always shows mono core-id (D11: replaces showSubtitle conditional)', () => {
    // D11: core-id is always shown as the secondary mono line —
    // eliminates the inconsistent rows where subtitle only showed
    // when displayName !== technicalId.
    expect(SOURCE).not.toContain('showSubtitle');
    expect(SOURCE).toContain('technicalId');
    // core-id rendered in mono fg-disabled
    expect(SOURCE).toContain('font-mono text-body-sm text-fg-disabled');
  });

  it('adds title attribute to core-id span for truncation tooltip', () => {
    expect(SOURCE).toContain('title={technicalId}');
  });

  it('renders CoreRenameDialog with renameFor as core prop', () => {
    expect(SOURCE).toContain('<CoreRenameDialog');
    expect(SOURCE).toContain('core={renameFor}');
  });

  it('keys CoreRenameDialog by renameFor.id for fresh state on each open', () => {
    expect(SOURCE).toContain("key={renameFor?.id ?? 'none'}");
  });
});

describe('CoresPane — buildMenuItems rename additions', () => {
  it('includes "Rename…" as a menu item', () => {
    expect(SOURCE).toContain("'Rename…'");
  });

  it('"Rename…" sets renameFor and clears menuFor', () => {
    expect(SOURCE).toContain('setRenameFor(core)');
  });

  it('includes "Reset name" item conditional on hasCustom', () => {
    expect(SOURCE).toContain('Reset name');
    expect(SOURCE).toContain('hasCustom');
  });

  it('"Reset name" calls clearCustomName and shows toast', () => {
    expect(SOURCE).toContain('clearCustomName(core.id)');
    expect(SOURCE).toMatch(/toast\.success.*Name reset|Name reset.*toast\.success/s);
  });
});

describe('CoresPane — CoreInfoDialog invert', () => {
  // Verify the CoreInfoDialog file (same directory) got the invert fix.
  it('CoreInfoDialog.tsx has invert on the logo img', () => {
    const dialogSrc = readFileSync(
      resolve(__dirname, 'CoreInfoDialog.tsx'),
      'utf8',
    );
    expect(dialogSrc).toMatch(/object-contain invert|invert.*object-contain/);
  });
});
