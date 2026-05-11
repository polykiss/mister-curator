import { describe, expect, it } from 'vitest';

import {
  atomicFolderPathsFromRoms,
  enumerateRomEntries,
  enumerateScrapePaths,
  mergeRecursivePathsWithAtomicFolders,
  metadataLookupPathFor,
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

  it('alias-folded synthetic container rows (PR #42 commit 4) stay out of the prefetch stream', () => {
    // fix/count-and-status-indicator commit 3 regression pin: PR #42
    // commit 4's ConnectionManager.listRoms wrapper appends a
    // synthetic 'folder-container' row to NEOGEO's top-level result
    // for each alias dir (e.g. NeoGeo-CD). The synthetic row's
    // `path` points at /media/fat/games/NeoGeo-CD — a directory,
    // not a file. If it leaked into prefetch, the orchestrator
    // would attempt to hash a directory and fail (or worse, return
    // garbage that poisons the metadata cache).
    //
    // enumerateRomEntries dropping container rows is the load-
    // bearing filter that keeps this from happening. Pin it
    // against a NeoGeo-CD-shape synthetic row directly.
    const synthetic = {
      coreId: 'NEOGEO',
      filename: 'NeoGeo-CD',
      displayName: 'NeoGeo-CD',
      sizeBytes: 0,
      hidden: false,
      path: '/media/fat/games/NeoGeo-CD',
      kind: 'folder-container' as const,
      relativePath: 'NeoGeo-CD',
    };
    const out = enumerateRomEntries([file('mslug.zip'), synthetic]);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe('file');
    expect(out.map((e) => e.path)).not.toContain(
      '/media/fat/games/NeoGeo-CD',
    );
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

describe('metadataLookupPathFor — per-row cache key derivation', () => {
  it('file row → file path', () => {
    const r = file('Sonic.zip');
    expect(metadataLookupPathFor(r)).toBe(
      '/media/fat/games/X68000/Sonic.zip',
    );
  });

  it('atomic-folder row → containedRomPath', () => {
    const r = atomic('Game', 'main.dim');
    expect(metadataLookupPathFor(r)).toBe(
      '/media/fat/games/X68000/Game/main.dim',
    );
  });

  it('atomic-folder row WITHOUT containedRomPath → null', () => {
    expect(metadataLookupPathFor(atomic('Empty', undefined))).toBeNull();
  });

  it('container-folder row → null (callers never look up metadata on containers)', () => {
    expect(metadataLookupPathFor(container('Subfolder'))).toBeNull();
  });
});

describe('mergeRecursivePathsWithAtomicFolders — auto-scrape dedup', () => {
  // The X68000 dominant case: ~647 atomic floppy folders × 2.25 disks
  // each = ~1455 paths from listRecursiveRomFiles. After this merge:
  // ~647 representative paths (the alphabetical-first launchable file
  // inside each folder), plus the atomicFolderPaths set the
  // orchestrator routes name-search hints by.

  it('drops contained-file paths inside top-level atomic folders, adds the representative', () => {
    const recursivePaths = [
      '/media/fat/games/X68000/Carrot Party/disk1.dim',
      '/media/fat/games/X68000/Carrot Party/disk2.dim',
      '/media/fat/games/X68000/Carrot Party/disk3.dim',
      '/media/fat/games/X68000/loose-rom.zip',
    ];
    const topLevelRoms = [
      atomic('Carrot Party', 'disk1.dim'),
      file('loose-rom.zip'),
    ];
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    // Expected: loose-rom.zip (passthrough) + disk1.dim (representative
    // for Carrot Party). disk2.dim + disk3.dim are dropped — they're
    // collapsed into the folder's representative.
    expect(result.paths).toEqual([
      '/media/fat/games/X68000/loose-rom.zip',
      '/media/fat/games/X68000/Carrot Party/disk1.dim',
    ]);
    expect(result.atomicFolderPaths.has(
      '/media/fat/games/X68000/Carrot Party/disk1.dim',
    )).toBe(true);
    expect(result.atomicFolderPaths.size).toBe(1);
  });

  it('multi-folder X68000: 1455 paths → 647 representatives', () => {
    // Synthetic version of the X68000 user report. 647 atomic folders
    // with 2.25 disks each = 1455 individual paths.
    const FOLDERS = 647;
    const DISKS_PER_FOLDER = 2;
    const EXTRAS = 161; // brings total to 1455 (647*2 + 161 = 1455)
    const recursivePaths: string[] = [];
    const topLevelRoms = [];
    for (let i = 0; i < FOLDERS; i += 1) {
      const folderName = `Game ${String(i).padStart(4, '0')}`;
      for (let d = 1; d <= DISKS_PER_FOLDER; d += 1) {
        recursivePaths.push(
          `/media/fat/games/X68000/${folderName}/disk${String(d)}.dim`,
        );
      }
      topLevelRoms.push(atomic(folderName, 'disk1.dim'));
    }
    // Add 161 extra "third disks" to a subset of folders.
    for (let i = 0; i < EXTRAS; i += 1) {
      const folderName = `Game ${String(i).padStart(4, '0')}`;
      recursivePaths.push(
        `/media/fat/games/X68000/${folderName}/disk3.dim`,
      );
    }
    expect(recursivePaths.length).toBe(1455);

    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    expect(result.paths.length).toBe(FOLDERS); // 647
    expect(result.atomicFolderPaths.size).toBe(FOLDERS);
  });

  it('top-level container contents pass through verbatim (no nested classification)', () => {
    // Nested atomic folders inside a container are out of scope;
    // top-level containers' recursive contents flow through unchanged.
    const recursivePaths = [
      '/media/fat/games/NES/Hacks/Mario.nes',
      '/media/fat/games/NES/Hacks/Zelda.nes',
      '/media/fat/games/NES/Castlevania.zip',
    ];
    const topLevelRoms = [
      container('Hacks'),
      file('Castlevania.zip'),
    ];
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    // All three paths kept as-is (container contents not collapsed).
    expect(result.paths).toEqual(recursivePaths);
    expect(result.atomicFolderPaths.size).toBe(0);
  });

  it('mixed top level: file + atomic + container', () => {
    const recursivePaths = [
      '/media/fat/games/X68000/loose.zip',
      '/media/fat/games/X68000/Atomic Game/disk1.dim',
      '/media/fat/games/X68000/Atomic Game/disk2.dim',
      '/media/fat/games/X68000/Container/Inner1.zip',
      '/media/fat/games/X68000/Container/Inner2.zip',
    ];
    const topLevelRoms = [
      file('loose.zip'),
      atomic('Atomic Game', 'disk1.dim'),
      container('Container'),
    ];
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    expect([...result.paths].sort()).toEqual([
      '/media/fat/games/X68000/Atomic Game/disk1.dim',
      '/media/fat/games/X68000/Container/Inner1.zip',
      '/media/fat/games/X68000/Container/Inner2.zip',
      '/media/fat/games/X68000/loose.zip',
    ]);
    expect(result.atomicFolderPaths.size).toBe(1);
  });

  it('atomic folder with no containedRomPath: contained files are still dropped, no representative added', () => {
    // Defensive case — an atomic folder with no launchable inside.
    // The folder's subtree is still poison (no contained-file scrape),
    // but we don't add a representative since there's nothing to
    // hash + nothing meaningful to bind.
    const recursivePaths = [
      '/media/fat/games/X68000/Empty/junk.txt',
      '/media/fat/games/X68000/loose.zip',
    ];
    const topLevelRoms = [
      atomic('Empty', undefined),
      file('loose.zip'),
    ];
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    // Only loose.zip survives — Empty/junk.txt is dropped (atomic
    // subtree poison) and Empty has no representative to add.
    expect(result.paths).toEqual([
      '/media/fat/games/X68000/loose.zip',
    ]);
    expect(result.atomicFolderPaths.size).toBe(0);
  });

  it('empty inputs', () => {
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths: [],
      topLevelRoms: [],
    });
    expect(result.paths).toEqual([]);
    expect(result.atomicFolderPaths.size).toBe(0);
  });

  it('subtree-membership uses path + "/" prefix (not raw substring)', () => {
    // Regression case: "Game" matches "Game 2" via substring but
    // NOT via path-prefix. Pin that the merge uses
    // `path + '/'` so a folder named "Game" doesn't accidentally
    // poison files in a sibling "Game 2/" folder.
    const recursivePaths = [
      '/media/fat/games/X68000/Game/disk1.dim',
      '/media/fat/games/X68000/Game 2/main.zip',
    ];
    const topLevelRoms = [atomic('Game', 'disk1.dim'), file('Game 2/main.zip')];
    const result = mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
    // The "Game 2/main.zip" must NOT be dropped by the "Game/" atomic.
    expect(result.paths).toContain('/media/fat/games/X68000/Game 2/main.zip');
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
