import { describe, expect, it } from 'vitest';

import type { HiddenCoreEntry, HideLedger } from '@shared/types';

import {
  EMPTY_LEDGER,
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
});
