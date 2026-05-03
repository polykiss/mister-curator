import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * `useState<boolean>` with a localStorage round-trip. The initial
 * value is hydrated from `key` (falling back to `defaultValue` if the
 * slot is missing or unparseable), and every change writes back.
 *
 * Used for the per-pane visibility toggles (Show hidden / Show system
 * files). The user's last choice wins next session; defaults only
 * apply on first launch or after a localStorage reset.
 *
 * Safe under SSR / non-browser test runners — the storage check
 * gracefully degrades to in-memory state when `window` is missing.
 */
export function usePersistedBool(
  key: string,
  defaultValue: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setLocal] = useState<boolean>(() =>
    readPersistedBool(key, defaultValue),
  );
  // Skip the first effect run — the state initializer already
  // observed localStorage. Only subsequent updates need to write.
  const initial = useRef(true);
  useEffect(() => {
    if (initial.current) {
      initial.current = false;
      return;
    }
    writePersistedBool(key, value);
  }, [key, value]);

  const set = useCallback((next: boolean) => {
    setLocal(next);
  }, []);

  return [value, set];
}

/**
 * Pure-ish helper exposed for tests. Reads `key` from `localStorage`
 * and parses `'true'` / `'false'`; anything else (missing slot,
 * legacy junk) falls back to `defaultValue`.
 */
export function readPersistedBool(key: string, defaultValue: boolean): boolean {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return defaultValue;
  } catch {
    // Storage can throw under privacy modes; treat as missing.
    return defaultValue;
  }
}

/** Pure-ish helper exposed for tests — mirror of `readPersistedBool`. */
export function writePersistedBool(key: string, value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, value ? 'true' : 'false');
  } catch {
    // Storage full / disabled — nothing to do.
  }
}
