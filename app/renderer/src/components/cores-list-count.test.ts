import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-string regression for PR #14 — the cores-list count is one
 * number, not the old "X folders · ~Y ROMs" breakdown.
 *
 * Vitest in this project runs in `node` (no jsdom), so this test
 * inspects the JSX source as a proxy for behavior — same pattern as
 * `right-edge-stack.test.ts`. The properties checked here are the
 * same ones that would render correctly OR incorrectly in a browser.
 *
 * Why source assertions aren't a substitute for a DOM test: a
 * regex-passing source could still ship a layout bug that splits
 * the number across two cells, etc. But the regression we're
 * guarding against is "the breakdown comes back" which is a code-
 * shape concern, and that the source check catches.
 */

const CORES_PANE_FULL = readFileSync(
  resolve(__dirname, 'CoresPane.tsx'),
  'utf8',
);
const CORES_PANE = stripLineAndBlockComments(CORES_PANE_FULL);

// Strip line + block comments so doc-comment references to the old
// "folders ·" labels (kept for historical context) don't break the
// assertions. Same idiom as `cores-context-cache-intent.test.ts`.
function stripLineAndBlockComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.replace(/\/\/[^\n]*/g, '');
}

describe('CoresPane — single-number count summary (PR #14)', () => {
  it('renders one count per core, not a folders/ROMs breakdown', () => {
    // The breakdown wrote two literal labels into the JSX —
    // "folders ·" and "ROMs". Their absence (in non-comment code) is
    // the load-bearing assertion of the simpler display.
    expect(CORES_PANE).not.toContain("folders ·");
    // 'ROMs' as a literal span label is gone too. The density-bar
    // aria label still uses "ROMs" in a sentence (passed via prop),
    // so pin this to the JSX-text shape only.
    expect(CORES_PANE).not.toMatch(/>\s*ROMs\s*</);
  });

  it('CoreCountSummary collapses to recursiveRomCount ?? romCount', () => {
    // The single-number formula. No `hasBreakdown` branch, no
    // mixed-cell layout. Just the count plus the optional hidden
    // suffix.
    expect(CORES_PANE).toMatch(
      /const\s+count\s*=\s*core\.recursiveRomCount\s*\?\?\s*core\.romCount/,
    );
    // The pre-PR-14 breakdown gate is gone — `hasBreakdown` was the
    // structural shape we stripped.
    expect(CORES_PANE).not.toMatch(/hasBreakdown/);
  });

  it('does not prefix the count with a "~" approximation marker', () => {
    // The breakdown rendered `~{recursive}`. PR #14 dropped the "~"
    // because for the common case (atomic-only cores) the count is
    // exact; the "~" implied more uncertainty than is warranted.
    expect(CORES_PANE).not.toMatch(/<span[^>]*>~\{recursive\}<\/span>/);
  });

  it('hidden-count parenthetical still appears for cores with hidden entries', () => {
    // The "(N hidden)" suffix is the only secondary chip in the
    // count summary. Surface it as a pinned regression — its loss
    // would be a UX regression the user might not notice immediately.
    expect(CORES_PANE).toMatch(
      /core\.hiddenCount\s*>\s*0\s*\?\s*\([\s\S]*?hidden/,
    );
  });
});
