import { describe, expect, it } from 'vitest';

import {
  classifyFolder,
  classifyFromFlags,
  resolveClassification,
  type FolderContents,
} from '@shared/folder-rom';

describe('classifyFolder — disc / atomic shape', () => {
  // Saturn-shaped disc folder: a `.cue` plus track .bin files.
  const saturn: FolderContents = {
    files: [
      'Castlevania - Symphony of the Night.cue',
      'Castlevania - Symphony of the Night (Track 01).bin',
      'Castlevania - Symphony of the Night (Track 02).bin',
    ],
    dirs: [],
  };

  it('returns atomic when a disc-image extension is present', () => {
    expect(classifyFolder(saturn)).toBe('atomic');
  });

  it('returns atomic for any of the disc extensions', () => {
    for (const ext of ['.cue', '.gdi', '.iso', '.chd', '.CUE', '.GDI', '.ISO', '.CHD']) {
      expect(
        classifyFolder({ files: [`game${ext}`], dirs: [] }),
      ).toBe('atomic');
    }
  });

  it('returns atomic for track-numbered files even without a .cue', () => {
    // Some MegaCD dumps don't ship a .cue; fall back to track pattern.
    const megaCd: FolderContents = {
      files: [
        'BC Racers (Track 01).bin',
        'BC Racers (Track 02).bin',
        'BC Racers (Track 03).bin',
      ],
      dirs: [],
    };
    expect(classifyFolder(megaCd)).toBe('atomic');
  });

  it('disc evidence wins over cart-extension evidence', () => {
    // .bin alone would otherwise match cart-ext, but a .cue pin to
    // atomic. The order of rules guarantees this.
    const mixed: FolderContents = {
      files: ['game.cue', 'game.bin'],
      dirs: [],
    };
    expect(classifyFolder(mixed)).toBe('atomic');
  });
});

describe('classifyFolder — container shape', () => {
  // NEOGEO-shaped organisational folder: many cartridge .zips, no
  // disc markers.
  const neoGeoSubfolder: FolderContents = {
    files: ['mslug.zip', 'kof97.zip', 'samsho.zip', 'lastblade2.zip'],
    dirs: [],
  };

  it('returns container when only cart-shape extensions present', () => {
    expect(classifyFolder(neoGeoSubfolder)).toBe('container');
  });

  it('returns container for any of the cart extensions', () => {
    for (const ext of [
      '.zip',
      '.7z',
      '.rar',
      '.sfc',
      '.smc',
      '.nes',
      '.gba',
      '.gb',
      '.gbc',
      '.md',
      '.gen',
      '.pce',
      '.lnx',
      '.col',
      '.gg',
      '.sms',
      '.a78',
      '.a26',
    ]) {
      expect(classifyFolder({ files: [`game${ext}`], dirs: [] })).toBe(
        'container',
      );
    }
  });

  it('returns container when there are subdirectories (likely a tree of games)', () => {
    expect(classifyFolder({ files: [], dirs: ['Region A', 'Region B'] })).toBe(
      'container',
    );
  });
});

describe('classifyFolder — unknown shape', () => {
  it('returns unknown for an empty folder', () => {
    expect(classifyFolder({ files: [], dirs: [] })).toBe('unknown');
  });

  it('returns unknown for files with no recognisable extensions', () => {
    expect(
      classifyFolder({ files: ['readme', 'notes.txt', 'license'], dirs: [] }),
    ).toBe('unknown');
  });
});

describe('classifyFromFlags', () => {
  it('mirrors the content-based classifier on representative inputs', () => {
    // Saturn: hasDisc=1
    expect(
      classifyFromFlags({
        hasDisc: true,
        hasTrack: false,
        hasCart: true,
        hasSubdir: false,
      }),
    ).toBe('atomic');
    // NEOGEO subfolder: hasCart=1
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: true,
        hasSubdir: false,
      }),
    ).toBe('container');
    // Just subdirs (likely organisational tree)
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: false,
        hasSubdir: true,
      }),
    ).toBe('container');
    // Empty / unrecognisable
    expect(
      classifyFromFlags({
        hasDisc: false,
        hasTrack: false,
        hasCart: false,
        hasSubdir: false,
      }),
    ).toBe('unknown');
  });
});

describe('resolveClassification — override layer', () => {
  it('user override wins over the heuristic', () => {
    expect(resolveClassification('container', 'atomic')).toBe('atomic');
    expect(resolveClassification('atomic', 'container')).toBe('container');
  });

  it('falls back to atomic when the heuristic returns unknown', () => {
    expect(resolveClassification('unknown', undefined)).toBe('atomic');
  });

  it('preserves the heuristic call when no override is present', () => {
    expect(resolveClassification('container', undefined)).toBe('container');
    expect(resolveClassification('atomic', undefined)).toBe('atomic');
  });
});
