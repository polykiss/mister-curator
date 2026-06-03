import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for PlatformBadge (D11).
 *
 * Source-string scan — same pattern as CoreLogo.test.ts. The component
 * uses hooks + IPC so jsdom rendering is impractical here. These scans
 * pin the logo-vs-wordmark branches and the object-URL lifecycle.
 */
const SOURCE = readFileSync(resolve(__dirname, 'PlatformBadge.tsx'), 'utf8');

describe('PlatformBadge — structural contract (D11)', () => {
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

  it('renders a Skeleton while url is provided but bytes not yet loaded', () => {
    expect(SOURCE).toContain('<Skeleton');
  });

  it('logo branch: renders img with invert and aria-hidden', () => {
    expect(SOURCE).toMatch(/<img\b/);
    expect(SOURCE).toContain('invert');
    expect(SOURCE).toContain('aria-hidden');
  });

  it('logo branch: normalizes logo to 26px cap-height', () => {
    expect(SOURCE).toContain('h-[26px]');
  });

  it('no-logo branch: renders name as a wordmark (not a gamepad icon)', () => {
    // D11 / D7: when url === null, show the name wordmark in the badge
    // box — never a generic placeholder icon.
    expect(SOURCE).toContain('url === null');
    expect(SOURCE).not.toContain('Gamepad2');
    // The name wordmark renders the name prop as text (not null)
    expect(SOURCE).toContain('{name}');
  });

  it('fixed 104×40 box for both logo and no-logo branches', () => {
    expect(SOURCE).toContain('w-[104px]');
    expect(SOURCE).toContain('h-10');
  });

  it('uses object-contain object-left so logos align left in the box', () => {
    expect(SOURCE).toContain('object-contain');
    expect(SOURCE).toContain('object-left');
  });
});
