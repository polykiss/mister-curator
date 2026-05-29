import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  helperTextFor,
  progressPercent,
  titleFor,
} from '@app/renderer/src/components/UpdateModeProgressModal';

const MODAL = readFileSync(
  resolve(__dirname, 'UpdateModeProgressModal.tsx'),
  'utf8',
);

const BROWSER_SCREEN = readFileSync(
  resolve(__dirname, 'BrowserScreen.tsx'),
  'utf8',
);

// ─── Pure helpers ─────────────────────────────────────────────────────────────

describe('titleFor', () => {
  it('returns entering title for entering phase', () => {
    expect(titleFor('entering')).toBe('Preparing library for update…');
  });

  it('returns restoring title for restoring phase', () => {
    expect(titleFor('restoring')).toBe('Restoring curation…');
  });
});

describe('helperTextFor', () => {
  it('entering phase references un-hiding', () => {
    expect(helperTextFor('entering')).toMatch(/[Uu]n-hid/);
  });

  it('restoring phase references re-hiding', () => {
    expect(helperTextFor('restoring')).toMatch(/[Rr]e-hid/);
  });
});

describe('progressPercent', () => {
  it('computes integer percentage', () => {
    expect(progressPercent(50, 100)).toBe(50);
    expect(progressPercent(1, 3)).toBe(33);
    expect(progressPercent(100, 100)).toBe(100);
  });

  it('returns 0 when total is 0 (guard against divide-by-zero)', () => {
    expect(progressPercent(0, 0)).toBe(0);
  });

  it('returns 0 when current is 0', () => {
    expect(progressPercent(0, 200)).toBe(0);
  });
});

// ─── Source-string contracts ───────────────────────────────────────────────────

describe('UpdateModeProgressModal — structural contracts', () => {
  it('modal does not render when open is false (Dialog open prop forwarded)', () => {
    expect(MODAL).toMatch(/open=\{open\}/);
  });

  it('is non-dismissable: prevents outside-click and escape-key close', () => {
    expect(MODAL).toMatch(/onInteractOutside.*e\.preventDefault/);
    expect(MODAL).toMatch(/onEscapeKeyDown.*e\.preventDefault/);
  });

  it('has no close button (hideDefaultClose)', () => {
    expect(MODAL).toContain('hideDefaultClose');
  });

  it('exports pure titleFor, helperTextFor, progressPercent helpers', () => {
    expect(MODAL).toMatch(/export function titleFor/);
    expect(MODAL).toMatch(/export function helperTextFor/);
    expect(MODAL).toMatch(/export function progressPercent/);
  });

  it('applies progress bar width from progressPercent', () => {
    expect(MODAL).toMatch(/width.*percent.*%/);
  });

  it('renders a spinner (Loader2 with animate-spin)', () => {
    expect(MODAL).toContain('Loader2');
    expect(MODAL).toContain('animate-spin');
  });

  it('shows N / M file counter', () => {
    expect(MODAL).toMatch(/\{String\(current\)\}[^}]*\/[^}]*\{String\(total\)\}/);
  });
});

describe('BrowserScreen — UpdateModeProgressModal integration', () => {
  it('imports UpdateModeProgressModal', () => {
    expect(BROWSER_SCREEN).toContain("import { UpdateModeProgressModal }");
  });

  it('subscribes to onUpdateModeProgress to track current and total', () => {
    expect(BROWSER_SCREEN).toContain('onUpdateModeProgress');
    expect(BROWSER_SCREEN).toMatch(/setProgressCurrent|progressCurrent/);
    expect(BROWSER_SCREEN).toMatch(/setProgressTotal|progressTotal/);
  });

  it('reads updateModeOperationPhase from CoresContext', () => {
    expect(BROWSER_SCREEN).toMatch(/updateModeOperationPhase/);
  });

  it('opens modal when updateModeOperationPhase is non-null', () => {
    expect(BROWSER_SCREEN).toMatch(/open=\{updateModeOperationPhase !== null\}/);
  });
});
