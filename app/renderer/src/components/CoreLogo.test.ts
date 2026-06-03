import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for CoreLogo.
 *
 * Source-string scan (same pattern as CoreInfoDialog.test.ts): the
 * component uses hooks (useState, useEffect, useRef) plus
 * window.mister IPC, which makes jsdom rendering impractical.
 * These scans catch the regressions we care about — IPC wiring,
 * object URL lifecycle, loading/error states, and the invert class.
 */
const SOURCE = readFileSync(resolve(__dirname, 'CoreLogo.tsx'), 'utf8');

describe('CoreLogo — structural contract', () => {
  it('calls getSystemLogoBytes to fetch logo bytes', () => {
    expect(SOURCE).toContain('getSystemLogoBytes');
  });

  it('creates a Blob and object URL from the bytes', () => {
    expect(SOURCE).toContain('new Blob(');
    expect(SOURCE).toContain('URL.createObjectURL');
  });

  it('revokes the object URL on unmount', () => {
    expect(SOURCE).toContain('URL.revokeObjectURL');
    // Cleanup effect with empty deps
    expect(SOURCE).toMatch(/useEffect\s*\(\s*\(\)\s*=>/s);
  });

  it('uses a cancelled flag to prevent stale state updates', () => {
    expect(SOURCE).toContain('cancelled');
  });

  it('renders a Skeleton while the url is provided but bytes not yet loaded', () => {
    expect(SOURCE).toContain('<Skeleton');
    expect(SOURCE).toContain('h-8 w-8 shrink-0 rounded');
  });

  it('renders an img with invert class when loaded', () => {
    expect(SOURCE).toMatch(/<img\b/);
    expect(SOURCE).toContain('invert');
  });

  it('returns null (no gamepad fallback) when url is null (D7 rev. 2)', () => {
    // D7: logo if available, otherwise name carries identity — never a
    // generic gamepad icon. The no-logo branch must return null, not
    // render a <Gamepad2> placeholder.
    expect(SOURCE).not.toContain('Gamepad2');
    expect(SOURCE).toContain('url === null');
    expect(SOURCE).toContain('return null');
  });

  it('sets aria-hidden on the img (decorative)', () => {
    expect(SOURCE).toContain('aria-hidden');
  });

  it('documents the monochrome invert assumption with a comment', () => {
    expect(SOURCE).toMatch(/logo-monochrome|monochrome.*invert/i);
  });
});
