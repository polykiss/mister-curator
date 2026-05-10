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
