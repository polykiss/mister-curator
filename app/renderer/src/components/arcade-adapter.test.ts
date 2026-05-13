import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * feat/pre-beta-polish-batch — structural contract for the arcade
 * adapter's optimistic hide/show flow.
 *
 * Source-string scan (same pattern as RomDetailDialog /
 * RomSearchScreenScraperDialog tests) rather than a render test:
 * arcade-adapter is a deeply-context-bound hook (ConnectionContext +
 * CoresContext, both of which expect a connected MiSTer client) and
 * a render test would require a heavy harness. The rules below pin
 * the small, stable contract: optimistic flip happens before the
 * SSH round-trip; revert + toast happen on rejection; the sidebar
 * Arcade badge moves in lockstep.
 */

const SOURCE = readFileSync(
  resolve(__dirname, 'arcade-adapter.tsx'),
  'utf8',
);

describe('arcade-adapter — optimistic single-toggle (feat/pre-beta-polish-batch)', () => {
  it('imports the ledger path helpers so the predicted relativePath matches what a fresh listing would return', () => {
    // The post-rename relativePath is the visible/hidden form per
    // the .Foo.mra ↔ Foo.mra convention. We borrow the existing
    // helpers from `@shared/ledger` rather than reinventing them
    // here — they handle subfolder paths (`_Konami/.Foo.mra`) the
    // renderer's naive `relativePath.startsWith('.')` check would
    // mis-handle.
    expect(SOURCE).toMatch(
      /import \{\s*arcadeMraHiddenPath,\s*arcadeMraVisiblePath,\s*\} from '@shared\/ledger'/,
    );
  });

  it('subscribes to CoresContext for the sidebar-badge adjust helper', () => {
    // Sidebar synthesis of the Arcade row's hiddenCount lives in
    // CoresContext (see synthesizeArcadeCoreEntry). The optimistic
    // path nudges the count via this helper so the badge moves on
    // the same click that flips the row's eye icon — pre-fix the
    // badge waited for the next refresh.
    expect(SOURCE).toMatch(
      /import \{ useCores \} from '@app\/renderer\/src\/contexts\/CoresContext'/,
    );
    expect(SOURCE).toMatch(
      /const \{ adjustArcadeHiddenCount \} = useCores\(\);/,
    );
  });

  it('onToggleSingle is synchronous (no await on the SSH call) — UI flips before the wire round-trip', () => {
    // Pre-fix the handler was `async ... await setArcadeMraVisibility`,
    // making the spinner mandatory and the eye-flip the LAST step.
    // Post-fix the handler kicks off the IPC and returns; the
    // optimistic flips have already painted by the time the
    // microtask queue picks up the promise.
    expect(SOURCE).toMatch(
      /const onToggleSingle = \(entry: ArcadeMraEntry\): void =>/,
    );
    // The IPC call is no longer awaited inside the handler.
    expect(SOURCE).not.toMatch(
      /await window\.mister\.setArcadeMraVisibility\(/,
    );
    // Instead the call lives in a chained .catch(...) — the only
    // surface that needs the promise is the revert path.
    expect(SOURCE).toMatch(
      /window\.mister[\s\S]{0,60}\.setArcadeMraVisibility\(originalPath, next\)[\s\S]{0,200}\.catch\(\(err: unknown\) =>/,
    );
  });

  it('optimistic writes run BEFORE the SSH call (so the UI is in the target state when the wire op starts)', () => {
    const start = SOURCE.indexOf('const onToggleSingle = (entry: ArcadeMraEntry)');
    expect(start).toBeGreaterThan(-1);
    const tail = SOURCE.slice(start);
    const sshIdx = tail.indexOf('.setArcadeMraVisibility(originalPath, next)');
    expect(sshIdx).toBeGreaterThan(-1);
    const head = tail.slice(0, sshIdx);
    // Three optimistic writes happen before the SSH kicks off:
    //   1. flip entry.hidden + relativePath
    //   2. re-key the metadata cache so the box art stays attached
    //   3. nudge the sidebar Arcade badge
    expect(head).toMatch(/setEntries\(\(prev\) =>/);
    expect(head).toMatch(/setMetadataByMra\(\(prev\) =>/);
    expect(head).toMatch(/adjustArcadeHiddenCount\(next \? 1 : -1\)/);
  });

  it('the .catch handler reverts every optimistic write before surfacing the toast', () => {
    const catchIdx = SOURCE.indexOf('.catch((err: unknown) =>');
    expect(catchIdx).toBeGreaterThan(-1);
    const tail = SOURCE.slice(catchIdx);
    const toastIdx = tail.indexOf('toast.error');
    expect(toastIdx).toBeGreaterThan(-1);
    const revertBlock = tail.slice(0, toastIdx);
    // Each write has a paired inverse-write — pin them so a
    // future "I'll just revert one of them" regression surfaces.
    expect(revertBlock).toMatch(/adjustArcadeHiddenCount\(next \? -1 : 1\)/);
    expect(revertBlock).toMatch(/setMetadataByMra\(\(prev\) =>/);
    expect(revertBlock).toMatch(/setEntries\(\(prev\) =>/);
  });

  it('toast message reads "Hide failed: <name>" or "Show failed: <name>" so the user sees WHICH direction failed', () => {
    // The user's expected copy from the pre-beta polish brief.
    // Pre-fix the message was "Could not hide/show ..." (more
    // verbose, less scannable).
    expect(SOURCE).toMatch(
      /toast\.error\(\s*`\$\{next \? 'Hide' : 'Show'\} failed: \$\{entry\.displayName\}`/,
    );
  });

  it('no in-flight spinner survives the rewrite — the eye flip IS the feedback', () => {
    // pendingPaths used to gate a Loader2 in the eye column while
    // SSH was on the wire. With optimistic UI the eye flip itself
    // is the feedback; the spinner was deleted along with the
    // pendingPaths state. (Loader2 stays in the file — it's still
    // used by the auto-hide checkbox while the bulk rule runs.)
    expect(SOURCE).not.toMatch(/pendingPaths/);
    expect(SOURCE).not.toMatch(/setPendingPaths/);
    // The auto-hide spinner survives — its bulk rename can still
    // run for several seconds, so the indicator is meaningful.
    expect(SOURCE).toMatch(/autoHidePending \?\s*\(\s*<Loader2/);
  });
});

describe('arcade-adapter — sidebar-badge sync (feat/pre-beta-polish-batch)', () => {
  it('CoresContext exposes adjustArcadeHiddenCount with the documented +/- delta contract', () => {
    const ctx = readFileSync(
      resolve(__dirname, '../contexts/CoresContext.tsx'),
      'utf8',
    );
    // Public type member.
    expect(ctx).toMatch(/readonly adjustArcadeHiddenCount: \(delta: number\) => void;/);
    // Implementation pins both hiddenCount AND recursiveHiddenCount
    // so the CoreCountSummary's `recursiveHiddenCount ?? hiddenCount`
    // reads the bumped value either way.
    expect(ctx).toMatch(/hiddenCount: core\.hiddenCount \+ delta/);
    expect(ctx).toMatch(
      /recursiveHiddenCount:\s*\(core\.recursiveHiddenCount \?\? core\.hiddenCount\) \+ delta/,
    );
    // No-op short-circuit on 0 — the toggle calls with ±1, but
    // future bulk-paths might call with 0 net delta.
    expect(ctx).toMatch(/if \(delta === 0\) return;/);
  });
});
