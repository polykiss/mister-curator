import { describe, expect, it, vi } from 'vitest';

import {
  TheGamesDBClient,
  mapTheGamesDbToMetadata,
} from '@app/main/metadata/clients/thegamesdb-client';

const HASH = 'a'.repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SAMPLE_BODY = {
  code: 200,
  status: 'Success',
  data: {
    games: [
      {
        id: 12345,
        game_title: 'Super Mario World',
        release_date: '1991-08-13',
        players: 2,
        overview: 'Mario rescues the princess.',
        rating: 'E',
        platform: 6,
      },
    ],
  },
  include: {
    boxart: {
      base_url: { original: 'https://cdn.thegamesdb.net/images/original/' },
      data: {
        '12345': [
          { side: 'front', filename: 'boxart/front/12345-1.jpg' },
          { side: 'back', filename: 'boxart/back/12345-1.jpg' },
        ],
      },
    },
  },
};

describe('TheGamesDB — response mapping', () => {
  it('maps a complete ByGameName payload to RomMetadata', () => {
    const meta = mapTheGamesDbToMetadata(SAMPLE_BODY, HASH, {});
    expect(meta).not.toBeNull();
    expect(meta?.hash).toBe(HASH);
    expect(meta?.name).toBe('Super Mario World');
    expect(meta?.year).toBe(1991);
    expect(meta?.players).toBe('2');
    expect(meta?.description).toBe('Mario rescues the princess.');
    expect(meta?.ageRating).toBe('E');
    expect(meta?.boxArtUrl).toBe(
      'https://cdn.thegamesdb.net/images/original/boxart/front/12345-1.jpg',
    );
    expect(meta?.source).toBe('thegamesdb');
    // v0 leaves these null — they need extra round-trips to resolve
    // numeric id refs into names.
    expect(meta?.publisher).toBeNull();
    expect(meta?.developer).toBeNull();
    expect(meta?.genre).toBeNull();
    expect(meta?.criticScore).toBeNull();
  });

  it('returns null when data.games is empty', () => {
    expect(
      mapTheGamesDbToMetadata({ data: { games: [] } }, HASH, {}),
    ).toBeNull();
  });

  it('returns null when body is malformed', () => {
    expect(mapTheGamesDbToMetadata(null, HASH, {})).toBeNull();
    expect(mapTheGamesDbToMetadata({}, HASH, {})).toBeNull();
    expect(mapTheGamesDbToMetadata({ data: null }, HASH, {})).toBeNull();
  });

  it('falls back to back-side art when front is missing', () => {
    const body = {
      data: { games: [{ id: 9, game_title: 'X', release_date: '1990' }] },
      include: {
        boxart: {
          base_url: { original: 'https://cdn/' },
          data: { '9': [{ side: 'back', filename: 'b.jpg' }] },
        },
      },
    };
    const meta = mapTheGamesDbToMetadata(body, HASH, {});
    expect(meta?.boxArtUrl).toBe('https://cdn/b.jpg');
  });

  it('returns null boxArtUrl when no boxart entry exists', () => {
    const body = {
      data: { games: [{ id: 9, game_title: 'X', release_date: '1990' }] },
      include: { boxart: { base_url: { original: 'https://cdn/' }, data: {} } },
    };
    const meta = mapTheGamesDbToMetadata(body, HASH, {});
    expect(meta?.boxArtUrl).toBeNull();
  });
});

describe('TheGamesDBClient — networking', () => {
  it('isEnabled is false when no key is configured', () => {
    const client = new TheGamesDBClient();
    expect(client.isEnabled()).toBe(false);
  });

  it('isEnabled is false when disabled is true even with a key', () => {
    const client = new TheGamesDBClient({ apiKey: 'k', disabled: true });
    expect(client.isEnabled()).toBe(false);
  });

  it('returns null without calling fetch when no key is set', async () => {
    const fetchMock = vi.fn();
    const client = new TheGamesDBClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByHint(HASH, { name: 'Super Mario' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null when no name hint is supplied', async () => {
    const fetchMock = vi.fn();
    const client = new TheGamesDBClient({
      apiKey: 'key-123',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByHint(HASH, {})).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes apikey, name, include, and fields query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_BODY));
    const client = new TheGamesDBClient({
      apiKey: 'key-123',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await client.getByHint(HASH, { name: 'Super Mario' });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('apikey=key-123');
    expect(url).toContain('name=Super+Mario');
    expect(url).toContain('include=boxart');
    expect(url).toContain('fields=');
  });

  it('returns null and logs on rate limit (429)', async () => {
    const log = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 429 }));
    const client = new TheGamesDBClient({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
      logger: log,
    });
    expect(await client.getByHint(HASH, { name: 'X' })).toBeNull();
    expect(log).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a 5xx without retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 503 }));
    const client = new TheGamesDBClient({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByHint(HASH, { name: 'X' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a non-JSON 200 response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>nope</html>', { status: 200 }));
    const client = new TheGamesDBClient({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByHint(HASH, { name: 'X' })).toBeNull();
  });

  it('returns mapped metadata on a happy-path 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_BODY));
    const client = new TheGamesDBClient({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const meta = await client.getByHint(HASH, { name: 'Super Mario World' });
    expect(meta?.name).toBe('Super Mario World');
    expect(meta?.source).toBe('thegamesdb');
  });
});
