import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SystemCatalog, SystemCatalogEntry } from '@app/main/metadata/screenscraper-service';
import { SystemCatalogService } from '@app/main/metadata/system-catalog-service';

// ─── helpers ────────────────────────────────────────────────────────

function makeCatalog(entries: Array<[number, SystemCatalogEntry]>): SystemCatalog {
  return new Map(entries);
}

function makeEntry(
  id: number,
  displayName: string,
  logoUrl: string | null = null,
): SystemCatalogEntry {
  return { id, displayName, logoUrl };
}

const SNES_ENTRY = makeEntry(4, 'Super Nintendo Entertainment System', 'https://ss/snes.svg');
const ARCADE_ENTRY = makeEntry(75, 'Arcade', null);

// ─── parseSystemCatalog (wire catalog) ──────────────────────────────

describe('feat/system-catalog-data-layer — SystemCatalogService.getWireCatalog', () => {
  let dir: string;
  let catalogPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-catalog-test-'));
    catalogPath = join(dir, 'system-catalog.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  function makeService(opts: {
    fetchResult?: SystemCatalog | null;
    logoBytes?: Buffer | null;
  } = {}): SystemCatalogService {
    const { fetchResult = null, logoBytes = null } = opts;
    const mockScraper = {
      fetchSystemCatalog: vi.fn(async () => fetchResult),
      getStatus: vi.fn(() => 'available'),
      hasCredentials: true,
    } as never;
    const mockLogoCache = {
      fetch: vi.fn(async () => logoBytes !== null ? '/cached/path.bin' : null),
      getLocal: vi.fn(async () => null),
    } as never;
    return new SystemCatalogService(mockScraper, mockLogoCache, catalogPath);
  }

  it('returns null before ensureCatalog is called', () => {
    const svc = makeService();
    expect(svc.getWireCatalog()).toBeNull();
  });

  it('returns wire entries keyed by coreId after ensureCatalog', async () => {
    const catalog = makeCatalog([
      [4, SNES_ENTRY],
      [75, ARCADE_ENTRY],
    ]);
    const svc = makeService({ fetchResult: catalog });
    await svc.ensureCatalog();
    const wire = svc.getWireCatalog();
    expect(wire).not.toBeNull();
    // coreId 'SNES' maps to ssId 4 in SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID
    expect(wire!['SNES']).toMatchObject({ id: 4, displayName: 'Super Nintendo Entertainment System' });
  });

  it('only includes coreIds present in SCREENSCRAPER_SYSTEM_ID_BY_CORE_ID', async () => {
    // ssId 99999 has no coreId mapping
    const catalog = makeCatalog([[99999, makeEntry(99999, 'Unknown System')]]);
    const svc = makeService({ fetchResult: catalog });
    await svc.ensureCatalog();
    const wire = svc.getWireCatalog();
    // The wire catalog is non-null but should contain no entries for 99999
    expect(Object.keys(wire ?? {})).not.toContain('99999');
  });

  it('writes a disk cache after fetch', async () => {
    const catalog = makeCatalog([[4, SNES_ENTRY]]);
    const svc = makeService({ fetchResult: catalog });
    await svc.ensureCatalog();
    const content = await fs.readFile(catalogPath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    expect(parsed).toMatchObject({ fetchedAt: expect.any(String) });
    const systems = (parsed as { systems: unknown[] }).systems;
    expect(systems.some((s: unknown) => (s as { id: number }).id === 4)).toBe(true);
  });

  it('loads catalog from disk cache on second ensureCatalog call', async () => {
    const catalog = makeCatalog([[4, SNES_ENTRY]]);
    const svc = makeService({ fetchResult: catalog });
    await svc.ensureCatalog(); // writes disk cache
    // Create a new service instance (fresh in-memory state) but same catalogPath
    const svc2 = makeService({ fetchResult: null }); // fetch returns null
    await svc2.ensureCatalog(); // should load from disk
    const wire = svc2.getWireCatalog();
    expect(wire).not.toBeNull();
    expect(wire!['SNES']).toBeDefined();
  });

  it('remains at null when both disk and fetch fail', async () => {
    const svc = makeService({ fetchResult: null });
    await svc.ensureCatalog();
    expect(svc.getWireCatalog()).toBeNull();
  });
});

describe('feat/system-catalog-data-layer — SystemCatalogService.getSystemLogoBytes', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-logo-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for null or empty url', async () => {
    const svc = new SystemCatalogService({} as never, {} as never, join(dir, 'c.json'));
    expect(await svc.getSystemLogoBytes(null)).toBeNull();
    expect(await svc.getSystemLogoBytes('')).toBeNull();
  });

  it('returns bytes when logo cache returns a valid path', async () => {
    const logoPath = join(dir, 'logo.bin');
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await fs.writeFile(logoPath, data);

    const mockLogoCache = {
      fetch: vi.fn(async () => logoPath),
      getLocal: vi.fn(async () => null),
    } as never;
    const svc = new SystemCatalogService({} as never, mockLogoCache, join(dir, 'c.json'));
    const result = await svc.getSystemLogoBytes('https://ss/logo.svg');
    expect(result).not.toBeNull();
    expect(result!.length).toBe(4);
    expect(result![0]).toBe(0x89);
  });

  it('returns null when logo cache fetch fails', async () => {
    const mockLogoCache = {
      fetch: vi.fn(async () => null),
      getLocal: vi.fn(async () => null),
    } as never;
    const svc = new SystemCatalogService({} as never, mockLogoCache, join(dir, 'c.json'));
    expect(await svc.getSystemLogoBytes('https://ss/logo.svg')).toBeNull();
  });
});

describe('fix/system-catalog-visibility-and-latch — SystemCatalogService.rescrapeSystemCatalog', () => {
  let dir: string;
  let catalogPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-rescrape-test-'));
    catalogPath = join(dir, 'system-catalog.json');
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('calls resetAuthState before fetching', async () => {
    const resetAuthState = vi.fn();
    const mockScraper = {
      fetchSystemCatalog: vi.fn(async () => null),
      getStatus: vi.fn(() => 'available'),
      resetAuthState,
    } as never;
    const svc = new SystemCatalogService(mockScraper, {} as never, catalogPath);
    await svc.rescrapeSystemCatalog();
    expect(resetAuthState).toHaveBeenCalledOnce();
  });

  it('returns { success: true, status: "ok" } on successful fetch', async () => {
    const catalog = new Map([[4, { id: 4, displayName: 'SNES', logoUrl: null }]]);
    const mockScraper = {
      fetchSystemCatalog: vi.fn(async () => catalog),
      getStatus: vi.fn(() => 'available'),
      resetAuthState: vi.fn(),
    } as never;
    const svc = new SystemCatalogService(mockScraper, {} as never, catalogPath);
    const result = await svc.rescrapeSystemCatalog();
    expect(result).toMatchObject({ success: true, status: 'ok' });
  });

  it('returns { success: false } when fetch returns null', async () => {
    const mockScraper = {
      fetchSystemCatalog: vi.fn(async () => null),
      getStatus: vi.fn(() => 'unavailable'),
      resetAuthState: vi.fn(),
    } as never;
    const svc = new SystemCatalogService(mockScraper, {} as never, catalogPath);
    const result = await svc.rescrapeSystemCatalog();
    expect(result.success).toBe(false);
    expect(result.status).toBe('unavailable');
  });
});
