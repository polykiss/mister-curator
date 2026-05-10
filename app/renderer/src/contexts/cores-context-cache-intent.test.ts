import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-string regression for the cache-intent split in
 * CoresContext.tsx (PR #12 round 2). The renderer has two distinct
 * cores-load paths — post-connect first load and the user clicking
 * Refresh — and they MUST differ on `forceRefresh`:
 *
 *   - post-connect → `forceRefresh: false` so the PR #12 disk cache
 *     can hit on warm reconnect (<1s).
 *   - Refresh button → `forceRefresh: true` so the user always has
 *     an escape hatch from a stuck cache.
 *
 * Round 1 of PR #12 hardcoded `forceRefresh: true` on the only load
 * path. Live test against a real MiSTer showed cache.invalidate +
 * cache.write on every reconnect instead of the expected cache.hit.
 *
 * The vitest environment is `node` (no jsdom in this project), so
 * this test inspects the JSX source as a proxy for behavior. The
 * properties checked here are the same ones that would render
 * correctly OR incorrectly in a browser:
 *
 *   - a `loadCores` helper exists, accepts `{ forceRefresh: boolean }`
 *   - the post-connect `useEffect` calls `loadCores({ forceRefresh: false })`
 *   - the public `refresh` callable calls `loadCores({ forceRefresh: true })`
 *   - no `forceRefresh: true` literal appears outside the two
 *     audited post-mutation paths (`refresh` itself + `refetchRoms`)
 */

const CORES_CONTEXT = readFileSync(
  resolve(__dirname, 'CoresContext.tsx'),
  'utf8',
);

describe('CoresContext — cache-intent split (PR #12 round 2)', () => {
  it('exposes a `loadCores` helper that takes `{ forceRefresh: boolean }`', () => {
    // The signature anchors the test on the helper itself rather
    // than its internal implementation — readable failure on rename.
    expect(CORES_CONTEXT).toMatch(
      /loadCores\s*=\s*useCallback\s*\(\s*async\s*\(\s*\{\s*forceRefresh\s*\}\s*:\s*\{\s*readonly\s+forceRefresh\s*:\s*boolean/,
    );
  });

  it('the post-connect useEffect calls loadCores({ forceRefresh: false })', () => {
    // The effect body must use the cache-friendly call. Without this,
    // every connected-status transition (cold connect, reconnect,
    // auto-retry recovery) bypasses the disk cache.
    const effect = extractBlock(
      CORES_CONTEXT,
      /useEffect\s*\(\s*\(\)\s*=>\s*\{[\s\S]*?shouldFetchCoresOnEffect[\s\S]*?\}\s*,\s*\[[^\]]*loadCores[^\]]*\]\s*\)/,
    );
    expect(effect).toMatch(/loadCores\(\s*\{\s*forceRefresh:\s*false\s*\}\s*\)/);
    expect(effect).not.toMatch(/forceRefresh:\s*true/);
  });

  it('the public `refresh` calls loadCores({ forceRefresh: true })', () => {
    // The Refresh button's contract is "always bypass". The wrapper
    // must hardcode true so a future caller wiring up a new "Refresh"
    // surface gets the right semantic by reaching for `refresh`.
    const refresh = extractTopLevelBinding(CORES_CONTEXT, 'refresh');
    expect(refresh).toMatch(/loadCores\(\s*\{\s*forceRefresh:\s*true\s*\}\s*\)/);
  });

  it('only the audited callsites carry a `forceRefresh: true` literal', () => {
    // Belt-and-suspenders: enumerate every `forceRefresh: true`
    // literal in NON-COMMENT code and assert it appears in exactly
    // the expected contexts. A future refactor that adds a fourth
    // bypass path slips through silently otherwise.
    //
    // Audited callsites:
    //   1. `refresh` wrapper — Refresh-button entry point. PR #12
    //      round 2.
    //   2. `refetchRoms` — post-mutation listRoms refetch
    //      (mark/unmark flips that need to land before the
    //      renderer re-renders; the manager invalidates the roms
    //      cache on these mutations so the witness-stat would hit
    //      a miss anyway, but forceRefresh skips the redundant
    //      stat). PR #12 round 2.
    //   3. `setFolderClassification` — fix/auto-scrape-correctness-suite
    //      commit 4b. The matcher's `recursiveRomCount` (the
    //      sidebar's per-core integer) depends on per-folder
    //      classification overrides; an override changes which
    //      branch fires for that folder so the count needs to
    //      recompute. Re-runs loadCores with forceRefresh so the
    //      matcher sees the updated overrides file.
    const codeOnly = stripLineComments(CORES_CONTEXT);
    const matches = [...codeOnly.matchAll(/forceRefresh\s*:\s*true/g)];
    expect(matches).toHaveLength(3);

    // Ensure each `true` literal sits inside one of the audited
    // callsites. Catches a paste-into-the-wrong-function regression.
    const refreshBlock = extractTopLevelBinding(CORES_CONTEXT, 'refresh');
    const refetchRomsBlock = extractTopLevelBinding(
      CORES_CONTEXT,
      'refetchRoms',
    );
    const setFolderClassificationBlock = extractTopLevelBinding(
      CORES_CONTEXT,
      'setFolderClassification',
    );
    expect(refreshBlock).toMatch(/forceRefresh:\s*true/);
    expect(refetchRomsBlock).toMatch(/forceRefresh:\s*true/);
    expect(setFolderClassificationBlock).toMatch(/forceRefresh:\s*true/);
  });

  it('post-connect lazy ROM load (`ensureRoms`) does NOT bypass the cache', () => {
    // ensureRoms is the lazy fetch on first drill — it must allow
    // the listRoms cache to hit. A regression here would force a
    // device walk on every drill into a NEOGEO sub-folder.
    const ensureRoms = extractTopLevelBinding(CORES_CONTEXT, 'ensureRoms');
    expect(ensureRoms).toMatch(/window\.mister\.listRoms\(/);
    expect(ensureRoms).not.toMatch(/forceRefresh/);
  });

  it('refetchSelectedRoms (used after bulk ops) does NOT pass forceRefresh', () => {
    // The manager invalidates the affected core's roms cache on
    // bulk-rename success, so the next listRoms is a cache miss
    // anyway. forceRefresh would skip the witness stat — a small
    // win — but symmetry with ensureRoms keeps the caching logic
    // predictable across surfaces, and the manager-side correctness
    // doesn't depend on this flag.
    const block = extractTopLevelBinding(CORES_CONTEXT, 'refetchSelectedRoms');
    expect(block).toMatch(/window\.mister\.listRoms\(/);
    expect(block).not.toMatch(/forceRefresh/);
  });
});

/** Extract the first JSX/JS block matching the given pattern, or
 * throw a readable error so failures in the regex don't masquerade
 * as failed assertions about the source. */
function extractBlock(source: string, pattern: RegExp): string {
  const match = pattern.exec(source);
  if (match === null) {
    throw new Error(
      `Source-pattern not found in CoresContext.tsx: ${String(pattern)}`,
    );
  }
  return match[0];
}

// Strip JS comments so audits over the source code don't
// accidentally count strings that appear in `//` line comments or
// in JSDoc blocks — comments can mention `forceRefresh: true`
// without being a callsite. Crude but adequate for this codebase:
// strips paired block comments first, then line comments. Doesn't
// try to be string-literal-aware; the source convention here uses
// single quotes for strings, so a `//` inside a string is rare.
function stripLineComments(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');
  return noBlocks.replace(/\/\/[^\n]*/g, '');
}

/**
 * Slice from the named const declaration up to the next top-level
 * const / function. Avoids tangling with regex-balanced parens; the
 * source convention is one top-level binding per declaration so
 * "next top-level const" reliably terminates the current one.
 */
function extractTopLevelBinding(source: string, name: string): string {
  const startRe = new RegExp(`\\bconst\\s+${name}\\s*=\\s*`);
  const startMatch = startRe.exec(source);
  if (startMatch === null) {
    throw new Error(`Top-level binding '${name}' not found in CoresContext.tsx`);
  }
  const start = startMatch.index;
  const tail = source.slice(start + startMatch[0].length);
  // Next top-level binding header: `\n  const ` or `\n  function ` —
  // both indented two spaces because the source bindings live inside
  // the CoresProvider function body.
  const nextRe = /\n {2}(?:const|function|useEffect|return)\s/;
  const nextMatch = nextRe.exec(tail);
  const end = nextMatch === null ? source.length : start + startMatch[0].length + nextMatch.index;
  return source.slice(start, end);
}
