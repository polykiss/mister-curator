import type { ReactElement, ReactNode } from 'react';

import { describe, expect, it } from 'vitest';

import type { CoreEntry } from '@shared/types';

import { CoreCountSummary } from '@app/renderer/src/components/CoresPane';

/**
 * fix/scrape-and-count-correctness commit 5 — sidebar count format
 * regression coverage. The pre-fix render included the literal
 * "hidden" word inside the parenthetical:
 *   `100 (50 hidden)`
 * The spec format is the muted paren itself as the cue:
 *   `100 (50)`
 * PR #38 commit 3 dropped the word once before; a later refactor
 * brought it back. Pin the format via direct component shape
 * inspection so any future "let's just add a tooltip word" change
 * trips this assertion.
 *
 * Also pins:
 *   • The numerator pulls from `recursiveRomCount` (whole walk),
 *     falling back to `romCount` when the matcher input lacked
 *     subfolder data.
 *   • The parenthetical pulls from `recursiveHiddenCount` so its
 *     basis matches the numerator. Pre-fix it pulled from the
 *     top-level `hiddenCount` and produced incoherent ratios for
 *     cores with hidden ROMs nested inside container subfolders.
 */

function core(overrides: Partial<CoreEntry> = {}): CoreEntry {
  return {
    id: 'NES',
    name: 'NES',
    romCount: 0,
    hiddenCount: 0,
    recursiveRomCount: 0,
    recursiveHiddenCount: 0,
    category: 'Console',
    rbfPaths: [],
    gamesDirExists: true,
    gamesDirHidden: false,
    ...overrides,
  };
}

/**
 * Walk the rendered tree and collect every text node into one
 * string. Mirrors what a screen reader would announce — the visual
 * order of the count + paren combo.
 */
function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('');
  }
  if (typeof node === 'object' && 'props' in node) {
    const props = (node as ReactElement<{ readonly children?: ReactNode }>).props;
    return collectText(props.children);
  }
  return '';
}

describe('CoreCountSummary — sidebar count format', () => {
  it('renders just `100` when no hidden ROMs', () => {
    const out = CoreCountSummary({
      core: core({ recursiveRomCount: 100, recursiveHiddenCount: 0 }),
    });
    expect(collectText(out)).toBe('100');
  });

  it('renders `100(50)` (no "hidden" word) when there are hidden ROMs', () => {
    const out = CoreCountSummary({
      core: core({ recursiveRomCount: 100, recursiveHiddenCount: 50 }),
    });
    const text = collectText(out);
    expect(text).toBe('100(50)');
    // Defensive: the word "hidden" must NOT appear in the rendered
    // text. PR #38 commit 3 dropped it; a later refactor brought it
    // back. This assertion is the load-bearing one.
    expect(text).not.toMatch(/hidden/i);
  });

  it('falls back to `romCount` / `hiddenCount` when the matcher omits recursive fields', () => {
    // Legacy fixture / partial test data: matcher input lacked
    // subfolder payload, so recursive*Count is undefined. The render
    // gracefully falls back to the top-level numbers.
    const out = CoreCountSummary({
      core: core({
        recursiveRomCount: undefined,
        recursiveHiddenCount: undefined,
        romCount: 7,
        hiddenCount: 2,
      }),
    });
    expect(collectText(out)).toBe('7(2)');
  });

  it('uses recursiveHiddenCount over hiddenCount for the parenthetical (consistent basis)', () => {
    // recursiveRomCount = 100 (whole walk, including ROMs nested
    // inside container subfolders). recursiveHiddenCount = 50.
    // top-level hiddenCount is only 5. Pre-fix the parenthetical
    // pulled from top-level → "100 (5)" which read as "5% hidden"
    // when the truth is 50%. Pin the recursive-basis behavior.
    const out = CoreCountSummary({
      core: core({
        recursiveRomCount: 100,
        recursiveHiddenCount: 50,
        romCount: 10,
        hiddenCount: 5,
      }),
    });
    expect(collectText(out)).toBe('100(50)');
  });

  it('X68000 ground-truth shape: 4 (643) — both numbers from recursive*Count', () => {
    // fix/count-and-status-indicator commit 5 — end-to-end pin
    // for the user's ground truth: X68000 should read "4 (643)"
    // once the matcher's atomic-via-shared-prefix call from
    // commit 1 is in place. Pre-commit-1 it read "1155 (1140)"
    // because the game folders classified container and the
    // sidebar inflated to file-level counts. Pin both numbers
    // come from the recursive walk so a future reversion to
    // top-level `romCount` / `hiddenCount` trips this assertion.
    const out = CoreCountSummary({
      core: core({
        recursiveRomCount: 4,
        recursiveHiddenCount: 643,
        // Top-level numbers are intentionally different so a
        // reversion to top-level basis would flip the result.
        romCount: 7,
        hiddenCount: 3,
      }),
    });
    const text = collectText(out);
    expect(text).toBe('4(643)');
    expect(text).not.toMatch(/hidden/i);
  });

  it('MegaCD ground-truth shape: hidden=21 atomic-folder count, NOT file-level', () => {
    // The user's MegaCD has 21 dot-prefixed game folders. Each
    // is an atomic disc dump (.cue + .bin). With recursive*Count
    // as the basis, atomic folders contribute 1 each → 21.
    const out = CoreCountSummary({
      core: core({
        recursiveRomCount: 5,
        recursiveHiddenCount: 21,
      }),
    });
    expect(collectText(out)).toBe('5(21)');
  });

  // feat/arcade-ux-and-ledger (PR 2/2) — Arcade synthetic row
  // switches the format to `playable (total)`.
  describe('Arcade row — `playable (total)` format', () => {
    it('renders `playable(total)` when arcadePlayableCount is defined', () => {
      const out = CoreCountSummary({
        core: core({
          id: '__arcade__',
          name: 'Arcade',
          category: 'Arcade',
          romCount: 502,
          hiddenCount: 0,
          recursiveRomCount: 502,
          recursiveHiddenCount: 0,
          arcadePlayableCount: 376,
        }),
      });
      const text = collectText(out);
      expect(text).toBe('376(502)');
    });

    it('shows zero playable as `0(N)` rather than hiding the paren', () => {
      // Distinct from the cores row's "hidden=0 → no paren" because
      // the Arcade format's paren conveys the denominator, not a
      // hidden count.
      const out = CoreCountSummary({
        core: core({
          id: '__arcade__',
          category: 'Arcade',
          recursiveRomCount: 502,
          arcadePlayableCount: 0,
        }),
      });
      expect(collectText(out)).toBe('0(502)');
    });

    it('falls back to the legacy `total (hidden)` format when arcadePlayableCount is undefined', () => {
      // Cold-connect path before the playability scan resolves —
      // the Arcade row carries `romCount` / `hiddenCount` but no
      // `arcadePlayableCount`. The render must not flash a 0; it
      // shows the old format until playability lands.
      const out = CoreCountSummary({
        core: core({
          id: '__arcade__',
          category: 'Arcade',
          recursiveRomCount: 502,
          recursiveHiddenCount: 12,
        }),
      });
      expect(collectText(out)).toBe('502(12)');
    });
  });

  it('paren span uses the muted disabled color (visual cue carries the meaning)', () => {
    // The "hidden" word was redundant against the muted paren color.
    // Pin the paren element's class so a stylistic refactor that
    // strips the muted color and re-adds the word can be spotted.
    const out = CoreCountSummary({
      core: core({ recursiveRomCount: 1, recursiveHiddenCount: 1 }),
    }) as ReactElement<{
      readonly children: ReadonlyArray<ReactElement<{
        readonly className: string;
        readonly children: ReactNode;
      }> | null>;
    }>;
    // Children is [<span>{total}</span>, <span className="text-fg-disabled">({hidden})</span>]
    const parenChild = out.props.children[1];
    expect(parenChild?.props.className).toMatch(/text-fg-disabled/);
  });
});
