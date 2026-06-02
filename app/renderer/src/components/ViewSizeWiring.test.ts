import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROMS_ADAPTER = readFileSync(resolve(__dirname, 'roms-adapter.tsx'), 'utf8');
const ARCADE_ADAPTER = readFileSync(resolve(__dirname, 'arcade-adapter.tsx'), 'utf8');
const DETAILED = readFileSync(resolve(__dirname, 'RomDetailedListView.tsx'), 'utf8');
const POSTER = readFileSync(resolve(__dirname, 'RomPosterView.tsx'), 'utf8');

describe('viewSize wiring — adapters (feat/view-size-control)', () => {
  it('roms-adapter imports SizeControl and ViewSize', () => {
    expect(ROMS_ADAPTER).toContain("import { SizeControl }");
    expect(ROMS_ADAPTER).toMatch(/ViewSize.*from.*roms-view-props/s);
  });

  it('roms-adapter persists viewSize with host-keyed key', () => {
    expect(ROMS_ADAPTER).toMatch(/mistercurator\.viewSize\.roms\.\$\{host\}/);
    expect(ROMS_ADAPTER).toMatch(/usePersistedString<ViewSize>/);
  });

  it('roms-adapter renders SizeControl only when not in list mode', () => {
    expect(ROMS_ADAPTER).toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });

  it('roms-adapter passes viewSize to view components via sharedProps', () => {
    expect(ROMS_ADAPTER).toMatch(/viewSize,/);
  });

  it('arcade-adapter has independent viewSize key (arcade, not roms)', () => {
    expect(ARCADE_ADAPTER).toMatch(/mistercurator\.viewSize\.arcade\.\$\{host\}/);
    expect(ROMS_ADAPTER).not.toMatch(/viewSize\.arcade\./);
    expect(ARCADE_ADAPTER).not.toMatch(/viewSize\.roms\./);
  });

  it('arcade-adapter renders SizeControl only in non-list modes', () => {
    expect(ARCADE_ADAPTER).toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });
});

describe('RomDetailedListView — size-driven rendering (feat/view-size-control)', () => {
  it('defines THUMB_PX map for all four sizes', () => {
    expect(DETAILED).toMatch(/THUMB_PX.*=.*\{.*S:.*M:.*L:.*XL:/s);
  });

  it('defines DESCRIPTION_LINE_CLAMP map for all four sizes', () => {
    expect(DETAILED).toMatch(/DESCRIPTION_LINE_CLAMP.*=.*\{.*S:.*M:.*L:.*XL:/s);
  });

  it('defaults viewSize to M', () => {
    expect(DETAILED).toMatch(/viewSize\s*=\s*'M'/);
  });

  it('passes descriptionContent to RomNameInner (description alignment fix)', () => {
    // Description is now passed as descriptionContent to RomNameInner so it
    // renders inside the title column, aligned with the title text.
    expect(DETAILED).toMatch(/descriptionContent=\{/);
    expect(DETAILED).toMatch(/RomNameInner[\s\S]{0,600}descriptionContent/);
  });

  it('thumbnail height is driven by thumbPx variable (not hardcoded h-20)', () => {
    expect(DETAILED).toMatch(/thumbPx/);
    // No hardcoded h-20 class (it should use inline style now)
    expect(DETAILED).not.toMatch(/className=".*\bh-20\b/);
  });
});

describe('RomPosterView — size-driven rendering (feat/view-size-control)', () => {
  it('defines TILE_MIN_WIDTH map for all four sizes', () => {
    expect(POSTER).toMatch(/TILE_MIN_WIDTH.*=.*\{.*S:.*M:.*L:.*XL:/s);
  });

  it('defaults viewSize to M', () => {
    expect(POSTER).toMatch(/viewSize\s*=\s*'M'/);
  });

  it('uses auto-fill minmax grid (not hardcoded grid-cols-N)', () => {
    expect(POSTER).toMatch(/repeat\(auto-fill,\s*minmax/);
    // No hardcoded grid-cols-4 in the main grid
    expect(POSTER).not.toMatch(/grid-cols-4[\s\S]{0,200}gap-4[\s\S]{0,200}p-4/);
  });

  it('applies the same grid style to both main and pinned grids', () => {
    // gridStyle is used in both grids
    const gridStyleCount = (POSTER.match(/style=\{gridStyle\}/g) ?? []).length;
    expect(gridStyleCount).toBeGreaterThanOrEqual(2);
  });
});
