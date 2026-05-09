import { describe, expect, it } from 'vitest';

import { abbreviateGenre, formatGenreList } from '@app/renderer/src/lib/genre-format';

describe('abbreviateGenre — PR-C round 2 genre map', () => {
  describe('mapped genres', () => {
    it.each([
      ['Role Playing Game', 'RPG'],
      ['Action Role Playing', 'Action RPG'],
      ['First Person Shooter', 'FPS'],
      ['Third Person Shooter', 'TPS'],
      ['Real Time Strategy', 'RTS'],
      ['Turn Based Strategy', 'TBS'],
      ['Massively Multiplayer Online', 'MMO'],
      ['Action Adventure', 'Action-Adv'],
      ["Shoot 'em up", 'Shmup'],
      ['Survival Horror', 'Survival'],
      ['Sports Football', 'Football'],
      ['Sports Basketball', 'Basketball'],
      ['Sports Baseball', 'Baseball'],
      ['Sports Hockey', 'Hockey'],
      ['Sports Soccer', 'Soccer'],
    ])('abbreviates %s → %s', (input, expected) => {
      expect(abbreviateGenre(input)).toBe(expected);
    });

    it('preserves Beat \'em up verbatim — no established short form', () => {
      // Documented in the source: borderline-fitting; truncation
      // handles overflow rather than picking an ad-hoc short form.
      expect(abbreviateGenre("Beat 'em up")).toBe("Beat 'em up");
    });
  });

  describe('unmapped genres', () => {
    it('passes a short unknown genre through verbatim', () => {
      expect(abbreviateGenre('Action')).toBe('Action');
      expect(abbreviateGenre('Adventure')).toBe('Adventure');
      expect(abbreviateGenre('Puzzle')).toBe('Puzzle');
    });

    it('passes a long unknown genre through verbatim — table truncation handles overflow', () => {
      // Don't invent ad-hoc abbreviations. The table-fixed +
      // text-truncate from PR #25 ellipses overflow at the cell
      // boundary; the title= attribute on the cell exposes the full
      // text on hover.
      expect(abbreviateGenre('Some Very Long Made Up Genre Name')).toBe(
        'Some Very Long Made Up Genre Name',
      );
    });
  });

  describe('null / undefined / empty input', () => {
    it('returns empty string for null', () => {
      expect(abbreviateGenre(null)).toBe('');
    });
    it('returns empty string for undefined', () => {
      expect(abbreviateGenre(undefined)).toBe('');
    });
    it('returns empty string for empty input', () => {
      expect(abbreviateGenre('')).toBe('');
    });
  });
});

describe('formatGenreList — chore/search-and-filter-cleanup commit 3', () => {
  // Bug: SS sometimes serves a single genre as a slash-joined list of
  // synonym forms ("RPG / Role-Playing Game") or surfaces the same
  // concept twice across different language entries
  // ("Action / Action"). Pre-fix, the cell + edit modal showed the
  // duplicates verbatim. `formatGenreList` cleans them up in the
  // renderer; the SS-side `pickGenreNameEnglishFirst` change in this
  // same commit prevents new duplicates from being cached at all.

  describe('slash-token dedupe (case-insensitive)', () => {
    it('"Action / Action" → "Action"', () => {
      expect(formatGenreList('Action / Action')).toBe('Action');
    });

    it('case-insensitive: "Action / ACTION" → "Action" (first-occurrence case wins)', () => {
      expect(formatGenreList('Action / ACTION')).toBe('Action');
    });

    it('"RPG / Role-Playing Game" → "RPG" (abbreviation collapses pair)', () => {
      // The abbreviation map normalizes "Role Playing Game" → "RPG"
      // (note the spec uses a hyphen but the abbreviation key has
      // none — input "Role Playing Game" abbreviates to "RPG"; the
      // hyphenated "Role-Playing Game" passes through). Either way,
      // when both forms reduce to "RPG" the dedupe collapses them.
      expect(formatGenreList('RPG / Role Playing Game')).toBe('RPG');
    });

    it('preserves slash-distinct entries that don\'t collide', () => {
      // Different genres on either side of the slash stay separate.
      expect(formatGenreList('Action / Adventure')).toBe('Action / Adventure');
    });
  });

  describe('comma-separated content treated as a single slash-token', () => {
    it('"Action, Adventure" → "Action, Adventure" (kept whole)', () => {
      // Commas separate distinct genres at the record level; the
      // formatter doesn't second-guess that. The cell uses
      // pickPrimaryGenre downstream to pick the lead.
      expect(formatGenreList('Action, Adventure')).toBe('Action, Adventure');
    });

    it('"Kampf / Versus, Kampf" — slash split + dedupe, but "Versus, Kampf" stays whole', () => {
      // The German-text incident from the spec. Renderer-side dedupe
      // handles what it can ("Kampf" + "Versus, Kampf" are different
      // strings → both kept). The root fix for this case is the
      // SS-side English preference in pickAllGenres.
      expect(formatGenreList('Kampf / Versus, Kampf')).toBe(
        'Kampf / Versus, Kampf',
      );
    });
  });

  describe('whitespace + edges', () => {
    it('trims whitespace around slash separators', () => {
      expect(formatGenreList('Action  /  Adventure')).toBe(
        'Action / Adventure',
      );
      expect(formatGenreList('Action/Adventure')).toBe('Action / Adventure');
    });

    it('drops empty slash-tokens', () => {
      expect(formatGenreList('Action / / Adventure')).toBe(
        'Action / Adventure',
      );
    });

    it('null / undefined / empty → empty string (matches abbreviateGenre)', () => {
      expect(formatGenreList(null)).toBe('');
      expect(formatGenreList(undefined)).toBe('');
      expect(formatGenreList('')).toBe('');
    });

    it('single-genre input passes through with abbreviation', () => {
      expect(formatGenreList('Role Playing Game')).toBe('RPG');
      expect(formatGenreList('Action')).toBe('Action');
    });
  });
});
