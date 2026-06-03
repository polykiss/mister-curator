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
  it('renders kicker above the logo and title', () => {
    // The kicker div must appear before the logo block in the JSX.
    const kickerIdx = SOURCE.indexOf('mb-3 text-caption font-bold uppercase tracking-[0.19em]');
    const logoIdx = SOURCE.indexOf('mb-3.5 flex h-12 items-center');
    expect(kickerIdx).toBeGreaterThan(-1);
    expect(logoIdx).toBeGreaterThan(kickerIdx);
  });

  it('renders title as <h2> with break-words so long game titles wrap inside the dialog', () => {
    expect(SOURCE).toMatch(/<h2\b/);
    expect(SOURCE).toContain('break-words');
  });

  it('renders chips inline beside the title (not below)', () => {
    // chips renders inside the same flex-wrap div as the h2.
    // Use lastIndexOf to find the JSX occurrence (not the JSDoc mention).
    const h2Idx = SOURCE.lastIndexOf('<h2');
    const chipsIdx = SOURCE.lastIndexOf('{chips}');
    expect(h2Idx).toBeGreaterThan(-1);
    expect(chipsIdx).toBeGreaterThan(h2Idx);
    // The subtitle paragraph follows the flex div.
    const subtitleIdx = SOURCE.indexOf('text-body-sm text-fg-muted');
    expect(subtitleIdx).toBeGreaterThan(chipsIdx);
  });

  it('renders subtitle below the title when present', () => {
    expect(SOURCE).toContain('text-body-sm text-fg-muted');
    expect(SOURCE).toContain('{subtitle}');
  });

  it('default titleClassName is text-heading; RomDetail can override to text-heading-lg', () => {
    expect(SOURCE).toContain("titleClassName = 'text-heading'");
  });
});
