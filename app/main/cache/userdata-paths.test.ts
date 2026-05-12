import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CacheManager } from '@app/main/cache/cache-manager';
import {
  MISTER_CACHE_DIR_NAME,
  MISTERCURATOR_USERDATA_NAMES,
  OLD_CACHE_DIR_NAME,
  findElectronCollisions,
  migrateOldCacheDirIfNeeded,
} from '@app/main/cache/userdata-paths';

describe('findElectronCollisions', () => {
  it('flags case-insensitive matches between our names and Electron-reserved ones', () => {
    expect(findElectronCollisions(['cache'])).toEqual(['cache']);
    expect(findElectronCollisions(['Cache'])).toEqual(['Cache']);
    expect(findElectronCollisions(['CACHE'])).toEqual(['CACHE']);
    expect(findElectronCollisions(['code cache'])).toEqual(['code cache']);
    expect(findElectronCollisions(['GPUCache'])).toEqual(['GPUCache']);
  });

  it('returns the empty list when no names collide', () => {
    expect(findElectronCollisions(['mister-cache', 'metadata'])).toEqual([]);
  });

  it('preserves the original casing of the input on a match (so error messages are useful)', () => {
    expect(findElectronCollisions(['Cache'])).toEqual(['Cache']);
  });

  it('our MISTERCURATOR_USERDATA_NAMES list has zero Electron collisions', () => {
    // Regression pin. If a future PR adds a userData subdir whose
    // name (case-insensitively) matches anything Electron / Chromium
    // creates, this test fires before the silent-failure bug
    // reaches production. Add the new name to
    // `MISTERCURATOR_USERDATA_NAMES`; if it collides, rename it.
    const collisions = findElectronCollisions(MISTERCURATOR_USERDATA_NAMES);
    expect(collisions).toEqual([]);
  });

  it('the OLD cache dir name (kept only for migration) DOES collide with Electron-reserved names', () => {
    // This is the bug we're fixing. The presence of this assertion
    // documents WHY `OLD_CACHE_DIR_NAME` and `MISTER_CACHE_DIR_NAME`
    // are different constants — and ensures the OLD constant
    // continues to identify the wrong name even if someone "fixes"
    // it by accident.
    expect(findElectronCollisions([OLD_CACHE_DIR_NAME])).toEqual([
      OLD_CACHE_DIR_NAME,
    ]);
  });
});

describe('migrateOldCacheDirIfNeeded', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(join(tmpdir(), 'mc-userdata-'));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  /**
   * Helper — write a minimal "our cache" subdir at the supplied
   * path. The migration uses marker files (cores.json, etc.) to
   * tell our subdirs apart from Chromium's siblings.
   */
  async function writeOurSubdir(parent: string, host: string): Promise<void> {
    const hostDir = join(parent, host);
    await fs.mkdir(hostDir, { recursive: true });
    await fs.writeFile(
      join(hostDir, 'cores.json'),
      JSON.stringify({ version: 1, host, witnesses: {}, data: [] }),
      'utf-8',
    );
  }

  /**
   * Helper — write a Chromium-shaped subdir / file inside the cache
   * dir that the migration MUST leave alone. Mimics what Chromium's
   * `Cache_Data/` and index files look like inside `<userData>/Cache/`.
   */
  async function writeChromiumDecoys(parent: string): Promise<void> {
    await fs.mkdir(join(parent, 'Cache_Data'), { recursive: true });
    await fs.writeFile(join(parent, 'Cache_Data', 'f_000001'), 'opaque', 'utf-8');
    await fs.writeFile(join(parent, 'index'), 'opaque-index', 'utf-8');
  }

  it('no-op when the old cache dir does not exist (fresh install)', async () => {
    const result = await migrateOldCacheDirIfNeeded(userDataDir);
    expect(result.moved).toEqual([]);
    expect(result.skippedDestinationExists).toEqual([]);
    // The new dir is NOT eagerly created — CacheManager will create
    // it lazily on first write.
    await expect(
      fs.access(join(userDataDir, MISTER_CACHE_DIR_NAME)),
    ).rejects.toThrow();
  });

  it('moves ours-marker subdirs from old → new and reports them', async () => {
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    await fs.mkdir(oldPath, { recursive: true });
    await writeOurSubdir(oldPath, '192.168.50.194');
    await writeOurSubdir(oldPath, 'mister.local');

    const result = await migrateOldCacheDirIfNeeded(userDataDir);

    expect([...result.moved].sort()).toEqual(['192.168.50.194', 'mister.local']);
    expect(result.skippedDestinationExists).toEqual([]);
    // New location has both subdirs with the contents intact.
    const newPath = join(userDataDir, MISTER_CACHE_DIR_NAME);
    const movedFile = await fs.readFile(
      join(newPath, '192.168.50.194', 'cores.json'),
      'utf-8',
    );
    expect(JSON.parse(movedFile).host).toBe('192.168.50.194');
    // Old subdirs are gone (the directory entry was renamed).
    await expect(
      fs.access(join(oldPath, '192.168.50.194')),
    ).rejects.toThrow();
  });

  it('leaves Chromium decoy entries untouched even on case-collision OS', async () => {
    // The whole point of this PR: do NOT mishandle Chromium's
    // adjacent files when running on macOS where `<userData>/cache/`
    // and `<userData>/Cache/` resolve to the same dir.
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    await fs.mkdir(oldPath, { recursive: true });
    await writeOurSubdir(oldPath, '192.168.50.194');
    await writeChromiumDecoys(oldPath);

    const result = await migrateOldCacheDirIfNeeded(userDataDir);

    expect(result.moved).toEqual(['192.168.50.194']);
    // Chromium decoys MUST still be in the old location.
    await expect(
      fs.access(join(oldPath, 'Cache_Data', 'f_000001')),
    ).resolves.toBeUndefined();
    await expect(fs.access(join(oldPath, 'index'))).resolves.toBeUndefined();
  });

  it('idempotent — a second run after migration is a no-op', async () => {
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    await fs.mkdir(oldPath, { recursive: true });
    await writeOurSubdir(oldPath, 'host-a');

    const first = await migrateOldCacheDirIfNeeded(userDataDir);
    expect(first.moved).toEqual(['host-a']);

    // Second invocation — the old dir might still exist (Chromium
    // siblings keep it alive on macOS) but our subdirs are gone.
    const second = await migrateOldCacheDirIfNeeded(userDataDir);
    expect(second.moved).toEqual([]);
    expect(second.skippedDestinationExists).toEqual([]);
  });

  it("skips a subdir whose destination already exists (doesn't overwrite newer data)", async () => {
    // The user flipped back to an older app build that wrote to OLD
    // after the migration already moved data to NEW. Two cache files
    // exist; migration should NOT clobber NEW with OLD's data.
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    const newPath = join(userDataDir, MISTER_CACHE_DIR_NAME);
    await fs.mkdir(oldPath, { recursive: true });
    await fs.mkdir(newPath, { recursive: true });
    await writeOurSubdir(oldPath, 'host-a');
    // Pre-populate NEW with a different file content for host-a.
    await fs.mkdir(join(newPath, 'host-a'), { recursive: true });
    await fs.writeFile(
      join(newPath, 'host-a', 'cores.json'),
      JSON.stringify({ version: 1, host: 'host-a', winner: 'new' }),
      'utf-8',
    );

    const result = await migrateOldCacheDirIfNeeded(userDataDir);

    expect(result.moved).toEqual([]);
    expect(result.skippedDestinationExists).toEqual(['host-a']);
    // NEW wins; its content is untouched.
    const newContent = JSON.parse(
      await fs.readFile(join(newPath, 'host-a', 'cores.json'), 'utf-8'),
    );
    expect(newContent.winner).toBe('new');
    // OLD still has its host-a (intentionally — operator decides).
    await expect(
      fs.access(join(oldPath, 'host-a', 'cores.json')),
    ).resolves.toBeUndefined();
  });

  it("ignores a subdir without ours-markers (don't claim foreign data)", async () => {
    // A subdir that LOOKS like one of ours (sanitised-name shape)
    // but lacks marker files isn't ours — leave it alone. Defensive
    // for the case where a future Chromium release adds a subdir
    // that happens to match our sanitised-host pattern.
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    await fs.mkdir(join(oldPath, '192.168.99.99'), { recursive: true });
    await fs.writeFile(join(oldPath, '192.168.99.99', 'some-other-file'), 'x');

    const result = await migrateOldCacheDirIfNeeded(userDataDir);

    expect(result.moved).toEqual([]);
    // The foreign subdir stays put.
    await expect(
      fs.access(join(oldPath, '192.168.99.99', 'some-other-file')),
    ).resolves.toBeUndefined();
  });

  it('post-migration round-trip — second connect reads cache from the NEW location', async () => {
    // Integration shape: after migrateOldCacheDirIfNeeded runs, a
    // CacheManager pointed at `<userData>/mister-cache/` finds the
    // migrated data.
    const oldPath = join(userDataDir, OLD_CACHE_DIR_NAME);
    await fs.mkdir(oldPath, { recursive: true });
    await writeOurSubdir(oldPath, '192.168.50.194');
    // Also write witnesses + a representative core so the read
    // round-trips through the schema validator.
    await fs.writeFile(
      join(oldPath, '192.168.50.194', 'cores.json'),
      JSON.stringify({
        version: 1,
        host: '192.168.50.194',
        cachedAt: '2026-05-12T00:00:00.000Z',
        witnesses: { '/media/fat/_Console': 'a'.repeat(32) },
        data: [],
      }),
      'utf-8',
    );

    await migrateOldCacheDirIfNeeded(userDataDir);

    const cache = new CacheManager(join(userDataDir, MISTER_CACHE_DIR_NAME));
    const result = await cache.getCoresCache('192.168.50.194');
    expect(result).not.toBeNull();
    expect(result?.host).toBe('192.168.50.194');
    expect(result?.witnesses).toEqual({
      '/media/fat/_Console': 'a'.repeat(32),
    });
  });
});
