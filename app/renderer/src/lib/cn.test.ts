import { describe, expect, it } from 'vitest';

import { cn } from '@app/renderer/src/lib/cn';

describe('cn() — extended tailwind-merge', () => {
  // Round 1 design-pass shipped a primary button with white text on
  // signal-green because tailwind-merge classified `text-body-sm`
  // (a font-size from our custom scale) as a text-color, deduped it
  // against `text-accent-fg`, and dropped the latter. The cn()
  // helper extends twMerge so our custom font-sizes register as
  // font-sizes — these tests guard the wiring.

  it('keeps the text color when both a custom font-size and a text-color are present', () => {
    expect(cn('text-accent-fg', 'text-body-sm')).toContain('text-accent-fg');
    expect(cn('text-accent-fg', 'text-body-sm')).toContain('text-body-sm');
  });

  it('keeps the text color regardless of class order', () => {
    expect(cn('text-body-sm', 'text-accent-fg')).toContain('text-accent-fg');
    expect(cn('text-body-sm', 'text-accent-fg')).toContain('text-body-sm');
  });

  it('still dedupes two text-color classes from our custom palette', () => {
    // The earlier color should drop when a later one supersedes it —
    // standard twMerge behavior we want to preserve.
    const result = cn('text-fg-muted', 'text-accent-fg');
    expect(result).toContain('text-accent-fg');
    expect(result).not.toContain('text-fg-muted');
  });

  it('still dedupes two font-sizes from our custom scale', () => {
    const result = cn('text-body-sm', 'text-body-lg');
    expect(result).toContain('text-body-lg');
    expect(result).not.toContain('text-body-sm');
  });

  it('survives the cva-style three-class stacking from button.tsx', () => {
    // Reproduces the exact shape that broke in Round 1: variant emits
    // `text-accent-fg`, size emits `text-body-sm`, both land in cn().
    const result = cn(
      'bg-accent text-accent-fg hover:bg-accent-hover',
      'h-7 px-3 text-body-sm',
    );
    expect(result).toContain('text-accent-fg');
    expect(result).toContain('text-body-sm');
    expect(result).toContain('bg-accent');
  });
});
