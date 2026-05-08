import { describe, expect, it, vi } from 'vitest';

import {
  ScreenScraperAuthError,
  ScreenScraperClient,
  type ScreenScraperClientOptions,
  mapJeuToMetadata,
} from '@app/main/metadata/clients/screenscraper-client';

const HASH = 'a'.repeat(32);
const CREDS = {
  devId: 'test-dev',
  devPassword: 'test-pw',
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status: number): Response {
  return new Response('', { status });
}

/**
 * Build a client with credentials populated by default. Most tests
 * don't care about cred plumbing — they care about retry / response
 * mapping / rate-limit behavior. Callers can override per-test.
 */
function makeClient(overrides: ScreenScraperClientOptions = {}): ScreenScraperClient {
  return new ScreenScraperClient({
    devId: CREDS.devId,
    devPassword: CREDS.devPassword,
    sleep: () => Promise.resolve(),
    now: () => 0,
    minIntervalMs: 0,
    ...overrides,
  });
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

describe('ScreenScraperClient — credentials (PR #15 round 2)', () => {
  it('returns null without calling fetch when credentials are missing', async () => {
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when devId is empty / whitespace', async () => {
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      devId: '   ',
      devPassword: 'something',
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null without calling fetch when devPassword is empty', async () => {
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      devId: 'something',
      devPassword: '',
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs the "credentials not configured" notice exactly once', async () => {
    const log = vi.fn();
    const client = new ScreenScraperClient({
      fetch: vi.fn() as unknown as typeof fetch,
      logger: log,
    });
    await client.getByMd5(HASH);
    await client.getByMd5('b'.repeat(32));
    await client.getByMd5('c'.repeat(32));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/credentials not configured/);
    expect(log.mock.calls[0]?.[0]).toMatch(/SCREENSCRAPER_DEVID/);
  });

  it('does not include credential values in the warning message', async () => {
    const log = vi.fn();
    const client = new ScreenScraperClient({
      fetch: vi.fn() as unknown as typeof fetch,
      logger: log,
      // Even though only devId is set, devPassword is missing → log fires.
      devId: 'super-secret-id',
    });
    await client.getByMd5(HASH);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).not.toContain('super-secret-id');
  });

  it('isEnabled is false when only devId is supplied', () => {
    const c1 = new ScreenScraperClient({ devId: 'x' });
    expect(c1.isEnabled()).toBe(false);
    const c2 = new ScreenScraperClient({ devPassword: 'y' });
    expect(c2.isEnabled()).toBe(false);
  });

  it('isEnabled is true when both creds are present and disabled is false', () => {
    const c = new ScreenScraperClient({
      devId: 'x',
      devPassword: 'y',
    });
    expect(c.isEnabled()).toBe(true);
  });

  it('isEnabled is false when explicitly disabled even with creds', () => {
    const c = new ScreenScraperClient({
      devId: 'x',
      devPassword: 'y',
      disabled: true,
    });
    expect(c.isEnabled()).toBe(false);
  });

  it('disabled mode wins over creds (no log, no fetch)', async () => {
    const log = vi.fn();
    const fetchMock = vi.fn();
    const client = new ScreenScraperClient({
      fetch: fetchMock as unknown as typeof fetch,
      logger: log,
      devId: 'x',
      devPassword: 'y',
      disabled: true,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('ScreenScraperClient — networking', () => {
  it('returns null without calling fetch when md5 is malformed', async () => {
    const fetchMock = vi.fn();
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5('not-a-hash')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes softname, output, md5, devid, devpassword in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      devId: 'my-dev-id',
      devPassword: 'pw with spaces & symbols',
    });
    await client.getByMd5(HASH);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('softname=mistercurator');
    expect(url).toContain('output=json');
    expect(url).toContain(`md5=${HASH}`);
    // URL.searchParams encodes credentials safely.
    expect(url).toContain('devid=my-dev-id');
    expect(url).toContain('devpassword=pw+with+spaces+%26+symbols');
  });

  it('returns null on 404 without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws ScreenScraperAuthError on 403, no retries', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(403));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(client.getByMd5(HASH)).rejects.toBeInstanceOf(ScreenScraperAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it('throws ScreenScraperAuthError on 401, no retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(client.getByMd5(HASH)).rejects.toBeInstanceOf(ScreenScraperAuthError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AuthError carries the HTTP status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(403));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    let caught: ScreenScraperAuthError | null = null;
    try {
      await client.getByMd5(HASH);
    } catch (err) {
      caught = err as ScreenScraperAuthError;
    }
    expect(caught?.status).toBe(403);
    expect(caught?.message).toMatch(/SCREENSCRAPER_DEVID/);
  });

  it('retries 429 with exponential backoff, then returns the parsed response', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const meta = await client.getByMd5(HASH);
    expect(meta).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Backoff: 1s, 2s for the two 429s.
    expect(sleeps).toEqual([1000, 2000]);
  });

  it('caps backoff at maxBackoffMs', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(429));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      maxBackoffMs: 5000,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    // 4 retries → 4 sleeps: 1s, 2s, 4s, 5s (capped). Then the 5th
    // attempt fails the retry cap and we return null.
    expect(sleeps).toEqual([1000, 2000, 4000, 5000]);
  });

  it('caps total 429 backoff at the 30s aggregate budget', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(429));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      // Default maxBackoffMs (30s) so the 5th retry would be 16s; 1+2+4+8 = 15
      // which is under 30s. The 5th would push total to 31s and trip the
      // aggregate guard, returning null without sleeping that 16s.
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    // Sum of sleeps must be ≤ 30s.
    const total = sleeps.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThanOrEqual(30_000);
  });

  it('5xx retries cap at 2 attempts (3 fetches total)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(503));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it('5xx then 200 returns the parsed response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network errors retry max once (2 fetches total)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network error then 200 returns the parsed response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns null on other 4xx (e.g. 400) without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(400));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await client.getByMd5(HASH)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the response is 200 but not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const client = makeClient({
      fetch: fetchMock as unknown as typeof fetch,
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
    const client = makeClient({
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
    const client = makeClient({
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
