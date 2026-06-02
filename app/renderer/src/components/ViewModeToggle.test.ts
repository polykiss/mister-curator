import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(
  resolve(__dirname, 'ViewModeToggle.tsx'),
  'utf8',
);

describe('ViewModeToggle — structure (feat/view-modes)', () => {
  it('exports ViewModeToggle function', () => {
    expect(SOURCE).toMatch(/export function ViewModeToggle/);
  });

  it('renders two buttons — one per ViewMode (refactor/unify-list-views: dropped Detailed)', () => {
    // Two modes: list, poster
    expect(SOURCE).toMatch(/'list'/);
    expect(SOURCE).toMatch(/'poster'/);
    expect(SOURCE).not.toMatch(/'detailed'/);
    const buttonCount = (SOURCE.match(/mode:\s*'(list|poster)'/g) ?? []).length;
    expect(buttonCount).toBe(2);
  });

  it('uses lucide-react icons: List and LayoutGrid (LayoutList removed)', () => {
    expect(SOURCE).toContain("from 'lucide-react'");
    expect(SOURCE).toContain('LayoutGrid');
    expect(SOURCE).not.toContain('LayoutList');
    expect(SOURCE).toContain('List');
    expect(SOURCE).toMatch(/Icon: List/);
    expect(SOURCE).toMatch(/Icon: LayoutGrid/);
  });

  it('each button has aria-label and aria-pressed', () => {
    expect(SOURCE).toMatch(/aria-label=\{label\}/);
    expect(SOURCE).toMatch(/aria-pressed=\{value === mode\}/);
  });

  it('clicking a button calls onChange with the corresponding ViewMode', () => {
    expect(SOURCE).toMatch(/onClick=\{\(\) => onChange\(mode\)\}/);
  });

  it('wraps buttons in a role="group" container for screen-reader grouping', () => {
    expect(SOURCE).toMatch(/role="group"/);
    expect(SOURCE).toMatch(/aria-label="View mode"/);
  });
});
