import { describe, expect, it, vi } from 'vitest';

import {
  ScreenScraperClient,
  mapJeuToMetadata,
} from '@app/main/metadata/clients/screenscraper-client';

const HASH = 'a'.repeat(32);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}

const SAMPLE_JEU = {
  response: {
    jeu: {
      noms: [
        { region: 'eu', text: 'Super Mario World (EU)' },
        { region: 'us', text: 'Super Mario World' },
      ],
      dates: [{ region: 'us', text: '1991-08-13' }],
      developpeur: { id: '1', text: 'Nintendo EAD' },
      editeur: { id: '1', text: 'Nintendo' },
      joueurs: { text: '1-2' },
      note: { text: '19' },
      classifications: [
        { type: 'ESRB', text: 'E' },
        { type: 'PEGI', text: '3' },
      ],
      genres: [
        {
          id: 'platform',
          noms: [
            { region: 'wor', text: 'Plateforme' },
            { region: 'us', text: 'Platform' },
          ],
        },
      ],
      synopsis: [
        { langue: 'fr', text: '...French...' },
        { langue: 'en', text: 'Mario rescues the princess.' },
      ],
      medias: [
        {
          type: 'box-2D',
          region: 'us',
          url: 'https://cdn.example/box2d-us.png',
        },
        {
          type: 'box-2D',
          region: 'eu',
          url: 'https://cdn.example/box2d-eu.png',
        },
        { type: 'ss', region: 'us', url: 'https://cdn.example/ss-1.png' },
        { type: 'ss', region: 'us', url: 'https://cdn.example/ss-2.png' },
        { type: 'sstitle', region: 'us', url: 'https://cdn.example/title.png' },
      ],
    },
  },
};

describe('ScreenScraper — response mapping', () => {
  it('maps a complete jeu payload into RomMetadata', () => {
    const meta = mapJeuToMetadata(SAMPLE_JEU, HASH, () => 1700000000000);
    expect(meta).not.toBeNull();
    expect(meta?.hash).toBe(HASH);
    expect(meta?.name).toBe('Super Mario World');
    expect(meta?.year).toBe(1991);
    expect(meta?.publisher).toBe('Nintendo');
    expect(meta?.developer).toBe('Nintendo EAD');
    expect(meta?.genre).toBe('Platform');
    expect(meta?.players).toBe('1-2');
    // /20 → /100, with one-decimal rounding.
    expect(meta?.criticScore).toBe(95);
    expect(meta?.ageRating).toBe('E');
    expect(meta?.description).toBe('Mario rescues the princess.');
    expect(meta?.boxArtUrl).toBe('https://cdn.example/box2d-us.png');
    expect(meta?.screenshotUrls).toEqual([
      'https://cdn.example/ss-1.png',
      'https://cdn.example/ss-2.png',
    ]);
    expect(meta?.titleScreenUrl).toBe('https://cdn.example/title.png');
    expect(meta?.source).toBe('screenscraper');
    expect(meta?.fetchedAt).toBe(new Date(1700000000000).toISOString());
  });

  it('returns null when the response has no jeu', () => {
    const meta = mapJeuToMetadata({ response: {} }, HASH, () => 0);
    expect(meta).toBeNull();
  });

  it('returns null on a fully-empty response object', () => {
    expect(mapJeuToMetadata({}, HASH, () => 0)).toBeNull();
    expect(mapJeuToMetadata(null, HASH, () => 0)).toBeNull();
  });

  it('falls back to box-3D when box-2D is absent', () => {
    const meta = mapJeuToMetadata(
      {
        response: {
          jeu: {
            medias: [
              { type: 'box-3D', region: 'us', url: 'https://cdn/3d.png' },
              { type: 'wheel', region: 'us', url: 'https://cdn/wheel.png' },
            ],
          },
        },
      },
      HASH,
      () => 0,
    );
    expect(meta?.boxArtUrl).toBe('https://cdn/3d.png');
  });

  it('falls back to wheel when box-2D and box-3D are absent', () => {
    const meta = mapJeuToMetadata(
      {
        response: {
          jeu: {
            medias: [
              { type: 'wheel', region: 'us', url: 'https://cdn/wheel.png' },
            ],
          },
        },
      },
      HASH,
      () => 0,
    );
    expect(meta?.boxArtUrl).toBe('https://cdn/wheel.png');
  });

  it('uses any region for box art when preferred regions are missing', () => {
    const meta = mapJeuToMetadata(
      {
        response: {
          jeu: {
            medias: [
              { type: 'box-2D', region: 'br', url: 'https://cdn/br.png' },
            ],
          },
        },
      },
      HASH,
      () => 0,
    );
    expect(meta?.boxArtUrl).toBe('https://cdn/br.png');
  });

  it('returns null criticScore for non-numeric or out-of-range note', () => {
    const noNote = mapJeuToMetadata(
      { response: { jeu: { note: { text: 'N/A' } } } },
      HASH,
      () => 0,
    );
    expect(noNote?.criticScore).toBeNull();

    const tooHigh = mapJeuToMetadata(
      { response: { jeu: { note: { text: '99' } } } },
      HASH,
      () => 0,
    );
    expect(tooHigh?.criticScore).toBeNull();
  });

  it('handles a name field with no usable region (empty strings)', () => {
    const meta = mapJeuToMetadata(
      {
        response: {
          jeu: { noms: [{ region: 'us', text: '' }] },
        },
      },
      HASH,
      () => 0,
    );
    expect(meta?.name).toBe('(unknown)');
  });

  it('parses a year from a partial date string', () => {
    const meta = mapJeuToMetadata(
      {
        response: { jeu: { dates: [{ region: 'us', text: '1985' }] } },
      },
      HASH,
      () => 0,
    );
    expect(meta?.year).toBe(1985);
  });

  it('rejects implausible years (< 1970 or > 2100)', () => {
    const meta = mapJeuToMetadata(
      { response: { jeu: { dates: [{ region: 'us', text: '1801' }] } } },
      HASH,
      () => 0,
    );
    expect(meta?.year).toBeNull();
  });
});

describe('ScreenScraperClient — networking', () => {
  it('returns null without calling fetch when disabled', async () => {
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      disabled: true,
    });
    const result = await client.getByMd5(HASH);
    expect(result).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when md5 is malformed', async () => {
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5('not-a-hash')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes the expected URL params (softname, output, md5)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      now: () => 0,
      minIntervalMs: 0,
    });
    await client.getByMd5(HASH);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('softname=mistercurator');
    expect(url).toContain('output=json');
    expect(url).toContain(`md5=${HASH}`);
  });

  it('returns null on 404 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      now: () => 0,
      minIntervalMs: 0,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries 429 with exponential backoff, then returns the parsed response', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => 0,
      minIntervalMs: 0,
      maxRetries: 4,
    });
    const meta = await client.getByMd5(HASH);
    expect(meta).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Backoff: 1s, 2s for the two 429s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps backoff at maxBackoffMs', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValue(emptyResponse(429));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      now: () => 0,
      minIntervalMs: 0,
      maxRetries: 6,
      maxBackoffMs: 5000,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    // 1s, 2s, 4s, 5s (capped), 5s, 5s.
    expect(sleeps).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });

  it('retries on 5xx like 429', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      now: () => 0,
      minIntervalMs: 0,
    });
    expect(await client.getByMd5(HASH)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null when the response is 200 but not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      now: () => 0,
      minIntervalMs: 0,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
  });

  it('enforces a 1.1s gap between requests by default', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      clock += 100; // each call takes 100ms
      return jsonResponse(SAMPLE_JEU);
    });
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      minIntervalMs: 1100,
    });
    await client.getByMd5(HASH);
    await client.getByMd5('b'.repeat(32));
    // First call: no wait. Second call: wait the remainder of the
    // 1100ms interval (1100 - 100ms-of-prev-call = 1000).
    expect(sleeps).toEqual([1000]);
  });

  it('serializes concurrent calls through the rate-limit queue', async () => {
    let clock = 0;
    const callOrder: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const md5 = /md5=([a-f0-9]{32})/.exec(url)?.[1] ?? '?';
      callOrder.push(md5);
      clock += 50;
      return jsonResponse(SAMPLE_JEU);
    });
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      minIntervalMs: 1100,
    });

    const a = client.getByMd5('a'.repeat(32));
    const b = client.getByMd5('b'.repeat(32));
    await Promise.all([a, b]);
    expect(callOrder).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });
});
