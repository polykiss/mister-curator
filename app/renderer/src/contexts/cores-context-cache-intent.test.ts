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
    // the expected contexts. A future refactor that adds a new
    // bypass path slips through silently otherwise.
    //
    // Audited callsites (fix/renderer-cache-state-races):
    //   1. `refresh` wrapper — Refresh-button entry point.
    //   2. `refetchRoms` — post-mutation listRoms refetch (mark/unmark
    //      flips that need to land before the renderer re-renders;
    //      the manager invalidates the roms cache on these mutations
    //      so the witness-stat would hit a miss anyway, but
    //      forceRefresh skips the redundant stat).
    //   3. `setRomVisibility` post-success reconciliation — re-fetch
    //      to confirm device truth matches the optimistic state.
    //   4. `setBulkRomVisibility` partial-failure recovery — forceRefresh
    //      bypasses a stale witness that would return pre-op data and
    //      overwrite the correct optimistic state (Bug B).
    const codeOnly = stripLineComments(CORES_CONTEXT);
    const matches = [...codeOnly.matchAll(/forceRefresh\s*:\s*true/g)];
    expect(matches).toHaveLength(4);

    // Ensure each `true` literal sits inside one of the four audited
    // callsites. Catches a paste-into-the-wrong-function regression.
    const refreshBlock = extractTopLevelBinding(CORES_CONTEXT, 'refresh');
    const refetchRomsBlock = extractTopLevelBinding(CORES_CONTEXT, 'refetchRoms');
    const setRomVisibilityBlock = extractTopLevelBinding(CORES_CONTEXT, 'setRomVisibility');
    const setBulkBlock = extractTopLevelBinding(CORES_CONTEXT, 'setBulkRomVisibility');
    expect(refreshBlock).toMatch(/forceRefresh:\s*true/);
    expect(refetchRomsBlock).toMatch(/forceRefresh:\s*true/);
    expect(setRomVisibilityBlock).toMatch(/forceRefresh:\s*true/);
    expect(setBulkBlock).toMatch(/forceRefresh:\s*true/);
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

describe('CoresContext — Bug B/C/D/E renderer-cache-state-races fixes', () => {
  const ROMS_ADAPTER = readFileSync(
    resolve(__dirname, '../components/roms-adapter.tsx'),
    'utf8',
  );
  const ARCADE_ADAPTER = readFileSync(
    resolve(__dirname, '../components/arcade-adapter.tsx'),
    'utf8',
  );

  it('exposes romCacheVersion in the context interface and value (Bug C)', () => {
    // romCacheVersion is the signal that makes the ensureRoms effect
    // re-fire after a full Refresh without requiring core.id or subPath
    // to change.
    expect(CORES_CONTEXT).toMatch(/readonly romCacheVersion:\s*number/);
    expect(CORES_CONTEXT).toMatch(/romCacheVersion,/);
  });

  it('loadCores increments romCacheVersion alongside the cache wipe (Bug C)', () => {
    // The increment must be co-located with the setRomsByCore({}) call so
    // the effect fires in the same render cycle as the cache clear.
    const block = extractTopLevelBinding(CORES_CONTEXT, 'loadCores');
    expect(block).toMatch(/setRomCacheVersion\(\(v\) => v \+ 1\)/);
  });

  it('ensureRoms effect deps include romCacheVersion (Bug C — re-fire on Refresh)', () => {
    // Without this dep the effect never re-fires when romsByCore is
    // cleared while core.id and subPath stay constant (the common case
    // when the user hits Refresh while viewing a subfolder).
    expect(ROMS_ADAPTER).toMatch(
      /void ensureRoms\(core\.id, subPath\)[\s\S]{0,20}\}, \[core\.id, subPath, ensureRoms, romCacheVersion\]\)/,
    );
  });

  it('roms-adapter destructures romCacheVersion from useCores (Bug C)', () => {
    expect(ROMS_ADAPTER).toMatch(/romCacheVersion,?\s*\n?\s*\} = useCores\(\)/);
  });

  it('setBulkRomVisibility recovery uses forceRefresh: true (Bug B)', () => {
    // Without forceRefresh the witness check may pass and return the
    // pre-op snapshot, overwriting the optimistic state with stale data
    // and causing a flash-then-disappear on partial bulk failure.
    const block = extractTopLevelBinding(CORES_CONTEXT, 'setBulkRomVisibility');
    // The recovery path follows `result.failed.length > 0`.
    const recoveryStart = block.indexOf('result.failed.length > 0');
    expect(recoveryStart).toBeGreaterThan(-1);
    const recovery = block.slice(recoveryStart);
    expect(recovery).toMatch(/forceRefresh:\s*true/);
  });

  it('setRomVisibility post-success reconciliation uses forceRefresh: true (Bug B)', () => {
    const block = extractTopLevelBinding(CORES_CONTEXT, 'setRomVisibility');
    // Must have at least one forceRefresh: true (the reconciliation re-fetch).
    expect(block).toMatch(/forceRefresh:\s*true/);
  });

  it('setRomsCache wrapper exists and calls console.debug before setRomsByCore (diagnostic log)', () => {
    // Every mutation to the ROM cache goes through this wrapper so
    // state-race debugging has a clear audit trail.
    expect(CORES_CONTEXT).toMatch(/const setRomsCache = useCallback/);
    const wrapperBlock = extractTopLevelBinding(CORES_CONTEXT, 'setRomsCache');
    expect(wrapperBlock).toMatch(/console\.debug/);
    expect(wrapperBlock).toMatch(/setRomsByCore/);
  });

  it('arcade adapter re-fires its load on romCacheVersion change with forceRefresh (Bug C parity)', () => {
    // When the user hits Refresh while on the Arcade pane, romCacheVersion
    // bumps → effect re-fires → arcade content reloads too.
    expect(ARCADE_ADAPTER).toMatch(/romCacheVersion.*\} = useCores\(\)/s);
    // isInitialArcadeMountRef guards forceRefresh: true on version bumps
    // vs forceRefresh: false on initial mount.
    expect(ARCADE_ADAPTER).toMatch(/isInitialArcadeMountRef/);
    // The load effect depends on romCacheVersion.
    expect(ARCADE_ADAPTER).toMatch(/\[refresh, romCacheVersion\]/);
  });

  it('roms-adapter scroll preservation: scrollContainerRef + captureScrollAnchor + useLayoutEffect (Bug E)', () => {
    // Structural contract: the three moving parts must all exist.
    expect(ROMS_ADAPTER).toMatch(/scrollContainerRef/);
    expect(ROMS_ADAPTER).toMatch(/captureScrollAnchor/);
    // useLayoutEffect runs AFTER presentableRoms is computed (declared via
    // useMemo), so restore fires before the browser paints the re-ordered
    // list.
    expect(ROMS_ADAPTER).toMatch(/useLayoutEffect[\s\S]{0,600}presentableRoms\]/);
    // The anchor is captured before the SSH call in onSingleToggle.
    const toggleIdx = ROMS_ADAPTER.indexOf('const onSingleToggle');
    const toggleBlock = ROMS_ADAPTER.slice(toggleIdx, toggleIdx + 400);
    expect(toggleBlock).toMatch(/captureScrollAnchor/);
  });

  it('arcade adapter scroll preservation: analogous pattern to roms-adapter (Bug E parity)', () => {
    expect(ARCADE_ADAPTER).toMatch(/arcadeScrollContainerRef/);
    expect(ARCADE_ADAPTER).toMatch(/captureArcadeScrollAnchor/);
    expect(ARCADE_ADAPTER).toMatch(/useLayoutEffect[\s\S]{0,600}sortedRows\]/);
    const toggleIdx = ARCADE_ADAPTER.indexOf('const onToggleSingle');
    const toggleBlock = ARCADE_ADAPTER.slice(toggleIdx, toggleIdx + 400);
    expect(toggleBlock).toMatch(/captureArcadeScrollAnchor/);
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
