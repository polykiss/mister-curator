import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Source-string contract for the Switch primitive (D17).
 * `Switch` is a forwardRef component, matching the hand-rolled
 * pattern; same scan approach as badge.tsx / table.tsx tests.
 */
const SOURCE = readFileSync(resolve(__dirname, 'switch.tsx'), 'utf8');

describe('Switch — structural contract (D17)', () => {
  it('renders a <button> with role="switch"', () => {
    expect(SOURCE).toContain('role="switch"');
    expect(SOURCE).toContain('type="button"');
  });

  it('forwards aria-checked from the checked prop', () => {
    expect(SOURCE).toContain('aria-checked={checked}');
  });

  it('calls onCheckedChange(!checked) on click', () => {
    expect(SOURCE).toMatch(/onClick.*onCheckedChange\(!checked\)/);
  });

  it('uses bg-accent track when checked, bg-switch-off (D35 exact spec) when off', () => {
    expect(SOURCE).toContain("checked ? 'bg-accent' : 'bg-switch-off'");
  });

  it('knob translates right when checked (D35: 14px for 30px track)', () => {
    expect(SOURCE).toContain("checked ? 'translate-x-[14px]' : 'translate-x-0.5'");
  });

  it('D28: thumb is accent-fg (dark) on ON state, white on OFF state for contrast', () => {
    // accent-fg is very dark on the green accent track; white on the dark overlay track.
    expect(SOURCE).toContain("checked ? 'bg-accent-fg' : 'bg-white'");
  });

  it('forwards the disabled prop and applies disabled:opacity-50 / disabled:cursor-not-allowed', () => {
    expect(SOURCE).toContain('disabled={disabled}');
    expect(SOURCE).toContain('disabled:cursor-not-allowed');
    expect(SOURCE).toContain('disabled:opacity-50');
  });

  it('uses forwardRef so ref can be attached (matching project primitive pattern)', () => {
    expect(SOURCE).toContain('forwardRef');
  });
});
