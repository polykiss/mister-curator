import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedBool,
  writePersistedBool,
} from '@app/renderer/src/lib/use-persisted-bool';

/**
 * Tiny in-memory localStorage stand-in. vitest's default node env
 * doesn't expose `window.localStorage`; the module-under-test is
 * defensive about that, so we install a stub before each test.
 */
function installStubLocalStorage(): { reset: () => void } {
  const store = new Map<string, string>();
  const stub: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (i) => Array.from(store.keys())[i] ?? null,
    removeItem: (key) => {
      store.delete(key);
    },
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  vi.stubGlobal('window', { localStorage: stub });
  return { reset: () => store.clear() };
}

describe('readPersistedBool / writePersistedBool', () => {
  let storage: { reset: () => void };

  beforeEach(() => {
    storage = installStubLocalStorage();
  });

  afterEach(() => {
    storage.reset();
    vi.unstubAllGlobals();
  });

  it('returns the default when the key is missing', () => {
    expect(readPersistedBool('mistercurator.test.unset', true)).toBe(true);
    expect(readPersistedBool('mistercurator.test.unset', false)).toBe(false);
  });

  it('round-trips true', () => {
    writePersistedBool('mistercurator.test.flag', true);
    expect(readPersistedBool('mistercurator.test.flag', false)).toBe(true);
  });

  it('round-trips false', () => {
    writePersistedBool('mistercurator.test.flag', false);
    expect(readPersistedBool('mistercurator.test.flag', true)).toBe(false);
  });

  it('falls back to the default when the stored value is not "true"/"false"', () => {
    writePersistedBool('mistercurator.test.flag', true);
    // Simulate legacy / corrupt data.
    window.localStorage.setItem('mistercurator.test.flag', 'maybe');
    expect(readPersistedBool('mistercurator.test.flag', true)).toBe(true);
    expect(readPersistedBool('mistercurator.test.flag', false)).toBe(false);
  });

  it('is robust to a localStorage that throws (private-mode / quota)', () => {
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('SecurityError');
        },
        setItem: () => {
          throw new Error('SecurityError');
        },
      } satisfies Pick<Storage, 'getItem' | 'setItem'>,
    });
    expect(readPersistedBool('x', true)).toBe(true);
    // Write should swallow.
    expect(() => {
      writePersistedBool('x', false);
    }).not.toThrow();
  });
});
