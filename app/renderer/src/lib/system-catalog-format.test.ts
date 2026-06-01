import { describe, expect, it } from 'vitest';

import { formatSupportType, formatSystemType } from './system-catalog-format';

// ─── formatSupportType ────────────────────────────────────────────────────────

describe('formatSupportType', () => {
  it('returns null for null input', () => {
    expect(formatSupportType(null)).toBeNull();
  });

  it('normalises cartouche → Cartridge', () => {
    expect(formatSupportType('cartouche')).toBe('Cartridge');
  });

  it('normalises cd → CD-ROM', () => {
    expect(formatSupportType('cd')).toBe('CD-ROM');
  });

  it('normalises disquette → Floppy Disk', () => {
    expect(formatSupportType('disquette')).toBe('Floppy Disk');
  });

  it('normalises k7 (cassette tape) → Cassette', () => {
    expect(formatSupportType('k7')).toBe('Cassette');
  });

  it('normalises pcb → PCB', () => {
    expect(formatSupportType('pcb')).toBe('PCB');
  });

  it('normalises bluray → Blu-ray', () => {
    expect(formatSupportType('bluray')).toBe('Blu-ray');
  });

  it('normalises carte → Card', () => {
    expect(formatSupportType('carte')).toBe('Card');
  });

  it('normalises non-applicable → N/A', () => {
    expect(formatSupportType('non-applicable')).toBe('N/A');
  });

  it('normalises videotape → VHS / Laserdisc', () => {
    expect(formatSupportType('videotape')).toBe('VHS / Laserdisc');
  });

  it('normalises download → Download', () => {
    expect(formatSupportType('download')).toBe('Download');
  });

  it('normalises hardware → Hardware', () => {
    expect(formatSupportType('hardware')).toBe('Hardware');
  });

  it('normalises smc → SMC', () => {
    expect(formatSupportType('smc')).toBe('SMC');
  });

  it('normalises web → Web', () => {
    expect(formatSupportType('web')).toBe('Web');
  });

  // compound terms
  it('normalises cartouche-cd → Cartridge / CD', () => {
    expect(formatSupportType('cartouche-cd')).toBe('Cartridge / CD');
  });

  it('normalises cartouche-download → Cartridge / Download', () => {
    expect(formatSupportType('cartouche-download')).toBe('Cartridge / Download');
  });

  it('normalises cartouche-k7 → Cartridge / Cassette', () => {
    expect(formatSupportType('cartouche-k7')).toBe('Cartridge / Cassette');
  });

  it('normalises cartouche-k7-disquette → Cartridge / Cassette / Floppy', () => {
    expect(formatSupportType('cartouche-k7-disquette')).toBe('Cartridge / Cassette / Floppy');
  });

  it('normalises cd-disquette → CD / Floppy', () => {
    expect(formatSupportType('cd-disquette')).toBe('CD / Floppy');
  });

  it('normalises k7-disquette → Cassette / Floppy', () => {
    expect(formatSupportType('k7-disquette')).toBe('Cassette / Floppy');
  });

  it('is case-insensitive — uppercased input still maps', () => {
    expect(formatSupportType('CARTOUCHE')).toBe('Cartridge');
    expect(formatSupportType('CD')).toBe('CD-ROM');
  });

  it('falls back to capitalised-first-letter for unknown terms', () => {
    expect(formatSupportType('bobine')).toBe('Bobine');
    expect(formatSupportType('some new term')).toBe('Some new term');
  });

  it('preserves casing of already-uppercase unknown terms', () => {
    // SS only sends French terms in lowercase; this just confirms no
    // accidental downcasing of anything that arrives already capitalised.
    expect(formatSupportType('OTHER')).toBe('OTHER');
  });
});

// ─── formatSystemType ─────────────────────────────────────────────────────────

describe('formatSystemType', () => {
  it('returns null for null input', () => {
    expect(formatSystemType(null)).toBeNull();
  });

  it('normalises Accessoire → Accessory', () => {
    expect(formatSystemType('Accessoire')).toBe('Accessory');
  });

  it('normalises Autres → Other', () => {
    expect(formatSystemType('Autres')).toBe('Other');
  });

  it('normalises Console Portable → Handheld', () => {
    expect(formatSystemType('Console Portable')).toBe('Handheld');
  });

  it('normalises Emulation Arcade → Arcade Emulator', () => {
    expect(formatSystemType('Emulation Arcade')).toBe('Arcade Emulator');
  });

  it('normalises Flipper → Pinball', () => {
    expect(formatSystemType('Flipper')).toBe('Pinball');
  });

  it('normalises Machine Virtuelle → Virtual Machine', () => {
    expect(formatSystemType('Machine Virtuelle')).toBe('Virtual Machine');
  });

  it('normalises Ordinateur → Computer', () => {
    expect(formatSystemType('Ordinateur')).toBe('Computer');
  });

  it('normalises Smartphone → Mobile', () => {
    expect(formatSystemType('Smartphone')).toBe('Mobile');
  });

  // already-English values pass through untouched
  it('passes through Console unchanged', () => {
    expect(formatSystemType('Console')).toBe('Console');
  });

  it('passes through Arcade unchanged', () => {
    expect(formatSystemType('Arcade')).toBe('Arcade');
  });

  it('passes through Console & Arcade unchanged', () => {
    expect(formatSystemType('Console & Arcade')).toBe('Console & Arcade');
  });

  it('falls back to sentence-case for unknown values', () => {
    expect(formatSystemType('Nouveau type')).toBe('Nouveau type');
  });
});
