import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HashService, type HashClient } from '@app/main/metadata/hash-service';
import type { Md5SumResult } from '@shared/mister-client';

/** Simple in-memory test client. Records every call; lets each test
 * pre-program the responses. */
function makeClient(opts: {
  md5: Map<string, { hash: string; mtime: number }>;
  stat?: Map<string, number>;
  shouldFail?: boolean;
}): HashClient & {
  md5Calls: string[][];
  statCalls: string[][];
} {
  const md5Calls: string[][] = [];
  const statCalls: string[][] = [];
  return {
    md5Calls,
    statCalls,
    async md5sumPaths(paths: readonly string[]): Promise<readonly Md5SumResult[]> {
      md5Calls.push([...paths]);
      if (opts.shouldFail) throw new Error('SSH failure');
      return paths
        .map((p) => {
          const rec = opts.md5.get(p);
          if (!rec) return null;
          return { path: p, hash: rec.hash, mtime: rec.mtime };
        })
        .filter((r): r is Md5SumResult => r !== null);
    },
    async statWitnesses(paths: readonly string[]): Promise<Record<string, number>> {
      statCalls.push([...paths]);
      const out: Record<string, number> = {};
      for (const p of paths) {
        out[p] = opts.stat?.get(p) ?? opts.md5.get(p)?.mtime ?? 0;
      }
      return out;
    },
  };
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
    const client = makeClient({ md5: new Map() });
    const result = await svc.getHash(client, 'host-1', []);
    expect(result.size).toBe(0);
    expect(client.md5Calls).toEqual([]);
    expect(client.statCalls).toEqual([]);
  });

  it('hashes uncached paths via md5sumPaths and writes the cache', async () => {
    const svc = new HashService(dir);
    const md5 = new Map<string, { hash: string; mtime: number }>([
      ['/media/fat/games/A.sfc', { hash: 'a'.repeat(32), mtime: 100 }],
      ['/media/fat/games/B.sfc', { hash: 'b'.repeat(32), mtime: 200 }],
    ]);
    const client = makeClient({ md5 });
    const result = await svc.getHash(client, 'host-1', [
      '/media/fat/games/A.sfc',
      '/media/fat/games/B.sfc',
    ]);
    expect(result.get('/media/fat/games/A.sfc')).toBe('a'.repeat(32));
    expect(result.get('/media/fat/games/B.sfc')).toBe('b'.repeat(32));
    // No stat call — every input was uncached, so we go straight to md5.
    expect(client.statCalls).toEqual([]);
    expect(client.md5Calls).toHaveLength(1);

    // File on disk has the entries.
    const cachePath = join(dir, 'host-1', 'hashes.json');
    const raw = JSON.parse(await fs.readFile(cachePath, 'utf-8')) as {
      version: number;
      host: string;
      entries: Record<string, { hash: string; mtime: number }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.host).toBe('host-1');
    expect(raw.entries['/media/fat/games/A.sfc']?.hash).toBe('a'.repeat(32));
  });

  it('serves cached hashes without re-running md5 when mtime matches', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([
      ['/p/a', { hash: 'a'.repeat(32), mtime: 500 }],
    ]);
    const client = makeClient({ md5 });

    // First call populates the cache.
    await svc.getHash(client, 'host-1', ['/p/a']);
    expect(client.md5Calls).toHaveLength(1);

    // Second call: mtime in stat matches the cached entry, so the
    // md5 call does NOT run again.
    const result = await svc.getHash(client, 'host-1', ['/p/a']);
    expect(result.get('/p/a')).toBe('a'.repeat(32));
    expect(client.md5Calls).toHaveLength(1); // unchanged
    expect(client.statCalls).toHaveLength(1); // exactly one validation
  });

  it('re-hashes when the device mtime drifts from the cached one', async () => {
    const svc = new HashService(dir);
    const stale = { hash: 'a'.repeat(32), mtime: 500 };
    const fresh = { hash: 'c'.repeat(32), mtime: 999 };
    const md5 = new Map([['/p/a', stale]]);
    const client = makeClient({ md5 });

    await svc.getHash(client, 'host-1', ['/p/a']);

    // Simulate the device file getting touched: stat returns a new
    // mtime, md5 returns a new hash.
    md5.set('/p/a', fresh);
    const stat = new Map([['/p/a', 999]]);
    const client2 = makeClient({ md5, stat });

    const result = await svc.getHash(client2, 'host-1', ['/p/a']);
    expect(result.get('/p/a')).toBe('c'.repeat(32));
    expect(client2.md5Calls).toHaveLength(1);
  });

  it('does not write a partial cache on SSH failure', async () => {
    const svc = new HashService(dir);
    const client = makeClient({ md5: new Map(), shouldFail: true });
    await expect(svc.getHash(client, 'host-1', ['/x'])).rejects.toThrow(
      'SSH failure',
    );
    // No cache file should exist.
    const exists = await fs
      .stat(join(dir, 'host-1', 'hashes.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('chunks 250 paths into 3 md5sumPaths calls (100 / 100 / 50)', async () => {
    const svc = new HashService(dir, { batchSize: 100 });
    const md5 = new Map<string, { hash: string; mtime: number }>();
    const paths: string[] = [];
    for (let i = 0; i < 250; i += 1) {
      const p = `/p/file-${String(i).padStart(3, '0')}`;
      paths.push(p);
      md5.set(p, { hash: 'a'.repeat(32), mtime: i + 1 });
    }
    const client = makeClient({ md5 });
    const result = await svc.getHash(client, 'host-1', paths);
    expect(result.size).toBe(250);
    expect(client.md5Calls).toHaveLength(3);
    expect(client.md5Calls[0]?.length).toBe(100);
    expect(client.md5Calls[1]?.length).toBe(100);
    expect(client.md5Calls[2]?.length).toBe(50);
  });

  it('respects a custom batchSize override', async () => {
    const svc = new HashService(dir, { batchSize: 25 });
    const md5 = new Map<string, { hash: string; mtime: number }>();
    const paths: string[] = [];
    for (let i = 0; i < 60; i += 1) {
      const p = `/p/${String(i)}`;
      paths.push(p);
      md5.set(p, { hash: 'a'.repeat(32), mtime: i });
    }
    const client = makeClient({ md5 });
    await svc.getHash(client, 'host-1', paths);
    expect(client.md5Calls.map((c) => c.length)).toEqual([25, 25, 10]);
  });

  it('drops paths the device says don\'t exist (md5 returns nothing for them)', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([['/p/exists', { hash: 'a'.repeat(32), mtime: 100 }]]);
    const client = makeClient({ md5 });
    const result = await svc.getHash(client, 'host-1', ['/p/exists', '/p/missing']);
    expect(result.size).toBe(1);
    expect(result.get('/p/exists')).toBe('a'.repeat(32));
    expect(result.has('/p/missing')).toBe(false);
  });

  it('partitions hosts so two profiles never share entries', async () => {
    const svc = new HashService(dir);
    const md5A = new Map([['/p/x', { hash: 'a'.repeat(32), mtime: 1 }]]);
    const md5B = new Map([['/p/x', { hash: 'b'.repeat(32), mtime: 2 }]]);

    await svc.getHash(makeClient({ md5: md5A }), 'host-A', ['/p/x']);
    await svc.getHash(makeClient({ md5: md5B }), 'host-B', ['/p/x']);

    const a = JSON.parse(
      await fs.readFile(join(dir, 'host-A', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, { hash: string }> };
    const b = JSON.parse(
      await fs.readFile(join(dir, 'host-B', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, { hash: string }> };
    expect(a.entries['/p/x']?.hash).toBe('a'.repeat(32));
    expect(b.entries['/p/x']?.hash).toBe('b'.repeat(32));
  });

  it('invalidate removes one entry from the cache', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([
      ['/p/a', { hash: 'a'.repeat(32), mtime: 1 }],
      ['/p/b', { hash: 'b'.repeat(32), mtime: 2 }],
    ]);
    await svc.getHash(makeClient({ md5 }), 'host-1', ['/p/a', '/p/b']);
    await svc.invalidate('host-1', '/p/a');

    const file = JSON.parse(
      await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
    ) as { entries: Record<string, unknown> };
    expect(file.entries['/p/a']).toBeUndefined();
    expect(file.entries['/p/b']).toBeDefined();
  });

  it('clearForHost removes the cache file', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([['/p/a', { hash: 'a'.repeat(32), mtime: 1 }]]);
    await svc.getHash(makeClient({ md5 }), 'host-1', ['/p/a']);
    await svc.clearForHost('host-1');
    const exists = await fs
      .stat(join(dir, 'host-1', 'hashes.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('serializes concurrent calls per host (overlapping paths share work)', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([
      ['/p/a', { hash: 'a'.repeat(32), mtime: 1 }],
      ['/p/b', { hash: 'b'.repeat(32), mtime: 2 }],
    ]);
    const client = makeClient({ md5 });

    // Both calls request /p/a; the second should observe A's cache
    // hit and not re-run md5 for that path.
    const [r1, r2] = await Promise.all([
      svc.getHash(client, 'host-1', ['/p/a']),
      svc.getHash(client, 'host-1', ['/p/a', '/p/b']),
    ]);
    expect(r1.get('/p/a')).toBe('a'.repeat(32));
    expect(r2.get('/p/a')).toBe('a'.repeat(32));
    expect(r2.get('/p/b')).toBe('b'.repeat(32));
    // Total md5 calls: one for the first call (/p/a), one for the
    // second (/p/b only — /p/a is now cached). If the gate were
    // missing, /p/a would be hashed twice.
    const allHashed = client.md5Calls.flat();
    expect(allHashed.filter((p) => p === '/p/a')).toHaveLength(1);
    expect(allHashed.filter((p) => p === '/p/b')).toHaveLength(1);
  });

  it('survives a corrupted cache file by treating it as empty', async () => {
    const svc = new HashService(dir);
    const cacheDir = join(dir, 'host-1');
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(join(cacheDir, 'hashes.json'), 'this is not json');

    const md5 = new Map([['/p/a', { hash: 'a'.repeat(32), mtime: 1 }]]);
    const result = await svc.getHash(makeClient({ md5 }), 'host-1', ['/p/a']);
    expect(result.get('/p/a')).toBe('a'.repeat(32));
  });

  it('treats device mtime 0 (file missing) as cache miss', async () => {
    const svc = new HashService(dir);
    const md5 = new Map([['/p/a', { hash: 'a'.repeat(32), mtime: 100 }]]);
    await svc.getHash(makeClient({ md5 }), 'host-1', ['/p/a']);

    // Simulate the file being deleted: stat returns 0, md5 returns
    // nothing. The result map should be empty (the path is gone),
    // and the in-memory entry preserved (we didn't get a new
    // observation to overwrite it with).
    const stat = new Map([['/p/a', 0]]);
    const client = makeClient({ md5: new Map(), stat });
    const result = await svc.getHash(client, 'host-1', ['/p/a']);
    expect(result.size).toBe(0);
    // md5 was attempted (mtime 0 looks like drift) but the device
    // returned no record, so result is empty.
    expect(client.md5Calls).toHaveLength(1);
  });

  describe('round 7 — hashStrategyVersion invalidation', () => {
    /** Pre-write a cache file with the supplied shape, then read. */
    async function seedCache(host: string, raw: unknown): Promise<void> {
      const cacheDir = join(dir, host);
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(
        join(cacheDir, 'hashes.json'),
        JSON.stringify(raw, null, 2),
      );
    }

    it('writes hashStrategyVersion: 2 alongside the v1 schema field', async () => {
      const svc = new HashService(dir);
      const md5 = new Map([['/p/a', { hash: 'a'.repeat(32), mtime: 1 }]]);
      await svc.getHash(makeClient({ md5 }), 'host-1', ['/p/a']);
      const raw = JSON.parse(
        await fs.readFile(join(dir, 'host-1', 'hashes.json'), 'utf-8'),
      ) as { version: number; hashStrategyVersion: number };
      expect(raw.version).toBe(1);
      expect(raw.hashStrategyVersion).toBe(2);
    });

    it('treats a pre-round-7 cache (no hashStrategyVersion) as an invalid file', async () => {
      // Pre-round-7 file: schema version 1, no hashStrategyVersion
      // field. Hashes inside were produced by the v1 algorithm
      // (direct md5sum of .zip wrappers) — round 6+ algorithm
      // disagrees, so we must NOT serve them.
      await seedCache('host-1', {
        version: 1,
        host: 'host-1',
        entries: {
          '/p/a': {
            hash: 'wrong-old-hash'.padEnd(32, 'x').slice(0, 32),
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      const md5 = new Map([['/p/a', { hash: 'a'.repeat(32), mtime: 100 }]]);
      const client = makeClient({ md5 });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      // The OLD wrong-shaped hash got dropped; the NEW algorithm
      // re-hashed and returned the correct value.
      expect(result.get('/p/a')).toBe('a'.repeat(32));
      // No stat call was issued (cache treated as empty); md5 was.
      expect(client.statCalls).toEqual([]);
      expect(client.md5Calls).toHaveLength(1);
    });

    it('treats a cache with mismatched hashStrategyVersion as invalid', async () => {
      // Future-version file (e.g. someone manually set v3) — we
      // can't trust its values either.
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 999,
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
      const md5 = new Map([['/p/a', { hash: 'b'.repeat(32), mtime: 100 }]]);
      const client = makeClient({ md5 });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')).toBe('b'.repeat(32));
      expect(client.md5Calls).toHaveLength(1);
    });

    it('serves a cache with matching hashStrategyVersion without re-hashing', async () => {
      await seedCache('host-1', {
        version: 1,
        hashStrategyVersion: 2,
        host: 'host-1',
        entries: {
          '/p/a': {
            hash: 'c'.repeat(32),
            mtime: 100,
            hashedAt: '2025-01-01T00:00:00.000Z',
          },
        },
      });
      const svc = new HashService(dir);
      // mtime in stat matches the cached entry → cache hit, no md5.
      const client = makeClient({
        md5: new Map(),
        stat: new Map([['/p/a', 100]]),
      });
      const result = await svc.getHash(client, 'host-1', ['/p/a']);
      expect(result.get('/p/a')).toBe('c'.repeat(32));
      expect(client.md5Calls).toEqual([]);
    });
  });
});
