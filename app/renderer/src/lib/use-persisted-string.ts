import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `useState<T>` (a string union) with a localStorage round-trip.
 * Validates the stored value against an allowlist; invalid or missing
 * values fall back to `defaultValue`.
 *
 * Pattern mirrors `usePersistedBool`. Used for view-mode persistence
 * in PR I-2 (list / detailed / poster).
 *
 * Safe under SSR / non-browser test runners — the storage check
 * gracefully degrades to in-memory state when `window` is missing.
 */
export function usePersistedString<T extends string>(
  key: string,
  defaultValue: T,
  valid: readonly T[],
): [T, (next: T) => void] {
  const [value, setLocal] = useState<T>(() =>
    readPersistedString(key, defaultValue, valid),
  );
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    writePersistedString(key, value);
  }, [key, value]);

  const set = useCallback((next: T) => {
    setLocal(next);
  }, []);

  return [value, set];
}

/** Pure read helper exposed for tests. */
export function readPersistedString<T extends string>(
  key: string,
  defaultValue: T,
  valid: readonly T[],
): T {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw !== null && (valid as readonly string[]).includes(raw)) {
      return raw as T;
    }
    return defaultValue;
  } catch {
    return defaultValue;
  }
}

/** Pure write helper exposed for tests. */
export function writePersistedString(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage full / disabled — nothing to do.
  }
}
