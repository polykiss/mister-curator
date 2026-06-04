import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for DetailHeader (D14).
 *
 * Source-string scan — same pattern as CoreInfoDialog/RomDetailDialog.
 * The component uses hooks + IPC so jsdom rendering is impractical.
 * Pins the logo/no-logo branches, the objectURL lifecycle, and the
 * slot layout that keeps both detail dialogs visually in sync.
 */
const SOURCE = readFileSync(resolve(__dirname, 'DetailHeader.tsx'), 'utf8');

describe('DetailHeader — logo branch (logoUrl non-null)', () => {
  it('calls getSystemLogoBytes to fetch logo bytes', () => {
    expect(SOURCE).toContain('getSystemLogoBytes');
  });

  it('creates a Blob and object URL from the bytes', () => {
    expect(SOURCE).toContain('new Blob(');
    expect(SOURCE).toContain('URL.createObjectURL');
  });

  it('revokes the object URL on unmount', () => {
    expect(SOURCE).toContain('URL.revokeObjectURL');
    expect(SOURCE).toMatch(/useEffect\s*\(\s*\(\)\s*=>/s);
  });

  it('uses a cancelled flag to prevent stale state updates', () => {
    expect(SOURCE).toContain('cancelled');
  });

  it('renders <img> with invert and object-contain for monochrome logos', () => {
    expect(SOURCE).toMatch(/<img\b/);
    expect(SOURCE).toContain('invert');
    expect(SOURCE).toContain('object-contain');
  });

  it('renders a Skeleton while logo bytes are in-flight', () => {
    expect(SOURCE).toContain('<Skeleton');
  });
});

describe('DetailHeader — no-logo branch (logoUrl null)', () => {
  it('omits the logo block entirely when logoUrl is null', () => {
    // No placeholder icon — the title sits directly under the kicker.
    expect(SOURCE).toContain('logoUrl !== null');
  });
});

describe('DetailHeader — layout slots', () => {
  it('renders kicker above the logo and title in the roomy layout', () => {
    // The kicker div must appear before the roomy logo block in the JSX.
    // D26: roomy layout uses h-[72px] (+50% from original 48px).
    const kickerIdx = SOURCE.indexOf('mb-3 text-caption font-bold uppercase tracking-[0.19em]');
    const logoIdx = SOURCE.indexOf('mb-3.5 flex h-[72px] items-center');
    expect(kickerIdx).toBeGreaterThan(-1);
    expect(logoIdx).toBeGreaterThan(kickerIdx);
  });

  it('renders title as <h2> with break-words so long game titles wrap inside the dialog', () => {
    expect(SOURCE).toMatch(/<h2\b/);
    expect(SOURCE).toContain('break-words');
  });

  it('renders chips inline beside the title (not below) in both layouts', () => {
    // chips renders inside the same flex div as the h2 in both compact
    // and roomy layouts. Use lastIndexOf to find the final JSX occurrence.
    const h2Idx = SOURCE.lastIndexOf('<h2');
    const chipsIdx = SOURCE.lastIndexOf('{chips}');
    expect(h2Idx).toBeGreaterThan(-1);
    expect(chipsIdx).toBeGreaterThan(h2Idx);
  });

  it('renders subtitle below the title when present', () => {
    expect(SOURCE).toContain('text-body-sm text-fg-muted');
    expect(SOURCE).toContain('{subtitle}');
  });

  it('default titleClassName is text-heading (D26: both layouts use heading, not heading-lg)', () => {
    expect(SOURCE).toContain("titleClassName = 'text-heading'");
  });

  it('compact prop selects the stacked logo+text layout (D32)', () => {
    // compact=true triggers the RomDetail layout: logo left, stacked text right.
    expect(SOURCE).toContain('compact = false');
    expect(SOURCE).toContain('if (compact)');
    // Compact logo is smaller (max-h-8) vs roomy (max-h-[72px]).
    expect(SOURCE).toContain('max-h-8');
    expect(SOURCE).toContain('max-h-[72px]');
    // Compact stacks title / systemName / subtitle vertically.
    expect(SOURCE).toContain('systemName');
    expect(SOURCE).toContain('flex-col');
  });
});
