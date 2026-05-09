import { describe, expect, it } from 'vitest';

import {
  atomicFolderPathsFromRoms,
  enumerateRomEntries,
  enumerateScrapePaths,
} from '@shared/rom-enumeration';
import type { Rom } from '@shared/types';

function file(name: string, overrides: Partial<Rom> = {}): Rom {
  return {
    coreId: 'X68000',
    filename: name,
    displayName: name.replace(/\.[^.]+$/, ''),
    sizeBytes: 1024,
    hidden: false,
    path: `/media/fat/games/X68000/${name}`,
    kind: 'file',
    relativePath: name,
    ...overrides,
  };
}

function atomic(folderName: string, containedFile: string | undefined, overrides: Partial<Rom> = {}): Rom {
  const folderPath = `/media/fat/games/X68000/${folderName}`;
  return {
    coreId: 'X68000',
    filename: folderName,
    displayName: folderName,
    sizeBytes: 0,
    hidden: false,
    path: folderPath,
    kind: 'folder-atomic',
    relativePath: folderName,
    containedRomPath:
      containedFile !== undefined ? `${folderPath}/${containedFile}` : undefined,
    ...overrides,
  };
}

function container(folderName: string, overrides: Partial<Rom> = {}): Rom {
  const folderPath = `/media/fat/games/X68000/${folderName}`;
  return {
    coreId: 'X68000',
    filename: folderName,
    displayName: folderName,
    sizeBytes: 0,
    hidden: false,
    path: folderPath,
    kind: 'folder-container',
    relativePath: folderName,
    ...overrides,
  };
}

describe('enumerateRomEntries — file rows', () => {
  it('passes a file row through unchanged (path, displayName, rowPath all the file)', () => {
    const out = enumerateRomEntries([file('Sonic.zip')]);
    expect(out).toEqual([
      {
        path: '/media/fat/games/X68000/Sonic.zip',
        kind: 'file',
        displayName: 'Sonic',
        rowPath: '/media/fat/games/X68000/Sonic.zip',
      },
    ]);
  });

  it('emits one entry per file row', () => {
    const out = enumerateRomEntries([
      file('a.zip'),
      file('b.zip'),
      file('c.zip'),
    ]);
    expect(out).toHaveLength(3);
    for (const e of out) expect(e.kind).toBe('file');
  });
});

describe('enumerateRomEntries — atomic-folder rows', () => {
  it('collapses to ONE entry whose path is the containedRomPath', () => {
    // The X68000 dominant case: a multi-disk floppy game folder.
    // Pre-helper, the auto-scrape queued every disk file separately.
    // Now ONE entry per folder, path = the alphabetical-first
    // launchable file inside (the contained primary).
    const out = enumerateRomEntries([
      atomic('Carrot Party Disk Magazine', 'disk1.dim'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      path: '/media/fat/games/X68000/Carrot Party Disk Magazine/disk1.dim',
      kind: 'atomic-folder',
      displayName: 'Carrot Party Disk Magazine',
      rowPath: '/media/fat/games/X68000/Carrot Party Disk Magazine',
    });
  });

  it('rowPath is the FOLDER (for hide/show + bulk ops); path is the contained file (for cache lookup)', () => {
    // The discrimination matters: folder-level operations (hide,
    // show, classification override) target the folder; metadata
    // cache lookups happen by the contained file's path → md5 →
    // RomMetadata. Pre-helper, every call site reinvented this
    // ternary — `kind === 'folder-atomic' ? containedRomPath : path`.
    const [e] = enumerateRomEntries([atomic('Disc Game', 'main.cue')]);
    expect(e?.rowPath).toBe('/media/fat/games/X68000/Disc Game');
    expect(e?.path).toBe('/media/fat/games/X68000/Disc Game/main.cue');
  });

  it('skips an atomic folder with no containedRomPath (defensive)', () => {
    // An empty atomic folder (no launchable inside) has nothing to
    // hash + no meaningful name-search hook beyond the folder name.
    // Skip rather than emit a half-entry the cache can't key by.
    const out = enumerateRomEntries([atomic('Empty', undefined)]);
    expect(out).toEqual([]);
  });

  it('displayName is the folder name verbatim (NOT extension-stripped)', () => {
    // Folders don't carry meaningful extensions — pass the
    // displayName through. The SS name-search uses this as the
    // query string when the contained file's hash misses.
    const [e] = enumerateRomEntries([
      atomic('Some Game (1989) [JP]', 'disk1.d88'),
    ]);
    expect(e?.displayName).toBe('Some Game (1989) [JP]');
  });
});

describe('enumerateRomEntries — container rows are filtered out', () => {
  it('container folders do NOT appear in the entry stream', () => {
    // The user/auto-scrape engine drills into containers separately
    // by calling `listRoms(coreId, container.relativePath)` and
    // running this helper on the inner level. A container row at
    // the current level is not itself a scrape target.
    const out = enumerateRomEntries([container('1 World A-Z')]);
    expect(out).toEqual([]);
  });

  it('mixed listing: files + atomic + container — only files + atomic make it', () => {
    const out = enumerateRomEntries([
      file('LooseRom.zip'),
      atomic('Multi-Disk Game', 'disk1.dim'),
      container('Browsable Subfolder'),
      file('AnotherLooseRom.bin'),
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((e) => e.kind)).toEqual([
      'file',
      'atomic-folder',
      'file',
    ]);
  });
});

describe('enumerateRomEntries — empty input', () => {
  it('returns empty array for empty input', () => {
    expect(enumerateRomEntries([])).toEqual([]);
  });
});

describe('enumerateScrapePaths — convenience over enumerateRomEntries.map(e => e.path)', () => {
  it('returns just the cache-lookup paths', () => {
    const paths = enumerateScrapePaths([
      file('LooseRom.zip'),
      atomic('Game A', 'disk1.dim'),
      container('Subfolder'),
    ]);
    expect(paths).toEqual([
      '/media/fat/games/X68000/LooseRom.zip',
      '/media/fat/games/X68000/Game A/disk1.dim',
    ]);
  });

  it('matches enumerateRomEntries(...).map(e => e.path) verbatim', () => {
    const roms = [
      file('a.zip'),
      atomic('Game', 'disk.dim'),
      container('Sub'),
      file('c.zip'),
    ];
    const fromShortcut = enumerateScrapePaths(roms);
    const fromFull = enumerateRomEntries(roms).map((e) => e.path);
    expect(fromShortcut).toEqual(fromFull);
  });
});

describe('atomicFolderPathsFromRoms — orchestrator name-search routing', () => {
  it('returns the contained file paths (matches what enumerateRomEntries emits as `path`)', () => {
    // The orchestrator checks `atomicFolderPaths.has(path)` to set
    // `parentFolderIsAtomic = true`. That `path` is the
    // containedRomPath (per `enumerateRomEntries`'s atomic branch),
    // so this set MUST use the same key shape.
    const set = atomicFolderPathsFromRoms([
      file('LooseRom.zip'),
      atomic('Game A', 'disk1.dim'),
      atomic('Game B', 'main.cue'),
      container('Subfolder'),
    ]);
    expect(set.has('/media/fat/games/X68000/Game A/disk1.dim')).toBe(true);
    expect(set.has('/media/fat/games/X68000/Game B/main.cue')).toBe(true);
    // File paths and container paths are NOT in the set.
    expect(set.has('/media/fat/games/X68000/LooseRom.zip')).toBe(false);
    expect(set.has('/media/fat/games/X68000/Subfolder')).toBe(false);
    expect(set.size).toBe(2);
  });

  it('skips atomic folders with no containedRomPath', () => {
    const set = atomicFolderPathsFromRoms([
      atomic('Empty', undefined),
      atomic('Has File', 'disk.dim'),
    ]);
    expect(set.size).toBe(1);
  });

  it('empty input returns an empty set', () => {
    expect(atomicFolderPathsFromRoms([]).size).toBe(0);
  });
});

describe('enumerateRomEntries — preserves input order', () => {
  it('atomic + file + atomic + file — output order matches input order', () => {
    const roms = [
      atomic('A', 'a.dim'),
      file('b.zip'),
      atomic('C', 'c.dim'),
      file('d.zip'),
    ];
    const out = enumerateRomEntries(roms);
    expect(out.map((e) => e.displayName)).toEqual(['A', 'b', 'C', 'd']);
  });
});
