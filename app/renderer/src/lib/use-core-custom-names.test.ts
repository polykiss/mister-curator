import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readPersistedCustomNames,
  writePersistedCustomNames,
  type CoreCustomNamesMap,
} from '@app/renderer/src/lib/use-core-custom-names';

// ─── localStorage stub ────────────────────────────────────────────────────────

const store: Record<string, string> = {};

const mockLocalStorage = {
  getItem: (key: string) => store[key] ?? null,
  setItem: (key: string, value: string) => { store[key] = value; },
  removeItem: (key: string) => { delete store[key]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
};

// vitest node env has no `window`; stub it so the module-under-test can
// reach localStorage (mirrors the pattern in use-persisted-bool.test.ts).
vi.stubGlobal('window', { localStorage: mockLocalStorage });

beforeEach(() => mockLocalStorage.clear());

// ─── readPersistedCustomNames ─────────────────────────────────────────────────

describe('readPersistedCustomNames', () => {
  it('returns empty object when storage is empty', () => {
    expect(readPersistedCustomNames()).toEqual({});
  });

  it('returns empty object when stored value is invalid JSON', () => {
    store['mistercurator.coreCustomNames'] = 'not-json{{{';
    expect(readPersistedCustomNames()).toEqual({});
  });

  it('returns empty object when stored value is an array (wrong shape)', () => {
    store['mistercurator.coreCustomNames'] = '[]';
    expect(readPersistedCustomNames()).toEqual({});
  });

  it('returns the stored map when valid', () => {
    const data: CoreCustomNamesMap = { 'profile-1': { SNES: 'Super Nintendo' } };
    store['mistercurator.coreCustomNames'] = JSON.stringify(data);
    expect(readPersistedCustomNames()).toEqual(data);
  });
});

// ─── writePersistedCustomNames ────────────────────────────────────────────────

describe('writePersistedCustomNames', () => {
  it('writes JSON to localStorage under the correct key', () => {
    const data: CoreCustomNamesMap = { 'p1': { GBA: 'Game Boy Advance' } };
    writePersistedCustomNames(data);
    expect(store['mistercurator.coreCustomNames']).toBe(JSON.stringify(data));
  });

  it('round-trips through read after write', () => {
    const data: CoreCustomNamesMap = { 'p1': { N64: 'Nintendo 64', GBA: 'GBA' } };
    writePersistedCustomNames(data);
    expect(readPersistedCustomNames()).toEqual(data);
  });
});

// ─── useCoreCustomNames — logic (tested via pure helpers) ────────────────────
//
// The hook itself uses useConnection (a React context) which requires
// a renderer environment. The pure read/write helpers above cover the
// persistence contract. The per-profile scoping and merge logic below
// is tested via the helpers directly, which mirror exactly what the
// hook's setState updater does.

describe('custom-names — per-profile scoping', () => {
  it('entries for different profiles do not collide', () => {
    const data: CoreCustomNamesMap = {
      'device-A': { SNES: 'Super Nintendo' },
      'device-B': { SNES: 'SNES Plus' },
    };
    writePersistedCustomNames(data);
    const read = readPersistedCustomNames();
    expect(read['device-A']?.['SNES']).toBe('Super Nintendo');
    expect(read['device-B']?.['SNES']).toBe('SNES Plus');
  });

  it('clearing a name removes only that entry, leaving others intact', () => {
    const data: CoreCustomNamesMap = {
      'device-A': { SNES: 'Super Nintendo', GBA: 'Game Boy Advance' },
    };
    writePersistedCustomNames(data);

    // Simulate clearCustomName for 'SNES' on 'device-A'
    const prev = readPersistedCustomNames();
    const profileMap = { ...(prev['device-A'] ?? {}) };
    delete profileMap['SNES'];
    const next: CoreCustomNamesMap = { ...prev, 'device-A': profileMap };
    writePersistedCustomNames(next);

    const result = readPersistedCustomNames();
    expect(result['device-A']?.['SNES']).toBeUndefined();
    expect(result['device-A']?.['GBA']).toBe('Game Boy Advance');
  });

  it('clearing the last entry for a profile removes the profile key', () => {
    const data: CoreCustomNamesMap = { 'device-A': { SNES: 'Super Nintendo' } };
    writePersistedCustomNames(data);

    const prev = readPersistedCustomNames();
    const profileMap = { ...(prev['device-A'] ?? {}) };
    delete profileMap['SNES'];
    const next: CoreCustomNamesMap = { ...prev };
    if (Object.keys(profileMap).length === 0) {
      delete next['device-A'];
    } else {
      next['device-A'] = profileMap;
    }
    writePersistedCustomNames(next);

    expect(readPersistedCustomNames()['device-A']).toBeUndefined();
  });
});

describe('use-core-custom-names — SSR safety', () => {
  it('readPersistedCustomNames does not throw when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(() => readPersistedCustomNames()).not.toThrow();
    vi.stubGlobal('window', { localStorage: mockLocalStorage });
  });

  it('writePersistedCustomNames does not throw when window is undefined', () => {
    vi.stubGlobal('window', undefined);
    expect(() => writePersistedCustomNames({})).not.toThrow();
    vi.stubGlobal('window', { localStorage: mockLocalStorage });
  });
});
