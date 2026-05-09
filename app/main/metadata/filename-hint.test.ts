import { describe, expect, it } from 'vitest';

import {
  extractNameHints,
  type NameHint,
} from '@app/main/metadata/filename-hint';

/**
 * Filename-hint extraction. Three sources in priority order:
 *   1. parentFolder (atomic-folder shape)
 *   2. paren-shortname (arcade / MAME-style romset id)
 *   3. filename-stem (cartridge-format with parens/brackets stripped)
 *
 * Each test verifies which sources fire and in what order.
 */

function findSource(
  hints: readonly NameHint[],
  source: NameHint['source'],
): NameHint | undefined {
  return hints.find((h) => h.source === source);
}

describe('extractNameHints — parentFolder (round 2: atomic-only gate)', () => {
  it('uses the parent folder name verbatim when atomic + given (atomic-folder shape)', () => {
    const hints = extractNameHints({
      filename: 'mslug2.neo',
      parentFolder: 'Metal Slug 2 (USA)',
      parentFolderIsAtomic: true,
    });
    expect(findSource(hints, 'folder')?.value).toBe('Metal Slug 2');
  });

  it('strips parens AND brackets from the parent folder', () => {
    const hints = extractNameHints({
      filename: 'game.zip',
      parentFolder: 'Castlevania - Symphony of the Night [Beta] (USA)',
      parentFolderIsAtomic: true,
    });
    expect(findSource(hints, 'folder')?.value).toBe(
      'Castlevania - Symphony of the Night',
    );
  });

  it('round 2: skips the folder hint when parentFolderIsAtomic=false (organizational folder)', () => {
    // Bug from round 1: organizational folders like NEOGEO's
    // `1 World A-Z` and NES's `Hacks` were emitting folder hints,
    // wasting one API call per ROM returning no candidates.
    const hints = extractNameHints({
      filename: 'mslug.zip',
      parentFolder: '1 World A-Z',
      parentFolderIsAtomic: false,
    });
    expect(findSource(hints, 'folder')).toBeUndefined();
  });

  it('round 2: defaults to atomic=false when omitted (conservative — no API budget waste)', () => {
    const hints = extractNameHints({
      filename: 'mslug.zip',
      parentFolder: 'Some Folder',
    });
    expect(findSource(hints, 'folder')).toBeUndefined();
  });

  it('skips the folder hint when parentFolder is undefined', () => {
    const hints = extractNameHints({ filename: 'game.nes' });
    expect(findSource(hints, 'folder')).toBeUndefined();
  });

  it('skips the folder hint when parentFolder is empty / whitespace (even when atomic)', () => {
    expect(
      findSource(
        extractNameHints({
          filename: 'g.nes',
          parentFolder: '',
          parentFolderIsAtomic: true,
        }),
        'folder',
      ),
    ).toBeUndefined();
    expect(
      findSource(
        extractNameHints({
          filename: 'g.nes',
          parentFolder: '   ',
          parentFolderIsAtomic: true,
        }),
        'folder',
      ),
    ).toBeUndefined();
  });

  it('returns the folder hint FIRST in the priority list when atomic', () => {
    const hints = extractNameHints({
      filename: 'Metal Slug 2 (USA).nes',
      parentFolder: 'Metal Slug 2',
      parentFolderIsAtomic: true,
    });
    expect(hints[0]?.source).toBe('folder');
  });
});

describe('extractNameHints — paren-shortname', () => {
  it('captures lowercase short-id in parens at the end (NEOGEO MAME-style)', () => {
    const hints = extractNameHints({ filename: 'Metal Slug 2 (mslug2).neo' });
    expect(findSource(hints, 'paren-shortname')?.value).toBe('mslug2');
  });

  it('captures alphanumeric short-ids', () => {
    expect(
      findSource(
        extractNameHints({ filename: 'King of Fighters 97 (kof97).zip' }),
        'paren-shortname',
      )?.value,
    ).toBe('kof97');
    expect(
      findSource(
        extractNameHints({ filename: 'Samurai Shodown 4 (samsho4).zip' }),
        'paren-shortname',
      )?.value,
    ).toBe('samsho4');
  });

  it('captures underscores in short-ids', () => {
    expect(
      findSource(
        extractNameHints({ filename: 'Some Game (foo_bar).zip' }),
        'paren-shortname',
      )?.value,
    ).toBe('foo_bar');
  });

  it('does NOT match region tags with uppercase or spaces', () => {
    // `(USA)` has uppercase letters → not lowercase short-id → no match.
    expect(
      findSource(
        extractNameHints({ filename: 'Castlevania (USA).nes' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
    // `(Rev 1)` has uppercase + space → no match.
    expect(
      findSource(
        extractNameHints({ filename: 'Castlevania (Rev 1).nes' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
    // `(Europe)` — capitalized → no match.
    expect(
      findSource(
        extractNameHints({ filename: 'Castlevania (Europe).nes' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
  });

  it('only matches the FINAL parens before the extension', () => {
    // Has multiple parens. The trailing `(mslug2)` matches; the
    // leading `(World)` doesn't.
    const hints = extractNameHints({
      filename: 'Metal Slug 2 (World) (mslug2).neo',
    });
    expect(findSource(hints, 'paren-shortname')?.value).toBe('mslug2');
  });

  it('skips the paren-shortname hint when no parens are present', () => {
    expect(
      findSource(
        extractNameHints({ filename: 'CleanName.nes' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
  });

  it('requires the parens to immediately precede the extension', () => {
    // `(mslug2)` not at the end → doesn't match the anchor.
    expect(
      findSource(
        extractNameHints({ filename: '(mslug2) trailing text.zip' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
  });

  it('does NOT match parens with no extension after', () => {
    expect(
      findSource(
        extractNameHints({ filename: 'Game (mslug2)' }),
        'paren-shortname',
      ),
    ).toBeUndefined();
  });
});

describe('extractNameHints — filename-stem', () => {
  it('strips the extension', () => {
    const hints = extractNameHints({ filename: 'Castlevania.nes' });
    expect(findSource(hints, 'filename-stem')?.value).toBe('Castlevania');
  });

  it('strips paren content and brackets, normalizes whitespace', () => {
    const hints = extractNameHints({
      filename: 'Castlevania - Symphony of the Night (USA) [Beta].iso',
    });
    expect(findSource(hints, 'filename-stem')?.value).toBe(
      'Castlevania - Symphony of the Night',
    );
  });

  it('handles multiple paren groups', () => {
    const hints = extractNameHints({
      filename: 'Game (USA) (Rev 1) (Beta).nes',
    });
    expect(findSource(hints, 'filename-stem')?.value).toBe('Game');
  });

  it('passes through verbatim when no parens/brackets', () => {
    const hints = extractNameHints({ filename: 'Sonic the Hedgehog.md' });
    expect(findSource(hints, 'filename-stem')?.value).toBe(
      'Sonic the Hedgehog',
    );
  });

  it('preserves internal punctuation (commas, hyphens, colons)', () => {
    const hints = extractNameHints({
      filename: "Star Wars: Rogue Squadron - The Game.n64",
    });
    expect(findSource(hints, 'filename-stem')?.value).toBe(
      'Star Wars: Rogue Squadron - The Game',
    );
  });

  it('handles extension-less filenames', () => {
    const hints = extractNameHints({ filename: 'README' });
    expect(findSource(hints, 'filename-stem')?.value).toBe('README');
  });

  it('collapses internal whitespace runs to a single space', () => {
    const hints = extractNameHints({
      filename: 'Game    With    Spaces  .nes',
    });
    expect(findSource(hints, 'filename-stem')?.value).toBe(
      'Game With Spaces',
    );
  });

  it('does NOT include the stem hint when the result is empty', () => {
    // Filename is JUST parens content + extension → stem is empty
    // after stripping.
    const hints = extractNameHints({ filename: '(USA).nes' });
    expect(findSource(hints, 'filename-stem')).toBeUndefined();
  });

  it('preserves non-ASCII characters', () => {
    const hints = extractNameHints({ filename: 'ポケットモンスター 赤.gb' });
    expect(findSource(hints, 'filename-stem')?.value).toBe(
      'ポケットモンスター 赤',
    );
  });
});

describe('extractNameHints — priority + ordering', () => {
  it('returns hints in priority order: folder > paren-shortname > stem (when atomic)', () => {
    const hints = extractNameHints({
      filename: 'Metal Slug 2 (mslug2).neo',
      parentFolder: 'Metal Slug 2 Folder',
      parentFolderIsAtomic: true,
    });
    expect(hints.map((h) => h.source)).toEqual([
      'folder',
      'paren-shortname',
      'filename-stem',
    ]);
  });

  it('round 2: when parent is non-atomic, folder hint is omitted; rest still in priority order', () => {
    const hints = extractNameHints({
      filename: 'Metal Slug 2 (mslug2).neo',
      parentFolder: '1 World A-Z',
      parentFolderIsAtomic: false,
    });
    expect(hints.map((h) => h.source)).toEqual([
      'paren-shortname',
      'filename-stem',
    ]);
  });

  it('omits sources that produce no hint', () => {
    // No parent folder, no paren-shortname → only stem fires.
    const hints = extractNameHints({ filename: 'CleanName.nes' });
    expect(hints.map((h) => h.source)).toEqual(['filename-stem']);
  });

  it('returns empty array when no source produces a hint', () => {
    // Empty filename, no parent folder.
    const hints = extractNameHints({ filename: '' });
    expect(hints).toEqual([]);
  });

  it('returns empty array when filename is just an extension', () => {
    const hints = extractNameHints({ filename: '.nes' });
    expect(hints).toEqual([]);
  });
});
