import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CacheManager } from '@app/main/cache/cache-manager';
import {
  CACHE_SCHEMA_VERSION,
  ROMS_CACHE_FILE_BUDGET,
  sanitiseFsSegment,
  witnessesMatch,
  type CacheEvent,
} from '@app/main/cache/cache-types';
import type { CoreEntry, Rom } from '@shared/types';

// Build a minimal `CoreEntry` for fixtures. Only the fields the cache
// guard checks need to be valid; the rest is opaque payload.
function fakeCore(id: string, romCount = 0): CoreEntry {
  return {
    id,
    name: id,
    romCount,
    hiddenCount: 0,
    category: 'Console',
    rbfPaths: [`/media/fat/_Console/${id}.rbf`],
    gamesDirExists: true,
    gamesDirHidden: false,
    gamesDirName: id,
  };
}

function fakeRom(filename: string, sizeBytes = 1024): Rom {
  return {
    coreId: 'NES',
    filename,
    displayName: filename,
    sizeBytes,
    hidden: false,
    path: `/media/fat/games/NES/${filename}`,
    kind: 'file',
  };
}

describe('CacheManager — cores cache', () => {
  let root: string;
  let events: CacheEvent[];
  let cm: CacheManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mc-cache-test-'));
    events = [];
    cm = new CacheManager(root, { onEvent: (e) => events.push(e) });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('returns null on first read (cold cache → miss)', async () => {
    const result = await cm.getCoresCache('192.168.1.42');
    expect(result).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'miss', surface: 'cores' });
  });

  it('round-trips: setCoresCache then getCoresCache returns the same data + witnesses', async () => {
    const data = [fakeCore('NES', 47), fakeCore('SNES', 12)];
    const witnesses = {
      '/media/fat/_Console': 1700000000,
      '/media/fat/games': 1700000010,
    };

    await cm.setCoresCache('host-a', data, witnesses);
    const got = await cm.getCoresCache('host-a');

    expect(got).not.toBeNull();
    expect(got?.version).toBe(CACHE_SCHEMA_VERSION);
    expect(got?.host).toBe('host-a');
    expect(got?.witnesses).toEqual(witnesses);
    expect(got?.data).toEqual(data);
    // Each cache op fires exactly one event.
    expect(events.map((e) => e.kind)).toEqual(['write']);
  });

  it('isolates cache per host', async () => {
    await cm.setCoresCache('host-a', [fakeCore('NES')], { '/media/fat/games': 1 });
    await cm.setCoresCache('host-b', [fakeCore('SNES')], { '/media/fat/games': 2 });

    const a = await cm.getCoresCache('host-a');
    const b = await cm.getCoresCache('host-b');

    expect(a?.data[0]?.id).toBe('NES');
    expect(b?.data[0]?.id).toBe('SNES');
  });

  it('returns null when the on-disk file has a wrong schemaVersion', async () => {
    const dir = join(root, sanitiseFsSegment('host-a'));
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'cores.json'),
      JSON.stringify({ version: 999, host: 'host-a', cachedAt: '', witnesses: {}, data: [] }),
    );

    const got = await cm.getCoresCache('host-a');
    expect(got).toBeNull();
    expect(events.find((e) => e.note === 'schema mismatch')).toBeDefined();
  });

  it('returns null when the JSON is corrupt', async () => {
    const dir = join(root, sanitiseFsSegment('host-a'));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'cores.json'), '{ this is not json');

    const got = await cm.getCoresCache('host-a');
    expect(got).toBeNull();
  });

  // feat/cache-miss-observability — `cache.miss` events historically
  // fired with NO `note` field for both file-missing and corrupt-JSON
  // cases, hiding any silent-failure mode behind the expected cold-
  // cache case. The next live-verify against 192.168.50.194 needs the
  // `note=` to conclusively identify why `readJsonOrNull` returns null
  // when the on-disk file appears intact.
  describe('readJsonOrNull failure-reason surfaces in cache.miss note', () => {
    it("file missing → cache.miss carries note='enoent'", async () => {
      // Fresh state: nothing on disk for host-a.
      await cm.getCoresCache('host-a');
      const miss = events.find((e) => e.kind === 'miss');
      expect(miss).toMatchObject({
        kind: 'miss',
        surface: 'cores',
        host: 'host-a',
        note: 'enoent',
      });
    });

    it("corrupt JSON → cache.miss carries note='syntax'", async () => {
      const dir = join(root, sanitiseFsSegment('host-a'));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'cores.json'), '{ this is not json');

      await cm.getCoresCache('host-a');
      const miss = events.find((e) => e.kind === 'miss');
      expect(miss).toMatchObject({
        kind: 'miss',
        surface: 'cores',
        host: 'host-a',
        note: 'syntax',
      });
    });

    it("other fs error (path is a directory → EISDIR) → cache.miss carries note='other' AND error is logged", async () => {
      // Writing a DIRECTORY at the cache file's expected path makes
      // fs.readFile throw EISDIR — neither ENOENT nor SyntaxError.
      // Pre-fix this case THREW out of readJsonOrNull and bubbled up
      // to the caller; post-fix it returns reason='other' and logs
      // the underlying error so the silent-failure path surfaces.
      const dir = join(root, sanitiseFsSegment('host-a'));
      await mkdir(dir, { recursive: true });
      await mkdir(join(dir, 'cores.json'), { recursive: true });

      const errorSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      try {
        const got = await cm.getCoresCache('host-a');
        expect(got).toBeNull();
        const miss = events.find((e) => e.kind === 'miss');
        expect(miss).toMatchObject({
          kind: 'miss',
          surface: 'cores',
          host: 'host-a',
          note: 'other',
        });
        // The 'other' branch must log so the underlying error
        // shows up in dev logs. Match loosely on the message
        // prefix; the second arg should be the captured error.
        expect(errorSpy).toHaveBeenCalled();
        const call = errorSpy.mock.calls[0];
        expect(call?.[0]).toMatch(/readJsonOrNull/);
      } finally {
        errorSpy.mockRestore();
      }
    });

    it('arcade surface carries the same reason note', async () => {
      // Same observability contract on the arcade-mra-meta cache.
      await cm.getArcadeMraMetaCache('host-a');
      const miss = events.find(
        (e) => e.kind === 'miss' && e.surface === 'arcade',
      );
      expect(miss).toMatchObject({
        kind: 'miss',
        surface: 'arcade',
        host: 'host-a',
        note: 'enoent',
      });
    });

    it('roms surface carries the reason on a cold cache', async () => {
      await cm.getRomsCache('host-a', 'NES', '');
      const miss = events.find(
        (e) => e.kind === 'miss' && e.surface === 'roms',
      );
      expect(miss).toMatchObject({
        kind: 'miss',
        surface: 'roms',
        host: 'host-a',
        coreId: 'NES',
        subPath: '',
        note: 'enoent',
      });
    });

    it("roms surface — corrupt file → cache.miss note='syntax'", async () => {
      const dir = join(root, sanitiseFsSegment('host-a'), 'roms');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'NES.json'), '{ this is not json');

      await cm.getRomsCache('host-a', 'NES', '');
      const miss = events.find(
        (e) => e.kind === 'miss' && e.surface === 'roms',
      );
      expect(miss).toMatchObject({ note: 'syntax' });
    });

    it("roms surface — schema mismatch still surfaces note='schema mismatch' (unchanged)", async () => {
      // Pre-fix the roms read swallowed schema mismatches as a no-
      // note miss. The new path threads them through to the event.
      const dir = join(root, sanitiseFsSegment('host-a'), 'roms');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'NES.json'),
        JSON.stringify({
          version: 999,
          host: 'host-a',
          coreId: 'NES',
          bySubPath: {},
        }),
      );

      await cm.getRomsCache('host-a', 'NES', '');
      const miss = events.find(
        (e) => e.kind === 'miss' && e.surface === 'roms',
      );
      expect(miss).toMatchObject({ note: 'schema mismatch' });
    });
  });

  it('invalidateCoresCache removes the file and emits invalidate', async () => {
    await cm.setCoresCache('host-a', [], { '/media/fat/games': 1 });
    await cm.invalidateCoresCache('host-a');

    const got = await cm.getCoresCache('host-a');
    expect(got).toBeNull();
    expect(events.map((e) => e.kind)).toContain('invalidate');
  });

  it('invalidateCoresCache is idempotent on a missing file', async () => {
    // No setup — file doesn't exist.
    await cm.invalidateCoresCache('host-a');
    // No invalidate event because there was nothing to remove. Avoids
    // misleading observability.
    expect(events.filter((e) => e.kind === 'invalidate')).toHaveLength(0);
  });

  it('writes are atomic — the temp file is renamed, not written in place', async () => {
    // The sequence write-tmp + rename means a crash mid-write leaves
    // either the old file or no file, never a partial JSON.
    const data = [fakeCore('NES')];
    await cm.setCoresCache('host-a', data, { p: 1 });

    const dir = join(root, sanitiseFsSegment('host-a'));
    const got = await readFile(join(dir, 'cores.json'), 'utf-8');
    expect(got).toContain('"version": 1');
    // No leftover .tmp file.
    await expect(readFile(join(dir, 'cores.json.tmp'), 'utf-8')).rejects.toThrow();
  });
});

describe('CacheManager — roms cache', () => {
  let root: string;
  let events: CacheEvent[];
  let cm: CacheManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mc-cache-test-'));
    events = [];
    cm = new CacheManager(root, { onEvent: (e) => events.push(e) });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('separate slots per (coreId, subPath) within one core file', async () => {
    const topLevel = [fakeRom('1942.zip')];
    const drilled = [fakeRom('mslug.zip'), fakeRom('kof97.zip')];

    await cm.setRomsCache('host-a', 'NEOGEO', '', topLevel, {
      '/media/fat/games/NEOGEO': 1,
    });
    await cm.setRomsCache('host-a', 'NEOGEO', '1 World A-Z', drilled, {
      '/media/fat/games/NEOGEO/1 World A-Z': 2,
    });

    const top = await cm.getRomsCache('host-a', 'NEOGEO', '');
    const drill = await cm.getRomsCache('host-a', 'NEOGEO', '1 World A-Z');

    expect(top?.data).toEqual(topLevel);
    expect(drill?.data).toEqual(drilled);
    expect(top?.witnesses['/media/fat/games/NEOGEO']).toBe(1);
    expect(drill?.witnesses['/media/fat/games/NEOGEO/1 World A-Z']).toBe(2);
  });

  it('a second write to the same subPath overwrites the slot, not the file', async () => {
    await cm.setRomsCache('host-a', 'NES', '', [fakeRom('a.nes')], { p: 1 });
    await cm.setRomsCache('host-a', 'NES', 'sub', [fakeRom('s.nes')], { p: 2 });
    // Replace top-level only.
    await cm.setRomsCache('host-a', 'NES', '', [fakeRom('b.nes')], { p: 3 });

    const top = await cm.getRomsCache('host-a', 'NES', '');
    const sub = await cm.getRomsCache('host-a', 'NES', 'sub');

    // Top-level updated.
    expect(top?.data[0]?.filename).toBe('b.nes');
    expect(top?.witnesses).toEqual({ p: 3 });
    // Sub-path slot unchanged.
    expect(sub?.data[0]?.filename).toBe('s.nes');
    expect(sub?.witnesses).toEqual({ p: 2 });
  });

  it('getRomsCache returns null when the subPath slot is absent', async () => {
    await cm.setRomsCache('host-a', 'NES', '', [], { p: 1 });
    const got = await cm.getRomsCache('host-a', 'NES', 'unknown-sub');
    expect(got).toBeNull();
  });

  it('invalidateRomsCache deletes the whole core file (drops every subPath slot)', async () => {
    await cm.setRomsCache('host-a', 'NES', '', [], { p: 1 });
    await cm.setRomsCache('host-a', 'NES', 'sub', [], { p: 2 });

    await cm.invalidateRomsCache('host-a', 'NES');

    expect(await cm.getRomsCache('host-a', 'NES', '')).toBeNull();
    expect(await cm.getRomsCache('host-a', 'NES', 'sub')).toBeNull();
  });

  it('LRU eviction trims oldest cores when the file budget is exceeded', async () => {
    // Insert budget+5 cores, each with cachedAt advancing forward in
    // wall-clock time so the order is deterministic.
    const total = ROMS_CACHE_FILE_BUDGET + 5;
    for (let i = 0; i < total; i += 1) {
      const id = `Core${String(i).padStart(3, '0')}`;
      await cm.setRomsCache('host-a', id, '', [fakeRom(`${id}.zip`)], {
        p: i,
      });
    }

    const evictEvents = events.filter((e) => e.kind === 'evict');
    // Each insert past the budget evicts one — total should be 5.
    expect(evictEvents).toHaveLength(5);
    // The oldest 5 by cachedAt are evicted (Core000..Core004).
    const evictedIds = evictEvents
      .map((e) => e.evictedCoreId)
      .sort((a, b) => (a ?? '').localeCompare(b ?? ''));
    expect(evictedIds).toEqual([
      'Core000',
      'Core001',
      'Core002',
      'Core003',
      'Core004',
    ]);
    // Oldest evictees no longer readable.
    expect(await cm.getRomsCache('host-a', 'Core000', '')).toBeNull();
    // Newest survives.
    expect(await cm.getRomsCache('host-a', `Core${String(total - 1).padStart(3, '0')}`, '')).not.toBeNull();
  });
});

describe('CacheManager — host-wide ops', () => {
  let root: string;
  let cm: CacheManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mc-cache-test-'));
    cm = new CacheManager(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('clearHost removes every cache file for the named host', async () => {
    await cm.setCoresCache('host-a', [fakeCore('NES')], { p: 1 });
    await cm.setRomsCache('host-a', 'NES', '', [fakeRom('a.nes')], { p: 1 });
    await cm.setRomsCache('host-a', 'SNES', '', [fakeRom('b.sfc')], { p: 1 });
    // Different host stays.
    await cm.setCoresCache('host-b', [], { p: 1 });

    await cm.clearHost('host-a');

    expect(await cm.getCoresCache('host-a')).toBeNull();
    expect(await cm.getRomsCache('host-a', 'NES', '')).toBeNull();
    expect(await cm.getRomsCache('host-a', 'SNES', '')).toBeNull();
    expect(await cm.getCoresCache('host-b')).not.toBeNull();
  });
});

describe('sanitiseFsSegment', () => {
  it('strips path-traversal and slashes', () => {
    // `../etc/passwd` → `.._etc_passwd` after the slash replace, then
    // the leading-dots collapse turns the `..` into one `_`, yielding
    // `__etc_passwd` (the second `_` is the slash). Result stays
    // anchored in the cache dir.
    expect(sanitiseFsSegment('../etc/passwd')).toBe('__etc_passwd');
    expect(sanitiseFsSegment('a/b\\c')).toBe('a_b_c');
  });

  it('keeps ASCII alphanumerics + . _ -', () => {
    expect(sanitiseFsSegment('192.168.1.42')).toBe('192.168.1.42');
    expect(sanitiseFsSegment('host-a_b.c')).toBe('host-a_b.c');
  });

  it('replaces leading dots so the cache file isn’t hidden on disk', () => {
    expect(sanitiseFsSegment('.hiddenCore')).toBe('_hiddenCore');
    expect(sanitiseFsSegment('..weird')).toBe('_weird');
  });

  it('non-ASCII falls back to underscore', () => {
    expect(sanitiseFsSegment('café')).toBe('caf_');
  });

  it('empty / single-dot inputs become an underscore (never the cache root itself)', () => {
    expect(sanitiseFsSegment('')).toBe('_');
    expect(sanitiseFsSegment('.')).toBe('_');
    expect(sanitiseFsSegment('..')).toBe('_');
  });
});

describe('witnessesMatch', () => {
  it('exact match → true', () => {
    // Use values well outside the ±2s tolerance window so the test
    // pins exact-equality behavior independent of tolerance.
    expect(witnessesMatch({ a: 100, b: 200 }, { a: 100, b: 200 })).toBe(
      true,
    );
  });

  it('any single mtime mismatch outside the tolerance window → false', () => {
    // fix/mtime-tolerance — widened from (1 vs 2) to (1 vs 100) so
    // the assertion targets the genuine-mismatch case, not the
    // SD-rebuild rounding artifact (which the tolerance now allows).
    expect(witnessesMatch({ a: 1 }, { a: 100 })).toBe(false);
  });

  it('mtime within ±2s of cached → true (SD-rebuild tolerance)', () => {
    // fix/mtime-tolerance regression pin: exFAT / FAT32 round mtimes
    // to 2-second resolution, so a rebuilt SD's stat output drifts
    // every cached witness by ≤1s. Strict equality treated these as
    // misses and forced a full cores/roms cache rebuild every
    // reconnect.
    expect(witnessesMatch({ a: 100 }, { a: 101 })).toBe(true);
    expect(witnessesMatch({ a: 100 }, { a: 99 })).toBe(true);
    expect(witnessesMatch({ a: 100 }, { a: 102 })).toBe(true); // window edge
    expect(witnessesMatch({ a: 100 }, { a: 98 })).toBe(true); // window edge
  });

  it('mtime ±3s outside the tolerance window → false', () => {
    expect(witnessesMatch({ a: 100 }, { a: 103 })).toBe(false);
    expect(witnessesMatch({ a: 100 }, { a: 97 })).toBe(false);
  });

  it('different key sets → false', () => {
    expect(witnessesMatch({ a: 100 }, { a: 100, b: 200 })).toBe(false);
    expect(witnessesMatch({ a: 100, b: 200 }, { a: 100 })).toBe(false);
  });

  it('mtime 0 (path missing on device) is always a mismatch even if both sides agree', () => {
    // The path went away. Anything we cached for it is by definition
    // stale — never a hit. Tolerance never widens this case.
    expect(witnessesMatch({ a: 0 }, { a: 0 })).toBe(false);
    expect(witnessesMatch({ a: 0, b: 100 }, { a: 0, b: 100 })).toBe(false);
  });

  it('order-independent across keys', () => {
    expect(witnessesMatch({ a: 100, b: 200 }, { b: 200, a: 100 })).toBe(
      true,
    );
  });

  // Phase 2 — cores cache flipped from mtime witnesses to content-
  // hash witnesses. The comparator now branches on `typeof` to keep
  // both flavours in one storage union. These cases pin the
  // content-hash branch alongside the existing mtime branch above.
  describe('content-hash flavour (Phase 2)', () => {
    const H1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const H2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    it('same hash on both sides → true (same .rbf set in the dir)', () => {
      expect(witnessesMatch({ a: H1, b: H2 }, { a: H1, b: H2 })).toBe(true);
    });

    it('any per-key hash mismatch → false (one .rbf added or removed)', () => {
      expect(witnessesMatch({ a: H1 }, { a: H2 })).toBe(false);
    });

    it('mixed cached-mtime / fresh-hash (pre-Phase-2 cores.json) → false', () => {
      // Type mismatch is a "kind drift" — cached was written by an
      // older code path with mtime numbers; new code emits hashes.
      // Cache invalidates and self-heals on the next walk.
      expect(witnessesMatch({ a: 100 }, { a: H1 })).toBe(false);
      expect(witnessesMatch({ a: H1 }, { a: 100 })).toBe(false);
    });

    it('the `\'0\'` missing sentinel never matches anything, not even another `\'0\'`', () => {
      // Same contract as the mtime `0` — a vanished dir is always
      // a mismatch so we never serve stale cache for it.
      expect(witnessesMatch({ a: '0' }, { a: '0' })).toBe(false);
      expect(witnessesMatch({ a: '0', b: H1 }, { a: '0', b: H1 })).toBe(false);
    });

    it('empty-dir hash (md5 of empty input) matches itself', () => {
      // Two paths that both contain zero .rbf/.mgl files produce
      // the same well-known md5-of-empty digest. They match — the
      // dirs are equivalent for the cores list's purposes.
      const EMPTY_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
      expect(
        witnessesMatch({ a: EMPTY_MD5 }, { a: EMPTY_MD5 }),
      ).toBe(true);
    });

    it('content-hash branch has no ±2 tolerance window (exact match required)', () => {
      // The mtime branch widens by ±2s for FAT/exFAT rounding. The
      // content-hash branch is strict — a 1-char digest difference
      // means at least one file changed; that's a real invalidate.
      const off = `${H1.slice(0, 31)}b`;
      expect(witnessesMatch({ a: H1 }, { a: off })).toBe(false);
    });
  });
});

describe('CacheManager — observability hooks (PR #12 round 3)', () => {
  let root: string;
  let events: CacheEvent[];
  let cm: CacheManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mc-cache-events-'));
    events = [];
    cm = new CacheManager(root, { onEvent: (e) => events.push(e) });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('recordHit fires `cache.hit` with the cores surface', () => {
    cm.recordHit('cores', { host: 'h1' });
    expect(events).toEqual([{ kind: 'hit', surface: 'cores', host: 'h1' }]);
  });

  it('recordHit fires `cache.hit` with the roms surface and per-call context', () => {
    cm.recordHit('roms', { host: 'h1', coreId: 'NES', subPath: '' });
    cm.recordHit('roms', { host: 'h1', coreId: 'NEOGEO', subPath: '1 World A-Z' });
    expect(events).toEqual([
      { kind: 'hit', surface: 'roms', host: 'h1', coreId: 'NES', subPath: '' },
      {
        kind: 'hit',
        surface: 'roms',
        host: 'h1',
        coreId: 'NEOGEO',
        subPath: '1 World A-Z',
      },
    ]);
  });

  it('recordStale fires `cache.stale` distinct from `cache.miss`', () => {
    // Use case: file existed and schema-validated, but witnesses
    // moved on. Distinct from miss (file absent / corrupt).
    cm.recordStale('cores', { host: 'h1' });
    cm.recordStale('roms', { host: 'h1', coreId: 'NES', subPath: '' });
    expect(events.map((e) => e.kind)).toEqual(['stale', 'stale']);
    expect(events[0]?.surface).toBe('cores');
    expect(events[1]?.surface).toBe('roms');
  });

  it('invalidateCoresCache forwards the optional note onto the event', async () => {
    // The catch-block recovery paths in ConnectionManager pass
    // `note: 'write-failed'` so dev logs distinguish recovery
    // invalidates from routine user-initiated ones.
    await cm.setCoresCache('h1', [], { p: 1 });
    events.length = 0;
    await cm.invalidateCoresCache('h1', { note: 'write-failed' });
    expect(events).toEqual([
      { kind: 'invalidate', surface: 'cores', host: 'h1', note: 'write-failed' },
    ]);
  });

  it('invalidateRomsCache forwards the optional note onto the event', async () => {
    await cm.setRomsCache('h1', 'NES', '', [], { p: 1 });
    events.length = 0;
    await cm.invalidateRomsCache('h1', 'NES', { note: 'write-failed' });
    expect(events).toEqual([
      {
        kind: 'invalidate',
        surface: 'roms',
        host: 'h1',
        coreId: 'NES',
        note: 'write-failed',
      },
    ]);
  });

  it('invalidate methods omit the note field when none is supplied', async () => {
    // Backward-compat: the existing invalidate event shape is
    // `{ kind, surface, host[, coreId] }` with no note for routine
    // invalidates. Adding the optional note must not surface as
    // `note: undefined` on existing callers.
    await cm.setCoresCache('h1', [], { p: 1 });
    events.length = 0;
    await cm.invalidateCoresCache('h1');
    expect(events).toEqual([{ kind: 'invalidate', surface: 'cores', host: 'h1' }]);
  });
});
