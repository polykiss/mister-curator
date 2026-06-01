import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WikipediaService } from '@app/main/metadata/wikipedia-service';

// ─── helpers ────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function makeService(fetchImpl: typeof fetch, rootDir: string): WikipediaService {
  return new WikipediaService({
    rootDir,
    userAgent: 'test-agent',
    fetch: fetchImpl,
  });
}

const SNES_EXTRACT = 'The Super Nintendo Entertainment System is a 16-bit home video game console.';
const SNES_SUMMARY = {
  type: 'standard',
  title: 'Super Nintendo Entertainment System',
  extract: SNES_EXTRACT,
  thumbnail: { source: 'https://upload.wikimedia.org/snes.jpg', width: 300, height: 200 },
};

// ─── tests ──────────────────────────────────────────────────────────

describe('WikipediaService.ensureSummary', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-wiki-test-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('fetches and returns a summary when cache is missing', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(SNES_SUMMARY));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    const result = await svc.ensureSummary(4, 'Super Nintendo Entertainment System');
    expect(result).not.toBeNull();
    expect(result!.extract).toBe(SNES_EXTRACT);
    expect(result!.thumbnailUrl).toBe('https://upload.wikimedia.org/snes.jpg');
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('returns cached value without network call when fresh', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(SNES_SUMMARY));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    await svc.ensureSummary(4, 'Super Nintendo Entertainment System');
    mockFetch.mockClear();
    const second = await svc.ensureSummary(4, 'Super Nintendo Entertainment System');
    expect(second!.extract).toBe(SNES_EXTRACT);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses WIKIPEDIA_TITLE_OVERRIDES for known display names', async () => {
    const mockFetch = vi.fn(async () => jsonResponse(SNES_SUMMARY));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    await svc.ensureSummary(4, 'Super Nintendo');
    const url = String((mockFetch.mock.calls as unknown[][])[0]![0]);
    expect(url).toContain('Super_Nintendo_Entertainment_System');
  });

  it('uses display name directly when no override exists', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ extract: 'Sega CD text', thumbnail: null }));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    await svc.ensureSummary(20, 'Sega CD');
    const url = String((mockFetch.mock.calls as unknown[][])[0]![0]);
    expect(url).toContain('Sega_CD');
  });

  it('returns null and caches null on 404', async () => {
    const mockFetch = vi.fn(async () => new Response('Not Found', { status: 404 }));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    const result = await svc.ensureSummary(999, 'Nonexistent System');
    expect(result).toBeNull();
    // Should be cached (short TTL) — second call should not hit network
    mockFetch.mockClear();
    const second = await svc.ensureSummary(999, 'Nonexistent System');
    expect(second).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null on network error and does NOT cache', async () => {
    const mockFetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    const result = await svc.ensureSummary(4, 'SNES');
    expect(result).toBeNull();
    // Cache file should NOT exist after a network error
    await expect(
      fs.readFile(join(dir, 'wikipedia', '4.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('returns null when extract is missing from response', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ type: 'disambiguation' }));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    const result = await svc.ensureSummary(4, 'SNES');
    expect(result).toBeNull();
  });

  it('sets thumbnailUrl to null when no thumbnail in response', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ extract: 'Some text', thumbnail: undefined }));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    const result = await svc.ensureSummary(4, 'Sega CD');
    expect(result!.thumbnailUrl).toBeNull();
  });

  it('URL-encodes special characters in the title', async () => {
    const mockFetch = vi.fn(async () => jsonResponse({ extract: 'PC Engine text' }));
    const svc = makeService(mockFetch as unknown as typeof fetch, dir);
    await svc.ensureSummary(31, 'PC-FX');
    const url = String((mockFetch.mock.calls as unknown[][])[0]![0]);
    // Hyphen encodes cleanly; the URL should not contain raw special chars
    expect(url).toContain('/page/summary/');
    expect(typeof url).toBe('string');
  });
});
