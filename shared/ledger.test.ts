import { describe, expect, it } from 'vitest';

import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';
import type { HiddenCoreEntry, HideLedger } from '@shared/types';

import type { CoreEntry } from '@shared/types';

import {
  arcadeMraHiddenPath,
  arcadeMraVisiblePath,
  EMPTY_LEDGER,
  healArcadeLedger,
  healLedger,
  ledgerEqual,
  LEDGER_HEREDOC_DELIMITER,
  parseLedger,
  serializeLedger,
  withArcadeAutoHideEnabled,
  withArcadeAutoHidden,
  withArcadeTombstoneAdded,
  withArcadeTombstoneRemoved,
  withCoreHidden,
  withCoreShown,
} from '@shared/ledger';

const sampleEntry: HiddenCoreEntry = {
  coreId: 'NES',
  gamesDirHidden: true,
  rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
  hiddenAt: '2026-01-01T00:00:00Z',
};

const sampleLedger: HideLedger = {
  schemaVersion: 1,
  hiddenCores: [sampleEntry],
};

describe('parseLedger', () => {
  it('returns the empty ledger for an empty string', () => {
    expect(parseLedger('')).toEqual(EMPTY_LEDGER);
    expect(parseLedger('   \n')).toEqual(EMPTY_LEDGER);
  });

  it('returns the empty ledger for malformed JSON', () => {
    expect(parseLedger('{not json')).toEqual(EMPTY_LEDGER);
  });

  it('returns the empty ledger for JSON that does not match the ledger shape', () => {
    expect(parseLedger('"a string"')).toEqual(EMPTY_LEDGER);
    expect(parseLedger('{"hiddenCores": "no"}')).toEqual(EMPTY_LEDGER);
    expect(parseLedger('{"schemaVersion": 1, "hiddenCores": [{"bad": true}]}')).toEqual(
      EMPTY_LEDGER,
    );
  });

  it('parses a valid ledger', () => {
    const raw = JSON.stringify(sampleLedger);
    expect(parseLedger(raw)).toEqual(sampleLedger);
  });

  it('throws on a recognized-but-incompatible schemaVersion', () => {
    const raw = JSON.stringify({ schemaVersion: 2, hiddenCores: [] });
    expect(() => parseLedger(raw)).toThrow(/schemaVersion/);
  });
});

describe('serializeLedger', () => {
  it('produces JSON that round-trips through parseLedger', () => {
    const out = serializeLedger(sampleLedger);
    expect(parseLedger(out)).toEqual(sampleLedger);
  });

  it('includes a trailing newline so files end with a newline', () => {
    expect(serializeLedger(sampleLedger).endsWith('\n')).toBe(true);
  });

  it('hard-fails when a coreId would prematurely close the SSH heredoc', () => {
    const bad: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [
        {
          ...sampleEntry,
          coreId: LEDGER_HEREDOC_DELIMITER,
        },
      ],
    };
    expect(() => serializeLedger(bad)).toThrow(/heredoc delimiter/);
  });

  it('hard-fails when an rbf path would prematurely close the SSH heredoc', () => {
    const bad: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [
        {
          ...sampleEntry,
          rbfPaths: [`/media/fat/${LEDGER_HEREDOC_DELIMITER}.rbf`],
        },
      ],
    };
    expect(() => serializeLedger(bad)).toThrow(/heredoc delimiter/);
  });
});

describe('withCoreHidden', () => {
  it('adds a new entry to an empty ledger', () => {
    const next = withCoreHidden(EMPTY_LEDGER, sampleEntry);
    expect(next.hiddenCores).toEqual([sampleEntry]);
  });

  it('replaces an existing entry with the same coreId', () => {
    const updated: HiddenCoreEntry = { ...sampleEntry, hiddenAt: '2026-02-01T00:00:00Z' };
    const next = withCoreHidden(sampleLedger, updated);
    expect(next.hiddenCores).toHaveLength(1);
    expect(next.hiddenCores[0]).toEqual(updated);
  });

  it('returns a new ledger object (does not mutate the input)', () => {
    const next = withCoreHidden(sampleLedger, { ...sampleEntry, coreId: 'SNES' });
    expect(next).not.toBe(sampleLedger);
    expect(sampleLedger.hiddenCores).toHaveLength(1);
  });
});

describe('withCoreShown', () => {
  it('removes the entry for the given coreId', () => {
    const next = withCoreShown(sampleLedger, 'NES');
    expect(next.hiddenCores).toEqual([]);
  });

  it('is a no-op when no entry matches', () => {
    const next = withCoreShown(sampleLedger, 'SNES');
    expect(next.hiddenCores).toEqual(sampleLedger.hiddenCores);
  });

  it('removes by case-insensitive id match (defensive)', () => {
    const ledger = withCoreHidden(EMPTY_LEDGER, { ...sampleEntry, coreId: 'APOGEE' });
    const next = withCoreShown(ledger, 'Apogee');
    expect(next.hiddenCores).toEqual([]);
  });
});

describe('healLedger', () => {
  function makeCore(overrides: Partial<CoreEntry> = {}): CoreEntry {
    return {
      id: 'NES',
      name: 'NES',
      romCount: 0,
      hiddenCount: 0,
      category: 'Console',
      rbfPaths: ['/media/fat/_Console/NES_20240115.rbf'],
      gamesDirExists: true,
      gamesDirHidden: false,
      ...overrides,
    };
  }

  const ledgerWith = (...entries: HiddenCoreEntry[]): HideLedger => ({
    schemaVersion: 1,
    hiddenCores: entries,
  });

  it('returns the same ledger reference when nothing is stale', () => {
    const ledger = ledgerWith(sampleEntry);
    const cores = [makeCore({ id: 'NES' })];
    expect(healLedger(ledger, cores)).toBe(ledger);
  });

  it('drops an entry whose coreId no longer exists in current cores', () => {
    const ledger = ledgerWith({
      coreId: '_hidden',
      gamesDirHidden: true,
      rbfPaths: [],
      hiddenAt: '2026-01-01T00:00:00Z',
    });
    const cores: CoreEntry[] = []; // no current cores at all
    const healed = healLedger(ledger, cores);
    expect(healed.hiddenCores).toEqual([]);
    expect(healed).not.toBe(ledger);
  });

  it('drops an entry whose current core fails the isRealCore check', () => {
    const ledger = ledgerWith({
      coreId: 'Bogus',
      gamesDirHidden: true,
      rbfPaths: [],
      hiddenAt: '2026-01-01T00:00:00Z',
    });
    // Simulate a CoreEntry that somehow exists but isn't a real core —
    // e.g. an Arcade-category entry that snuck through.
    const cores = [
      makeCore({ id: 'Bogus', category: 'Arcade', rbfPaths: [], gamesDirExists: false }),
    ];
    const healed = healLedger(ledger, cores);
    expect(healed.hiddenCores).toEqual([]);
  });

  it('matches ledger entries to cores case-insensitively', () => {
    const ledger = ledgerWith({
      coreId: 'APOGEE', // pre-dedupe casing
      gamesDirHidden: true,
      rbfPaths: [],
      hiddenAt: '2026-01-01T00:00:00Z',
    });
    const cores = [makeCore({ id: 'Apogee' })]; // post-dedupe canonical
    expect(healLedger(ledger, cores)).toBe(ledger);
  });

  it('keeps survivors and drops stale ones in a mixed batch', () => {
    const ledger = ledgerWith(
      { ...sampleEntry, coreId: 'NES' },
      { ...sampleEntry, coreId: '_hidden' },
      { ...sampleEntry, coreId: 'SNES' },
    );
    const cores = [makeCore({ id: 'NES' }), makeCore({ id: 'SNES' })];
    const healed = healLedger(ledger, cores);
    expect(healed.hiddenCores.map((e) => e.coreId)).toEqual(['NES', 'SNES']);
  });
});

describe('ledgerEqual', () => {
  it('returns true for two empty ledgers', () => {
    expect(ledgerEqual(EMPTY_LEDGER, EMPTY_LEDGER)).toBe(true);
  });

  it('returns true for the same ledger reference', () => {
    expect(ledgerEqual(sampleLedger, sampleLedger)).toBe(true);
  });

  it('returns false when entries differ in length', () => {
    expect(ledgerEqual(EMPTY_LEDGER, sampleLedger)).toBe(false);
  });

  it('returns false when entry contents differ', () => {
    const a = sampleLedger;
    const b: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [{ ...sampleEntry, coreId: 'OTHER' }],
    };
    expect(ledgerEqual(a, b)).toBe(false);
  });

  it('treats absent vs explicit-default arcade fields as equal', () => {
    const a: HideLedger = { schemaVersion: 1, hiddenCores: [] };
    const b: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHideEnabled: true,
      arcadeAutoHidden: [],
      arcadeUserShownDespiteMissing: [],
    };
    expect(ledgerEqual(a, b)).toBe(true);
  });

  it('returns false when arcadeAutoHideEnabled differs', () => {
    const a: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHideEnabled: true,
    };
    const b: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHideEnabled: false,
    };
    expect(ledgerEqual(a, b)).toBe(false);
  });

  it('returns false when arcade arrays differ', () => {
    const a: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['Foo.mra'],
    };
    const b: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['Bar.mra'],
    };
    expect(ledgerEqual(a, b)).toBe(false);
  });
});

// feat/arcade-ux-and-ledger (PR 2/2) — arcade-specific helpers.

describe('parseLedger — arcade fields', () => {
  it('accepts a ledger with all three arcade fields', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHideEnabled: false,
      arcadeAutoHidden: ['Foo.mra', '_Konami/Bar.mra'],
      arcadeUserShownDespiteMissing: ['Baz.mra'],
    });
    const ledger = parseLedger(raw);
    expect(ledger.arcadeAutoHideEnabled).toBe(false);
    expect(ledger.arcadeAutoHidden).toEqual(['Foo.mra', '_Konami/Bar.mra']);
    expect(ledger.arcadeUserShownDespiteMissing).toEqual(['Baz.mra']);
  });

  it('parses a pre-V1 ledger (no arcade fields) cleanly with arcade fields undefined', () => {
    const raw = JSON.stringify({ schemaVersion: 1, hiddenCores: [] });
    const ledger = parseLedger(raw);
    expect(ledger.arcadeAutoHideEnabled).toBeUndefined();
    expect(ledger.arcadeAutoHidden).toBeUndefined();
    expect(ledger.arcadeUserShownDespiteMissing).toBeUndefined();
  });

  it('falls back to EMPTY_LEDGER when arcadeAutoHideEnabled is a non-boolean', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHideEnabled: 'yes', // wrong type
    });
    expect(parseLedger(raw)).toBe(EMPTY_LEDGER);
  });

  it('falls back to EMPTY_LEDGER when arcadeAutoHidden contains a non-string', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['ok.mra', 42],
    });
    expect(parseLedger(raw)).toBe(EMPTY_LEDGER);
  });
});

describe('arcadeMraVisiblePath', () => {
  it('strips a leading dot from the basename', () => {
    expect(arcadeMraVisiblePath('.Foo.mra')).toBe('Foo.mra');
  });

  it('leaves an already-visible basename alone', () => {
    expect(arcadeMraVisiblePath('Foo.mra')).toBe('Foo.mra');
  });

  it('only strips the dot from the basename, not parent segments', () => {
    expect(arcadeMraVisiblePath('_Konami/.Foo.mra')).toBe('_Konami/Foo.mra');
    expect(arcadeMraVisiblePath('_Konami/Foo.mra')).toBe('_Konami/Foo.mra');
  });
});

describe('arcadeMraHiddenPath', () => {
  it('prepends a leading dot to a visible basename', () => {
    expect(arcadeMraHiddenPath('Foo.mra')).toBe('.Foo.mra');
  });

  it('leaves an already-hidden basename alone (idempotent)', () => {
    expect(arcadeMraHiddenPath('.Foo.mra')).toBe('.Foo.mra');
  });

  it('only dots the basename, not parent segments', () => {
    expect(arcadeMraHiddenPath('_Konami/Foo.mra')).toBe('_Konami/.Foo.mra');
    expect(arcadeMraHiddenPath('_Konami/.Foo.mra')).toBe('_Konami/.Foo.mra');
  });
});

describe('healArcadeLedger', () => {
  const meta = (relativePath: string): ArcadeMraMeta => ({
    relativePath,
    displayName: relativePath.split('/').pop()!.replace(/^\./, ''),
    hidden: relativePath.split('/').pop()!.startsWith('.'),
    requiredZips: [],
    rbf: 'r',
  });

  it('returns the same object when both arcade lists are empty / absent', () => {
    const ledger: HideLedger = { schemaVersion: 1, hiddenCores: [] };
    expect(healArcadeLedger(ledger, [meta('Foo.mra')])).toBe(ledger);
  });

  it('keeps entries whose visible path matches a current .mra (either form)', () => {
    const ledger: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['Foo.mra'],
      arcadeUserShownDespiteMissing: ['Bar.mra'],
    };
    // Foo is currently dot-prefixed (auto-hidden), Bar is visible.
    const entries = [meta('.Foo.mra'), meta('Bar.mra')];
    const healed = healArcadeLedger(ledger, entries);
    expect(healed.arcadeAutoHidden).toEqual(['Foo.mra']);
    expect(healed.arcadeUserShownDespiteMissing).toEqual(['Bar.mra']);
  });

  it('drops auto-hidden entries whose visible path no longer maps to a .mra', () => {
    const ledger: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['Foo.mra', 'Gone.mra'],
    };
    const healed = healArcadeLedger(ledger, [meta('Foo.mra')]);
    expect(healed.arcadeAutoHidden).toEqual(['Foo.mra']);
  });

  it('drops tombstones whose visible path no longer maps to a .mra', () => {
    const ledger: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeUserShownDespiteMissing: ['Stale.mra', 'Live.mra'],
    };
    const healed = healArcadeLedger(ledger, [meta('Live.mra')]);
    expect(healed.arcadeUserShownDespiteMissing).toEqual(['Live.mra']);
  });

  it('returns the same object when no entries are dropped', () => {
    const ledger: HideLedger = {
      schemaVersion: 1,
      hiddenCores: [],
      arcadeAutoHidden: ['Foo.mra'],
      arcadeUserShownDespiteMissing: ['Bar.mra'],
    };
    expect(
      healArcadeLedger(ledger, [meta('Foo.mra'), meta('Bar.mra')]),
    ).toBe(ledger);
  });
});

describe('withArcadeAutoHideEnabled / withArcadeAutoHidden / tombstone helpers', () => {
  const base: HideLedger = { schemaVersion: 1, hiddenCores: [] };

  it('withArcadeAutoHideEnabled sets the field', () => {
    expect(withArcadeAutoHideEnabled(base, false).arcadeAutoHideEnabled).toBe(
      false,
    );
    expect(withArcadeAutoHideEnabled(base, true).arcadeAutoHideEnabled).toBe(
      true,
    );
  });

  it('withArcadeAutoHidden replaces the set with a fresh copy', () => {
    const next = withArcadeAutoHidden(base, ['A.mra', 'B.mra']);
    expect(next.arcadeAutoHidden).toEqual(['A.mra', 'B.mra']);
    // Replacement, not append.
    expect(
      withArcadeAutoHidden(next, ['C.mra']).arcadeAutoHidden,
    ).toEqual(['C.mra']);
  });

  it('withArcadeTombstoneAdded is idempotent on a duplicate', () => {
    const once = withArcadeTombstoneAdded(base, 'Foo.mra');
    const twice = withArcadeTombstoneAdded(once, 'Foo.mra');
    expect(twice).toBe(once); // referential — no-op short-circuit
    expect(once.arcadeUserShownDespiteMissing).toEqual(['Foo.mra']);
  });

  it('withArcadeTombstoneRemoved is idempotent on a missing entry', () => {
    expect(withArcadeTombstoneRemoved(base, 'Foo.mra')).toBe(base);
  });

  it('withArcadeTombstoneRemoved drops just the named entry', () => {
    const seeded: HideLedger = {
      ...base,
      arcadeUserShownDespiteMissing: ['A.mra', 'B.mra', 'C.mra'],
    };
    expect(
      withArcadeTombstoneRemoved(seeded, 'B.mra').arcadeUserShownDespiteMissing,
    ).toEqual(['A.mra', 'C.mra']);
  });
});
