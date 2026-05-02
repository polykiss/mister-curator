import { describe, expect, it } from 'vitest';

import {
  EMPTY_SYSTEM_FILES_MARKS,
  isMarked,
  marksEqual,
  parseSystemFilesMarks,
  serializeSystemFilesMarks,
  SYSTEM_FILES_HEREDOC_DELIMITER,
  withMark,
  withoutMark,
} from '@shared/system-files-marks';
import type { SystemFilesMarks } from '@shared/types';

const sample: SystemFilesMarks = {
  schemaVersion: 1,
  marked: [
    { coreId: 'C64', filename: 'DolphinDOS_2.0.rom', markedAt: '2026-05-02T12:00:00Z' },
    { coreId: 'Atari800', filename: 'pal.act', markedAt: '2026-05-02T12:01:00Z' },
  ],
};

describe('parseSystemFilesMarks', () => {
  it('returns the empty marks file for empty input', () => {
    expect(parseSystemFilesMarks('')).toEqual(EMPTY_SYSTEM_FILES_MARKS);
    expect(parseSystemFilesMarks('   \n\n  ')).toEqual(EMPTY_SYSTEM_FILES_MARKS);
  });

  it('returns the empty marks file for malformed JSON', () => {
    expect(parseSystemFilesMarks('not json')).toEqual(EMPTY_SYSTEM_FILES_MARKS);
    expect(parseSystemFilesMarks('{[}')).toEqual(EMPTY_SYSTEM_FILES_MARKS);
  });

  it('parses a well-formed marks file', () => {
    const json = JSON.stringify(sample);
    expect(parseSystemFilesMarks(json)).toEqual(sample);
  });

  it('throws on an unknown schemaVersion (forces a hard upgrade)', () => {
    const future = JSON.stringify({ schemaVersion: 99, marked: [] });
    expect(() => parseSystemFilesMarks(future)).toThrow(
      /unsupported schemaVersion/,
    );
  });

  it('returns empty marks for an object without the expected shape', () => {
    expect(parseSystemFilesMarks(JSON.stringify({ marked: [] }))).toEqual(
      EMPTY_SYSTEM_FILES_MARKS,
    );
    expect(parseSystemFilesMarks(JSON.stringify({}))).toEqual(
      EMPTY_SYSTEM_FILES_MARKS,
    );
  });
});

describe('serializeSystemFilesMarks', () => {
  it('round-trips a parsed marks file', () => {
    expect(parseSystemFilesMarks(serializeSystemFilesMarks(sample))).toEqual(
      sample,
    );
  });

  it('refuses to write a payload that contains the heredoc delimiter', () => {
    const hostile: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        {
          coreId: SYSTEM_FILES_HEREDOC_DELIMITER,
          filename: 'foo',
          markedAt: '2026-05-02T12:00:00Z',
        },
      ],
    };
    expect(() => serializeSystemFilesMarks(hostile)).toThrow(
      /heredoc delimiter/,
    );
  });
});

describe('isMarked', () => {
  it('returns true for an exact match', () => {
    expect(isMarked(sample, 'C64', 'DolphinDOS_2.0.rom')).toBe(true);
  });

  it('matches coreId case-insensitively', () => {
    expect(isMarked(sample, 'c64', 'DolphinDOS_2.0.rom')).toBe(true);
    expect(isMarked(sample, 'C64', 'DolphinDOS_2.0.rom')).toBe(true);
  });

  it('matches filename case-sensitively (filesystem semantics)', () => {
    expect(isMarked(sample, 'C64', 'dolphindos_2.0.rom')).toBe(false);
  });

  it('returns false for unknown entries', () => {
    expect(isMarked(sample, 'NES', 'super-mario.nes')).toBe(false);
    expect(isMarked(sample, 'C64', 'Empty.d64')).toBe(false);
  });

  it('returns false for the empty marks file', () => {
    expect(isMarked(EMPTY_SYSTEM_FILES_MARKS, 'C64', 'anything.rom')).toBe(false);
  });
});

describe('withMark', () => {
  it('appends a new mark', () => {
    const next = withMark(EMPTY_SYSTEM_FILES_MARKS, {
      coreId: 'NES',
      filename: 'header.txt',
      markedAt: '2026-05-02T13:00:00Z',
    });
    expect(next.marked).toHaveLength(1);
    expect(next.marked[0]?.filename).toBe('header.txt');
  });

  it('is idempotent — re-marking returns the same object', () => {
    const next = withMark(sample, {
      coreId: 'C64',
      filename: 'DolphinDOS_2.0.rom',
      markedAt: '2026-05-02T15:00:00Z',
    });
    expect(next).toBe(sample);
  });
});

describe('withoutMark', () => {
  it('removes an existing mark', () => {
    const next = withoutMark(sample, 'C64', 'DolphinDOS_2.0.rom');
    expect(next.marked).toHaveLength(1);
    expect(next.marked.map((m) => m.filename)).not.toContain(
      'DolphinDOS_2.0.rom',
    );
  });

  it('is idempotent — removing a non-existent mark returns the same object', () => {
    const next = withoutMark(sample, 'NES', 'foo.bar');
    expect(next).toBe(sample);
  });

  it('matches coreId case-insensitively when removing', () => {
    const next = withoutMark(sample, 'c64', 'DolphinDOS_2.0.rom');
    expect(next.marked).toHaveLength(1);
  });
});

describe('marksEqual', () => {
  it('returns true for the same reference', () => {
    expect(marksEqual(sample, sample)).toBe(true);
  });

  it('returns true for structurally equal marks', () => {
    expect(marksEqual(sample, JSON.parse(JSON.stringify(sample)))).toBe(true);
  });

  it('returns false when an entry differs', () => {
    const drift: SystemFilesMarks = {
      schemaVersion: 1,
      marked: [
        ...sample.marked.slice(0, 1),
        { ...sample.marked[1]!, markedAt: '2030-01-01T00:00:00Z' },
      ],
    };
    expect(marksEqual(sample, drift)).toBe(false);
  });

  it('returns false when lengths differ', () => {
    expect(marksEqual(sample, EMPTY_SYSTEM_FILES_MARKS)).toBe(false);
  });
});
