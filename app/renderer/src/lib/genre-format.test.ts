import { describe, expect, it } from 'vitest';

import { abbreviateGenre } from '@app/renderer/src/lib/genre-format';

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
