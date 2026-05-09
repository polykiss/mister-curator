import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The renderer's Content-Security-Policy is set in
 * `app/renderer/index.html` via a `<meta http-equiv>` tag, loaded
 * verbatim by both Vite (dev server) and Electron's BrowserWindow
 * (prod build). PR #20 round 8 added `blob:` to `img-src` so the
 * box-art `useBoxArt` flow (bytes via IPC → Blob → objectURL → `<img
 * src>`) doesn't get blocked by the CSP.
 *
 * jsdom doesn't enforce CSP, so we can't test the rejection
 * directly. Assert the source-of-truth string instead — if anyone
 * tightens the policy in a way that re-breaks box art, this test
 * fires before the regression hits the renderer.
 */

type Directives = Readonly<Record<string, readonly string[]>>;

function parseCsp(content: string): Directives {
  const out: Record<string, string[]> = {};
  for (const part of content.split(';')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const [name, ...values] = trimmed.split(/\s+/);
    if (name === undefined) continue;
    out[name] = values;
  }
  return out;
}

const HTML_PATH = join(import.meta.dirname, 'index.html');

async function readCspContent(): Promise<string> {
  const html = await fs.readFile(HTML_PATH, 'utf-8');
  const match = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i.exec(
    html,
  );
  if (match === null || match[1] === undefined) {
    throw new Error('No CSP meta tag found in renderer index.html');
  }
  return match[1];
}

describe('renderer Content-Security-Policy', () => {
  it('img-src allows blob: so useBoxArt objectURLs render (PR #20 round 8)', async () => {
    const csp = parseCsp(await readCspContent());
    expect(csp['img-src']).toBeDefined();
    expect(csp['img-src']).toContain('blob:');
  });

  it('img-src still allows the existing self + data: sources', async () => {
    const csp = parseCsp(await readCspContent());
    expect(csp['img-src']).toContain("'self'");
    expect(csp['img-src']).toContain('data:');
  });

  it('the round-8 widening is scoped to img-src and does NOT broaden other directives', async () => {
    // Regression guard: blob: should appear ONLY in img-src. If a
    // future change pastes `blob:` into default-src or connect-src
    // by accident, surface that here before it ships.
    const csp = parseCsp(await readCspContent());
    for (const [directive, values] of Object.entries(csp)) {
      if (directive === 'img-src') continue;
      expect(values, `${directive} should not allow blob:`).not.toContain(
        'blob:',
      );
    }
  });

  it('default-src stays locked down to self', async () => {
    const csp = parseCsp(await readCspContent());
    expect(csp['default-src']).toEqual(["'self'"]);
  });
});
