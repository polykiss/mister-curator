import { describe, expect, it } from 'vitest';

import {
  diagLine,
  makeIdGen,
  truncateForLog,
} from '@shared/diag-log';

describe('diagLine — log formatter', () => {
  it('renders a plain message with no fields', () => {
    expect(diagLine('ssh', '→', 'connecting')).toBe('[ssh] → connecting');
  });

  it('appends key=value pairs after a double-space separator', () => {
    expect(
      diagLine('ssh', '←', 'exit', { code: 0, ms: 42, opId: 'op-3' }),
    ).toBe('[ssh] ← exit  code=0 ms=42 opId=op-3');
  });

  it('drops fields whose value is undefined', () => {
    expect(
      diagLine('ipc', '→', 'invoke', {
        method: 'mister:listRoms',
        callId: 'c-1',
        skipped: undefined,
      }),
    ).toBe('[ipc] → invoke  method=mister:listRoms callId=c-1');
  });

  it('quotes string values that contain whitespace so grep/awk stays clean', () => {
    expect(
      diagLine('prefetch', '·', 'lookup', {
        path: 'Sonic 2 (USA).gen',
      }),
    ).toBe('[prefetch] · lookup  path="Sonic 2 (USA).gen"');
  });

  it('does not quote strings without whitespace', () => {
    expect(
      diagLine('prefetch', '·', 'lookup', {
        source: 'screenscraper',
      }),
    ).toBe('[prefetch] · lookup  source=screenscraper');
  });

  it('uses the failure glyph and supports the level upstream', () => {
    expect(
      diagLine('ssh', '✗', 'timeout', { ms: 60000, opId: 'op-7' }),
    ).toBe('[ssh] ✗ timeout  ms=60000 opId=op-7');
  });
});

describe('truncateForLog', () => {
  it('returns short strings unchanged', () => {
    expect(truncateForLog('hello')).toBe('hello');
  });

  it('truncates and appends an ellipsis when over the cap', () => {
    const long = 'a'.repeat(250);
    const out = truncateForLog(long);
    expect(out.length).toBe(201);
    expect(out.endsWith('…')).toBe(true);
  });

  it('respects a custom cap', () => {
    expect(truncateForLog('abcdefghij', 4)).toBe('abcd…');
  });
});

describe('makeIdGen', () => {
  it('issues monotonically-increasing prefixed ids', () => {
    const gen = makeIdGen('op-');
    expect(gen()).toBe('op-1');
    expect(gen()).toBe('op-2');
    expect(gen()).toBe('op-3');
  });

  it('is independent across instances', () => {
    const a = makeIdGen('a-');
    const b = makeIdGen('b-');
    a();
    a();
    expect(a()).toBe('a-3');
    expect(b()).toBe('b-1');
  });
});
