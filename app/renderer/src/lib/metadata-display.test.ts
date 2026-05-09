import { describe, expect, it } from 'vitest';

import type { RomMetadata } from '@shared/metadata-types';

import {
  displayGenre,
  displayName,
  displayNote,
  displayRating,
  displayTags,
  displayYear,
} from '@app/renderer/src/lib/metadata-display';

/**
 * Display-merge helpers — every consumer that renders a ROM row
 * MUST go through these (NOT raw metadata.name etc.) so userOverride
 * layers correctly. Comprehensive truth tables: source-only, override-
 * only, both-set, neither-set.
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

describe('displayName', () => {
  it('returns metadata.name when no override is set', () => {
    expect(displayName(buildMetadata())).toBe('Source Name');
  });

  it('returns userOverride.name when set', () => {
    expect(
      displayName(
        buildMetadata({ userOverride: { name: 'User Override Name' } }),
      ),
    ).toBe('User Override Name');
  });

  it('user-set EMPTY string still wins over source name (set-wins rule)', () => {
    // The override may be intentionally empty — perhaps the user
    // wants to clear the name. Reset (clears userOverride entirely)
    // is the way to revert.
    expect(
      displayName(buildMetadata({ userOverride: { name: '' } })),
    ).toBe('');
  });

  it('returns sentinel "(no match)" for source=none records (no override)', () => {
    expect(
      displayName(
        buildMetadata({
          source: 'none',
          name: '(no match)',
        }),
      ),
    ).toBe('(no match)');
  });
});

describe('displayYear', () => {
  it('returns metadata.year when no override is set', () => {
    expect(displayYear(buildMetadata())).toBe(1990);
  });

  it('returns userOverride.year when set', () => {
    expect(
      displayYear(buildMetadata({ userOverride: { year: 2001 } })),
    ).toBe(2001);
  });

  it('user-set 0 still wins over source year (set-wins)', () => {
    expect(
      displayYear(buildMetadata({ userOverride: { year: 0 } })),
    ).toBe(0);
  });

  it('returns null when source year is null and no override', () => {
    expect(displayYear(buildMetadata({ year: null }))).toBeNull();
  });

  it('override null is impossible — type prevents it', () => {
    // userOverride.year is `number | undefined`, not `number | null`.
    // Undefined → fall back. To "clear" a year override, the user
    // resets the entire userOverride block.
    expect(
      displayYear(buildMetadata({ year: 1990, userOverride: {} })),
    ).toBe(1990);
  });
});

describe('displayGenre', () => {
  it('returns metadata.genre when no override is set', () => {
    expect(displayGenre(buildMetadata())).toBe('Action');
  });

  it('returns userOverride.genre when set', () => {
    expect(
      displayGenre(
        buildMetadata({ userOverride: { genre: 'RPG' } }),
      ),
    ).toBe('RPG');
  });

  it('returns null when source genre is null and no override', () => {
    expect(displayGenre(buildMetadata({ genre: null }))).toBeNull();
  });

  it('preserves multi-genre strings verbatim (caller picks primary)', () => {
    expect(
      displayGenre(buildMetadata({ genre: 'Action, Adventure' })),
    ).toBe('Action, Adventure');
  });
});

describe('displayRating', () => {
  it('returns metadata.rating when no override is set', () => {
    expect(displayRating(buildMetadata())).toBe(8);
  });

  it('returns userOverride.rating when set', () => {
    expect(
      displayRating(buildMetadata({ userOverride: { rating: 9.5 } })),
    ).toBe(9.5);
  });

  it('returns null when source rating is null and no override', () => {
    expect(displayRating(buildMetadata({ rating: null }))).toBeNull();
  });
});

describe('displayTags', () => {
  it('returns empty array when no override (sources do not surface tags)', () => {
    expect(displayTags(buildMetadata())).toEqual([]);
  });

  it('returns userOverride.tags when set', () => {
    expect(
      displayTags(
        buildMetadata({
          userOverride: { tags: ['hack', 'fan-translation'] },
        }),
      ),
    ).toEqual(['hack', 'fan-translation']);
  });

  it('preserves order (writer is responsible for canonical ordering)', () => {
    expect(
      displayTags(
        buildMetadata({
          userOverride: { tags: ['z-tag', 'a-tag', 'm-tag'] },
        }),
      ),
    ).toEqual(['z-tag', 'a-tag', 'm-tag']);
  });

  it('returns empty array (not undefined) for missing override block', () => {
    // Callers can treat the return as "no pills to render" without
    // a null check.
    const result = displayTags(buildMetadata({ userOverride: {} }));
    expect(result).toEqual([]);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('displayNote', () => {
  it('returns null when no override (sources do not surface notes)', () => {
    expect(displayNote(buildMetadata())).toBeNull();
  });

  it('returns userOverride.note when set', () => {
    expect(
      displayNote(
        buildMetadata({
          userOverride: { note: 'Personal favorite' },
        }),
      ),
    ).toBe('Personal favorite');
  });

  it('user-set EMPTY note still wins over null source (set-wins)', () => {
    expect(
      displayNote(buildMetadata({ userOverride: { note: '' } })),
    ).toBe('');
  });
});

describe('display helpers — independent overrides (no cross-field coupling)', () => {
  it('overriding name doesn\'t affect year/genre/rating/etc.', () => {
    const m = buildMetadata({
      userOverride: { name: 'NEW NAME' },
    });
    expect(displayName(m)).toBe('NEW NAME');
    expect(displayYear(m)).toBe(1990); // source year intact
    expect(displayGenre(m)).toBe('Action'); // source genre intact
    expect(displayRating(m)).toBe(8); // source rating intact
    expect(displayTags(m)).toEqual([]); // no tags set
    expect(displayNote(m)).toBeNull(); // no note set
  });

  it('overriding tags + note doesn\'t touch SS-resolved fields', () => {
    const m = buildMetadata({
      userOverride: {
        tags: ['hack'],
        note: 'Test',
      },
    });
    expect(displayName(m)).toBe('Source Name');
    expect(displayYear(m)).toBe(1990);
    expect(displayTags(m)).toEqual(['hack']);
    expect(displayNote(m)).toBe('Test');
  });
});

describe('display helpers — v4 records still parse + render (back-compat)', () => {
  it('v4 record with no userOverride field renders source-only', () => {
    // Pre-PR-D2 records had no userOverride. After the validator
    // accepts them, the display helpers fall back to source values
    // for every field.
    const v4: RomMetadata = {
      version: 4,
      hash: 'a'.repeat(32),
      name: 'Legacy Name',
      system: 'NES',
      year: 1985,
      publisher: null,
      developer: null,
      genre: 'Platform',
      description: null,
      players: null,
      rating: 7,
      releaseDate: null,
      boxArtUrl: null,
      titleScreenUrl: null,
      screenshotUrl: null,
      source: 'screenscraper',
      fetchedAt: '2026-01-01T00:00:00.000Z',
      // No userOverride field at all (v4 didn't have one).
    };
    expect(displayName(v4)).toBe('Legacy Name');
    expect(displayYear(v4)).toBe(1985);
    expect(displayGenre(v4)).toBe('Platform');
    expect(displayRating(v4)).toBe(7);
    expect(displayTags(v4)).toEqual([]);
    expect(displayNote(v4)).toBeNull();
  });
});
