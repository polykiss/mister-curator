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
  /**
   * Wrapper bytes-on-disk. Defaults to `size` (matching the
   * non-archive case where extracted == wrapper). Override to model
   * the .zip case where they differ.
   */
  readonly diskSize?: number;
  readonly mtime: number;
}

function makeClient(opts: {
  hashes: Map<string, FixtureHash>;
  stat?: Map<string, number>;
  shouldFail?: boolean;
}): HashClient & {
  hashCalls: string[][];
  statCalls: string[][];
} {
  const hashCalls: string[][] = [];
  const statCalls: string[][] = [];
  return {
    hashCalls,
    statCalls,
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
            // The fixture's `size` doubles as the disk-size for tests
            // — non-archive fixtures coincide naturally; archive
            // fixtures override via `diskSize` when they need to
            // exercise the wrapper-vs-extracted distinction.
            diskSize: rec.diskSize ?? rec.size,
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
    async statPathsWithSize(paths: readonly string[]) {
      // Migration tests pass `stat` with mtime and `hashes` with size
      // separately. Default semantics: mtime falls back to the hashes
      // fixture; size comes from hashes' `diskSize` (or `size` for
      // non-archive fixtures). Missing entries report {0, 0} per the
      // device-side contract.
      const out: Record<string, { size: number; mtime: number }> = {};
      for (const p of paths) {
        const rec = opts.hashes.get(p);
        const mtime = opts.stat?.get(p) ?? rec?.mtime ?? 0;
        const size = rec?.diskSize ?? rec?.size ?? 0;
        out[p] = { size, mtime };
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
    // fix/scrape-and-count-correctness commit 1: bump from v3 to v4
    // when `diskSizeBytes` was added. v3 entries get re-hashed on
    // first read so the new field populates.
    expect(raw.hashStrategyVersion).toBe(4);
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
    // hashPaths call.
    const result = await svc.getHash(client, 'host-1', ['/p/a']);
    expect(result.get('/p/a')?.md5).toBe('a'.repeat(32));
    expect(client.hashCalls).toHaveLength(1); // unchanged
    expect(client.statCalls).toHaveLength(1);
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

    it('writes hashStrategyVersion: 4 alongside the v1 schema field', async () => {
      // fix/scrape-and-count-correctness commit 1 bumped to v4 when
      // `diskSizeBytes` was added to HashEntry.
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('a', 1, 1)]]);
      await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a']);
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { version: number; hashStrategyVersion: number };
      expect(raw.version).toBe(1);
      expect(raw.hashStrategyVersion).toBe(4);
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

    it('serves a current-version cache with full quad without re-hashing', async () => {
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 4,
        host: 'host-1',
        entries: {
          '/p/a': {
            md5: 'c'.repeat(32),
            sha1: 'd'.repeat(40),
            size: 4242,
            diskSizeBytes: 1234,
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
      expect(result.get('/p/a')?.diskSizeBytes).toBe(1234);
      expect(client.hashCalls).toEqual([]);
    });

    it('treats a v3 cache (missing diskSizeBytes) as invalid and re-hashes', async () => {
      // The user observation that motivated commit 1: cache `size`
      // looked stale because it was extracted-content bytes, not
      // wrapper bytes. v3 entries lack the new `diskSizeBytes` field,
      // so the validator returns null and a re-hash populates both
      // fields fresh.
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 3,
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
      expect(result.get('/p/a')?.diskSizeBytes).toBeDefined();
      expect(client.hashCalls).toHaveLength(1);
    });

    it('persists wrapper diskSizeBytes distinctly from extracted size', async () => {
      // Verifies the load-bearing fix from commit 1: the cache now
      // records BOTH the extracted-content size (existing `size`,
      // which still feeds SS romtaille) and the wrapper-bytes-on-disk
      // (`diskSizeBytes`, what the size column displays). For the
      // `.grdians.zip` reproduction case those numbers differ.
      const svc = new HashService(dir);
      const hashes = new Map<string, FixtureHash>([
        [
          '/media/fat/games/mame/grdians.zip',
          {
            md5: '5'.repeat(32),
            sha1: '7'.repeat(40),
            size: 36700160,
            diskSize: 14199857,
            mtime: 1709054222,
          },
        ],
      ]);
      const client = makeClient({ hashes });
      await svc.getHash(client, 'host-1', [
        '/media/fat/games/mame/grdians.zip',
      ]);
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as {
        entries: Record<
          string,
          { size: number; diskSizeBytes: number }
        >;
      };
      const e = raw.entries['/media/fat/games/mame/grdians.zip'];
      expect(e?.size).toBe(36700160);
      expect(e?.diskSizeBytes).toBe(14199857);
    });
  });

  describe('migrateV3Entries (fix/count-and-status-indicator commit 4)', () => {
    async function seedV3Cache(
      host: string,
      entries: Readonly<
        Record<
          string,
          {
            md5: string;
            sha1: string;
            size: number;
            mtime: number;
            hashedAt: string;
          }
        >
      >,
    ): Promise<void> {
      const cacheDir = join(dir, host);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify(
          {
            version: 1,
            hashStrategyVersion: 3,
            host,
            entries,
          },
          null,
          2,
        ),
      );
    }

    it('migrates a v3 entry to v4 when mtime still matches — no hash recompute', async () => {
      // Pre-fix: v3 → v4 strategy bump invalidated every entry,
      // forcing a full rehash. Post-fix: stat-only batch populates
      // diskSizeBytes from `stat -c '%s'` and bumps the entry to
      // v4 in place.
      await seedV3Cache('host-1', {
        '/p/Game.zip': {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 36700160, // extracted-content size from v3
          mtime: 1700000000,
          hashedAt: '2025-01-01T00:00:00.000Z',
        },
      });
      const svc = new HashService(dir);
      // Stat-only client: hashPaths MUST NOT be called.
      const hashes = new Map<string, FixtureHash>([
        [
          '/p/Game.zip',
          {
            md5: 'a'.repeat(32),
            sha1: 'b'.repeat(40),
            size: 36700160,
            diskSize: 14199857, // wrapper bytes from stat
            mtime: 1700000000,
          },
        ],
      ]);
      const client = makeClient({ hashes });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 1, needsRehash: 0 });
      expect(client.hashCalls).toEqual([]);
      // Cache file is now v4 with diskSizeBytes populated from
      // stat. Hash + sha1 + size are preserved verbatim from v3.
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as {
        hashStrategyVersion: number;
        entries: Record<
          string,
          {
            md5: string;
            sha1: string;
            size: number;
            diskSizeBytes: number;
            mtime: number;
          }
        >;
      };
      expect(raw.hashStrategyVersion).toBe(4);
      const e = raw.entries['/p/Game.zip'];
      expect(e?.md5).toBe('a'.repeat(32));
      expect(e?.size).toBe(36700160);
      expect(e?.diskSizeBytes).toBe(14199857);
      expect(e?.mtime).toBe(1700000000);
    });

    it('drops a v3 entry whose mtime drifted (existing rehash path handles)', async () => {
      await seedV3Cache('host-1', {
        '/p/Stale.zip': {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 1024,
          mtime: 1700000000,
          hashedAt: '2025-01-01T00:00:00.000Z',
        },
      });
      const svc = new HashService(dir);
      // Stat returns a different mtime → entry is invalid.
      const hashes = new Map<string, FixtureHash>([
        [
          '/p/Stale.zip',
          {
            md5: '0'.repeat(32),
            sha1: '0'.repeat(40),
            size: 1024,
            mtime: 1800000000, // drifted
          },
        ],
      ]);
      const client = makeClient({
        hashes,
        stat: new Map([['/p/Stale.zip', 1800000000]]),
      });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 0, needsRehash: 1 });
      expect(client.hashCalls).toEqual([]);
      // Entry got dropped from cache; existing rehash path will
      // refire on next access.
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, unknown> };
      expect(raw.entries['/p/Stale.zip']).toBeUndefined();
    });

    it('drops a v3 entry whose path vanished (size=0)', async () => {
      await seedV3Cache('host-1', {
        '/p/Gone.zip': {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 1024,
          mtime: 1700000000,
          hashedAt: '2025-01-01T00:00:00.000Z',
        },
      });
      const svc = new HashService(dir);
      // Empty hashes map AND stat=0 → fixture treats as missing.
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/Gone.zip', 0]]),
      });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 0, needsRehash: 1 });
    });

    it('mixed batch: some migrate, some need rehash', async () => {
      await seedV3Cache('host-1', {
        '/p/Fresh.zip': {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 100,
          mtime: 100,
          hashedAt: '2025-01-01T00:00:00.000Z',
        },
        '/p/Stale.zip': {
          md5: 'c'.repeat(32),
          sha1: 'd'.repeat(40),
          size: 200,
          mtime: 200,
          hashedAt: '2025-01-01T00:00:00.000Z',
        },
      });
      const svc = new HashService(dir);
      const hashes = new Map<string, FixtureHash>([
        [
          '/p/Fresh.zip',
          { md5: 'a'.repeat(32), sha1: 'b'.repeat(40), size: 100, diskSize: 50, mtime: 100 },
        ],
        [
          '/p/Stale.zip',
          { md5: 'c'.repeat(32), sha1: 'd'.repeat(40), size: 200, diskSize: 150, mtime: 999 },
        ],
      ]);
      const client = makeClient({ hashes });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 1, needsRehash: 1 });
      expect(client.hashCalls).toEqual([]);
    });

    it('idempotent on a v4 cache (no migration)', async () => {
      // Seed a fresh v4 cache via the normal path, then re-run
      // the migration — it should no-op.
      const svc = new HashService(dir);
      const hashes = new Map([['/p/a', fix('a', 100, 100)]]);
      await svc.getHash(makeClient({ hashes }), 'host-1', ['/p/a']);
      const client2 = makeClient({ hashes });
      const result = await svc.migrateV3Entries(client2, 'host-1');
      expect(result).toEqual({ migrated: 0, needsRehash: 0 });
      expect(client2.hashCalls).toEqual([]);
    });

    it('no-op when there is no cache file', async () => {
      const svc = new HashService(dir);
      const client = makeClient({ hashes: new Map() });
      const result = await svc.migrateV3Entries(client, 'host-empty');
      expect(result).toEqual({ migrated: 0, needsRehash: 0 });
    });

    it('chunks the SSH stat batch at batchSize', async () => {
      // Seed 250 v3 entries; with batchSize=100 the migration
      // should issue 3 statPathsWithSize calls (100 / 100 / 50).
      const entries: Record<
        string,
        {
          md5: string;
          sha1: string;
          size: number;
          mtime: number;
          hashedAt: string;
        }
      > = {};
      const hashes = new Map<string, FixtureHash>();
      for (let i = 0; i < 250; i += 1) {
        const p = `/p/file-${String(i).padStart(3, '0')}`;
        entries[p] = {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 1,
          mtime: i + 1,
          hashedAt: '2025-01-01T00:00:00.000Z',
        };
        hashes.set(p, {
          md5: 'a'.repeat(32),
          sha1: 'b'.repeat(40),
          size: 1,
          diskSize: 1,
          mtime: i + 1,
        });
      }
      await seedV3Cache('host-1', entries);
      const svc = new HashService(dir, { batchSize: 100 });
      const client = makeClient({ hashes });
      // Spy on the stat call boundary by wrapping the mock.
      const statBatchCalls: number[] = [];
      const origStat = client.statPathsWithSize.bind(client);
      client.statPathsWithSize = async (paths) => {
        statBatchCalls.push(paths.length);
        return origStat(paths);
      };
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 250, needsRehash: 0 });
      expect(statBatchCalls).toEqual([100, 100, 50]);
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
      // Bulk hide → both renamed. Distinct mtimes → both migrate.
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([
          ['/p/.A.nes', 1700000001],
          ['/p/.B.nes', 1700000002],
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
      });
      const result = await svc.checkCachedMtimes(client, 'host-1', [newPath]);
      expect(result.entries.get(newPath)?.md5).toBe('a'.repeat(32));
      // Rewritten on disk.
      const file = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { entries: Record<string, FixtureHash> };
      expect(file.entries[newPath]).toBeDefined();
      expect(file.entries[oldPath]).toBeUndefined();
    });
  });

  describe('±2s tolerance on SD-rebuild-style drift (fix/mtime-tolerance)', () => {
    // Models the user's reported scenario: data partition rebuilt
    // onto exFAT/FAT32 rounds mtimes to 2-second resolution, drifting
    // every cached entry by up to 1s. Pre-fix `validated=0
    // needsHash=665` on mame; post-fix all entries match within
    // tolerance and the cache stays warm.

    it('getHash: stat mtime within ±1s of cached → cache hit, no rehash', async () => {
      const svc = new HashService(dir);
      const fixture = fix('a', 100, 1700000000);
      // Seed cache.
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/a', fixture]]) }),
        'host-1',
        ['/p/a'],
      );
      // Reconnect after SD rebuild: stat reports mtime +1s.
      const driftedClient = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 1700000001]]),
      });
      const result = await svc.getHash(driftedClient, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('a'.repeat(32));
      // No new hash call — the tolerance kept the entry warm.
      expect(driftedClient.hashCalls).toEqual([]);
    });

    it('getHash: stat mtime within ±2s (window edge) → cache hit', async () => {
      const svc = new HashService(dir);
      const fixture = fix('a', 100, 1700000000);
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/a', fixture]]) }),
        'host-1',
        ['/p/a'],
      );
      const driftedClient = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 1700000002]]),
      });
      const result = await svc.getHash(driftedClient, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('a'.repeat(32));
      expect(driftedClient.hashCalls).toEqual([]);
    });

    it('getHash: stat mtime ±3s outside window → cache miss, rehash', async () => {
      const svc = new HashService(dir);
      const fixture = fix('a', 100, 1700000000);
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/a', fixture]]) }),
        'host-1',
        ['/p/a'],
      );
      // Drift of 3s = past the tolerance window → genuine
      // file-changed signal.
      const fresh = fix('z', 200, 1700000003);
      const driftedClient = makeClient({
        hashes: new Map([['/p/a', fresh]]),
        stat: new Map([['/p/a', 1700000003]]),
      });
      const result = await svc.getHash(driftedClient, 'host-1', ['/p/a']);
      expect(result.get('/p/a')?.md5).toBe('z'.repeat(32));
      // One rehash call — the cached entry was invalidated.
      expect(driftedClient.hashCalls).toHaveLength(1);
    });

    it('checkCachedMtimes: tolerance match counts under toleranceCount', async () => {
      const svc = new HashService(dir);
      const fixture = fix('a', 100, 1700000000);
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/a', fixture]]) }),
        'host-1',
        ['/p/a'],
      );
      const driftedClient = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 1700000001]]),
      });
      const result = await svc.checkCachedMtimes(driftedClient, 'host-1', [
        '/p/a',
      ]);
      expect(result.entries.get('/p/a')?.md5).toBe('a'.repeat(32));
      expect(result.exactCount).toBe(0);
      expect(result.toleranceCount).toBe(1);
    });

    it('checkCachedMtimes: exact match counts under exactCount, not toleranceCount', async () => {
      const svc = new HashService(dir);
      const fixture = fix('a', 100, 1700000000);
      await svc.getHash(
        makeClient({ hashes: new Map([['/p/a', fixture]]) }),
        'host-1',
        ['/p/a'],
      );
      const exactClient = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 1700000000]]),
      });
      const result = await svc.checkCachedMtimes(exactClient, 'host-1', [
        '/p/a',
      ]);
      expect(result.exactCount).toBe(1);
      expect(result.toleranceCount).toBe(0);
    });

    it('checkCachedMtimes: mtime 0 sentinel is NEVER a hit, even when cached mtime is 0', async () => {
      // The missing-file sentinel is preserved across the tolerance —
      // 0 vs 0 still returns null (the file is gone).
      const svc = new HashService(dir);
      // Synthetic v4 cache entry with mtime 0 (degenerate but valid
      // shape). We can't seed via getHash because hashPaths returns
      // a non-zero mtime; write the cache file directly.
      const cacheDir = join(dir, 'host-1');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify({
          version: 1,
          hashStrategyVersion: 4,
          host: 'host-1',
          entries: {
            '/p/a': {
              md5: 'a'.repeat(32),
              sha1: 'b'.repeat(40),
              size: 100,
              diskSizeBytes: 100,
              mtime: 0,
              hashedAt: '2025-01-01T00:00:00.000Z',
            },
          },
        }),
      );
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/a', 0]]),
      });
      const result = await svc.checkCachedMtimes(client, 'host-1', ['/p/a']);
      expect(result.entries.get('/p/a')).toBeNull();
      expect(result.exactCount).toBe(0);
      expect(result.toleranceCount).toBe(0);
    });

    it('migrateV3Entries: v3 entry within ±1s of stat → migrated, not rehashed', async () => {
      // Seed a v3 cache directly with mtime 1700000000. Stat
      // reports +1s drift (SD-rebuild rounding artifact).
      const cacheDir = join(dir, 'host-1');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify({
          version: 1,
          hashStrategyVersion: 3,
          host: 'host-1',
          entries: {
            '/p/Game.zip': {
              md5: 'a'.repeat(32),
              sha1: 'b'.repeat(40),
              size: 36700160,
              mtime: 1700000000,
              hashedAt: '2025-01-01T00:00:00.000Z',
            },
          },
        }),
      );
      const svc = new HashService(dir);
      const client = makeClient({
        hashes: new Map<string, FixtureHash>([
          [
            '/p/Game.zip',
            {
              md5: 'a'.repeat(32),
              sha1: 'b'.repeat(40),
              size: 36700160,
              diskSize: 14199857,
              mtime: 1700000001,
            },
          ],
        ]),
      });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 1, needsRehash: 0 });
      // Hash NOT recomputed — entry kept verbatim with the v3 mtime.
      expect(client.hashCalls).toEqual([]);
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as {
        entries: Record<string, { md5: string; mtime: number }>;
      };
      expect(raw.entries['/p/Game.zip']?.md5).toBe('a'.repeat(32));
      expect(raw.entries['/p/Game.zip']?.mtime).toBe(1700000000);
    });

    it('migrateV3Entries: v3 entry ±3s outside window → dropped, needs rehash', async () => {
      const cacheDir = join(dir, 'host-1');
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify({
          version: 1,
          hashStrategyVersion: 3,
          host: 'host-1',
          entries: {
            '/p/Stale.zip': {
              md5: 'a'.repeat(32),
              sha1: 'b'.repeat(40),
              size: 1024,
              mtime: 1700000000,
              hashedAt: '2025-01-01T00:00:00.000Z',
            },
          },
        }),
      );
      const svc = new HashService(dir);
      const client = makeClient({
        hashes: new Map(),
        stat: new Map([['/p/Stale.zip', 1700000003]]),
      });
      const result = await svc.migrateV3Entries(client, 'host-1');
      expect(result).toEqual({ migrated: 0, needsRehash: 1 });
    });
  });

  // fix/witness-chunking — pre-fix the witness check was one SSH
  // exec for every path in the input, producing a ~177KB script
  // for NES (681 paths × 3 path-mentions per row). That exceeded
  // ssh2's 32KB exec-channel send window and crashed with EPIPE
  // before busybox saw the command. The chunking helper splits
  // input into `batchSize`-sized SSH calls.
  describe('statWitnesses chunking', () => {
    function manyFixtures(count: number, baseMtime = 1700000000): {
      paths: string[];
      hashes: Map<string, FixtureHash>;
    } {
      const hashes = new Map<string, FixtureHash>();
      const paths: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const p = `/p/file-${String(i).padStart(4, '0')}.bin`;
        paths.push(p);
        // Mtimes shift by 1s per path so an off-by-one in the
        // aggregation would surface as a wrong mtime, not just a
        // count mismatch.
        hashes.set(p, fix(`f${i}`, 1024, baseMtime + i));
      }
      return { paths, hashes };
    }

    it('checkCachedMtimes: 250-path input issues 3 SSH stat calls at default chunk size of 100', async () => {
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(250);
      // Seed cache: a single call covering all 250 will itself
      // chunk through the helper (3 calls), so the seed call's
      // `statCalls` count is 3. The follow-up `checkCachedMtimes`
      // adds 3 more, for 6 total.
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      const client = makeClient({ hashes });
      const result = await svc.checkCachedMtimes(client, 'host-1', paths);
      // All entries validated (exact mtime match → cache hit per path).
      expect(result.entries.size).toBe(250);
      const validatedCount = [...result.entries.values()].filter(
        (v) => v !== null,
      ).length;
      expect(validatedCount).toBe(250);
      expect(result.exactCount).toBe(250);
      // Exactly ceil(250 / 100) = 3 SSH ops for the stat phase.
      expect(client.statCalls).toHaveLength(3);
      expect(client.statCalls[0]).toHaveLength(100);
      expect(client.statCalls[1]).toHaveLength(100);
      expect(client.statCalls[2]).toHaveLength(50);
      // Sanity: no hashes recomputed (every cached entry round-tripped).
      expect(client.hashCalls).toHaveLength(0);
    });

    it('checkCachedMtimes: exact multiple of chunk size produces exactly that many calls', async () => {
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(200);
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      const client = makeClient({ hashes });
      await svc.checkCachedMtimes(client, 'host-1', paths);
      expect(client.statCalls).toHaveLength(2);
      expect(client.statCalls[0]).toHaveLength(100);
      expect(client.statCalls[1]).toHaveLength(100);
    });

    it('checkCachedMtimes: aggregated mtimes preserve per-path identity across chunks', async () => {
      // Off-by-one in the aggregation Object.assign would mis-key
      // chunk-2 paths under chunk-1's keys or vice versa. This
      // test pins per-path mtimes match through the chunk-merge.
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(150);
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      const client = makeClient({ hashes });
      const result = await svc.checkCachedMtimes(client, 'host-1', paths);
      for (const p of paths) {
        const entry = result.entries.get(p);
        expect(entry).not.toBeNull();
        expect(entry?.mtime).toBe(hashes.get(p)?.mtime);
      }
    });

    it('checkCachedMtimes: a single chunk throwing fails the whole call (matches pre-fix posture)', async () => {
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(250);
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      // Custom client where the second statWitnesses call throws.
      const statCalls: string[][] = [];
      let call = 0;
      const client: HashClient & {
        statCalls: string[][];
        hashCalls: string[][];
      } = {
        ...makeClient({ hashes }),
        statCalls,
        async statWitnesses(p: readonly string[]) {
          statCalls.push([...p]);
          call += 1;
          if (call === 2) throw new Error('EPIPE');
          const out: Record<string, number> = {};
          for (const path of p) {
            out[path] = hashes.get(path)?.mtime ?? 0;
          }
          return out;
        },
      };
      const result = await svc.checkCachedMtimes(client, 'host-1', paths);
      // All paths get marked as needs-rehash on a thrown chunk —
      // same posture as the pre-chunking single-call failure.
      expect(result.exactCount).toBe(0);
      expect(result.toleranceCount).toBe(0);
      for (const p of paths) expect(result.entries.get(p)).toBeNull();
      // Chunk 1 succeeded then chunk 2 threw → exactly 2 calls
      // before the helper exits (no chunk 3).
      expect(statCalls).toHaveLength(2);
    });

    it('getHash: 250-path input also chunks the witness stat call', async () => {
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(250);
      // Cold seed → no prior cache → uses the cacheIsEmpty branch
      // which only stats cachedPaths (none). To exercise the
      // mixed-cached path, seed first via getHash, then re-call.
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      const client = makeClient({ hashes });
      const result = await svc.getHash(client, 'host-1', paths);
      expect(result.size).toBe(250);
      // 250 paths × all cached → 3 stat chunks, 0 re-hash chunks.
      expect(client.statCalls).toHaveLength(3);
      expect(client.hashCalls).toHaveLength(0);
    });

    it('empty input: zero SSH calls (chunking helper short-circuits)', async () => {
      const svc = new HashService(dir);
      const client = makeClient({ hashes: new Map() });
      const result = await svc.checkCachedMtimes(client, 'host-1', []);
      expect(result.entries.size).toBe(0);
      expect(client.statCalls).toEqual([]);
    });

    it('NES-sized input (681 paths) drives exactly 7 chunks at default size', async () => {
      // The exact scale the EPIPE-loop bug surfaced at on the
      // user's MiSTer. ceil(681 / 100) = 7.
      const svc = new HashService(dir);
      const { paths, hashes } = manyFixtures(681);
      await svc.getHash(makeClient({ hashes }), 'host-1', paths);

      const client = makeClient({ hashes });
      await svc.checkCachedMtimes(client, 'host-1', paths);
      expect(client.statCalls).toHaveLength(7);
      expect(client.statCalls[6]).toHaveLength(681 - 6 * 100); // 81
    });
  });
});
