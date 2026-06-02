import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROMS_ADAPTER = readFileSync(
  resolve(__dirname, 'roms-adapter.tsx'),
  'utf8',
);
const ARCADE_ADAPTER = readFileSync(
  resolve(__dirname, 'arcade-adapter.tsx'),
  'utf8',
);

describe('view-mode wiring — roms-adapter (refactor/unify-list-views)', () => {
  it('imports ViewModeToggle, RomPosterView, useViewPreferences (unified, no per-pane keys)', () => {
    expect(ROMS_ADAPTER).not.toContain("import { RomDetailedListView }");
    expect(ROMS_ADAPTER).toContain("import { RomPosterView }");
    expect(ROMS_ADAPTER).toContain("import { ViewModeToggle }");
    // feat/unified-views-and-optimistic-dots: usePersistedString replaced
    // by useViewPreferences (shared context).
    expect(ROMS_ADAPTER).not.toContain("import { usePersistedString }");
    expect(ROMS_ADAPTER).toContain("useViewPreferences");
  });

  it('uses unified view keys from context (not per-pane roms keys)', () => {
    // feat/unified-views-and-optimistic-dots: per-pane key removed,
    // both panes now read from ViewPreferencesContext.
    expect(ROMS_ADAPTER).not.toMatch(/mistercurator\.viewMode\.roms\./);
    expect(ROMS_ADAPTER).not.toMatch(/\['list',\s*'poster'\]/);
    expect(ROMS_ADAPTER).not.toMatch(/'detailed'/);
  });

  it('renders ViewModeToggle in the header', () => {
    expect(ROMS_ADAPTER).toMatch(/<ViewModeToggle\s+value=\{viewMode\}\s+onChange=\{setViewMode\}/);
  });

  it('SizeControl always visible (not conditional on viewMode)', () => {
    // Must contain SizeControl without a viewMode guard around it
    expect(ROMS_ADAPTER).toMatch(/<SizeControl\s+value=\{viewSize\}/);
    // Must NOT have the old viewMode !== 'list' guard
    expect(ROMS_ADAPTER).not.toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });

  it('switches between two view components (list + poster)', () => {
    expect(ROMS_ADAPTER).not.toMatch(/<RomDetailedListView\s/);
    expect(ROMS_ADAPTER).toMatch(/<RomPosterView\s/);
    expect(ROMS_ADAPTER).toMatch(/<RomListView\s/);
    expect(ROMS_ADAPTER).toMatch(/viewMode === 'poster'/);
    expect(ROMS_ADAPTER).not.toMatch(/viewMode === 'detailed'/);
  });
});

describe('view-mode wiring — arcade-adapter (refactor/unify-list-views)', () => {
  it('imports ViewModeToggle, RomPosterView, useViewPreferences', () => {
    expect(ARCADE_ADAPTER).not.toContain("import { RomDetailedListView }");
    expect(ARCADE_ADAPTER).toContain("import { RomPosterView }");
    expect(ARCADE_ADAPTER).toContain("import { ViewModeToggle }");
    expect(ARCADE_ADAPTER).toContain("useViewPreferences");
  });

  it('uses unified view keys from context (not per-pane arcade keys)', () => {
    // feat/unified-views-and-optimistic-dots: per-pane key removed.
    expect(ARCADE_ADAPTER).not.toMatch(/mistercurator\.viewMode\.arcade\./);
    expect(ARCADE_ADAPTER).not.toMatch(/\['list',\s*'poster'\]/);
  });

  it('SizeControl always visible in arcade', () => {
    expect(ARCADE_ADAPTER).toMatch(/<SizeControl\s+value=\{viewSize\}/);
    expect(ARCADE_ADAPTER).not.toMatch(/viewMode !== 'list'[\s\S]{0,100}<SizeControl/);
  });

  it('view mode is now universal (both panes use ViewPreferencesContext)', () => {
    // feat/unified-views-and-optimistic-dots: per-pane keys removed.
    // Both adapters read from ViewPreferencesContext (unified key
    // mistercurator.viewMode.${host}).
    expect(ROMS_ADAPTER).not.toMatch(/viewMode\.roms\./);
    expect(ARCADE_ADAPTER).not.toMatch(/viewMode\.arcade\./);
    expect(ROMS_ADAPTER).toContain('useViewPreferences');
    expect(ARCADE_ADAPTER).toContain('useViewPreferences');
  });

  it('passes arcadeContext through sharedProps', () => {
    expect(ARCADE_ADAPTER).toMatch(/arcadeContext:\s*arcadeRowContext/);
    const count = (ARCADE_ADAPTER.match(/arcadeContext:/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

describe('RomPosterView — structure (feat/view-modes)', () => {
  const POSTER = readFileSync(
    resolve(__dirname, 'RomPosterView.tsx'),
    'utf8',
  );

  it('renders a grid container (not a table)', () => {
    expect(POSTER).toMatch(/grid/);
    expect(POSTER).not.toContain('<Table>');
    expect(POSTER).not.toContain('<TableBody>');
  });

  it('renders one PosterTile per rom', () => {
    expect(POSTER).toMatch(/unpinned\.map\(renderTile\)/);
  });

  it('pinned rows render in a separate section at the top', () => {
    expect(POSTER).toMatch(/pinned\.length > 0/);
    expect(POSTER).toMatch(/pinned\.map\(renderTile\)/);
  });

  it('selection shows a ring on the tile', () => {
    expect(POSTER).toMatch(/ring-2 ring-accent/);
    expect(POSTER).toMatch(/isSelected/);
  });

  it('hidden state dims the tile', () => {
    expect(POSTER).toMatch(/isDimmed && 'opacity-50'/);
  });

  it('Missing ROMs badge shows for arcade isMissing rows', () => {
    expect(POSTER).toContain('Missing ROMs');
    expect(POSTER).toMatch(/isMissing/);
  });
});

describe('RomListView — unified size-aware rendering (refactor/unify-list-views)', () => {
  const LIST_VIEW = readFileSync(
    resolve(__dirname, 'RomListView.tsx'),
    'utf8',
  );

  it('defines THUMB_PX with S=48 (minimal) through XL=160', () => {
    expect(LIST_VIEW).toMatch(/THUMB_PX.*\{.*S:\s*48.*M:\s*80.*L:\s*120.*XL:\s*160/s);
  });

  it('defines DESCRIPTION_LINE_CLAMP with S=null (no description at compact size)', () => {
    expect(LIST_VIEW).toMatch(/DESCRIPTION_LINE_CLAMP/);
    expect(LIST_VIEW).toMatch(/S:\s*null/);
    expect(LIST_VIEW).toMatch(/M:\s*'line-clamp-2'/);
  });

  it('defaults viewSize to S (preserves original compact behaviour)', () => {
    expect(LIST_VIEW).toMatch(/viewSize\s*=\s*'S'/);
  });

  it('passes descriptionContent to RomNameInner for M+ sizes (alignment fix)', () => {
    expect(LIST_VIEW).toMatch(/descriptionContent=\{/);
    expect(LIST_VIEW).toMatch(/RomNameInner[\s\S]{0,600}descriptionContent/);
  });

  it('uses DetailedThumbnailCell at M+ sizes, RomThumbnailCell at S', () => {
    expect(LIST_VIEW).toMatch(/DetailedThumbnailCell/);
    expect(LIST_VIEW).toMatch(/RomThumbnailCell/);
    expect(LIST_VIEW).toMatch(/isDetailed/);
  });

  it('Missing ROMs badge preserved for arcade rows', () => {
    expect(LIST_VIEW).toContain('Missing ROMs');
  });
});
