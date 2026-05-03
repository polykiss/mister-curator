import { describe, expect, it } from 'vitest';

import {
  EMPTY_FOLDER_CLASSIFICATIONS,
  FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER,
  folderClassificationsEqual,
  getFolderOverride,
  parseFolderClassifications,
  serializeFolderClassifications,
  withFolderOverride,
  withoutFolderOverride,
} from '@shared/folder-classifications';
import type { FolderClassifications } from '@shared/types';

const sample: FolderClassifications = {
  schemaVersion: 1,
  overrides: [
    {
      coreId: 'NEOGEO',
      folderPath: '1 World A-Z',
      classification: 'container',
      setAt: '2026-05-02T12:00:00Z',
    },
    {
      coreId: 'Saturn',
      folderPath: 'Hidden Disc Game',
      classification: 'atomic',
      setAt: '2026-05-02T12:01:00Z',
    },
  ],
};

describe('parseFolderClassifications', () => {
  it('returns the empty file for empty input', () => {
    expect(parseFolderClassifications('')).toEqual(EMPTY_FOLDER_CLASSIFICATIONS);
    expect(parseFolderClassifications('   ')).toEqual(
      EMPTY_FOLDER_CLASSIFICATIONS,
    );
  });

  it('returns empty for malformed JSON', () => {
    expect(parseFolderClassifications('garbage')).toEqual(
      EMPTY_FOLDER_CLASSIFICATIONS,
    );
  });

  it('round-trips a populated marks file', () => {
    const json = JSON.stringify(sample);
    expect(parseFolderClassifications(json)).toEqual(sample);
  });

  it('throws on an unknown schemaVersion', () => {
    expect(() =>
      parseFolderClassifications(
        JSON.stringify({ schemaVersion: 99, overrides: [] }),
      ),
    ).toThrow(/unsupported schemaVersion/);
  });

  it('rejects overrides with an unknown classification value', () => {
    const bad = JSON.stringify({
      schemaVersion: 1,
      overrides: [
        {
          coreId: 'X',
          folderPath: 'Y',
          classification: 'unknown',
          setAt: '2026-01-01',
        },
      ],
    });
    // Validator drops the whole shape — the unrecognised value isn't
    // a valid override.
    expect(parseFolderClassifications(bad)).toEqual(
      EMPTY_FOLDER_CLASSIFICATIONS,
    );
  });
});

describe('serializeFolderClassifications', () => {
  it('round-trips through parse', () => {
    expect(parseFolderClassifications(serializeFolderClassifications(sample))).toEqual(
      sample,
    );
  });

  it('refuses to write a payload that contains the heredoc delimiter', () => {
    const hostile: FolderClassifications = {
      schemaVersion: 1,
      overrides: [
        {
          coreId: FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER,
          folderPath: 'x',
          classification: 'atomic',
          setAt: '2026-01-01',
        },
      ],
    };
    expect(() => serializeFolderClassifications(hostile)).toThrow(
      /heredoc delimiter/,
    );
  });
});

describe('getFolderOverride', () => {
  it('returns the override for an exact match', () => {
    expect(getFolderOverride(sample, 'NEOGEO', '1 World A-Z')).toBe('container');
  });

  it('matches coreId case-insensitively', () => {
    expect(getFolderOverride(sample, 'neogeo', '1 World A-Z')).toBe(
      'container',
    );
  });

  it('matches folderPath case-sensitively (filesystem semantics)', () => {
    expect(getFolderOverride(sample, 'NEOGEO', '1 world a-z')).toBeUndefined();
  });

  it('returns undefined for a missing entry', () => {
    expect(getFolderOverride(sample, 'NES', 'anything')).toBeUndefined();
    expect(
      getFolderOverride(EMPTY_FOLDER_CLASSIFICATIONS, 'X', 'Y'),
    ).toBeUndefined();
  });
});

describe('withFolderOverride', () => {
  it('appends a new override', () => {
    const next = withFolderOverride(EMPTY_FOLDER_CLASSIFICATIONS, {
      coreId: 'NEOGEO',
      folderPath: '1 World A-Z',
      classification: 'container',
      setAt: '2026-05-02',
    });
    expect(next.overrides).toHaveLength(1);
  });

  it('replaces an existing override for the same (coreId, folderPath)', () => {
    const next = withFolderOverride(sample, {
      coreId: 'NEOGEO',
      folderPath: '1 World A-Z',
      classification: 'atomic',
      setAt: '2026-05-03',
    });
    expect(next.overrides).toHaveLength(2);
    const updated = next.overrides.find(
      (o) => o.coreId === 'NEOGEO' && o.folderPath === '1 World A-Z',
    );
    expect(updated?.classification).toBe('atomic');
    expect(updated?.setAt).toBe('2026-05-03');
  });
});

describe('withoutFolderOverride', () => {
  it('removes an existing override', () => {
    const next = withoutFolderOverride(sample, 'NEOGEO', '1 World A-Z');
    expect(next.overrides).toHaveLength(1);
    expect(
      next.overrides.find((o) => o.coreId === 'NEOGEO'),
    ).toBeUndefined();
  });

  it('is idempotent — removing a missing override returns the same object', () => {
    const next = withoutFolderOverride(sample, 'NES', 'foo');
    expect(next).toBe(sample);
  });

  it('matches coreId case-insensitively when removing', () => {
    const next = withoutFolderOverride(sample, 'neogeo', '1 World A-Z');
    expect(next.overrides).toHaveLength(1);
  });
});

describe('folderClassificationsEqual', () => {
  it('returns true for the same reference', () => {
    expect(folderClassificationsEqual(sample, sample)).toBe(true);
  });

  it('returns true for structurally equal marks', () => {
    expect(
      folderClassificationsEqual(sample, JSON.parse(JSON.stringify(sample))),
    ).toBe(true);
  });

  it('returns false when an entry differs', () => {
    const drift: FolderClassifications = {
      schemaVersion: 1,
      overrides: [
        ...sample.overrides.slice(0, 1),
        { ...sample.overrides[1]!, setAt: '2099-01-01' },
      ],
    };
    expect(folderClassificationsEqual(sample, drift)).toBe(false);
  });
});
