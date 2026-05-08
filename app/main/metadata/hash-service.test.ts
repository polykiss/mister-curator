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
});
