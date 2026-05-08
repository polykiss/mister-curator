import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ScreenScraperAuthError,
  ScreenScraperService,
  parseScreenScraperResponse,
  redactScreenScraperUrl,
  type ScreenScraperLookupQuery,
  type ScreenScraperServiceOptions,
} from '@app/main/metadata/screenscraper-service';

const HASH_MD5 = 'd0e7d56cb3eb1f3f8e51a8fd0bcfaf28';
const HASH_SHA1 = 'a'.repeat(40);
const HASH_CRC32 = '01abcdef';
const SNES_SYSTEM_ID = 4;

const CREDS = {
  devId: 'test-dev',
  devPassword: 'test-pw',
} as const;

function makeService(
  overrides: ScreenScraperServiceOptions = {},
): ScreenScraperService {
  return new ScreenScraperService({
    devId: CREDS.devId,
    devPassword: CREDS.devPassword,
    sleep: () => Promise.resolve(),
    now: () => 0,
    minIntervalMs: 0,
    ...overrides,
  });
}

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
      id: 1234,
      systeme: {
        id: 4,
        nom: 'Super Nintendo Entertainment System',
        parentid: 0,
      },
      noms: [
        { region: 'eu', text: 'Super Mario World (EU)' },
        { region: 'us', text: 'Super Mario World' },
      ],
      dates: [
        { region: 'jp', text: '1990-11-21' },
        { region: 'us', text: '1991-08-13' },
      ],
      developpeur: { id: '1', text: 'Nintendo EAD' },
      editeur: { id: '1', text: 'Nintendo' },
      joueurs: { text: '1-2' },
      note: { text: '19' },
      synopsis: [
        { langue: 'fr', text: '...French...' },
        { langue: 'en', text: 'Mario rescues the princess.' },
      ],
      genres: [
        {
          id: 'platform',
          noms: [
            { region: 'wor', text: 'Plateforme' },
            { region: 'us', text: 'Platform' },
          ],
        },
        {
          id: 'action',
          noms: [{ region: 'us', text: 'Action' }],
        },
      ],
      medias: [
        { type: 'box-2D', region: 'eu', url: 'https://cdn/box2d-eu.png' },
        { type: 'box-2D', region: 'us', url: 'https://cdn/box2d-us.png' },
        { type: 'box-3D', region: 'us', url: 'https://cdn/box3d-us.png' },
        { type: 'sstitle', region: 'us', url: 'https://cdn/title.png' },
        { type: 'ss', region: 'us', url: 'https://cdn/snap-1.png' },
        { type: 'ss', region: 'us', url: 'https://cdn/snap-2.png' },
        { type: 'wheel', region: 'us', url: 'https://cdn/wheel.png' },
        { type: 'marquee', region: 'us', url: 'https://cdn/marquee.png' },
      ],
    },
  },
};

const SNES_QUERY: ScreenScraperLookupQuery = {
  systemId: SNES_SYSTEM_ID,
  md5: HASH_MD5,
  sha1: HASH_SHA1,
  crc32: HASH_CRC32,
};

describe('ScreenScraperService — credentials', () => {
  it('reports unavailable when no creds are configured', () => {
    const svc = new ScreenScraperService();
    expect(svc.getStatus()).toBe('unavailable');
  });

  it('reports unavailable when only one of the two dev creds is set', () => {
    expect(
      new ScreenScraperService({ devId: 'x' }).getStatus(),
    ).toBe('unavailable');
    expect(
      new ScreenScraperService({ devPassword: 'y' }).getStatus(),
    ).toBe('unavailable');
  });

  it('reports unavailable when creds are whitespace-only', () => {
    const svc = new ScreenScraperService({
      devId: '   ',
      devPassword: 'real-pw',
    });
    expect(svc.getStatus()).toBe('unavailable');
  });

  it('reports available when both dev creds are present', () => {
    const svc = new ScreenScraperService({
      devId: 'x',
      devPassword: 'y',
    });
    expect(svc.getStatus()).toBe('available');
  });

  it('lookup returns null without fetching when unavailable', async () => {
    const fetchMock = vi.fn();
    const svc = new ScreenScraperService({
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs the no-creds notice exactly once across multiple lookups', async () => {
    const log = vi.fn();
    const svc = new ScreenScraperService({
      fetch: vi.fn() as unknown as typeof fetch,
      logger: log,
    });
    await svc.lookup(SNES_QUERY);
    await svc.lookup({ ...SNES_QUERY, md5: 'b'.repeat(32) });
    await svc.lookup({ ...SNES_QUERY, md5: 'c'.repeat(32) });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toMatch(/credentials not configured/);
    expect(log.mock.calls[0]?.[0]).toMatch(/SCREENSCRAPER_DEV_ID/);
  });

  it('does not include credential values in any log output', async () => {
    const log = vi.fn();
    const svc = new ScreenScraperService({
      fetch: vi.fn() as unknown as typeof fetch,
      logger: log,
      devId: 'super-secret-id',
      // devPassword missing → no-creds path triggers the log.
    });
    await svc.lookup(SNES_QUERY);
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls[0]?.[0]).not.toContain('super-secret-id');
  });
});

describe('ScreenScraperService — request URL', () => {
  it('passes softname, output, devid, devpassword, systemeid in the URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup(SNES_QUERY);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('softname=mistercurator');
    expect(url).toContain('output=json');
    expect(url).toContain(`devid=${CREDS.devId}`);
    expect(url).toContain(`devpassword=${CREDS.devPassword}`);
    expect(url).toContain(`systemeid=${String(SNES_SYSTEM_ID)}`);
  });

  it('passes md5, sha1, crc when supplied (multi-hash query)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup(SNES_QUERY);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain(`md5=${HASH_MD5}`);
    expect(url).toContain(`sha1=${HASH_SHA1}`);
    expect(url).toContain(`crc=${HASH_CRC32}`);
  });

  it('omits hash params when not supplied', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup({ systemId: SNES_SYSTEM_ID, md5: HASH_MD5 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('md5=');
    expect(url).not.toContain('sha1=');
    expect(url).not.toContain('crc=');
  });

  it('passes ssid + sspassword when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      ssid: 'user-ssid',
      sspassword: 'user-pw',
    });
    await svc.lookup(SNES_QUERY);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('ssid=user-ssid');
    expect(url).toContain('sspassword=user-pw');
  });

  it('omits ssid + sspassword when not configured (dev-only mode)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup(SNES_QUERY);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('ssid=');
    expect(url).not.toContain('sspassword=');
  });

  it('passes romnom when supplied (SS hash-collision tie-breaker)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup({
      ...SNES_QUERY,
      romName: 'Super Mario World (USA).sfc',
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('romnom=');
    expect(url).toMatch(/romnom=Super\+Mario\+World\+%28USA%29\.sfc/);
  });

  it('passes romtaille when romSize is supplied (round 2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup({ ...SNES_QUERY, romSize: 524288 });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('romtaille=524288');
  });

  it('omits romtaille when romSize is undefined or zero', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await svc.lookup(SNES_QUERY); // no romSize
    let url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('romtaille=');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse(SAMPLE_JEU));
    await svc.lookup({ ...SNES_QUERY, romSize: 0 });
    url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('romtaille=');
  });

  it('URL-encodes credentials with special characters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      devPassword: 'pw with spaces & symbols',
    });
    await svc.lookup(SNES_QUERY);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('devpassword=pw+with+spaces+%26+symbols');
  });
});

describe('ScreenScraperService — response mapping', () => {
  it('parses a complete jeu payload into ScreenScraperGame', () => {
    const game = parseScreenScraperResponse(SAMPLE_JEU);
    expect(game).not.toBeNull();
    expect(game?.id).toBe(1234);
    expect(game?.name).toBe('Super Mario World');
    expect(game?.system).toBe('Super Nintendo Entertainment System');
    expect(game?.developer).toBe('Nintendo EAD');
    expect(game?.publisher).toBe('Nintendo');
    expect(game?.players).toBe('1-2');
    // /20 → /10 with one-decimal rounding. 19/2 = 9.5.
    expect(game?.rating).toBe(9.5);
    expect(game?.releaseDate).toBe('1991-08-13');
    expect(game?.description).toBe('Mario rescues the princess.');
    expect(game?.genres).toEqual(['Platform', 'Action']);
    expect(game?.boxArtUrl).toBe('https://cdn/box2d-us.png');
    expect(game?.extra.box3DUrl).toBe('https://cdn/box3d-us.png');
    expect(game?.extra.titleScreenUrl).toBe('https://cdn/title.png');
    expect(game?.extra.snapUrl).toBe('https://cdn/snap-1.png');
    expect(game?.extra.clearLogoUrl).toBe('https://cdn/wheel.png');
    expect(game?.extra.marqueeUrl).toBe('https://cdn/marquee.png');
    expect(game?.extra.screenshots).toEqual([
      'https://cdn/snap-1.png',
      'https://cdn/snap-2.png',
    ]);
  });

  it('returns null when response.jeu is missing', () => {
    expect(parseScreenScraperResponse({ response: {} })).toBeNull();
    expect(parseScreenScraperResponse({})).toBeNull();
    expect(parseScreenScraperResponse(null)).toBeNull();
  });

  it('reads system from response.jeu.systeme.nom (round 4)', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          systeme: { id: 1, nom: 'Sega Mega Drive', parentid: 0 },
          noms: [{ region: 'us', text: 'Sonic 2' }],
        },
      },
    });
    expect(game?.system).toBe('Sega Mega Drive');
  });

  it('returns system=null when systeme.nom is missing or empty', () => {
    const noSysteme = parseScreenScraperResponse({
      response: { jeu: { id: 1, noms: [{ region: 'us', text: 'X' }] } },
    });
    expect(noSysteme?.system).toBeNull();
    const emptyNom = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          systeme: { id: 1, nom: '', parentid: 0 },
          noms: [{ region: 'us', text: 'X' }],
        },
      },
    });
    expect(emptyNom?.system).toBeNull();
  });

  it('returns null when jeu has no usable name in any region', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [{ region: 'us', text: '' }],
        },
      },
    });
    expect(game).toBeNull();
  });

  it('falls back EU when US is absent', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [
            { region: 'jp', text: 'スーパーマリオ' },
            { region: 'eu', text: 'Super Mario World' },
          ],
        },
      },
    });
    expect(game?.name).toBe('Super Mario World');
  });

  it('uses any region as final fallback when none match preferred order', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [{ region: 'br', text: 'Mario Brasil' }],
        },
      },
    });
    expect(game?.name).toBe('Mario Brasil');
  });

  it('falls back box-2D → box-3D → wheel for primary art', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [{ region: 'us', text: 'X' }],
          medias: [
            { type: 'box-3D', region: 'us', url: 'https://cdn/3d.png' },
            { type: 'wheel', region: 'us', url: 'https://cdn/wheel.png' },
          ],
        },
      },
    });
    expect(game?.boxArtUrl).toBe('https://cdn/3d.png');
  });

  it('returns null rating on non-numeric or out-of-range note', () => {
    const noNote = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [{ region: 'us', text: 'X' }],
          note: { text: 'N/A' },
        },
      },
    });
    expect(noNote?.rating).toBeNull();

    const tooHigh = parseScreenScraperResponse({
      response: {
        jeu: {
          id: 1,
          noms: [{ region: 'us', text: 'X' }],
          note: { text: '99' },
        },
      },
    });
    expect(tooHigh?.rating).toBeNull();
  });

  it('handles a string id by parsing it', () => {
    const game = parseScreenScraperResponse({
      response: {
        jeu: {
          id: '4242',
          noms: [{ region: 'us', text: 'X' }],
        },
      },
    });
    expect(game?.id).toBe(4242);
  });

  it('rejects an unparseable id', () => {
    expect(
      parseScreenScraperResponse({
        response: {
          jeu: {
            id: 'not-a-number',
            noms: [{ region: 'us', text: 'X' }],
          },
        },
      }),
    ).toBeNull();
  });
});

describe('ScreenScraperService — networking', () => {
  it('returns the parsed game on a 200 happy-path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    const game = await svc.lookup(SNES_QUERY);
    expect(game?.name).toBe('Super Mario World');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on 404 without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null on a 200 + non-JSON body', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('<html>error</html>', { status: 200 }));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
  });

  it('returns null on a 200 + body without `response.jeu`', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ response: {} }));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
  });

  it('returns null on other 4xx without retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(400));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ScreenScraperService — auth failure', () => {
  it('throws ScreenScraperAuthError on 403, no retries, latches unavailable', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(403));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await expect(svc.lookup(SNES_QUERY)).rejects.toBeInstanceOf(
      ScreenScraperAuthError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(svc.getStatus()).toBe('unavailable');
  });

  it('does NOT throw on 401 — round 2 reclassified it as server-load', async () => {
    // SS docs: 401 means "API closed for non-members or inactive
    // members" when CPU is saturated (>60%). It's NOT auth failure.
    // Real auth = 403 only. 401 retries like 5xx, then enters the
    // rate-limited cooldown.
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      rateLimitCooldownMs: 1_000,
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    // 401 doesn't latch unavailable.
    expect(svc.getStatus()).not.toBe('unavailable');
    // It does enter rate-limited so the next call short-circuits.
    expect(svc.getStatus()).toBe('rate-limited');
  });

  it('AuthError carries the HTTP status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(403));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    let caught: ScreenScraperAuthError | null = null;
    try {
      await svc.lookup(SNES_QUERY);
    } catch (err) {
      caught = err as ScreenScraperAuthError;
    }
    expect(caught?.status).toBe(403);
    expect(caught?.message).toMatch(/SCREENSCRAPER_DEV_ID/);
  });

  it('subsequent lookups after AuthError short-circuit to null without fetching', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(403))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    await expect(svc.lookup(SNES_QUERY)).rejects.toBeInstanceOf(
      ScreenScraperAuthError,
    );
    // Even though the next mocked response would succeed, the latched
    // unavailable status prevents the request entirely.
    const second = await svc.lookup(SNES_QUERY);
    expect(second).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('ScreenScraperService — rate limiting', () => {
  it('retries 429 with exponential backoff, then returns the parsed response', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(emptyResponse(429))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const game = await svc.lookup(SNES_QUERY);
    expect(game).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(svc.getStatus()).toBe('available');
  });

  it('enters rate-limited cooldown when the 429 retry budget is exhausted', async () => {
    let now = 1_000_000;
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(429));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      now: () => now,
      rateLimitCooldownMs: 5_000,
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    expect(svc.getStatus()).toBe('rate-limited');

    // Subsequent lookups during cooldown short-circuit.
    fetchMock.mockClear();
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    // Advance the clock past the cooldown — status flips back.
    now += 6_000;
    expect(svc.getStatus()).toBe('available');
    fetchMock.mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const after = await svc.lookup(SNES_QUERY);
    expect(after?.name).toBe('Super Mario World');
  });

  it('caps total 429 backoff at the aggregate budget', async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(429));
    const svc = makeService({
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    const total = sleeps.reduce((a, b) => a + b, 0);
    // Aggregate guard caps total backoff at 30s.
    expect(total).toBeLessThanOrEqual(30_000);
    expect(svc.getStatus()).toBe('rate-limited');
  });

  it('5xx retries cap at 2 attempts (3 fetches total)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(emptyResponse(503));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(svc.getStatus()).toBe('available');
  });

  it('5xx then 200 returns the parsed response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(emptyResponse(503))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    const game = await svc.lookup(SNES_QUERY);
    expect(game?.name).toBe('Super Mario World');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('network errors retry max once (2 fetches total)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect(await svc.lookup(SNES_QUERY)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Network failures don't latch unavailable — could be a transient
    // glitch.
    expect(svc.getStatus()).toBe('available');
  });

  it('network error then 200 returns the parsed response', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
    const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
    expect((await svc.lookup(SNES_QUERY))?.name).toBe('Super Mario World');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  describe('round 2 — 401 retry-then-cooldown', () => {
    it('401 retries with backoff (max 2), then 200 returns the response', async () => {
      const sleeps: number[] = [];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(emptyResponse(401))
        .mockResolvedValueOnce(emptyResponse(401))
        .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });
      const game = await svc.lookup(SNES_QUERY);
      expect(game?.name).toBe('Super Mario World');
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // Same exp ladder as 5xx: 1s, 2s.
      expect(sleeps).toEqual([1000, 2000]);
      expect(svc.getStatus()).toBe('available');
    });

    it('401 budget exhausted enters rate-limited cooldown (not unavailable)', async () => {
      let now = 1_000_000;
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        sleep: () => Promise.resolve(),
        now: () => now,
        rateLimitCooldownMs: 5_000,
      });
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(svc.getStatus()).toBe('rate-limited');
      // Crucially, NOT permanently unavailable — 401 is server-load,
      // not auth failure.
      expect(svc.getStatus()).not.toBe('unavailable');

      // Cooldown elapses → available again.
      now += 6_000;
      expect(svc.getStatus()).toBe('available');
    });
  });

  describe('round 2 — HTTP 426 (blacklisted softname)', () => {
    it('latches unavailable with a distinct log line, no retry', async () => {
      const log = vi.fn();
      const sleeps: number[] = [];
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(426));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        logger: log,
        sleep: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      });
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
      expect(svc.getStatus()).toBe('unavailable');
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/HTTP 426/),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/blacklisted/i),
      );
    });

    it('does NOT throw — 426 isn\'t auth-failure-shaped', async () => {
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(426));
      const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
      // No throw — caller gets null and status latches unavailable.
      await expect(svc.lookup(SNES_QUERY)).resolves.toBeNull();
    });

    it('subsequent lookups after 426 short-circuit without fetching', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(emptyResponse(426))
        .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
      const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
      await svc.lookup(SNES_QUERY);
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('round 2 — HTTP 430/431 (quota exceeded)', () => {
    it('430 latches quota-exceeded with the daily-quota message', async () => {
      const log = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(430));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        logger: log,
      });
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(svc.getStatus()).toBe('quota-exceeded');
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/HTTP 430/),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/daily.*quota/i),
      );
    });

    it('431 latches quota-exceeded with the KO-scrapes message', async () => {
      const log = vi.fn();
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(431));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        logger: log,
      });
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(svc.getStatus()).toBe('quota-exceeded');
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/HTTP 431/),
      );
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/not recognised/i),
      );
    });

    it('quota-exceeded is distinct from rate-limited (no cooldown elapse)', async () => {
      let now = 1_000_000;
      const fetchMock = vi.fn().mockResolvedValue(emptyResponse(430));
      const svc = makeService({
        fetch: fetchMock as unknown as typeof fetch,
        now: () => now,
        rateLimitCooldownMs: 1_000,
      });
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(svc.getStatus()).toBe('quota-exceeded');
      // Even far in the future, quota-exceeded does NOT flip back to
      // available — daily quotas are session-permanent.
      now += 24 * 60 * 60 * 1000;
      expect(svc.getStatus()).toBe('quota-exceeded');
    });

    it('subsequent lookups during quota-exceeded short-circuit', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(emptyResponse(430))
        .mockResolvedValueOnce(jsonResponse(SAMPLE_JEU));
      const svc = makeService({ fetch: fetchMock as unknown as typeof fetch });
      await svc.lookup(SNES_QUERY);
      expect(await svc.lookup(SNES_QUERY)).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('ScreenScraperService — request queue', () => {
  it('enforces the 1.1s gap between request starts by default', async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => {
      clock += 100; // each call simulates 100ms wall time
      return jsonResponse(SAMPLE_JEU);
    });
    const svc = new ScreenScraperService({
      ...CREDS,
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        sleeps.push(ms);
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      minIntervalMs: 1100,
    });
    await svc.lookup(SNES_QUERY);
    await svc.lookup({ ...SNES_QUERY, md5: 'b'.repeat(32) });
    // First call: no wait. Second: 1100 - 100ms-elapsed = 1000.
    expect(sleeps).toEqual([1000]);
  });

  it('serialises concurrent calls through the rate-limit queue', async () => {
    let clock = 0;
    const callOrder: string[] = [];
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const md5 = /md5=([a-f0-9]{32})/.exec(url)?.[1] ?? '?';
      callOrder.push(md5);
      clock += 50;
      return jsonResponse(SAMPLE_JEU);
    });
    const svc = new ScreenScraperService({
      ...CREDS,
      fetch: fetchMock as unknown as typeof fetch,
      sleep: (ms: number) => {
        clock += ms;
        return Promise.resolve();
      },
      now: () => clock,
      minIntervalMs: 1100,
    });
    const a = svc.lookup({ ...SNES_QUERY, md5: 'a'.repeat(32) });
    const b = svc.lookup({ ...SNES_QUERY, md5: 'b'.repeat(32) });
    await Promise.all([a, b]);
    expect(callOrder).toEqual(['a'.repeat(32), 'b'.repeat(32)]);
  });
});

/**
 * Live probes against api.screenscraper.fr. Off by default — gate via
 * `SCREENSCRAPER_LIVE_PROBE=1` so CI never depends on the SS API.
 *
 * Runs require:
 *   SCREENSCRAPER_DEV_ID, SCREENSCRAPER_DEV_PASSWORD env vars, plus
 *   optionally SCREENSCRAPER_SSID / SCREENSCRAPER_SSPASSWORD for
 *   member-quota mode.
 *
 * The first probe is a known-good cartridge (Sonic The Hedgehog 2,
 * Sega Mega Drive). systemeid 1 = Mega Drive in SS's archive. If
 * the assertion fails on a fresh check, verify the system id with:
 *   curl 'https://api.screenscraper.fr/api2/systemesListe.php?devid=…&devpassword=…&output=json' \
 *     | jq '.response.systemes[] | select(.noms.nom_eu | test("Mega Drive"))'
 */
describe('redactScreenScraperUrl (round 3)', () => {
  it('replaces every credential param value with [redacted]', () => {
    const url =
      'https://api.screenscraper.fr/api2/jeuInfos.php' +
      '?devid=secret-dev&devpassword=secret-pw' +
      '&ssid=user&sspassword=user-pw' +
      '&systemeid=4&md5=abc&romnom=foo.sfc';
    const out = redactScreenScraperUrl(url);
    expect(out).toContain('devid=%5Bredacted%5D');
    expect(out).toContain('devpassword=%5Bredacted%5D');
    expect(out).toContain('ssid=%5Bredacted%5D');
    expect(out).toContain('sspassword=%5Bredacted%5D');
    // Non-cred params are preserved verbatim.
    expect(out).toContain('systemeid=4');
    expect(out).toContain('md5=abc');
    expect(out).toContain('romnom=foo.sfc');
    // No leftover plaintext creds anywhere.
    expect(out).not.toMatch(/secret-dev|secret-pw|user-pw/);
  });

  it('returns the URL unchanged when no creds are present', () => {
    const url = 'https://api.screenscraper.fr/api2/jeuInfos.php?systemeid=4';
    expect(redactScreenScraperUrl(url)).toBe(url);
  });

  it('returns malformed input unchanged (no crash)', () => {
    expect(redactScreenScraperUrl('not a url')).toBe('not a url');
  });

  it('redacts only the cred params, leaving order/structure intact', () => {
    const url = 'https://api.screenscraper.fr/api2/jeuInfos.php?ssid=u';
    const out = redactScreenScraperUrl(url);
    expect(out).toBe(
      'https://api.screenscraper.fr/api2/jeuInfos.php?ssid=%5Bredacted%5D',
    );
  });

  it('also redacts media URLs (mediaJeu.php carries the same query params)', () => {
    // SS embeds creds in media URLs too; round 4's live test caught
    // these printed in plain text by `scripts/test-metadata.ts` for
    // box art. Same redactor applies — the helper keys on the param
    // names, not the path.
    const url =
      'https://neoclone.screenscraper.fr/api2/mediaJeu.php' +
      '?devid=misterCurater&devpassword=PLAINTEXT&ssid=u&sspassword=p' +
      '&jeuid=1234&media=box-2D';
    const out = redactScreenScraperUrl(url);
    expect(out).not.toContain('PLAINTEXT');
    expect(out).not.toContain('misterCurater');
    expect(out).toContain('devid=%5Bredacted%5D');
    expect(out).toContain('devpassword=%5Bredacted%5D');
    expect(out).toContain('ssid=%5Bredacted%5D');
    expect(out).toContain('sspassword=%5Bredacted%5D');
    // Non-cred params survive.
    expect(out).toContain('jeuid=1234');
    expect(out).toContain('media=box-2D');
  });
});

describe('ScreenScraperService — diagnostic logs (round 3)', () => {
  it('logs a redacted URL when network/timeout retries are exhausted', async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const svc = makeService({
      fetch: fetchImpl as unknown as typeof fetch,
      logger: (m) => messages.push(m),
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    const networkLog = messages.find((m) => m.includes('network/timeout'));
    expect(networkLog).toBeDefined();
    // The cred values must NOT appear in the log; the placeholder must.
    expect(networkLog!).not.toContain(CREDS.devId);
    expect(networkLog!).not.toContain(CREDS.devPassword);
    expect(networkLog!).toContain('devid=%5Bredacted%5D');
    expect(networkLog!).toContain('devpassword=%5Bredacted%5D');
  });

  it('logs a redacted URL when 5xx retries are exhausted', async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => emptyResponse(503));
    const svc = makeService({
      fetch: fetchImpl as unknown as typeof fetch,
      logger: (m) => messages.push(m),
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    const log5xx = messages.find((m) => m.includes('HTTP 503'));
    expect(log5xx).toBeDefined();
    expect(log5xx!).not.toContain(CREDS.devPassword);
    expect(log5xx!).toContain('devpassword=%5Bredacted%5D');
  });

  it('logs a redacted URL on unexpected non-2xx (e.g. 418) and returns null', async () => {
    const messages: string[] = [];
    const fetchImpl = vi.fn(async () => emptyResponse(418));
    const svc = makeService({
      fetch: fetchImpl as unknown as typeof fetch,
      logger: (m) => messages.push(m),
    });
    const result = await svc.lookup(SNES_QUERY);
    expect(result).toBeNull();
    const log4xx = messages.find((m) => m.includes('HTTP 418'));
    expect(log4xx).toBeDefined();
    expect(log4xx!).not.toContain(CREDS.devPassword);
    expect(log4xx!).toContain('devpassword=%5Bredacted%5D');
  });
});

const liveProbeEnabled = process.env['SCREENSCRAPER_LIVE_PROBE'] === '1';

describe.runIf(liveProbeEnabled)('ScreenScraperService — live probes', () => {
  let svc: ScreenScraperService;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    svc = new ScreenScraperService({
      devId: process.env['SCREENSCRAPER_DEV_ID'] ?? null,
      devPassword: process.env['SCREENSCRAPER_DEV_PASSWORD'] ?? null,
      ssid: process.env['SCREENSCRAPER_SSID'] ?? null,
      sspassword: process.env['SCREENSCRAPER_SSPASSWORD'] ?? null,
      logger: (m) => warnings.push(m),
    });
  });

  afterEach(() => {
    if (warnings.length > 0) {
      console.warn('[live] ScreenScraper warnings:', warnings);
    }
  });

  it(
    'returns a real game for Sonic The Hedgehog 2 (Mega Drive) by md5',
    async () => {
      // Sonic The Hedgehog 2 (World) — md5 from the live MiSTer test.
      const game = await svc.lookup({
        systemId: 1, // SS Sega Mega Drive
        md5: '8e2c29a1e65111fe2078359e685e7943',
      });
      expect(game).not.toBeNull();
      expect(game?.name.toLowerCase()).toContain('sonic');
    },
    20_000,
  );

  it(
    'returns null for a hash known not to exist',
    async () => {
      const game = await svc.lookup({
        systemId: 1,
        md5: '0'.repeat(32),
      });
      expect(game).toBeNull();
    },
    20_000,
  );
});
