import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Structural contract for CoreRenameDialog.
 *
 * Source-string scan (same pattern as CoreInfoDialog.test.ts): Radix
 * Dialog portal-renders outside the jsdom root, making render tests
 * brittle. These scans catch field drift, input wiring, and form
 * submission behaviour.
 */
const SOURCE = readFileSync(resolve(__dirname, 'CoreRenameDialog.tsx'), 'utf8');

describe('CoreRenameDialog — structural contract', () => {
  it('uses max-w-sm for the dialog', () => {
    expect(SOURCE).toContain('max-w-sm');
  });

  it('title is "Rename core"', () => {
    expect(SOURCE).toContain('Rename core');
  });

  it('uses <Input autoFocus> from the ui/input component', () => {
    expect(SOURCE).toContain("from '@app/renderer/src/components/ui/input'");
    expect(SOURCE).toContain('<Input');
    expect(SOURCE).toContain('autoFocus');
  });

  it('pre-fills placeholder from ssDisplayName prop', () => {
    expect(SOURCE).toContain('ssDisplayName');
    expect(SOURCE).toContain('placeholder');
  });

  it('shows Technical ID helper text with core.id', () => {
    expect(SOURCE).toContain('Technical ID:');
    expect(SOURCE).toContain('core?.id');
  });

  it('uses form onSubmit (Enter saves)', () => {
    expect(SOURCE).toContain('onSubmit');
    expect(SOURCE).toContain('e.preventDefault()');
  });

  it('has Cancel and Save buttons', () => {
    expect(SOURCE).toContain('Cancel');
    expect(SOURCE).toContain('Save');
  });

  it('calls onSave with the current inputValue on submit', () => {
    expect(SOURCE).toContain('onSave(inputValue)');
  });

  it('seeds inputValue from currentCustomName prop', () => {
    expect(SOURCE).toContain('currentCustomName');
    expect(SOURCE).toContain('currentCustomName ?? \'\'');
  });

  it('renders null-safe core?.id (core prop can be null)', () => {
    expect(SOURCE).toContain('core?.id');
  });
});
