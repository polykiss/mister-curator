import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROMS_ADAPTER = readFileSync(resolve(__dirname, 'roms-adapter.tsx'), 'utf8');
const ARCADE_ADAPTER = readFileSync(resolve(__dirname, 'arcade-adapter.tsx'), 'utf8');
const LIST_VIEW = readFileSync(resolve(__dirname, 'RomListView.tsx'), 'utf8');
const POSTER = readFileSync(resolve(__dirname, 'RomPosterView.tsx'), 'utf8');

describe('viewSize wiring — adapters (refactor/unify-list-views)', () => {
  it('roms-adapter imports SizeControl and uses useViewPreferences', () => {
    expect(ROMS_ADAPTER).toContain("import { SizeControl }");
    // feat/unified-views-and-optimistic-dots: viewSize now from context.
    expect(ROMS_ADAPTER).toContain('useViewPreferences');
  });

  it('roms-adapter uses unified viewSize key from context', () => {
    // Per-pane key removed; both adapters use ViewPreferencesContext.
    expect(ROMS_ADAPTER).not.toMatch(/mistercurator\.viewSize\.roms\./);
    expect(ROMS_ADAPTER).not.toMatch(/usePersistedString<ViewSize>/);
  });

  it('roms-adapter renders SizeControl unconditionally (both list and poster)', () => {
    // SizeControl is always visible now — list mode uses it too (for size scaling)
    expect(ROMS_ADAPTER).toMatch(/<SizeControl\s+value=\{viewSize\}/);
    expect(ROMS_ADAPTER).not.toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });

  it('roms-adapter passes viewSize to view components via sharedProps', () => {
    expect(ROMS_ADAPTER).toMatch(/viewSize,/);
  });

  it('viewSize is now universal (no per-pane arcade/roms keys)', () => {
    // feat/unified-views-and-optimistic-dots: unified, not per-pane.
    expect(ARCADE_ADAPTER).not.toMatch(/mistercurator\.viewSize\.arcade\./);
    expect(ROMS_ADAPTER).not.toMatch(/viewSize\.arcade\./);
    expect(ARCADE_ADAPTER).not.toMatch(/viewSize\.roms\./);
    expect(ROMS_ADAPTER).not.toMatch(/viewSize\.roms\./);
  });

  it('arcade-adapter renders SizeControl unconditionally', () => {
    expect(ARCADE_ADAPTER).toMatch(/<SizeControl\s+value=\{viewSize\}/);
    expect(ARCADE_ADAPTER).not.toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });
});

describe('RomListView — unified size-driven rendering (refactor/unify-list-views)', () => {
  it('defines THUMB_PX map for all four sizes (S=48 for compact compatibility)', () => {
    expect(LIST_VIEW).toMatch(/THUMB_PX.*=.*\{.*S:.*48.*M:.*80.*L:.*120.*XL:.*160/s);
  });

  it('defines DESCRIPTION_LINE_CLAMP map (S=null = no description at compact size)', () => {
    expect(LIST_VIEW).toMatch(/DESCRIPTION_LINE_CLAMP.*=.*\{.*S:.*null.*M:.*L:.*XL:/s);
  });

  it('defaults viewSize to S (preserves original minimal-list behaviour)', () => {
    expect(LIST_VIEW).toMatch(/viewSize\s*=\s*'S'/);
  });

  it('passes descriptionContent to RomNameInner at M+ sizes', () => {
    expect(LIST_VIEW).toMatch(/descriptionContent=\{/);
    expect(LIST_VIEW).toMatch(/RomNameInner[\s\S]{0,600}descriptionContent/);
  });

  it('uses DetailedThumbnailCell at M+ and RomThumbnailCell at S', () => {
    expect(LIST_VIEW).toMatch(/DetailedThumbnailCell/);
    expect(LIST_VIEW).toMatch(/RomThumbnailCell/);
    expect(LIST_VIEW).toMatch(/isDetailed/);
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
    expect(POSTER).not.toMatch(/grid-cols-4[\s\S]{0,200}gap-4[\s\S]{0,200}p-4/);
  });

  it('applies the same grid style to both main and pinned grids', () => {
    const gridStyleCount = (POSTER.match(/style=\{gridStyle\}/g) ?? []).length;
    expect(gridStyleCount).toBeGreaterThanOrEqual(2);
  });
});
