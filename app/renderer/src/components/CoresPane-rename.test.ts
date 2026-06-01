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
  it('imports CoreLogo', () => {
    expect(SOURCE).toContain("import { CoreLogo }");
    expect(SOURCE).toContain("from '@app/renderer/src/components/CoreLogo'");
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

  it('loads catalog eagerly on mount (empty deps effect)', () => {
    expect(SOURCE).toContain('getSystemCatalog');
    // The effect must use empty deps [], not depend on menuFor.
    // Check that 'getSystemCatalog' does not appear inside an
    // if-block that guards on menuFor (line-local check, not cross-file).
    expect(SOURCE).not.toContain('menuFor !== null && systemCatalog === null');
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
    expect(SOURCE).toMatch(/h-14.*items-center.*gap-3.*border-b|group\/row.*h-14/s);
  });

  it('renders CoreLogo with catalogEntry?.logoUrl', () => {
    expect(SOURCE).toMatch(/<CoreLogo\b/);
    expect(SOURCE).toContain('catalogEntry?.logoUrl');
  });

  it('computes three-tier displayName (custom → SS → technical)', () => {
    expect(SOURCE).toContain('customName ?? catalogEntry?.displayName ?? technicalId');
  });

  it('conditionally renders subtitle when displayName !== technicalId', () => {
    expect(SOURCE).toContain('showSubtitle');
    expect(SOURCE).toContain('displayName !== technicalId');
  });

  it('adds title attribute to display name span for truncation tooltip', () => {
    expect(SOURCE).toContain('title={displayName}');
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
