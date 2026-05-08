import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ImageCache } from '@app/main/metadata/image-cache';

const URL_A = 'https://cdn.example/box-art-a.jpg';
const URL_B = 'https://cdn.example/box-art-b.png';

function imageResponse(bytes: Uint8Array, status = 200): Response {
  return new Response(bytes, {
    status,
    headers: { 'content-type': 'image/jpeg' },
  });
}

describe('ImageCache', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'mc-imagecache-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('getLocal returns null when nothing is cached', async () => {
    const cache = new ImageCache(dir);
    expect(await cache.getLocal(URL_A)).toBeNull();
  });

  it('first fetch downloads, caches, and returns the path', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const path = await cache.fetch(URL_A);
    expect(path).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const written = await fs.readFile(path as string);
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });

  it('second fetch returns the cached path with no network call', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const a = await cache.fetch(URL_A);
    const b = await cache.fetch(URL_A);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache on non-200 response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404 }));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await cache.fetch(URL_A)).toBeNull();
    expect(await cache.getLocal(URL_A)).toBeNull();
  });

  it('does not cache on a network exception', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await cache.fetch(URL_A)).toBeNull();
    expect(await cache.getLocal(URL_A)).toBeNull();
  });

  it('does not write a partial file when the response body is empty', async () => {
    // 200 + zero bytes is treated as a failure; we'd rather refetch
    // later than serve an empty image.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array(), { status: 200 }));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await cache.fetch(URL_A)).toBeNull();
    expect(await cache.getLocal(URL_A)).toBeNull();
  });

  it('deduplicates concurrent requests for the same URL', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    // Each call returns a fresh Response — Response bodies can only
    // be read once, so a shared instance would let the second pass
    // succeed only because dedup kept it from running, not as a real
    // verification. A factory mockImplementation makes the dedup the
    // load-bearing thing.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [r1, r2] = await Promise.all([
      cache.fetch(URL_A),
      cache.fetch(URL_A),
    ]);
    expect(r1).toBe(r2);
    expect(r1).not.toBeNull();
    // The point of dedup: only one network round-trip even though
    // two callers asked at the same time.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('different URLs are cached under different file paths', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    // Each call gets its own Response — the body of a fetch Response
    // is single-use and must not be shared across calls.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const a = await cache.fetch(URL_A);
    const b = await cache.fetch(URL_B);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('shards files into 2-char prefix subdirs to keep listings small', async () => {
    const bytes = new Uint8Array([0]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const path = await cache.fetch(URL_A);
    expect(path).toMatch(/[/\\][0-9a-f]{2}[/\\][0-9a-f]{40}\.bin$/);
  });

  it('clearAll removes the cache directory', async () => {
    const bytes = new Uint8Array([1]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    await cache.fetch(URL_A);
    expect(await cache.getLocal(URL_A)).not.toBeNull();
    await cache.clearAll();
    expect(await cache.getLocal(URL_A)).toBeNull();
  });

  it('clearAll on a never-populated cache is a no-op', async () => {
    const cache = new ImageCache(join(dir, 'never-existed'));
    await expect(cache.clearAll()).resolves.toBeUndefined();
  });

  it('accepts (and currently ignores) a maxWidth option for forward-compat', async () => {
    const bytes = new Uint8Array([1, 2]);
    const fetchMock = vi.fn().mockResolvedValue(imageResponse(bytes));
    const cache = new ImageCache(dir, {
      fetch: fetchMock as unknown as typeof fetch,
    });
    const path = await cache.fetch(URL_A, { maxWidth: 200 });
    expect(path).not.toBeNull();
    // The bytes on disk are the raw response, untouched. v1.x with
    // sharp wired in will diverge here.
    const written = await fs.readFile(path as string);
    expect(Array.from(written)).toEqual(Array.from(bytes));
  });
});
