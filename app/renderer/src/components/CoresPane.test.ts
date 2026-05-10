import type { ReactElement } from 'react';

import { describe, expect, it } from 'vitest';

import type { CoreEntry } from '@shared/types';

import { CoreCountSummary } from '@app/renderer/src/components/CoresPane';

/**
 * fix/sidebar-count-and-mtime-batch — sidebar count visual cleanup.
 * Pre-fix: `100 (50 hidden)`. Post-fix: `100 (50)` with the parens
 * in muted color. The "hidden" word is implied by the styling;
 * dropping it makes the count more scannable. `0` hidden still
 * omits the parens entirely (existing behavior preserved).
 *
 * Component is small enough to call as a function and walk the
 * resulting children — no jsdom needed.
 */

function core(overrides: Partial<CoreEntry> = {}): CoreEntry {
  return {
    id: 'NES',
    name: 'NES',
    romCount: 100,
    hiddenCount: 0,
    recursiveRomCount: 100,
    recursiveHiddenCount: 0,
    category: 'Console',
    rbfPaths: [],
    gamesDirExists: true,
    gamesDirHidden: false,
    ...overrides,
  } as unknown as CoreEntry;
}

interface ChildSpan {
  readonly className?: string;
  readonly children?: unknown;
}

function spans(result: ReactElement<{ readonly children: unknown }>): ChildSpan[] {
  const kids = result.props.children;
  const arr = Array.isArray(kids) ? kids : [kids];
  const out: ChildSpan[] = [];
  for (const c of arr) {
    if (c === null || typeof c !== 'object') continue;
    out.push((c as ReactElement<ChildSpan>).props);
  }
  return out;
}

describe('CoreCountSummary — drop "hidden" word, keep muted parens', () => {
  it('renders just the total when hiddenCount is 0', () => {
    const result = CoreCountSummary({
      core: core({ recursiveRomCount: 100, hiddenCount: 0 }),
    }) as ReactElement<{ readonly children: unknown }>;
    const ss = spans(result);
    // Only the total span; no parenthetical.
    expect(ss).toHaveLength(1);
    expect(ss[0]?.children).toBe(100);
  });

  it('renders total + muted parens (no "hidden" word) when hiddenCount > 0', () => {
    const result = CoreCountSummary({
      core: core({ recursiveRomCount: 100, hiddenCount: 50 }),
    }) as ReactElement<{ readonly children: unknown }>;
    const ss = spans(result);
    expect(ss).toHaveLength(2);
    // Total first.
    expect(ss[0]?.children).toBe(100);
    // Parenthetical second — muted color, format `(N)`, no "hidden" word.
    expect(ss[1]?.className).toContain('text-fg-disabled');
    const parenChildren = Array.isArray(ss[1]?.children)
      ? (ss[1]!.children as unknown[])
      : [ss[1]?.children];
    const joined = parenChildren.join('');
    expect(joined).toBe('(50)');
    expect(joined).not.toContain('hidden');
  });

  it('falls back to romCount when recursiveRomCount is undefined', () => {
    const result = CoreCountSummary({
      core: core({
        romCount: 25,
        recursiveRomCount: undefined as unknown as number,
        hiddenCount: 5,
      }),
    }) as ReactElement<{ readonly children: unknown }>;
    const ss = spans(result);
    expect(ss[0]?.children).toBe(25);
    const parenChildren = Array.isArray(ss[1]?.children)
      ? (ss[1]!.children as unknown[])
      : [ss[1]?.children];
    expect(parenChildren.join('')).toBe('(5)');
  });
});
