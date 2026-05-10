import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HashService, type HashClient } from '@app/main/metadata/hash-service';
import type { HashRecord } from '@shared/mister-client';

/** A tiny in-memory mock that mirrors the IMisterClient subset
 * HashService consumes. Test seeds a Map of path → fixture data;
 * the mock returns matching HashRecord rows. */
interface FixtureHash {
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
  readonly mtime: number;
}

function makeClient(opts: {
  hashes: Map<string, FixtureHash>;
  stat?: Map<string, number>;
  /**
   * fix/sidebar-count-and-mtime-batch round 2: per-path size
   * override for the new `statPathsWithSize` shape. Defaults to the
   * matching hash fixture's size, so existing tests don't need to
   * supply this — only the rename-recovery tests that synthesize
   * a fresh path matching an old cache entry need to.
   */
  size?: Map<string, number>;
  shouldFail?: boolean;
}): HashClient & {
  hashCalls: string[][];
  statCalls: string[][];
  statSizeCalls: string[][];
} {
  const hashCalls: string[][] = [];
  const statCalls: string[][] = [];
  const statSizeCalls: string[][] = [];
  return {
    hashCalls,
    statCalls,
    statSizeCalls,
    async hashPaths(paths: readonly string[]): Promise<readonly HashRecord[]> {
      hashCalls.push([...paths]);
      if (opts.shouldFail) throw new Error('SSH failure');
      return paths
        .map((p) => {
          const rec = opts.hashes.get(p);
          if (!rec) return null;
          return {
            path: p,
            md5: rec.md5,
            sha1: rec.sha1,
            size: rec.size,
            mtime: rec.mtime,
          };
        })
        .filter((r): r is HashRecord => r !== null);
    },
    async statWitnesses(paths: readonly string[]): Promise<Record<string, number>> {
      statCalls.push([...paths]);
      const out: Record<string, number> = {};
      for (const p of paths) {
        out[p] = opts.stat?.get(p) ?? opts.hashes.get(p)?.mtime ?? 0;
      }
      return out;
    },
    async statPathsWithSize(
      paths: readonly string[],
    ): Promise<Record<string, { mtime: number; size: number }>> {
      statSizeCalls.push([...paths]);
      const out: Record<string, { mtime: number; size: number }> = {};
      for (const p of paths) {
        const f = opts.hashes.get(p);
        out[p] = {
          mtime: opts.stat?.get(p) ?? f?.mtime ?? 0,
          size: opts.size?.get(p) ?? f?.size ?? 0,
        };
      }
      return out;
    },
  };
}

/** Build a fixture entry with predictable hashes derived from a label. */
function fix(
  label: string,
  size = 1024,
  mtime = 1700000000,
): FixtureHash {
  const md5 = label.repeat(32).slice(0, 32);
  const sha1 = label.repeat(40).slice(0, 40);
  return { md5, sha1, size, mtime };
}

describe('HashService', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-hash-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an empty map for empty input without touching the client', async () => {
    const svc = new HashService(dir);
    const client = makeClient({ hashes: new Map() });
    const result = await svc.getHash(client, 'host-1', []);
    expect(result.size).toBe(0);
    expect(client.hashCalls).toEqual([]);
    expect(client.statCalls).toEqual([]);
  });

  it('hashes uncached paths via hashPaths and writes the cache', async () => {
    const svc = new HashService(dir);
    const hashes = new Map<string, FixtureHash>([
      ['/media/fat/games/A.sfc', fix('a', 100, 1)],
      ['/media/fat/games/B.sfc', fix('b', 200, 2)],
    ]);
    const client = makeClient({ hashes });
    const result = await svc.getHash(client, 'host-1', [
      '/media/fat/games/A.sfc',
      '/media/fat/games/B.sfc',
    ]);
    expect(result.get('/media/fat/games/A.sfc')?.md5).toBe('a'.repeat(32));
    expect(result.get('/media/fat/games/A.sfc')?.sha1).toBe('a'.repeat(40));
    expect(result.get('/media/fat/games/A.sfc')?.size).toBe(100);
    expect(result.get('/media/fat/games/B.sfc')?.md5).toBe('b'.repeat(32));
    expect(client.statCalls).toEqual([]);
    expect(client.hashCalls).toHaveLength(1);

    const cachePath = join(dir, 'host-1', 'hashes.json');
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as {
      version: number;
      hashStrategyVersion: number;
      host: string;
      entries: Record<string, FixtureHash & { hashedAt: string }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.hashStrategyVersion).toBe(3); // PR #16 round 2 bump
    expect(raw.host).toBe('host-1');
    expect(raw.entries['/media/fat/games/A.sfc']?.md5).toBe('a'.repeat(32));
    expect(raw.entries['/media/fat/games/A.sfc']?.sha1).toBe('a'.repeat(40));
    expect(raw.entries['/media/fat/games/A.sfc']?.size).toBe(100);
  });

  it('serves cached entries without re-running hash when mtime matches', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([['/p/a', fix('a', 100, 500)]]);
    const client = makeClient({ hashes });

    await svc.getHash(client, 'host-1', ['/p/a']);
    expect(client.hashCalls).toHaveLength(1);

    // Second call: mtime in stat matches the cached entry, so no
    // hashPaths call. Round 2 (fix/sidebar-count-and-mtime-batch):
    // hash-service now uses `statPathsWithSize` instead of
    // `statWitnesses`, so the call lands in `statSizeCalls`.
    const result = await svc.getHash(client, 'host-1', ['/p/a']);
    expect(result.get('/p/a')?.md5).toBe('a'.repeat(32));
    expect(client.hashCalls).toHaveLength(1); // unchanged
    expect(client.statSizeCalls).toHaveLength(1);
  });

  it('re-hashes when the device mtime drifts from the cached one', async () => {
    const svc = new HashService(dir);
    const stale = fix('a', 100, 500);
    const fresh = fix('c', 200, 999);
    const hashes = new Map([['/p/a', stale]]);
    const client = makeClient({ hashes });
    await svc.getHash(client, 'host-1', ['/p/a']);

    hashes.set('/p/a', fresh);
    const stat = new Map([['/p/a', 999]]);
    const client2 = makeClient({ hashes, stat });
    const result = await svc.getHash(client2, 'host-1', ['/p/a']);
    expect(result.get('/p/a')?.md5).toBe('c'.repeat(32));
    expect(result.get('/p/a')?.size).toBe(200);
    expect(client2.hashCalls).toHaveLength(1);
  });

  it('does not write a partial cache on hashPaths failure', async () => {
    const svc = new HashService(dir);
    const client = makeClient({ hashes: new Map(), shouldFail: true });
    await expect(svc.getHash(client, 'host-1', ['/x'])).rejects.toThrow(
      'SSH failure',
    );
    const exists = await fs
      .stat(join(dir, 'host-1', 'hashes.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('chunks 250 paths into 3 hashPaths calls (100 / 100 / 50)', async () => {
    const svc = new HashService(dir, { batchSize: 100 });
    const hashes = new Map<string, FixtureHash>();
    const paths: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const p = `/p/file-${String(i).padStart(3, '0')}`;
      paths.push(p);
      hashes.set(p, fix('a', 1, i + 1));
    }
    const client = makeClient({ hashes });
    const result = await svc.getHash(client, 'host-1', paths);
    expect(result.size).toBe(250);
    expect(client.hashCalls).toHaveLength(3);
    expect(client.hashCalls[0]?.length).toBe(100);
    expect(client.hashCalls[1]?.length).toBe(100);
    expect(client.hashCalls[2]?.length).toBe(50);
  });

  it('drops paths the device says don\'t exist', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([['/p/exists', fix('a', 100, 1)]]);
    const client = makeClient({ hashes });
    const result = await svc.getHash(client, 'host-1', [
      '/p/exists',
      '/p/missing',
    ]);
    expect(result.size).toBe(1);
    expect(result.has('/p/exists')).toBe(true);
    expect(result.has('/p/missing')).toBe(false);
  });

  it('partitions hosts so two profiles never share entries', async () => {
    const svc = new HashService(dir);
    const ha = new Map([['/p/x', fix('a', 1, 1)]]);
    const hb = new Map([['/p/x', fix('b', 2, 2)]]);

    await svc.getHash(makeClient({ hashes: ha }), 'host-A', ['/p/x']);
    await svc.getHash(makeClient({ hashes: hb }), 'host-B', ['/p/x']);

    const a = JSON.parse(
      await fs.readFile(join(dir, 'host-A', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, FixtureHash> };
    const b = JSON.parse(
      await fs.readFile(join(dir, 'host-B', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, FixtureHash> };
    expect(a.entries['/p/x']?.md5).toBe('a'.repeat(32));
    expect(b.entries['/p/x']?.md5).toBe('b'.repeat(32));
  });

  it('invalidate removes one entry from the cache', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([
      ['/p/a', fix('a', 1, 1)],
      ['/p/b', fix('b', 2, 2)],
    ]);
    await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a', '/p/b']);
    await svc.invalidate('host-1', '/p/a');

    const file = JSON.parse(
      await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, unknown> };
    expect(file.entries['/p/a']).toBeUndefined();
    expect(file.entries['/p/b']).toBeDefined();
  });

  it('clearForHost removes the cache file', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([['/p/a', fix('a', 1, 1)]]);
    await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a']);
    await svc.clearForHost('host-1');
    const exists = await fs
      .stat(join(dir, 'host-1', 'hashes.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('serializes concurrent calls per host so overlapping paths share work', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([
      ['/p/a', fix('a', 1, 1)],
      ['/p/b', fix('b', 2, 2)],
    ]);
    const client = makeClient({ hashes });

    const [r1, r2] = await Promise.all([
      svc.getHash(client, 'host-1', ['/p/a']),
      svc.getHash(client, 'host-1', ['/p/a', '/p/b']),
    ]);
    expect(r1.get('/p/a')?.md5).toBe('a'.repeat(32));
    expect(r2.get('/p/a')?.md5).toBe('a'.repeat(32));
    expect(r2.get('/p/b')?.md5).toBe('b'.repeat(32));
    const allHashed = client.hashCalls.flat();
    expect(allHashed.filter((p) => p === '/p/a')).toHaveLength(1);
    expect(allHashed.filter((p) => p === '/p/b')).toHaveLength(1);
  });

  it('survives a corrupted cache file by treating it as empty', async () => {
    const svc = new HashService(dir);
    const cacheDir = join(dir, 'host-1');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(join(cacheDir, 'hashes.json'), 'this is not json');

    const hashes = new Map([['/p/a', fix('a', 1, 1)]]);
    const result = await svc.getHash(
      makeClient({ hashes }),
      'host-1',
      ['/p/a'],
    );
    expect(result.get('/p/a')?.md5).toBe('a'.repeat(32));
  });

  it('treats device mtime 0 (file missing) as cache miss', async () => {
    const svc = new HashService(dir);
    const hashes = new Map([['/p/a', fix('a', 100, 100)]]);
    await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a']);

    const stat = new Map([['/p/a', 0]]);
    const client = makeClient({ hashes: new Map(), stat });
    const result = await svc.getHash(client, 'host-1', ['/p/a']);
    expect(result.size).toBe(0);
    expect(client.hashCalls).toHaveLength(1);
  });

  describe('hashStrategyVersion invalidation (PR #16 round 2)', () => {
    async function seedCache(host: string, raw: unknown): Promise<void> {
      const cacheDir = join(dir, host);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify(raw, null, 2),
      );
    }

    it('writes hashStrategyVersion: 3 alongside the v1 schema field', async () => {
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('a', 1, 1)]]);
      await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a']);
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { version: number; hashStrategyVersion: number };
      expect(raw.version).toBe(1);
      expect(raw.hashStrategyVersion).toBe(3);
    });

    it('treats a v2 (md5-only) cache as invalid and re-hashes', async () => {
      // PR #15 round 6 produced v2 entries with just `hash` + `mtime`
      // + `hashedAt` (no sha1, no size). PR #16 round 2 needs the
      // full triple — schema bump invalidates v2 wholesale.
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 2,
        host: 'host-1',
        entries: {
          '/p/a': {
            hash: 'a'.repeat(32),
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('z', 999, 100)]]);
      const client = makeClient({ hashes });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('z'.repeat(32));
      expect(result.get('/p/a')?.sha1).toBe('z'.repeat(40));
      expect(result.get('/p/a')?.size).toBe(999);
      expect(client.hashCalls).toHaveLength(1);
    });

    it('treats a pre-round-7 cache (no hashStrategyVersion) as invalid', async () => {
      await seedCache('host-1', {
        version: 1,
        host: 'host-1',
        entries: {
          '/p/a': {
            hash: 'a'.repeat(32),
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('z', 1, 100)]]);
      const client = makeClient({ hashes });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('z'.repeat(32));
      expect(client.hashCalls).toHaveLength(1);
    });

    it('treats a future-version cache (mismatched > current) as invalid', async () => {
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 999,
        host: 'host-1',
        entries: {
          '/p/a': {
            md5: 'a'.repeat(32),
            sha1: 'a'.repeat(40),
            size: 100,
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('z', 1, 100)]]);
      const client = makeClient({ hashes });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('z'.repeat(32));
      expect(client.hashCalls).toHaveLength(1);
    });

    it('serves a current-version cache with full triple without re-hashing', async () => {
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 3,
        host: 'host-1',
        entries: {
          '/p/a': {
            md5: 'c'.repeat(32),
            sha1: 'd'.repeat(40),
            size: 4242,
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 100]]),
      });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('c'.repeat(32));
      expect(result.get('/p/a')?.sha1).toBe('d'.repeat(40));
      expect(result.get('/p/a')?.size).toBe(4242);
      expect(client.hashCalls).toEqual([]);
    });
  });

  // feat/rename-aware-hash-cache: when a file is renamed (e.g. dot-
  // prefixed for hide), the cache entry under the OLD path is
  // stranded. Pre-fix the next connect re-hashed every renamed file
  // (~30-60s for mame's 600+ hidden ROMs). Post-fix the lookup
  // recognizes the rename via mtime match and migrates the cache key
  // — no re-hash required.
  describe('rename recovery (feat/rename-aware-hash-cache)', () => {
    it('migrates a cache entry when an uncached path matches an existing entry by mtime', async () => {
      const svc = new HashService(dir);
      const oldPath = '/media/fat/games/NES/Castlevania.nes';
      const newPath = '/media/fat/games/NES/.Castlevania.nes';
      const fixture = fix('a', 1024, 1700000000);
      // Seed the cache with the OLD path (representing the
      // pre-rename hash).
      await svc.getHash(
        makeClient({ hashes: new Map([[oldPath, fixture]]) }),
        'host-1',
        [oldPath],
      );
      // Now ask for the NEW path. The device reports the new file's
      // mtime as the same value (Unix mv preserves mtime).
      const client = makeClient({
        hashes: new Map([[newPath, fixture]]), // hashPaths would also work
        stat: new Map([[newPath, 1700000000]]),
      });
      const result = await svc.getHash(client, 'host-1', [newPath]);
      // The cached entry was returned WITHOUT a fresh hashPaths call
      // — recovered via mtime match.
      expect(result.get(newPath)?.md5).toBe('a'.repeat(32));
      expect(client.hashCalls).toEqual([]);
      // The cache file now keys the entry under the NEW path; the
      // OLD key is gone.
      const file = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, FixtureHash> };
      expect(file.entries[newPath]).toBeDefined();
      expect(file.entries[oldPath]).toBeUndefined();
    });

    it('refuses to migrate when two cached entries have the same mtime (ambiguous)', async () => {
      const svc = new HashService(dir);
      const sharedMtime = 1700000000;
      const aFix = fix('a', 1024, sharedMtime);
      const bFix = fix('b', 2048, sharedMtime);
      const aOld = '/p/A.nes';
      const bOld = '/p/B.nes';
      const aNew = '/p/.A.nes';
      const cFresh = fix('c', 4096, sharedMtime); // collision-prone
      // Seed cache with two entries sharing a mtime.
      await svc.getHash(
        makeClient({
          hashes: new Map([
            [aOld, aFix],
            [bOld, bFix],
          ]),
        }),
        'host-1',
        [aOld, bOld],
      );
      // Ask for a NEW path with the same mtime — the lookup is
      // ambiguous (could match either A or B). Refuses to migrate;
      // re-hashes fresh.
      const client = makeClient({
        hashes: new Map([[aNew, cFresh]]),
        stat: new Map([[aNew, sharedMtime]]),
      });
      const result = await svc.getHash(client, 'host-1', [aNew]);
      // Got the fresh hash, not the migrated one.
      expect(result.get(aNew)?.md5).toBe('c'.repeat(32));
      expect(client.hashCalls).toHaveLength(1);
      // Both old keys still in cache (neither was migrated).
      const file = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, FixtureHash> };
      expect(file.entries[aOld]).toBeDefined();
      expect(file.entries[bOld]).toBeDefined();
    });

    it('refuses to migrate when mtime does not match any cached entry', async () => {
      const svc = new HashService(dir);
      const oldFix = fix('a', 1024, 1700000000);
      // Seed cache.
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/A.nes', oldFix]]) }),
        'host-1',
        ['/p/A.nes'],
      );
      // Ask for a NEW path with a DIFFERENT mtime (file genuinely
      // modified). Re-hash fresh.
      const newFix = fix('c', 1024, 1700099999);
      const client = makeClient({
        hashes: new Map([['/p/.A.nes', newFix]]),
        stat: new Map([['/p/.A.nes', 1700099999]]),
      });
      const result = await svc.getHash(client, 'host-1', ['/p/.A.nes']);
      expect(result.get('/p/.A.nes')?.md5).toBe('c'.repeat(32));
      expect(client.hashCalls).toHaveLength(1);
    });

    it('two paths renamed simultaneously each migrate to their unique cache entry', async () => {
      const svc = new HashService(dir);
      const aFix = fix('a', 100, 1700000001); // distinct mtimes
      const bFix = fix('b', 200, 1700000002);
      // Seed cache with two old keys.
      await svc.getHash(
        makeClient({
          hashes: new Map([
            ['/p/A.nes', aFix],
            ['/p/B.nes', bFix],
          ]),
        }),
        'host-1',
        ['/p/A.nes', '/p/B.nes'],
      );
      // Bulk hide → both renamed. Distinct (mtime, size) → both
      // migrate. Round 2 (fix/sidebar-count-and-mtime-batch): the
      // migration discriminates by (mtime, size), so the synthetic
      // renamed paths must report the same size as the cached
      // entries — Unix `mv` preserves both.
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([
          ['/p/.A.nes', 1700000001],
          ['/p/.B.nes', 1700000002],
        ]),
        size: new Map([
          ['/p/.A.nes', 100],
          ['/p/.B.nes', 200],
        ]),
      });
      const result = await svc.getHash(client, 'host-1', [
        '/p/.A.nes',
        '/p/.B.nes',
      ]);
      expect(result.get('/p/.A.nes')?.md5).toBe('a'.repeat(32));
      expect(result.get('/p/.B.nes')?.md5).toBe('b'.repeat(32));
      // Zero re-hashes — both recovered via rename migration.
      expect(client.hashCalls).toEqual([]);
      const file = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, FixtureHash> };
      expect(file.entries['/p/.A.nes']).toBeDefined();
      expect(file.entries['/p/.B.nes']).toBeDefined();
      expect(file.entries['/p/A.nes']).toBeUndefined();
      expect(file.entries['/p/B.nes']).toBeUndefined();
    });

    it('migration persists across HashService instances (cache file rewritten)', async () => {
      const oldPath = '/p/A.nes';
      const newPath = '/p/.A.nes';
      const fixture = fix('a', 1024, 1700000000);
      // Phase 1: seed cache + perform migration.
      const svc1 = new HashService(dir);
      await svc1.getHash(
        makeClient({ hashes: new Map([[oldPath, fixture]]) }),
        'host-1',
        [oldPath],
      );
      const client1 = makeClient({
        hashes: new Map([[newPath, fixture]]),
        stat: new Map([[newPath, 1700000000]]),
      });
      await svc1.getHash(client1, 'host-1', [newPath]);
      // Phase 2: fresh service instance reads from disk. The
      // migrated entry should be there under the NEW key.
      const svc2 = new HashService(dir);
      const client2 = makeClient({
        hashes: new Map(),
        stat: new Map([[newPath, 1700000000]]),
      });
      const result = await svc2.getHash(client2, 'host-1', [newPath]);
      expect(result.get(newPath)?.md5).toBe('a'.repeat(32));
      expect(client2.hashCalls).toEqual([]); // no re-hash
    });

    // fix/sidebar-count-and-mtime-batch round 2 — the load-bearing
    // case the original (mtime-only) round 1 missed: bulk-copied ROM
    // collections share mtimes within the second (e.g. mame's 600+
    // files copied via SMB in one batch). Mtime-only matching
    // refused those as ambiguous → every renamed file re-hashed on
    // connect even with the migration logic in place. (mtime, size)
    // discrimination cleanly resolves the collision.
    it('mtime collision with distinct sizes: BOTH migrate (size discriminates)', async () => {
      const svc = new HashService(dir);
      const sharedMtime = 1700000000;
      const aFix = fix('a', 1024, sharedMtime);
      const bFix = fix('b', 2048, sharedMtime);
      // Seed: two cache entries with the SAME mtime but different
      // sizes — the bulk-copy scenario.
      await svc.getHash(
        makeClient({
          hashes: new Map([
            ['/p/A.nes', aFix],
            ['/p/B.nes', bFix],
          ]),
        }),
        'host-1',
        ['/p/A.nes', '/p/B.nes'],
      );
      // Both renamed (hide). Stat reports same mtime, distinct sizes
      // matching the cached entries.
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([
          ['/p/.A.nes', sharedMtime],
          ['/p/.B.nes', sharedMtime],
        ]),
        size: new Map([
          ['/p/.A.nes', 1024],
          ['/p/.B.nes', 2048],
        ]),
      });
      const result = await svc.checkCachedMtimes(client, 'host-1', [
        '/p/.A.nes',
        '/p/.B.nes',
      ]);
      // Pre-fix (round 1): both lookups would refuse as ambiguous.
      // Post-fix: size discriminates → both migrate uniquely.
      expect(result.get('/p/.A.nes')?.md5).toBe('a'.repeat(32));
      expect(result.get('/p/.B.nes')?.md5).toBe('b'.repeat(32));
    });

    it('mtime collision with the SAME size: refuses migration (truly ambiguous)', async () => {
      // Pin the (rare) genuine ambiguity case. Two files with
      // identical (mtime, size) — e.g. two empty placeholder files
      // or two same-shape ROM patches — can't be discriminated.
      // Refuse the migration; re-hash fresh.
      const svc = new HashService(dir);
      const sharedMtime = 1700000000;
      const sharedSize = 1024;
      await svc.getHash(
        makeClient({
          hashes: new Map([
            ['/p/A.nes', fix('a', sharedSize, sharedMtime)],
            ['/p/B.nes', fix('b', sharedSize, sharedMtime)],
          ]),
        }),
        'host-1',
        ['/p/A.nes', '/p/B.nes'],
      );
      const client = makeClient({
        hashes: new Map([
          ['/p/.A.nes', fix('c', sharedSize, sharedMtime)],
        ]),
        stat: new Map([['/p/.A.nes', sharedMtime]]),
        size: new Map([['/p/.A.nes', sharedSize]]),
      });
      const result = await svc.getHash(client, 'host-1', ['/p/.A.nes']);
      // Got the fresh hash, not a migration.
      expect(result.get('/p/.A.nes')?.md5).toBe('c'.repeat(32));
      expect(client.hashCalls).toHaveLength(1);
    });

    it('checkCachedMtimes also migrates renamed paths', async () => {
      // The orchestrator's primary lookup path uses
      // checkCachedMtimes (PR #20 round 9 batched validation), not
      // getHash. The migration must work there too.
      const svc = new HashService(dir);
      const oldPath = '/p/A.nes';
      const newPath = '/p/.A.nes';
      const fixture = fix('a', 1024, 1700000000);
      await svc.getHash(
        makeClient({ hashes: new Map([[oldPath, fixture]]) }),
        'host-1',
        [oldPath],
      );
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([[newPath, 1700000000]]),
        size: new Map([[newPath, 1024]]),
      });
      const result = await svc.checkCachedMtimes(client, 'host-1', [newPath]);
      expect(result.get(newPath)?.md5).toBe('a'.repeat(32));
      // Rewritten on disk.
      const file = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, FixtureHash> };
      expect(file.entries[newPath]).toBeDefined();
      expect(file.entries[oldPath]).toBeUndefined();
    });
  });
});
