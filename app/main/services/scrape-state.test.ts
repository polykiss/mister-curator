import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ScrapeStateStore } from '@app/main/services/scrape-state';

/**
 * feat/auto-scrape-persistence — `ScrapeStateStore` records when
 * each core last finished a full scrape pass, keyed by host.
 * Engine + wiring layers consume this to skip warm cores on
 * re-connect.
 */

describe('ScrapeStateStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-scrape-state-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns an empty map for a host with no file yet', async () => {
    const store = new ScrapeStateStore(dir);
    const m = await store.load('host-1');
    expect(m.size).toBe(0);
  });

  it('markScraped persists ISO timestamp + load returns it', async () => {
    const fixedNow = new Date('2026-05-10T12:34:56.000Z');
    const store = new ScrapeStateStore(dir, { now: () => fixedNow });
    await store.markScraped('host-1', 'NES');
    const m = await store.load('host-1');
    expect(m.get('NES')).toBe('2026-05-10T12:34:56.000Z');
  });

  it('persists across instances (atomic disk rewrite)', async () => {
    const fixedNow = new Date('2026-05-10T12:00:00.000Z');
    const store1 = new ScrapeStateStore(dir, { now: () => fixedNow });
    await store1.markScraped('host-1', 'SNES');
    // Fresh instance reads from disk.
    const store2 = new ScrapeStateStore(dir);
    const m = await store2.load('host-1');
    expect(m.get('SNES')).toBe('2026-05-10T12:00:00.000Z');
  });

  it('partitions hosts so two profiles never share entries', async () => {
    const store = new ScrapeStateStore(dir, {
      now: () => new Date('2026-05-10T00:00:00.000Z'),
    });
    await store.markScraped('host-A', 'NES');
    await store.markScraped('host-B', 'SNES');
    const a = await store.load('host-A');
    const b = await store.load('host-B');
    expect(a.has('NES')).toBe(true);
    expect(a.has('SNES')).toBe(false);
    expect(b.has('SNES')).toBe(true);
    expect(b.has('NES')).toBe(false);
  });

  it('clear drops one core but leaves the rest', async () => {
    const store = new ScrapeStateStore(dir, {
      now: () => new Date('2026-05-10T00:00:00.000Z'),
    });
    await store.markScraped('host-1', 'NES');
    await store.markScraped('host-1', 'SNES');
    await store.clear('host-1', 'NES');
    const m = await store.load('host-1');
    expect(m.has('NES')).toBe(false);
    expect(m.has('SNES')).toBe(true);
  });

  it('clearForHost wipes the file', async () => {
    const store = new ScrapeStateStore(dir);
    await store.markScraped('host-1', 'NES');
    await store.clearForHost('host-1');
    const exists = await fs
      .stat(join(dir, 'host-1', 'scrape-state.json'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
    // Subsequent load returns empty (and doesn't choke on missing file).
    const m = await store.load('host-1');
    expect(m.size).toBe(0);
  });

  it('coresScrapedWithin returns only entries within the time window', async () => {
    let now = new Date('2026-05-10T12:00:00.000Z');
    const store = new ScrapeStateStore(dir, { now: () => now });
    await store.markScraped('host-1', 'A'); // marked at 12:00:00

    // Advance to 30 min later; mark B.
    now = new Date('2026-05-10T12:30:00.000Z');
    await store.markScraped('host-1', 'B');

    // Advance to 1h 5min after the original (12:00 + 1:05 = 13:05).
    now = new Date('2026-05-10T13:05:00.000Z');
    // A is now ~65 min old, B is ~35 min old. Window = 1 hour.
    const recent = await store.coresScrapedWithin(
      'host-1',
      60 * 60 * 1000,
    );
    expect(recent.has('A')).toBe(false);
    expect(recent.has('B')).toBe(true);
  });

  it('coresScrapedWithin uses inclusive cutoff (timestamp == cutoff is in)', async () => {
    let now = new Date('2026-05-10T12:00:00.000Z');
    const store = new ScrapeStateStore(dir, { now: () => now });
    await store.markScraped('host-1', 'A');
    // Advance exactly 1 hour. A's timestamp should equal the cutoff.
    now = new Date('2026-05-10T13:00:00.000Z');
    const recent = await store.coresScrapedWithin(
      'host-1',
      60 * 60 * 1000,
    );
    expect(recent.has('A')).toBe(true);
  });

  it('survives a corrupt JSON file by treating it as empty', async () => {
    const path = join(dir, 'host-1', 'scrape-state.json');
    await fs.mkdir(join(dir, 'host-1'), { recursive: true });
    await fs.writeFile(path, '{ this is not json');
    const store = new ScrapeStateStore(dir);
    const m = await store.load('host-1');
    expect(m.size).toBe(0);
  });

  it('rejects a file with mismatched schema version (treats as empty)', async () => {
    const path = join(dir, 'host-1', 'scrape-state.json');
    await fs.mkdir(join(dir, 'host-1'), { recursive: true });
    await fs.writeFile(
      path,
      JSON.stringify({ version: 999, host: 'host-1', entries: {} }),
    );
    const store = new ScrapeStateStore(dir);
    const m = await store.load('host-1');
    expect(m.size).toBe(0);
  });
});
