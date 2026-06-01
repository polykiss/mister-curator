import { describe, expect, it } from 'vitest';

import {
  isOsMetadataDir,
  isOsMetadataFile,
} from '@shared/library-filter';

describe('isOsMetadataFile — macOS AppleDouble prefix', () => {
  it('matches typical AppleDouble sidecars', () => {
    expect(isOsMetadataFile('._foo.zip')).toBe(true);
    expect(isOsMetadataFile('._castlevania.chd')).toBe(true);
    expect(isOsMetadataFile('._.DS_Store')).toBe(true);
  });

  it('matches `._` even with no suffix', () => {
    expect(isOsMetadataFile('._')).toBe(true);
  });

  it('does NOT match a plain underscore prefix', () => {
    expect(isOsMetadataFile('_foo.zip')).toBe(false);
    expect(isOsMetadataFile('_resources')).toBe(false);
  });

  it('does NOT match `.` followed by something other than `_`', () => {
    expect(isOsMetadataFile('.gitkeep')).toBe(false);
    expect(isOsMetadataFile('.hidden.zip')).toBe(false);
  });
});

describe('isOsMetadataFile — well-known basenames', () => {
  it('matches .DS_Store (case-insensitive on the basename)', () => {
    expect(isOsMetadataFile('.DS_Store')).toBe(true);
    expect(isOsMetadataFile('.ds_store')).toBe(true);
  });

  it('does NOT match DS_Store without the leading dot', () => {
    expect(isOsMetadataFile('DS_Store')).toBe(false);
    expect(isOsMetadataFile('ds_store')).toBe(false);
  });

  it('matches Thumbs.db case-insensitively', () => {
    expect(isOsMetadataFile('Thumbs.db')).toBe(true);
    expect(isOsMetadataFile('thumbs.db')).toBe(true);
    expect(isOsMetadataFile('THUMBS.DB')).toBe(true);
  });

  it('matches desktop.ini case-insensitively (Windows convention)', () => {
    expect(isOsMetadataFile('desktop.ini')).toBe(true);
    expect(isOsMetadataFile('Desktop.ini')).toBe(true);
    expect(isOsMetadataFile('DESKTOP.INI')).toBe(true);
  });

  it('matches .directory (KDE folder metadata)', () => {
    expect(isOsMetadataFile('.directory')).toBe(true);
    expect(isOsMetadataFile('.DIRECTORY')).toBe(true);
  });

  it('does NOT match real ROM filenames', () => {
    expect(isOsMetadataFile('Sonic.zip')).toBe(false);
    expect(isOsMetadataFile('Castlevania - Aria of Sorrow.gba')).toBe(false);
    expect(isOsMetadataFile('chrono trigger.smc')).toBe(false);
    expect(isOsMetadataFile('Mega Man X.sfc')).toBe(false);
  });

  it('does NOT match near-miss filenames that contain the magic strings', () => {
    expect(isOsMetadataFile('mythumbs.db')).toBe(false);
    expect(isOsMetadataFile('mydesktop.ini')).toBe(false);
    expect(isOsMetadataFile('thumbs.db.bak')).toBe(false);
  });
});

describe('isOsMetadataDir — well-known directories', () => {
  it('matches macOS metadata directories case-insensitively', () => {
    expect(isOsMetadataDir('.AppleDouble')).toBe(true);
    expect(isOsMetadataDir('.appledouble')).toBe(true);
    expect(isOsMetadataDir('.Spotlight-V100')).toBe(true);
    expect(isOsMetadataDir('.spotlight-v100')).toBe(true);
    expect(isOsMetadataDir('.Trashes')).toBe(true);
    expect(isOsMetadataDir('.fseventsd')).toBe(true);
  });

  it('matches Windows recycle bin (with the literal $)', () => {
    expect(isOsMetadataDir('$RECYCLE.BIN')).toBe(true);
    expect(isOsMetadataDir('$Recycle.Bin')).toBe(true);
    expect(isOsMetadataDir('$recycle.bin')).toBe(true);
  });

  it('matches Linux fsck recovery directory', () => {
    expect(isOsMetadataDir('lost+found')).toBe(true);
    expect(isOsMetadataDir('LOST+FOUND')).toBe(true);
  });

  it('does NOT match real ROM-tree directories', () => {
    expect(isOsMetadataDir('Genesis')).toBe(false);
    expect(isOsMetadataDir('1 World A-Z')).toBe(false);
    expect(isOsMetadataDir('Overlays')).toBe(false);
    expect(isOsMetadataDir('SNES')).toBe(false);
  });

  it('does NOT match near-miss directory names', () => {
    expect(isOsMetadataDir('appledouble')).toBe(false); // missing leading dot
    expect(isOsMetadataDir('recycle.bin')).toBe(false); // missing leading $
    expect(isOsMetadataDir('lost-found')).toBe(false); // hyphen, not plus
  });

  it('matches System Volume Information (Windows FAT32 artifact on SD cards)', () => {
    expect(isOsMetadataDir('System Volume Information')).toBe(true);
    expect(isOsMetadataDir('SYSTEM VOLUME INFORMATION')).toBe(true);
    expect(isOsMetadataDir('system volume information')).toBe(true);
  });

  it('does NOT match partial System Volume Information names', () => {
    expect(isOsMetadataDir('System')).toBe(false);
    expect(isOsMetadataDir('System Volume')).toBe(false);
  });

  it('matches .git (git repos synced to SD card)', () => {
    expect(isOsMetadataDir('.git')).toBe(true);
    expect(isOsMetadataDir('.GIT')).toBe(true);
  });

  it('does NOT match git- prefixed directory names', () => {
    expect(isOsMetadataDir('git-repos')).toBe(false);
    expect(isOsMetadataDir('git')).toBe(false); // missing leading dot
  });
});

describe('isOsMetadataFile — chore/search-and-filter-cleanup commit 4 four-case matrix', () => {
  // The user report singled out four shapes that need the right
  // behavior. The filter has handled "._" since the 2244a94 commit
  // (when this module landed) — these tests pin all four together so
  // the contract is obvious in one block. If the user still sees
  // "._" files in the listing, the bug is upstream of this helper
  // (a code path that bypasses the filter entirely), not in the
  // helper's classification logic.
  it.each([
    ['._Foo.zip', true, 'AppleDouple — filtered out'],
    ['.Foo.zip', false, 'user-hidden ROM — kept (dimmed in UI)'],
    ['Foo.zip', false, 'visible ROM — kept'],
    ['._.DS_Store', true, 'AppleDouple shadow of .DS_Store — filtered out'],
  ])('classifies %s as filtered=%s (%s)', (filename, expected) => {
    expect(isOsMetadataFile(filename)).toBe(expected);
  });
});
