import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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

  // chore/search-and-filter-cleanup commit 1
  describe('strip leading "." or "._" (hide convention + AppleDouble)', () => {
    it('strips a single leading dot (MiSTer hide convention)', () => {
      // Bug: hidden ROM ".Aero Fighters 3 (sonicwi3).neo" prefilled as
      // ".Aero Fighters 3" — the dot is the hide marker, never part
      // of the game name. SS search returned nothing.
      expect(
        filenameToSearchTerm('.Aero Fighters 3 (sonicwi3).neo'),
      ).toBe('Aero Fighters 3');
    });

    it('strips leading "._" (macOS AppleDouble resource fork)', () => {
      // AppleDouble shouldn't reach the listing post-commit-4, but
      // strip it here as defense-in-depth in case one slips through.
      expect(filenameToSearchTerm('._foo (bar).zip')).toBe('foo');
    });

    it('strips dot then continues with paren strip in the same pass', () => {
      expect(filenameToSearchTerm('.foo (bar).zip')).toBe('foo');
    });

    it('strips at most one leading dot (no greedy strip)', () => {
      // Pin the rule: SINGLE leading "." is removed, not all leading
      // dots. The second dot stays — it's part of the (deliberately
      // unusual) filename and may be load-bearing for the user.
      // "..foo.zip" → after strip: ".foo.zip" → after extension strip:
      // ".foo" → no further dot strip happens since the regex only
      // applies once at the start.
      expect(filenameToSearchTerm('..foo.zip')).toBe('.foo');
    });

    it('regular filenames are unchanged', () => {
      expect(
        filenameToSearchTerm('Aero Fighters 3 (sonicwi3).neo'),
      ).toBe('Aero Fighters 3');
    });
  });

  // chore/search-and-filter-cleanup commit 2
  describe('rotate trailing ", The"/"A"/"An" to leading article', () => {
    // Bug: No-Intro / TOSEC names put the article after a comma —
    // "Legend of Zelda, The". SS indexes by the natural "The Legend
    // of Zelda" form so the comma shape returned zero matches.
    it('"Legend of Zelda, The" → "The Legend of Zelda"', () => {
      expect(filenameToSearchTerm('Legend of Zelda, The (USA).sfc')).toBe(
        'The Legend of Zelda',
      );
    });

    it('preserves apostrophes and digits in the body', () => {
      expect(
        filenameToSearchTerm("King of Fighters '99, The (Japan).neo"),
      ).toBe("The King of Fighters '99");
    });

    it('reorders ", A"', () => {
      expect(filenameToSearchTerm('Game, A.zip')).toBe('A Game');
    });

    it('reorders ", An"', () => {
      expect(filenameToSearchTerm('Octopus, An.zip')).toBe('An Octopus');
    });

    it('article match is case-insensitive (input case preserved)', () => {
      expect(filenameToSearchTerm('Game, THE.zip')).toBe('THE Game');
      expect(filenameToSearchTerm('Game, the.zip')).toBe('the Game');
    });

    it('no reorder when no trailing article', () => {
      expect(filenameToSearchTerm('Final Fantasy.sfc')).toBe('Final Fantasy');
    });

    it('mid-string "The" is NOT mistaken for a trailing article', () => {
      // "Adams, The Family" has a comma mid-string but the body
      // continues after — "The" is mid-string, not end-of-string.
      // Pin that the regex anchors to end-of-string only.
      expect(filenameToSearchTerm('Adams, The Family.zip')).toBe(
        'Adams, The Family',
      );
    });

    it('multiple commas: only the trailing one matters', () => {
      // Real example shape: "Doom II, Hell on Earth, The". The
      // trailing ", The" is the article comma; the earlier comma
      // is part of the title and stays put.
      expect(
        filenameToSearchTerm('Doom II, Hell on Earth, The.zip'),
      ).toBe('The Doom II, Hell on Earth');
    });

    it('runs AFTER paren strip — article right before parens still rotates', () => {
      // Pin the pipeline order: paren strip happens first so the
      // trailing-article matcher sees the bare title. If paren
      // strip ran AFTER, "Legend of Zelda, The (USA)" would never
      // match the trailing-article regex.
      expect(
        filenameToSearchTerm('Legend of Zelda, The (USA) (Rev 1).sfc'),
      ).toBe('The Legend of Zelda');
    });

    it('does not match a trailing article without a comma', () => {
      // "The" needs a leading ", " separator. Bare "Legend of
      // Zelda The" stays as-is.
      expect(filenameToSearchTerm('Legend of Zelda The.sfc')).toBe(
        'Legend of Zelda The',
      );
    });
  });
});

describe('SearchResultItem — every result is selectable (PR-D2 r2 c3)', () => {
  // User report: "can't select Art of Fighting 3 even though it appears
  // in results." The user's hypothesis was that selection logic disables
  // results already bound elsewhere — that's wrong, manual override
  // exists precisely to override the auto-binder's pick. Pin the
  // contract that the ONLY disable condition is the in-flight bind for
  // THIS exact result. No cache-state check, no jeuid uniqueness
  // check, no "already matches current row" check.
  //
  // Source-string scan rather than a render test — the result button
  // sits inside a component-local SearchResultItem that isn't exported,
  // and a render test would need jsdom + Radix + img mock. The string
  // contract is small enough to assert directly.
  const SOURCE = readFileSync(
    resolve(__dirname, 'RomSearchScreenScraperDialog.tsx'),
    'utf8',
  );

  it('the result button has exactly one disable condition: `binding`', () => {
    // The "Use this match" button MUST disable on exactly `binding`
    // — nothing else. Regression case: someone adds an eligibility
    // check like `disabled={binding || isAlreadyBound}` smuggling the
    // jeuid-uniqueness gate back in. Pin the bare expression.
    expect(SOURCE).toContain('disabled={binding}');
    // Surface area-wide — no other `disabled=` on the result button
    // that ORs in a second condition. Match every disabled={...} and
    // confirm none chain on a search-result-related identifier.
    const allDisabled = SOURCE.match(/disabled=\{[^}]*\}/g) ?? [];
    for (const d of allDisabled) {
      // Only the search-form Search button is allowed to OR conditions
      // (it gates on `searching || searchTerm.trim() === ''`). The
      // result-row button has the bare `{binding}` expression — no
      // `||`/`&&` involving cache state.
      if (d.includes('binding')) {
        expect(d).toBe('disabled={binding}');
      }
    }
  });

  it('handleUseMatch passes the picked game straight through with no eligibility check', () => {
    // The handler MUST call bindRomMetadataFromSearch unconditionally
    // for the picked game. Pin that no early-return guards on cache
    // state or jeuid uniqueness sneak in.
    const handlerMatch = SOURCE.match(
      /async function handleUseMatch\([^)]*\)[^{]*\{[\s\S]*?\n {2}\}/,
    );
    expect(handlerMatch).not.toBeNull();
    const body = handlerMatch![0];
    // The bind IPC is called immediately after setBindingId — no early
    // returns or eligibility checks between them. Pinning by
    // adjacent-line proximity rather than substring scanning to make
    // the regression case ("added a check before the IPC call")
    // obvious.
    const setBindingIdx = body.indexOf('setBindingId(game.id)');
    const bindCallIdx = body.indexOf('window.mister.bindRomMetadataFromSearch');
    expect(setBindingIdx).toBeGreaterThan(-1);
    expect(bindCallIdx).toBeGreaterThan(setBindingIdx);
    // The slice between them must contain only `try {` boilerplate —
    // no `if`/`return`/`throw` statements gating the bind.
    const between = body.slice(setBindingIdx, bindCallIdx);
    expect(between).not.toMatch(/\bif\b/);
    expect(between).not.toMatch(/\breturn\b/);
  });
});
