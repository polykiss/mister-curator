import { describe, expect, it } from 'vitest';

import { filenameToSearchTerm } from '@app/renderer/src/components/RomSearchScreenScraperDialog';

/**
 * `filenameToSearchTerm` is the search-input prefill helper. Mirrors
 * the shape `filename-hint.ts`'s stem extractor produces, but inlined
 * in the renderer to avoid a main-process import.
 */

describe('filenameToSearchTerm', () => {
  it('strips the extension', () => {
    expect(filenameToSearchTerm('Castlevania.nes')).toBe('Castlevania');
  });

  it('strips parens content', () => {
    expect(filenameToSearchTerm('Castlevania (USA).nes')).toBe('Castlevania');
  });

  it('strips brackets content', () => {
    expect(filenameToSearchTerm('Castlevania [Beta].nes')).toBe('Castlevania');
  });

  it('strips multiple parens + brackets', () => {
    expect(
      filenameToSearchTerm('Castlevania (USA) (Rev 1) [Beta].nes'),
    ).toBe('Castlevania');
  });

  it('preserves internal punctuation (colons, hyphens)', () => {
    expect(
      filenameToSearchTerm('Star Wars: Rogue Squadron - Battle.n64'),
    ).toBe('Star Wars: Rogue Squadron - Battle');
  });

  it('collapses whitespace runs to a single space', () => {
    expect(filenameToSearchTerm('Game    With    Spaces  .nes')).toBe(
      'Game With Spaces',
    );
  });

  it('handles extensionless filenames', () => {
    expect(filenameToSearchTerm('README')).toBe('README');
  });

  it('handles filenames with parens-only stem (returns empty)', () => {
    expect(filenameToSearchTerm('(USA).nes')).toBe('');
  });

  it('preserves non-ASCII characters', () => {
    expect(filenameToSearchTerm('ポケットモンスター 赤.gb')).toBe(
      'ポケットモンスター 赤',
    );
  });

  it('handles MAME-style romset filenames (paren-shortname stripped)', () => {
    expect(
      filenameToSearchTerm('Metal Slug 2 (mslug2).neo'),
    ).toBe('Metal Slug 2');
  });
});
