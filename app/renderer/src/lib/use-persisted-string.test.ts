import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedString,
  writePersistedString,
} from '@app/renderer/src/lib/use-persisted-string';

const VALID = ['list', 'detailed', 'poster'] as const;
type ViewMode = (typeof VALID)[number];

/**
 * Tiny in-memory localStorage stand-in. vitest's default node env
 * doesn't expose `window.localStorage`; the module-under-test is
 * defensive about that, so we install a stub before each test.
 * Mirrors the pattern used by use-persisted-bool.test.ts.
 */
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

describe('readPersistedString', () => {
  let storage: { reset: () => void };

  beforeEach(() => {
    storage = installStubLocalStorage();
  });

  afterEach(() => {
    storage.reset();
    vi.unstubAllGlobals();
  });

  it('returns defaultValue when key is not set', () => {
    expect(readPersistedString('__test_missing__', 'list', VALID)).toBe('list');
  });

  it('returns the stored value when it is in the allowlist', () => {
    window.localStorage.setItem('__test_valid__', 'detailed');
    expect(readPersistedString('__test_valid__', 'list', VALID)).toBe('detailed');
  });

  it('returns defaultValue when the stored value is not in the allowlist', () => {
    window.localStorage.setItem('__test_invalid__', 'bogus');
    expect(
      readPersistedString<ViewMode>('__test_invalid__', 'list', VALID),
    ).toBe('list');
  });

  it('returns defaultValue for an empty string (empty is not in the allowlist)', () => {
    window.localStorage.setItem('__test_empty__', '');
    expect(readPersistedString('__test_empty__', 'poster', VALID)).toBe('poster');
  });

  it('is robust to a localStorage that throws (private-mode / quota)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => { throw new Error('SecurityError'); },
        setItem: () => { throw new Error('SecurityError'); },
      } satisfies Pick<Storage, 'getItem' | 'setItem'>,
    });
    expect(readPersistedString('x', 'list', VALID)).toBe('list');
    expect(() => writePersistedString('x', 'detailed')).not.toThrow();
  });
});

describe('writePersistedString', () => {
  let storage: { reset: () => void };

  beforeEach(() => {
    storage = installStubLocalStorage();
  });

  afterEach(() => {
    storage.reset();
    vi.unstubAllGlobals();
  });

  it('writes the value to localStorage', () => {
    writePersistedString('__test_write__', 'poster');
    expect(window.localStorage.getItem('__test_write__')).toBe('poster');
  });
});
