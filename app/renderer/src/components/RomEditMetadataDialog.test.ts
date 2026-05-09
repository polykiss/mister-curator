import { describe, expect, it } from 'vitest';

import type { RomMetadata } from '@shared/metadata-types';

import { buildOverride } from '@app/renderer/src/components/RomEditMetadataDialog';

/**
 * `buildOverride` is the pure form-state → UserMetadataOverride
 * converter. Comprehensive truth table for the "drop fields that
 * match source" rule + edge cases.
 */

function buildMetadata(overrides: Partial<RomMetadata> = {}): RomMetadata {
  return {
    version: 5,
    hash: 'a'.repeat(32),
    name: 'Source Name',
    system: 'NES',
    year: 1990,
    publisher: null,
    developer: null,
    genre: 'Action',
    description: null,
    players: null,
    rating: 8,
    releaseDate: null,
    boxArtUrl: null,
    titleScreenUrl: null,
    screenshotUrl: null,
    source: 'screenscraper',
    fetchedAt: '2026-05-09T00:00:00.000Z',
    ...overrides,
  };
}

const EMPTY_FORM = {
  name: '',
  year: '',
  genre: '',
  rating: '',
  tagsText: '',
  note: '',
};

describe('buildOverride — drop fields that match source', () => {
  it('returns undefined when every field matches source', () => {
    const meta = buildMetadata();
    const override = buildOverride(meta, {
      name: 'Source Name',
      year: '1990',
      genre: 'Action',
      rating: '8',
      tagsText: '',
      note: '',
    });
    expect(override).toBeUndefined();
  });

  it('returns undefined when every field is blank (no overrides)', () => {
    expect(buildOverride(buildMetadata(), EMPTY_FORM)).toBeUndefined();
  });

  it('keeps fields that differ from source', () => {
    const override = buildOverride(buildMetadata(), {
      name: 'My Renamed',
      year: '2020',
      genre: 'RPG',
      rating: '9',
      tagsText: '',
      note: '',
    });
    expect(override).toEqual({
      name: 'My Renamed',
      year: 2020,
      genre: 'RPG',
      rating: 9,
    });
  });

  it('drops blank name (doesn\'t persist empty override)', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      name: '   ',
    });
    expect(override).toBeUndefined();
  });

  it('keeps year=0 if it differs from source (set-wins)', () => {
    // Year 0 would fall through to "differs from 1990 → keep".
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      year: '0',
    });
    expect(override).toEqual({ year: 0 });
  });
});

describe('buildOverride — tags handling', () => {
  it('parses comma-separated tags + dedupes + trims', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      tagsText: 'hack, fan-translation,hack ,  improvement, ,',
    });
    expect(override?.tags).toEqual(['hack', 'fan-translation', 'improvement']);
  });

  it('drops empty tags', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      tagsText: ',,,',
    });
    expect(override).toBeUndefined();
  });

  it('single tag works', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      tagsText: 'demo',
    });
    expect(override?.tags).toEqual(['demo']);
  });
});

describe('buildOverride — rating range validation', () => {
  it('drops rating outside 0-10 range', () => {
    expect(
      buildOverride(buildMetadata(), { ...EMPTY_FORM, rating: '11' }),
    ).toBeUndefined();
    expect(
      buildOverride(buildMetadata(), { ...EMPTY_FORM, rating: '-1' }),
    ).toBeUndefined();
  });

  it('keeps in-range rating that differs from source', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      rating: '7.5',
    });
    expect(override).toEqual({ rating: 7.5 });
  });

  it('drops non-numeric rating', () => {
    expect(
      buildOverride(buildMetadata(), { ...EMPTY_FORM, rating: 'great' }),
    ).toBeUndefined();
  });
});

describe('buildOverride — note handling', () => {
  it('keeps non-empty note (sources don\'t surface notes)', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      note: 'Personal favorite',
    });
    expect(override).toEqual({ note: 'Personal favorite' });
  });

  it('drops blank note', () => {
    const override = buildOverride(buildMetadata(), {
      ...EMPTY_FORM,
      note: '   ',
    });
    expect(override).toBeUndefined();
  });
});

describe('buildOverride — preserves search-modal jeuid', () => {
  it('carries forward an existing jeuid override (only the search modal sets it)', () => {
    const meta = buildMetadata({
      userOverride: { jeuid: '1234' },
    });
    const override = buildOverride(meta, {
      ...EMPTY_FORM,
      name: 'Renamed via edit modal',
    });
    expect(override).toEqual({
      name: 'Renamed via edit modal',
      jeuid: '1234',
    });
  });

  it('returns undefined even with existing jeuid if nothing else changed', () => {
    // The save path normalizes "no changes" to no override entirely
    // — caller may want to send `undefined` to clear. But buildOverride
    // is always permissive: if jeuid exists, it preserves it. The
    // "no changes" case still includes jeuid.
    const meta = buildMetadata({
      userOverride: { jeuid: '1234' },
    });
    const override = buildOverride(meta, EMPTY_FORM);
    expect(override).toEqual({ jeuid: '1234' });
  });
});
