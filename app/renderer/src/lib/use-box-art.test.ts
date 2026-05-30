import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, 'use-box-art.ts'), 'utf8');

/**
 * fix/render-cascade-hide-unhide Fix 4 — useBoxArt must preserve the
 * existing objectURL when `url` briefly becomes null (metadata wipe +
 * repopulate), and must not issue a new fetch when the same URL returns.
 *
 * The hook runs in a browser context (IPC calls, URL.createObjectURL),
 * so the tests are structural: they assert that the implementation
 * contains the correct patterns rather than exercising the hook via
 * renderHook (which would require a DOM environment).
 */

describe('fix/render-cascade-hide-unhide — Fix 4: useBoxArt preserves objectURL across null cycles', () => {
  it('null-url branch does NOT call setObjectUrl(null)', () => {
    // If setObjectUrl(null) fires on url=null, the image flickers on
    // every metadata wipe cycle. The branch must return early without
    // touching state.
    const nullBranch = SOURCE.match(
      /if \(url === null[^)]*\)[^{]*\{([\s\S]*?)\n    \}/,
    );
    expect(nullBranch).not.toBeNull();
    expect(nullBranch![1]).not.toContain('setObjectUrl(null)');
  });

  it('tracks last fetched url+objectUrl in lastFetchRef', () => {
    expect(SOURCE).toContain('lastFetchRef');
    expect(SOURCE).toContain("lastFetchRef.current = { url, objectUrl: created }");
  });

  it('re-surfaces cached objectURL when same URL returns without a new fetch', () => {
    // The same-URL short-circuit: if last.url === url, call
    // setObjectUrl(last.objectUrl) and return — no getBoxArtBytes call.
    expect(SOURCE).toContain('last.url === url');
    expect(SOURCE).toContain('setObjectUrl(last.objectUrl)');
  });

  it('does not re-fetch the same URL after a null cycle (no getBoxArtBytes in same-URL branch)', () => {
    // Extract the same-URL branch and verify it returns without calling getBoxArtBytes.
    const sameUrlBranch = SOURCE.match(
      /last\.url === url[\s\S]*?return;\s*\}/,
    );
    expect(sameUrlBranch).not.toBeNull();
    expect(sameUrlBranch![0]).not.toContain('getBoxArtBytes');
  });

  it('revokes previous objectURL only when a different URL arrives', () => {
    // revokeObjectURL is called in the "different URL" path and the
    // unmount cleanup — NOT in the [url] effect's cleanup (which runs
    // on every dependency change including null transitions).
    expect(SOURCE).toContain('URL.revokeObjectURL(last.objectUrl)');
    // Between `cancelled = true` (the cleanup marker) and `}, [url])`
    // (the end of the [url] effect), there must be no revokeObjectURL
    // call. If one were added there, it would clear the objectURL on
    // every null-url dependency change.
    expect(SOURCE).not.toMatch(
      /cancelled = true;[\s\S]*?URL\.revokeObjectURL[\s\S]*?\}, \[url\]\)/,
    );
  });

  it('revokes on component unmount via a separate useEffect([], [])', () => {
    // The unmount cleanup uses a deps=[] effect so it runs once.
    expect(SOURCE).toMatch(/useEffect\(\(\) => \{[\s\S]*?revokeObjectURL[\s\S]*?\}, \[\]\)/);
  });

  it('useRef is imported (needed for lastFetchRef)', () => {
    expect(SOURCE).toMatch(/import.*useRef.*from 'react'/);
  });
});
