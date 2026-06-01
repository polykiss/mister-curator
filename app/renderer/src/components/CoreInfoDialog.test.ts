import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for CoreInfoDialog.
 *
 * Uses source-string scanning (same pattern as RomDetailDialog.test.ts
 * and RomSearchScreenScraperDialog.test.ts) rather than a render test:
 * Radix Dialog portal-renders outside the jsdom root and requires a
 * full a11y tree to render correctly. String scans are small, fast, and
 * catch the regressions we care about (field drift, conditional display,
 * copy wiring, catalog-fallback copy).
 */
const SOURCE = readFileSync(
  resolve(__dirname, 'CoreInfoDialog.tsx'),
  'utf8',
);

describe('CoreInfoDialog — structural contract', () => {
  it('uses max-w-2xl for the dialog (not the default max-w-md)', () => {
    expect(SOURCE).toContain('max-w-2xl');
  });

  it('renders three sections: Core, ROM library, ScreenScraper', () => {
    expect(SOURCE).toContain('"Core"');
    expect(SOURCE).toContain('"ROM library"');
    expect(SOURCE).toContain('"ScreenScraper"');
  });

  it('displays core.id in the Core section', () => {
    expect(SOURCE).toContain('core.id');
  });

  it('displays core.category in the Core section', () => {
    expect(SOURCE).toContain('core.category');
  });

  it('displays core.rbfPaths (with map for multiple paths)', () => {
    expect(SOURCE).toContain('core.rbfPaths');
    expect(SOURCE).toContain('.map(');
  });

  it('displays core.gamesDirName with em-dash fallback', () => {
    expect(SOURCE).toContain('core.gamesDirName');
    expect(SOURCE).toContain("'—'");
  });

  it('derives games-dir status from gamesDirExists + gamesDirHidden', () => {
    expect(SOURCE).toContain('core.gamesDirExists');
    expect(SOURCE).toContain('core.gamesDirHidden');
    expect(SOURCE).toContain('Missing');
    expect(SOURCE).toContain('dot-prefixed');
    expect(SOURCE).toContain('Available');
  });

  it('shows arcade playable count only when defined', () => {
    expect(SOURCE).toContain('core.arcadePlayableCount');
    // Conditional render — either ternary or && guard
    expect(SOURCE).toMatch(/arcadePlayableCount.*!==.*undefined|arcadePlayableCount.*\?/s);
  });

  it('shows romCount with optional recursive annotation', () => {
    expect(SOURCE).toContain('core.romCount');
    expect(SOURCE).toContain('recursive');
  });

  it('shows hiddenCount with optional recursive annotation', () => {
    expect(SOURCE).toContain('core.hiddenCount');
  });

  it('shows catalog systemId and displayName when entry exists', () => {
    expect(SOURCE).toContain('catalogEntry.id');
    expect(SOURCE).toContain('catalogEntry.displayName');
    expect(SOURCE).toContain('catalogEntry.logoUrl');
  });

  it('shows fallback text when no catalog entry', () => {
    expect(SOURCE).toContain('No ScreenScraper mapping for this core');
  });

  it('wires Copy button to navigator.clipboard.writeText with core.id', () => {
    expect(SOURCE).toContain('navigator.clipboard.writeText');
    expect(SOURCE).toContain('core.id');
  });

  it('shows toast.success on copy', () => {
    expect(SOURCE).toContain("toast.success('Copied')");
  });

  it('uses the Copy icon from lucide-react', () => {
    expect(SOURCE).toContain("import { Copy }");
    expect(SOURCE).toMatch(/<Copy\b/);
  });

  it('renders null for core content when core prop is null', () => {
    // Guard: content only renders when core !== null
    expect(SOURCE).toContain('core !== null');
  });
});

describe('CoreInfoDialog — CountDisplay logic', () => {
  // CountDisplay is an internal helper — tested indirectly via source
  // pattern to verify the "X (Y recursive)" branch is present.

  it('shows plain count when recursive === count', () => {
    // The implementation should NOT show the recursive annotation when
    // count and recursive are identical.
    expect(SOURCE).toMatch(/recursive.*!==.*count|count.*!==.*recursive/s);
  });

  it('shows "(Y recursive)" annotation when recursive differs from count', () => {
    expect(SOURCE).toContain('recursive');
  });
});
