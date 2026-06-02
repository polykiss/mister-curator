import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedString,
  writePersistedString,
} from '@app/renderer/src/lib/use-persisted-string';

function installStubLocalStorage(): { reset: () => void } {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, value); },
  };
  vi.stubGlobal('window', { localStorage: stub });
  return { reset: () => store.clear() };
}

const SOURCE = readFileSync(
  resolve(__dirname, 'SizeControl.tsx'),
  'utf8',
);

describe('SizeControl — structure (feat/view-size-control)', () => {
  it('exports SizeControl and ViewSize is in SIZE_ORDER', () => {
    expect(SOURCE).toMatch(/export function SizeControl/);
    expect(SOURCE).toMatch(/SIZE_ORDER.*'S'.*'M'.*'L'.*'XL'/s);
  });

  it('renders a minus button, current value label, and plus button', () => {
    expect(SOURCE).toMatch(/aria-label="Decrease size"/);
    expect(SOURCE).toMatch(/aria-label="Increase size"/);
    // The label shows the current value
    expect(SOURCE).toMatch(/\{value\}/);
  });

  it('minus button is disabled when value is S', () => {
    expect(SOURCE).toMatch(/disabled=\{!canDecrease\}/);
    expect(SOURCE).toMatch(/canDecrease = idx > 0/);
  });

  it('plus button is disabled when value is XL', () => {
    expect(SOURCE).toMatch(/disabled=\{!canIncrease\}/);
    expect(SOURCE).toMatch(/canIncrease = idx < SIZE_ORDER\.length - 1/);
  });

  it('clicking minus calls onChange with the previous size', () => {
    expect(SOURCE).toMatch(/onChange\(SIZE_ORDER\[idx - 1\]/);
  });

  it('clicking plus calls onChange with the next size', () => {
    expect(SOURCE).toMatch(/onChange\(SIZE_ORDER\[idx \+ 1\]/);
  });

  it('label has aria-live="polite" for screen reader announcements', () => {
    expect(SOURCE).toMatch(/aria-live="polite"/);
  });

  it('container has role="group" + aria-label for screen reader grouping', () => {
    expect(SOURCE).toMatch(/role="group"/);
    expect(SOURCE).toMatch(/aria-label="View size"/);
  });
});

describe('ViewSize persistence via usePersistedString', () => {
  const VALID = ['S', 'M', 'L', 'XL'] as const;
  let storage: { reset: () => void };

  beforeEach(() => { storage = installStubLocalStorage(); });
  afterEach(() => { storage.reset(); vi.unstubAllGlobals(); });

  it('defaults to M when not set', () => {
    expect(readPersistedString('__test_viewsize_missing__', 'M', VALID)).toBe('M');
  });

  it('reads a valid stored value', () => {
    writePersistedString('__test_viewsize__', 'XL');
    expect(readPersistedString('__test_viewsize__', 'M', VALID)).toBe('XL');
  });

  it('falls back to default for an invalid value', () => {
    writePersistedString('__test_viewsize_bad__', 'huge');
    expect(readPersistedString('__test_viewsize_bad__', 'M', VALID)).toBe('M');
  });
});
