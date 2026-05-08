import type { MetadataHint, RomMetadata } from '@shared/metadata-types';

const ENDPOINT = 'https://api.thegamesdb.net/v1/Games/ByGameName';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * TheGamesDB fallback client. Per PR #15's option 2c: no shipped API
 * key. The client is a no-op when `METADATA_THEGAMESDB_KEY` is unset,
 * returning null from every call without touching the network. When a
 * key IS provided, it does a name-based search (TheGamesDB's free
 * public API doesn't expose a hash-search endpoint) and maps the
 * first result to `RomMetadata`.
 *
 * v0 mapping is conservative: developer / publisher / genre come back
 * as numeric IDs from this endpoint, and resolving them to names
 * needs extra calls. We surface what's present in one round-trip and
 * leave the deferred fields null. PR #16 can iterate when we know
 * which fields the UI actually displays.
 *
 * Failure / 429 / 5xx → null. No retries; the orchestrator can call
 * again later. The expectation is that this client is invoked once
 * per ROM that ScreenScraper missed — the cumulative volume is small.
 */
export class TheGamesDBClient {
  private readonly fetchImpl: typeof fetch;
  private readonly apiKey: string | null;
  private readonly disabled: boolean;
  private readonly timeoutMs: number;
  private readonly logger: (message: string) => void;

  constructor(options: {
    readonly apiKey?: string | null;
    readonly fetch?: typeof fetch;
    readonly disabled?: boolean;
    readonly timeoutMs?: number;
    readonly logger?: (message: string) => void;
  } = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.apiKey = options.apiKey ?? null;
    this.disabled = options.disabled ?? false;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.logger = options.logger ?? ((): void => {
      /* default: no log */
    });
  }

  /** Whether this client is configured to actually make network calls. */
  isEnabled(): boolean {
    return !this.disabled && this.apiKey !== null && this.apiKey.length > 0;
  }

  /**
   * Best-effort fallback lookup. Requires a `hint.name` since the API
   * is name-search-only here. Returns null when:
   *   - the client is disabled / unkeyed
   *   - the hint has no name
   *   - the API rejects, rate-limits, or times out
   *   - no results match
   */
  async getByHint(
    hash: string,
    hint: MetadataHint = {},
  ): Promise<RomMetadata | null> {
    if (!this.isEnabled()) return null;
    const name = hint.name?.trim();
    if (name === undefined || name.length === 0) return null;

    const url = new URL(ENDPOINT);
    url.searchParams.set('apikey', this.apiKey ?? '');
    url.searchParams.set('name', name);
    url.searchParams.set('include', 'boxart');
    url.searchParams.set('fields', 'players,publishers,genres,overview,rating');

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url.toString());
    } catch (err) {
      this.logger(
        `[TheGamesDB] network error for "${name}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }

    if (res.status === 429) {
      this.logger(`[TheGamesDB] rate limited for "${name}"`);
      return null;
    }
    if (!res.ok) {
      this.logger(
        `[TheGamesDB] non-OK status ${String(res.status)} for "${name}"`,
      );
      return null;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return null;
    }
    return mapTheGamesDbToMetadata(body, hash, hint);
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    try {
      return await this.fetchImpl(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── response mapping (exported for direct test access) ─────────────

interface TgdbGame {
  readonly id?: number;
  readonly game_title?: string;
  readonly release_date?: string;
  readonly players?: number;
  readonly overview?: string;
  readonly rating?: string;
  readonly platform?: number;
}

interface TgdbBoxartFile {
  readonly side?: string;
  readonly filename?: string;
}

/**
 * Map a v1 ByGameName response to `RomMetadata`. Picks the first
 * game with a usable title; if a `system` hint is supplied, prefers a
 * platform whose ID would loosely match. Returns null when nothing
 * usable is present.
 */
export function mapTheGamesDbToMetadata(
  body: unknown,
  hash: string,
  _hint: MetadataHint,
): RomMetadata | null {
  if (body === null || typeof body !== 'object') return null;
  const obj = body as Record<string, unknown>;
  const data = obj.data;
  if (data === null || typeof data !== 'object') return null;
  const games = (data as Record<string, unknown>).games;
  if (!Array.isArray(games) || games.length === 0) return null;

  // Pick the first game with a usable title. v0 doesn't try to
  // disambiguate across platforms — that's a deferred refinement.
  const game = (games as TgdbGame[]).find(
    (g) => typeof g.game_title === 'string' && g.game_title.length > 0,
  );
  if (game === undefined) return null;

  const boxArtUrl = pickBoxArtUrl(obj.include, game.id);

  return {
    version: 1,
    hash,
    name: game.game_title ?? '(unknown)',
    year: parseYear(game.release_date),
    publisher: null,
    developer: null,
    genre: null,
    players:
      typeof game.players === 'number' ? String(game.players) : null,
    criticScore: null,
    ageRating: typeof game.rating === 'string' ? game.rating : null,
    description: typeof game.overview === 'string' ? game.overview : null,
    boxArtUrl,
    screenshotUrls: [],
    titleScreenUrl: null,
    source: 'thegamesdb',
    fetchedAt: new Date().toISOString(),
  };
}

function pickBoxArtUrl(include: unknown, gameId: number | undefined): string | null {
  if (gameId === undefined || include === null || typeof include !== 'object') {
    return null;
  }
  const inc = include as Record<string, unknown>;
  const boxart = inc.boxart;
  if (boxart === null || typeof boxart !== 'object') return null;
  const ba = boxart as Record<string, unknown>;
  const baseUrl = readBaseUrl(ba.base_url);
  if (baseUrl === null) return null;
  const data = ba.data;
  if (data === null || typeof data !== 'object') return null;
  const files = (data as Record<string, unknown>)[String(gameId)];
  if (!Array.isArray(files)) return null;
  // Front cover preferred.
  const front = (files as TgdbBoxartFile[]).find(
    (f) => f.side === 'front' && typeof f.filename === 'string',
  );
  const pick = front ?? (files as TgdbBoxartFile[])[0];
  if (pick === undefined || typeof pick.filename !== 'string') return null;
  return `${baseUrl}${pick.filename}`;
}

function readBaseUrl(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return null;
  const orig = (value as Record<string, unknown>).original;
  if (typeof orig === 'string') return orig;
  const lg = (value as Record<string, unknown>).large;
  if (typeof lg === 'string') return lg;
  return null;
}

function parseYear(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})/.exec(value);
  if (!match) return null;
  const y = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(y)) return null;
  if (y < 1970 || y > 2100) return null;
  return y;
}
