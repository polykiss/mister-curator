import { describe, expect, it } from 'vitest';

import type { HiddenCoreEntry, HideLedger } from '@shared/types';

import type { CoreEntry } from '@shared/types';

import {
  EMPTY_LEDGER,
  healLedger,
  ledgerEqual,
  LEDGER_HEREDOC_DELIMITER,
  parseLedger,
  serializeLedger,
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
});
