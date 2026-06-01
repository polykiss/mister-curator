import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for the context-menu and core-info additions in
 * CoresPane (#30 PR-2).
 *
 * Source-string scanning (same pattern as CoresPane-progress.test.ts):
 * CoresPane renders inside a context tree that is hard to replicate in
 * a node-environment test. The structural rules below catch the
 * integration regressions we care about — handler wiring, IPC call
 * placement, toast call patterns, and disabled-state logic.
 */
const SOURCE = readFileSync(
  resolve(__dirname, 'CoresPane.tsx'),
  'utf8',
);

describe('CoresPane — context-menu plumbing', () => {
  it('imports RomRowMenu', () => {
    expect(SOURCE).toContain("import { RomRowMenu }");
    expect(SOURCE).toContain("from '@app/renderer/src/components/RomRowMenu'");
  });

  it('imports CoreInfoDialog', () => {
    expect(SOURCE).toContain("import { CoreInfoDialog }");
    expect(SOURCE).toContain("from '@app/renderer/src/components/CoreInfoDialog'");
  });

  it('imports SystemCatalogWireEntry type', () => {
    expect(SOURCE).toContain('SystemCatalogWireEntry');
  });

  it('declares menuFor state', () => {
    expect(SOURCE).toContain('menuFor');
    expect(SOURCE).toContain('setMenuFor');
  });

  it('declares infoFor state', () => {
    expect(SOURCE).toContain('infoFor');
    expect(SOURCE).toContain('setInfoFor');
  });

  it('declares systemCatalog state', () => {
    expect(SOURCE).toContain('systemCatalog');
    expect(SOURCE).toContain('setSystemCatalog');
  });

  it('declares rescrapeInFlight state', () => {
    expect(SOURCE).toContain('rescrapeInFlight');
    expect(SOURCE).toContain('setRescrapeInFlight');
  });

  it('lazy-loads catalog in a useEffect on first menu open', () => {
    expect(SOURCE).toContain('useEffect');
    expect(SOURCE).toContain('getSystemCatalog');
    // The effect only fires when menuFor is non-null and catalog is null
    expect(SOURCE).toMatch(/menuFor.*!==.*null|menuFor.*null/s);
    expect(SOURCE).toMatch(/systemCatalog.*===.*null|systemCatalog.*null/s);
  });

  it('adds onContextMenu handler to RenderArgs', () => {
    expect(SOURCE).toContain('onContextMenu:');
    // The handler passes the core and cursor coords
    expect(SOURCE).toMatch(/onContextMenu.*core.*clientX.*clientY|clientX.*clientY.*onContextMenu/s);
  });

  it('attaches onContextMenu to the <li> row', () => {
    // The li must call e.preventDefault() and args.onContextMenu
    expect(SOURCE).toContain('e.preventDefault()');
    expect(SOURCE).toContain('args.onContextMenu');
  });

  it('conditionally renders RomRowMenu when menuFor is non-null', () => {
    expect(SOURCE).toMatch(/menuFor.*!==.*null[\s\S]*<RomRowMenu|menuFor.*\?[\s\S]*<RomRowMenu/);
  });

  it('passes buildMenuItems result to RomRowMenu items prop', () => {
    expect(SOURCE).toContain('buildMenuItems(menuFor.core)');
  });

  it('renders CoreInfoDialog with infoFor as the core prop', () => {
    expect(SOURCE).toContain('<CoreInfoDialog');
    expect(SOURCE).toContain('core={infoFor}');
    expect(SOURCE).toContain('catalog={systemCatalog}');
  });
});

describe('CoresPane — buildMenuItems logic', () => {
  it('includes "Show core info" item that sets infoFor', () => {
    expect(SOURCE).toContain('Show core info');
    expect(SOURCE).toContain('setInfoFor(core)');
  });

  it('includes "Rescrape system" item', () => {
    expect(SOURCE).toContain('Rescrape system');
  });

  it('disables rescrape when no logo URL', () => {
    // The disabled condition checks for hasLogo or isInFlight
    expect(SOURCE).toContain('hasLogo');
    expect(SOURCE).toContain('isInFlight');
    expect(SOURCE).toMatch(/disabled.*!hasLogo.*\|\|.*isInFlight|disabled.*isInFlight.*\|\|.*!hasLogo/s);
  });

  it('shows a tooltip when no SS coverage', () => {
    expect(SOURCE).toContain('No ScreenScraper coverage for this system');
  });

  it('calls rescrapeSystemLogo with the logoUrl', () => {
    expect(SOURCE).toContain('rescrapeSystemLogo');
    expect(SOURCE).toContain('entry.logoUrl');
  });

  it('shows toast.success on successful rescrape', () => {
    expect(SOURCE).toContain('toast.success');
    expect(SOURCE).toContain('entry.displayName');
  });

  it('shows toast.error on failed rescrape (null result)', () => {
    expect(SOURCE).toContain('toast.error');
    expect(SOURCE).toContain('Could not fetch logo');
  });

  it('shows toast.error on caught exception', () => {
    // Should have at least two toast.error calls (null result + catch)
    const errorCount = (SOURCE.match(/toast\.error/g) ?? []).length;
    expect(errorCount).toBeGreaterThanOrEqual(2);
  });

  it('removes core.id from rescrapeInFlight in finally block', () => {
    expect(SOURCE).toContain('finally');
    expect(SOURCE).toContain('next.delete(core.id)');
  });
});
