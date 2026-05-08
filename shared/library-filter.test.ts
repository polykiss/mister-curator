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
});
