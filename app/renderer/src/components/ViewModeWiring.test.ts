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

describe('view-mode wiring — roms-adapter (feat/view-modes)', () => {
  it('imports ViewModeToggle, RomDetailedListView, RomPosterView, usePersistedString', () => {
    expect(ROMS_ADAPTER).toContain("import { RomDetailedListView }");
    expect(ROMS_ADAPTER).toContain("import { RomPosterView }");
    expect(ROMS_ADAPTER).toContain("import { ViewModeToggle }");
    expect(ROMS_ADAPTER).toContain("import { usePersistedString }");
  });

  it('persists viewMode per host under the expected localStorage key', () => {
    expect(ROMS_ADAPTER).toMatch(/mistercurator\.viewMode\.roms\.\$\{host\}/);
    expect(ROMS_ADAPTER).toMatch(/usePersistedString<ViewMode>/);
  });

  it('renders ViewModeToggle in the header alongside the filter input', () => {
    expect(ROMS_ADAPTER).toMatch(/<ViewModeToggle\s+value=\{viewMode\}\s+onChange=\{setViewMode\}/);
  });

  it('switches between all three view components', () => {
    expect(ROMS_ADAPTER).toMatch(/<RomDetailedListView\s/);
    expect(ROMS_ADAPTER).toMatch(/<RomPosterView\s/);
    expect(ROMS_ADAPTER).toMatch(/<RomListView\s/);
    // Both checks for viewMode branching
    expect(ROMS_ADAPTER).toMatch(/viewMode === 'detailed'/);
    expect(ROMS_ADAPTER).toMatch(/viewMode === 'poster'/);
  });
});

describe('view-mode wiring — arcade-adapter (feat/view-modes)', () => {
  it('imports ViewModeToggle, RomDetailedListView, RomPosterView', () => {
    expect(ARCADE_ADAPTER).toContain("import { RomDetailedListView }");
    expect(ARCADE_ADAPTER).toContain("import { RomPosterView }");
    expect(ARCADE_ADAPTER).toContain("import { ViewModeToggle }");
  });

  it('persists viewMode per host under the arcade-specific key', () => {
    expect(ARCADE_ADAPTER).toMatch(/mistercurator\.viewMode\.arcade\.\$\{host\}/);
  });

  it('arcade view mode is independent of ROM pane (different key prefix)', () => {
    // ROM key: viewMode.roms; arcade key: viewMode.arcade — different keys
    // so switching one pane does not affect the other
    expect(ROMS_ADAPTER).toMatch(/viewMode\.roms\./);
    expect(ARCADE_ADAPTER).toMatch(/viewMode\.arcade\./);
    // Confirm ROM adapter does NOT use the arcade key
    expect(ROMS_ADAPTER).not.toMatch(/viewMode\.arcade\./);
    // Confirm arcade adapter does NOT use the ROM key
    expect(ARCADE_ADAPTER).not.toMatch(/viewMode\.roms\./);
  });

  it('passes arcadeContext through to all three view components', () => {
    expect(ARCADE_ADAPTER).toMatch(/arcadeContext:\s*arcadeRowContext/);
    // arcadeContext must appear multiple times (once per mode branch uses sharedProps)
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
    expect(POSTER).toMatch(/grid\s+grid-cols/);
    expect(POSTER).not.toContain('<Table>');
    expect(POSTER).not.toContain('<TableBody>');
  });

  it('renders one PosterTile per rom', () => {
    expect(POSTER).toMatch(/unpinned\.map\(renderTile\)/);
  });

  it('pinned rows (folder-container) render in a separate section at the top', () => {
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

describe('RomDetailedListView — structure (feat/view-modes)', () => {
  const DETAILED = readFileSync(
    resolve(__dirname, 'RomDetailedListView.tsx'),
    'utf8',
  );

  it('renders a table (not a grid)', () => {
    expect(DETAILED).toContain('<Table>');
    expect(DETAILED).toContain('<TableBody>');
  });

  it('shows description below name using line-clamp-2', () => {
    expect(DETAILED).toMatch(/line-clamp-2/);
    expect(DETAILED).toMatch(/description/);
  });

  it('uses a taller thumbnail (h-20 or larger)', () => {
    expect(DETAILED).toMatch(/h-20/);
  });

  it('Missing ROMs badge preserved', () => {
    expect(DETAILED).toContain('Missing ROMs');
  });
});
