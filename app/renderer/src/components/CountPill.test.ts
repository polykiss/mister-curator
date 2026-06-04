import type { ReactElement } from 'react';

import { describe, expect, it } from 'vitest';

import { CountPill } from '@app/renderer/src/components/CountPill';

/**
 * Unit tests for the CountPill primitive (D16).
 */

type PillEl = ReactElement<{
  readonly className: string;
  readonly children: ReadonlyArray<ReactElement<{ readonly className: string }> | string | null>;
}>;

function render(props: Parameters<typeof CountPill>[0]): PillEl {
  return CountPill(props) as PillEl;
}

describe('CountPill — render shape (D16)', () => {
  it('renders the count value and label', () => {
    const el = render({ count: 42, label: 'ROMs' });
    const text = JSON.stringify(el);
    expect(text).toContain('42');
    expect(text).toContain('ROMs');
  });

  it('neutral tone shows no status dot', () => {
    const el = render({ count: 10, label: 'ROMs', tone: 'neutral' });
    const text = JSON.stringify(el);
    // No bg-warning or bg-info dot in neutral
    expect(text).not.toContain('bg-warning');
    expect(text).not.toContain('bg-info');
  });

  it('hidden tone shows an amber (bg-warning) dot', () => {
    const el = render({ count: 5, label: 'hidden', tone: 'hidden' });
    const text = JSON.stringify(el);
    expect(text).toContain('bg-warning');
  });

  it('system tone shows a blue (bg-info) dot', () => {
    const el = render({ count: 2, label: 'system', tone: 'system' });
    const text = JSON.stringify(el);
    expect(text).toContain('bg-info');
  });

  it('default tone is neutral (no dot)', () => {
    // tone omitted → neutral
    const el = render({ count: 100, label: 'ROMs' });
    const text = JSON.stringify(el);
    expect(text).not.toContain('bg-warning');
    expect(text).not.toContain('bg-info');
  });

  it('count can be a string (e.g. "N / M" for filter-active state)', () => {
    const el = render({ count: '12 / 50', label: 'shown' });
    const text = JSON.stringify(el);
    expect(text).toContain('12 / 50');
    expect(text).toContain('shown');
  });

  it('uses filled pill chrome — bg-overlay, rounded-full, no border (D27 rev.)', () => {
    const el = render({ count: 1, label: 'test' });
    expect(el.props.className).toContain('bg-overlay');
    expect(el.props.className).toContain('rounded-full');
    // Filled, not outline — no border-default ring
    expect(el.props.className).not.toContain('border-default');
  });
});
