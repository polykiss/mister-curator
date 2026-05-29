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
      /const \{ adjustArcadeHiddenCount[^}]* \} = useCores\(\);/,
    );
  });

  it('onToggleSingle is synchronous (no await on the SSH call) — UI flips before the wire round-trip', () => {
    // Pre-fix the handler was `async ... await setArcadeMraVisibility`,
    // making the spinner mandatory and the eye-flip the LAST step.
    // Post-fix the row's eye toggle is still synchronous (void
    // return): the optimistic flips paint immediately, the SSH
    // call runs in background via the shared Promise-returning
    // helper introduced in feat/detail-modal-nav-hide.
    expect(SOURCE).toMatch(
      /const onToggleSingle = \(entry: ArcadeMraEntry\): void =>/,
    );
    // The IPC is invoked inside `applyArcadeMraVisibility`, not
    // directly inside the row's toggle. The toggle never awaits
    // the IPC.
    expect(SOURCE).not.toMatch(
      /onToggleSingle = \(entry: ArcadeMraEntry\): void =>[\s\S]{0,400}await window\.mister\.setArcadeMraVisibility/,
    );
    // The shared helper exists with the documented signature.
    expect(SOURCE).toMatch(
      /const applyArcadeMraVisibility = \(\s*entry: ArcadeMraEntry,\s*next: boolean,\s*\): Promise<void> =>/,
    );
    // And THAT helper drives the SSH call.
    expect(SOURCE).toMatch(
      /window\.mister[\s\S]{0,80}\.setArcadeMraVisibility\(originalPath, next\)/,
    );
  });

  it('the shared optimistic helper performs all three local writes BEFORE the SSH call', () => {
    // feat/detail-modal-nav-hide extracted the optimistic core
    // into `applyArcadeMraVisibility` so the detail dialog can
    // await it. The ordering contract — local writes first, then
    // SSH — moved into the helper. Pin it there.
    const start = SOURCE.indexOf(
      'const applyArcadeMraVisibility = (',
    );
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

  it('the helper reverts every optimistic write and re-throws so callers can decide on toast / no advance', () => {
    // Pre-PR the catch handler swallowed the rejection and
    // surfaced a toast inline. Now the helper re-throws so the
    // detail dialog can:
    //   (a) advance only on success, or
    //   (b) stay on the current entry on failure.
    // The row's `onToggleSingle` wraps in its own catch + toast.
    const catchIdx = SOURCE.indexOf(
      "window.mister\n      .setArcadeMraVisibility(originalPath, next)\n      .catch((err: unknown) =>",
    );
    // Tolerate formatting drift on the .catch — use a regex match.
    const helperRegex =
      /applyArcadeMraVisibility[\s\S]+?\.setArcadeMraVisibility\(originalPath, next\)[\s\S]+?\.catch\(\(err: unknown\) =>([\s\S]+?)throw err;/;
    const helperCatch = SOURCE.match(helperRegex);
    void catchIdx; // unused — the regex is the assertion path.
    expect(helperCatch).not.toBeNull();
    const revertBlock = helperCatch?.[1] ?? '';
    // Inverse-writes pinned in the same order: counts, metadata,
    // entries.
    expect(revertBlock).toMatch(/adjustArcadeHiddenCount\(next \? -1 : 1\)/);
    expect(revertBlock).toMatch(/setMetadataByMra\(\(prev\) =>/);
    expect(revertBlock).toMatch(/setEntries\(\(prev\) =>/);
  });

  it('the row-toggle wrapper surfaces toast.error with "Hide failed" / "Show failed" copy on rejection', () => {
    // The row-view eye click is fire-and-forget — its catch path
    // owns the toast. The detail-dialog's hide button owns its
    // own toast for the same shape (see the dialog wiring tests).
    const onToggleIdx = SOURCE.indexOf(
      'const onToggleSingle = (entry: ArcadeMraEntry): void =>',
    );
    expect(onToggleIdx).toBeGreaterThan(-1);
    const block = SOURCE.slice(onToggleIdx);
    expect(block).toMatch(
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
