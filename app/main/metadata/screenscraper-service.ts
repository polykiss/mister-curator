/**
 * ScreenScraper API client (PR #16 round 1).
 *
 * Hits `https://api.screenscraper.fr/api2/jeuInfos.php` with multi-
 * hash queries (CRC32 + MD5 + SHA-1) and parses the response into
 * `ScreenScraperGame`. This module is the request/parse layer ONLY —
 * round 2 wires it into MetadataService as the primary source ahead
 * of the existing OpenVGDB + libretro fallback chain.
 *
 * Credentials:
 *   - Dev creds (`devid` / `devpassword`) are REQUIRED for any
 *     successful response. Without them every call surfaces as a
 *     401/403 auth error (the live behaviour we hit in PR #15
 *     round 2). When env-var-supplied creds are missing, the service
 *     declares itself `unavailable` at construction and every
 *     `lookup` returns null without touching the network.
 *   - User creds (`ssid` / `sspassword`) are optional. When supplied
 *     the request gets a higher quota; without them dev creds alone
 *     work at the lower default-user tier.
 *
 * Status state machine:
 *   - `unavailable` — no creds, OR a 403 was observed (real auth
 *     failure, latched), OR 426 (software blacklisted, latched).
 *     Subsequent lookups never make a request.
 *   - `rate-limited` — 429 retry budget exhausted, OR 401 budget
 *     exhausted (SS returns 401 when CPU is saturated; the docs
 *     spell this out — it's "API closed for non-members or inactive
 *     members," NOT auth failure). `getStatus()` lazily flips back
 *     to `available` once `rateLimitCooldownMs` (default 5 min)
 *     elapses.
 *   - `quota-exceeded` — 430 (daily scrape quota hit) or 431 (too
 *     many KO scrapes today). Latched for the rest of the session;
 *     re-checking would just re-poke the quota counter. Distinct
 *     from `rate-limited` so the renderer can surface different
 *     copy ("come back tomorrow" vs "wait a few minutes").
 *   - `available` — the default. Requests flow.
 *
 * Rate limit:
 *   - The anonymous floor is ~1 req/sec across all anonymous traffic.
 *     A `minIntervalMs` queue (1100ms default) spaces request starts.
 *   - 429 retries follow exponential backoff with two budgets — a
 *     per-attempt cap (4 retries) and a total-elapsed cap
 *     (`TOTAL_429_BUDGET_MS`, 30s) — whichever trips first ends the
 *     attempt by entering the rate-limited cooldown.
 *
 * Retry-by-status (PR #16 round 2 spec):
 *   - 401             → server overloaded — retry like 429 (the docs
 *                       call this "API closed when CPU > 60%"; it is
 *                       NOT a real auth failure). After budget
 *                       exhausted → `rate-limited` cooldown.
 *   - 403             → real auth failure → throw
 *                       `ScreenScraperAuthError`, latch `unavailable`.
 *   - 404             → null (legitimate no-match).
 *   - 426             → software blacklisted — log loudly, latch
 *                       `unavailable` with a distinct error message
 *                       (this means MiSTerCurator's softname is
 *                       blocked; we'd need to identify under a
 *                       different label).
 *   - 429             → exp. backoff, then `rate-limited`.
 *   - 430             → daily scrape quota hit → latch
 *                       `quota-exceeded`.
 *   - 431             → too many KO (failed) scrapes today → latch
 *                       `quota-exceeded` with distinct log message.
 *   - 5xx             → exp. backoff, max 2 retries, then null.
 *   - network/timeout → max 1 retry, then null.
 *   - other 4xx       → null.
 *   - 200 + no jeu    → null (parser-side no-match).
 *   - 200 + non-JSON  → null.
 */

const ENDPOINT = 'https://api.screenscraper.fr/api2/jeuInfos.php';
const SOFTNAME = 'mistercurator';
const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;

const MAX_429_RETRIES = 4;
const MAX_5XX_RETRIES = 2;
/**
 * 401 means "API closed for non-members" (CPU >60% per SS docs), NOT
 * an auth failure. Retry shape mirrors 5xx (small retry count with
 * backoff); when exhausted we enter the rate-limited cooldown rather
 * than nulling silently — the API genuinely needs time before the
 * next attempt has a chance.
 */
const MAX_401_RETRIES = 2;
const MAX_NETWORK_RETRIES = 1;
const TOTAL_429_BUDGET_MS = 30_000;

/**
 * Region preference for picking text/image fields out of
 * ScreenScraper's regional arrays. "us" first because the MiSTer
 * userbase skews North American; "wor" / "eu" / "jp" cover the rest;
 * "ss" is ScreenScraper's own meta-region. Anything beyond this list
 * is acceptable as a final fallback.
 *
 * TODO: configurable region preference (PR #16 follow-up — settings UI).
 */
const REGION_ORDER = ['us', 'wor', 'eu', 'jp', 'ss'] as const;

/** Box-art media types in fallback order. */
const BOX_ART_TYPES = ['box-2D', 'box-3D', 'wheel'] as const;

export type ScreenScraperStatus =
  | 'available'
  | 'unavailable'
  | 'rate-limited'
  | 'quota-exceeded';

/**
 * Thrown on HTTP 401/403. Latches the service to `unavailable` for
 * the remainder of the session — credentials don't suddenly start
 * working, and retrying just stacks per-call rate-limit waits.
 */
export class ScreenScraperAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(
      `ScreenScraper rejected the request with status ${String(status)}: check SCREENSCRAPER_DEV_ID / SCREENSCRAPER_DEV_PASSWORD.`,
    );
    this.name = 'ScreenScraperAuthError';
    this.status = status;
  }
}

/**
 * Names of credential-bearing query params on `jeuInfos.php`. Anything
 * we log that includes a request URL must scrub these — leaking dev
 * creds rotates an account; leaking user creds compromises a personal
 * SS membership. Order doesn't matter; the redactor checks each.
 */
const CREDENTIAL_PARAMS = ['devid', 'devpassword', 'ssid', 'sspassword'];

/**
 * Replace credential values in a `jeuInfos.php` URL with `[redacted]`.
 * Safe for unrelated URLs (returns them unchanged) and for URLs with
 * no creds (no-op). Use this before passing any SS URL to a logger,
 * an error message, or a stack-trace-bound diagnostic.
 */
export function redactScreenScraperUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  let mutated = false;
  for (const key of CREDENTIAL_PARAMS) {
    if (parsed.searchParams.has(key)) {
      parsed.searchParams.set(key, '[redacted]');
      mutated = true;
    }
  }
  return mutated ? parsed.toString() : url;
}

/**
 * Parsed `jeuInfos` payload normalised into a stable shape. Round-1
 * scope: the fields the renderer's list view needs (name, year,
 * genre, publisher, box art) plus the SS-only extras the detail
 * modal will surface in PR #17 (description, developer, players,
 * rating, alternate art).
 */
export interface ScreenScraperGame {
  /** ScreenScraper internal game id — unique within their archive. */
  readonly id: number;
  /** Region-preferred name. Falls back through REGION_ORDER. */
  readonly name: string;
  readonly description: string | null;
  readonly developer: string | null;
  readonly publisher: string | null;
  readonly genres: readonly string[];
  /** Region-preferred raw release-date string (`YYYY-MM-DD` or just `YYYY`). */
  readonly releaseDate: string | null;
  /** Normalised to 0–10. SS's `note` field is /20. */
  readonly rating: number | null;
  /** Free-form: "1", "1-2", "1-4", etc. */
  readonly players: string | null;
  /** Region-preferred box-2D URL (falls back to box-3D, then wheel). */
  readonly boxArtUrl: string | null;
  /** Other art types parsed but not yet surfaced to RomMetadata. */
  readonly extra: ScreenScraperExtraArt;
}

/**
 * Parsed-but-unsurfaced art URLs. PR #17's detail-modal UI consumes
 * these. Each is region-preferenced via the same REGION_ORDER as the
 * primary fields.
 */
export interface ScreenScraperExtraArt {
  readonly box3DUrl: string | null;
  readonly marqueeUrl: string | null;
  readonly titleScreenUrl: string | null;
  readonly snapUrl: string | null;
  readonly clearLogoUrl: string | null;
  /** Multiple gameplay screenshots, in SS's response order. */
  readonly screenshots: readonly string[];
}

/** One lookup against jeuInfos. At least one hash is recommended. */
export interface ScreenScraperLookupQuery {
  /** SS-internal system id (e.g. 4 = SNES). Required by jeuInfos. */
  readonly systemId: number;
  /** Lowercase or uppercase hex (32 chars). */
  readonly md5?: string;
  /** Lowercase or uppercase hex (40 chars). */
  readonly sha1?: string;
  /** Lowercase or uppercase hex (8 chars). */
  readonly crc32?: string;
  /**
   * Optional ROM filename — SS uses it as a tie-breaker on hash
   * collisions and as a search fallback when no hash matches its
   * index. Pass the romFileName-with-extension when available.
   */
  readonly romName?: string;
  /**
   * Optional ROM size in bytes — SS's `romtaille`. Round 2 wires
   * this through from HashService's cached extracted-content size.
   * For .zip wrappers this is the inner size, NOT the wrapper —
   * SS expects the actual ROM bytes count.
   */
  readonly romSize?: number;
}

export interface ScreenScraperServiceOptions {
  /** Dev credentials. Both required; absence forces `unavailable`. */
  readonly devId?: string | null;
  readonly devPassword?: string | null;
  /** User credentials. Both optional; together they raise the quota. */
  readonly ssid?: string | null;
  readonly sspassword?: string | null;
  /** Test seam — defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam for the rate-limit waiter. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — wall-clock source. */
  readonly now?: () => number;
  /** Minimum gap between request starts. Default 1100ms. */
  readonly minIntervalMs?: number;
  /** Cap on the exponential-backoff delay. Default 30s. */
  readonly maxBackoffMs?: number;
  /** Per-request fetch timeout. Default 15s. */
  readonly timeoutMs?: number;
  /**
   * Cooldown after the 429 budget is exhausted. During this window
   * lookups return null without touching the network. Default 5 min.
   */
  readonly rateLimitCooldownMs?: number;
  /**
   * Single-line warning sink. Used for the "no creds configured"
   * notice and for any non-cred diagnostic. Never receives the URL
   * or the credential values.
   */
  readonly logger?: (message: string) => void;
}

export class ScreenScraperService {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly minIntervalMs: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;
  private readonly rateLimitCooldownMs: number;
  private readonly devId: string | null;
  private readonly devPassword: string | null;
  private readonly ssid: string | null;
  private readonly sspassword: string | null;
  private readonly hasCredentials: boolean;
  private readonly logger: (message: string) => void;

  /** Latched true after a real auth failure (403); never resets. */
  private authFailed = false;
  /**
   * Latched true after HTTP 426 — SS has blacklisted this softname.
   * No retry strategy can fix it; we'd need a code change to
   * identify under a different name. Surfaces as `unavailable`.
   */
  private blacklisted = false;
  /**
   * Latched true after HTTP 430 (daily quota) or 431 (too many KO
   * scrapes). Persists for the rest of the session — the quota
   * counter is daily, and re-poking it doesn't help.
   */
  private quotaExceeded = false;
  /** Wall-clock at which the rate-limit cooldown ends, or null. */
  private rateLimitedUntil: number | null = null;
  /** Logged the "no creds" notice — suppress repeats. */
  private warnedNoCreds = false;

  /** Promise chain serialising all live requests for the rate floor. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Wall-clock at the start of the most recent request, or null. */
  private lastCallAt: number | null = null;

  constructor(options: ScreenScraperServiceOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.nowImpl = options.now ?? Date.now;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.rateLimitCooldownMs =
      options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    this.devId = nonEmpty(options.devId);
    this.devPassword = nonEmpty(options.devPassword);
    this.ssid = nonEmpty(options.ssid);
    this.sspassword = nonEmpty(options.sspassword);
    this.hasCredentials = this.devId !== null && this.devPassword !== null;
    this.logger = options.logger ?? ((): void => {
      /* default: no log */
    });
  }

  /**
   * Current state. Lazily transitions out of `rate-limited` when the
   * cooldown window has elapsed. Latched states (`unavailable` due
   * to authFailed/blacklisted; `quota-exceeded`) never transition
   * back within a session.
   */
  getStatus(): ScreenScraperStatus {
    if (!this.hasCredentials) return 'unavailable';
    if (this.authFailed) return 'unavailable';
    if (this.blacklisted) return 'unavailable';
    if (this.quotaExceeded) return 'quota-exceeded';
    if (this.rateLimitedUntil !== null) {
      if (this.nowImpl() >= this.rateLimitedUntil) {
        this.rateLimitedUntil = null;
        return 'available';
      }
      return 'rate-limited';
    }
    return 'available';
  }

  /**
   * Look up a game by hash(es) on a specific SS system. Returns:
   *   - a parsed `ScreenScraperGame` on a hit,
   *   - null on a clean no-match (404 / response without `jeu`),
   *   - null when the service is unavailable / rate-limited,
   *   - null after exhausted retries on transient failures.
   *
   * Throws `ScreenScraperAuthError` on the FIRST 401/403; subsequent
   * lookups in the same session short-circuit to null because the
   * status latches to `unavailable`.
   */
  async lookup(
    query: ScreenScraperLookupQuery,
  ): Promise<ScreenScraperGame | null> {
    if (!this.hasCredentials) {
      if (!this.warnedNoCreds) {
        this.warnedNoCreds = true;
        this.logger(
          '[ScreenScraper] credentials not configured; metadata fetch skipped. ' +
            'Set SCREENSCRAPER_DEV_ID and SCREENSCRAPER_DEV_PASSWORD to enable.',
        );
      }
      return null;
    }
    if (this.getStatus() !== 'available') return null;
    return this.enqueue(() => this.doLookup(query));
  }

  // ─── internals ─────────────────────────────────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      // Rate-limit the START of consecutive requests, not the gap
      // between end-of-one and start-of-next. ScreenScraper's rate
      // floor is per call attempt — a slow call shouldn't earn the
      // next caller extra throttling.
      if (this.lastCallAt !== null) {
        const elapsed = this.nowImpl() - this.lastCallAt;
        const wait = this.minIntervalMs - elapsed;
        if (wait > 0) await this.sleepImpl(wait);
      }
      this.lastCallAt = this.nowImpl();
      return fn();
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async doLookup(
    query: ScreenScraperLookupQuery,
  ): Promise<ScreenScraperGame | null> {
    const url = this.buildUrl(query);
    let attempts401 = 0;
    let attempts429 = 0;
    let attempts5xx = 0;
    let attemptsNetwork = 0;
    let total429BackoffMs = 0;

    while (true) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url);
      } catch {
        if (attemptsNetwork >= MAX_NETWORK_RETRIES) {
          this.logger(
            `[ScreenScraper] network/timeout after ${String(attemptsNetwork + 1)} attempts; ` +
              `giving up on ${redactScreenScraperUrl(url)}`,
          );
          return null;
        }
        await this.sleepImpl(this.backoffMs(attemptsNetwork));
        attemptsNetwork += 1;
        continue;
      }

      // 401: server-load saturation per SS docs ("API closed for
      // non-members or inactive members" when CPU > 60%). NOT auth.
      // Retry with backoff like 5xx; on exhaustion enter the
      // rate-limited cooldown — the API genuinely needs time before
      // the next attempt has a chance.
      if (res.status === 401) {
        if (attempts401 >= MAX_401_RETRIES) {
          this.enterRateLimitedCooldown(
            'API closed (HTTP 401, server-load saturation)',
          );
          return null;
        }
        await this.sleepImpl(this.backoffMs(attempts401));
        attempts401 += 1;
        continue;
      }
      // 403: real auth failure. Latch unavailable and surface a
      // typed error so MetadataService can log + skip SS. No retry.
      if (res.status === 403) {
        this.authFailed = true;
        this.logger(
          '[ScreenScraper] auth failed (HTTP 403); disabling for this session. ' +
            'Verify SCREENSCRAPER_DEV_ID / SCREENSCRAPER_DEV_PASSWORD.',
        );
        throw new ScreenScraperAuthError(res.status);
      }
      if (res.status === 404) return null;
      // 426: software blacklisted. Fatal config — only fixable by
      // changing the softname identifier upstream. Latch unavailable
      // with a distinct log line.
      if (res.status === 426) {
        this.blacklisted = true;
        this.logger(
          '[ScreenScraper] HTTP 426 — this software\'s softname is blacklisted. ' +
            'Disabling for this session. The MiSTerCurator softname needs to be updated.',
        );
        return null;
      }
      if (res.status === 429) {
        if (attempts429 >= MAX_429_RETRIES) {
          this.enterRateLimitedCooldown('rate-limit (HTTP 429) budget exhausted');
          return null;
        }
        const backoff = this.backoffMs(attempts429);
        if (total429BackoffMs + backoff > TOTAL_429_BUDGET_MS) {
          this.enterRateLimitedCooldown(
            `rate-limit (HTTP 429) aggregate budget (${String(TOTAL_429_BUDGET_MS)}ms) exhausted`,
          );
          return null;
        }
        await this.sleepImpl(backoff);
        total429BackoffMs += backoff;
        attempts429 += 1;
        continue;
      }
      // 430: daily scrape quota hit. 431: too many KO scrapes today
      // (SS penalises clients that submit lots of unmatchable
      // queries — keep poking and the timeout extends). Both latch
      // `quota-exceeded` for the rest of the session; distinct log
      // messages let ops tell them apart.
      if (res.status === 430) {
        this.quotaExceeded = true;
        this.logger(
          '[ScreenScraper] HTTP 430 — daily scrape quota exceeded. Disabled until next day.',
        );
        return null;
      }
      if (res.status === 431) {
        this.quotaExceeded = true;
        this.logger(
          '[ScreenScraper] HTTP 431 — too many ROMs not recognised today. ' +
            'Disabled to avoid further KO penalty.',
        );
        return null;
      }
      if (res.status >= 500) {
        if (attempts5xx >= MAX_5XX_RETRIES) {
          this.logger(
            `[ScreenScraper] HTTP ${String(res.status)} persisted after ${String(attempts5xx + 1)} attempts; ` +
              `giving up on ${redactScreenScraperUrl(url)}`,
          );
          return null;
        }
        await this.sleepImpl(this.backoffMs(attempts5xx));
        attempts5xx += 1;
        continue;
      }
      if (!res.ok) {
        this.logger(
          `[ScreenScraper] unexpected HTTP ${String(res.status)} on ${redactScreenScraperUrl(url)}; treating as no-match.`,
        );
        return null;
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return null;
      }
      return parseScreenScraperResponse(body);
    }
  }

  private enterRateLimitedCooldown(reason: string): void {
    this.rateLimitedUntil = this.nowImpl() + this.rateLimitCooldownMs;
    this.logger(
      `[ScreenScraper] ${reason}; cooling down for ${String(this.rateLimitCooldownMs)}ms.`,
    );
  }

  private buildUrl(query: ScreenScraperLookupQuery): string {
    // URL.searchParams handles the encoding for credentials and ROM
    // names that may contain special characters (passwords with `+`
    // or `&`, ROM filenames with parens, etc).
    const u = new URL(ENDPOINT);
    u.searchParams.set('softname', SOFTNAME);
    u.searchParams.set('output', 'json');
    if (this.devId !== null) u.searchParams.set('devid', this.devId);
    if (this.devPassword !== null) {
      u.searchParams.set('devpassword', this.devPassword);
    }
    if (this.ssid !== null) u.searchParams.set('ssid', this.ssid);
    if (this.sspassword !== null) {
      u.searchParams.set('sspassword', this.sspassword);
    }
    u.searchParams.set('systemeid', String(query.systemId));
    if (query.md5 !== undefined && query.md5.length > 0) {
      u.searchParams.set('md5', query.md5);
    }
    if (query.sha1 !== undefined && query.sha1.length > 0) {
      u.searchParams.set('sha1', query.sha1);
    }
    if (query.crc32 !== undefined && query.crc32.length > 0) {
      u.searchParams.set('crc', query.crc32);
    }
    if (query.romName !== undefined && query.romName.length > 0) {
      u.searchParams.set('romnom', query.romName);
    }
    if (query.romSize !== undefined && query.romSize > 0) {
      u.searchParams.set('romtaille', String(query.romSize));
    }
    return u.toString();
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

  private backoffMs(attempt: number): number {
    // 1s, 2s, 4s, 8s, 16s, 30s ... capped.
    const base = 1000 * 2 ** attempt;
    return Math.min(this.maxBackoffMs, base);
  }
}

// ─── response parser (exported for direct test access) ─────────────

/**
 * Normalise a parsed `jeuInfos.php` response into our internal
 * `ScreenScraperGame` shape. Returns null when:
 *   - the body is missing / non-object
 *   - `response.jeu` is missing (legitimate no-match — SS sometimes
 *     returns 200 + empty response object for unknown hashes)
 *   - the matched game has no usable name in any region
 *
 * Exported so the parser is testable without a full client + mock
 * fetch chain.
 */
export function parseScreenScraperResponse(
  body: unknown,
): ScreenScraperGame | null {
  if (body === null || typeof body !== 'object') return null;
  const jeu = readPath<unknown>(body, ['response', 'jeu']);
  if (jeu === null || typeof jeu !== 'object') return null;
  const j = jeu as Record<string, unknown>;

  const idRaw = j.id;
  const id =
    typeof idRaw === 'number'
      ? idRaw
      : typeof idRaw === 'string'
        ? Number.parseInt(idRaw, 10)
        : NaN;
  if (!Number.isFinite(id)) return null;

  const name = pickRegionalText(j.noms);
  if (name === null) return null;

  const medias = j.medias;
  return {
    id,
    name,
    description: pickSynopsis(j.synopsis),
    developer: readNestedText(j.developpeur),
    publisher: readNestedText(j.editeur),
    genres: pickAllGenres(j.genres),
    releaseDate: pickRegionalText(j.dates),
    rating: scaleNoteOutOf20(readNestedText(j.note)),
    players: readNestedText(j.joueurs),
    boxArtUrl: pickMedia(medias, BOX_ART_TYPES),
    extra: {
      box3DUrl: pickMedia(medias, ['box-3D']),
      marqueeUrl: pickMedia(medias, ['marquee']),
      titleScreenUrl: pickMedia(medias, ['sstitle']),
      snapUrl: pickMedia(medias, ['ss']),
      clearLogoUrl: pickMedia(medias, ['wheel']),
      screenshots: pickAllMedia(medias, ['ss', 'screenmarqueesmall']),
    },
  };
}

// ─── helpers ────────────────────────────────────────────────────────

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readPath<T>(root: unknown, path: readonly string[]): T | null {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? null : (cur as T);
}

/**
 * Walk a regional array (`[ {region: 'us', text: '...'}, ... ]`) and
 * pick the highest-priority entry's text.
 */
function pickRegionalText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && 'text' in v,
  );
  for (const r of REGION_ORDER) {
    const hit = items.find((it) => it.region === r);
    if (
      hit !== undefined &&
      typeof hit.text === 'string' &&
      hit.text.length > 0
    ) {
      return hit.text;
    }
  }
  for (const it of items) {
    if (typeof it.text === 'string' && it.text.length > 0) return it.text;
  }
  return null;
}

function readNestedText(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const text = (value as Record<string, unknown>).text;
  return typeof text === 'string' && text.length > 0 ? text : null;
}

function pickAllGenres(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const g of value) {
    if (g === null || typeof g !== 'object') continue;
    const noms = (g as Record<string, unknown>).noms;
    const name = pickRegionalText(noms);
    if (name !== null) out.push(name);
  }
  return out;
}

function pickSynopsis(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object',
  );
  // Language preference: en, then any with usable text.
  const en = items.find((it) => it.langue === 'en');
  if (en !== undefined && typeof en.text === 'string' && en.text.length > 0) {
    return en.text;
  }
  for (const it of items) {
    if (typeof it.text === 'string' && it.text.length > 0) return it.text;
  }
  return null;
}

function pickMedia(
  value: unknown,
  types: readonly string[],
): string | null {
  if (!Array.isArray(value)) return null;
  for (const t of types) {
    const hit = pickMediaForType(value, t);
    if (hit !== null) return hit;
  }
  return null;
}

function pickAllMedia(
  value: unknown,
  types: readonly string[],
): readonly string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const t of types) {
    for (const item of value) {
      if (item !== null && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        if (o.type === t && typeof o.url === 'string' && o.url.length > 0) {
          out.push(o.url);
        }
      }
    }
  }
  return out;
}

function pickMediaForType(
  items: readonly unknown[],
  type: string,
): string | null {
  const matches = items.filter((it): it is Record<string, unknown> => {
    if (it === null || typeof it !== 'object') return false;
    return (it as Record<string, unknown>).type === type;
  });
  if (matches.length === 0) return null;
  for (const r of REGION_ORDER) {
    const hit = matches.find((m) => m.region === r);
    if (hit !== undefined && typeof hit.url === 'string' && hit.url.length > 0) {
      return hit.url;
    }
  }
  for (const m of matches) {
    if (typeof m.url === 'string' && m.url.length > 0) return m.url;
  }
  return null;
}

function scaleNoteOutOf20(text: string | null): number | null {
  if (text === null) return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 20) return null;
  // /20 → /10. Round to one decimal place for stable storage.
  return Math.round((n / 2) * 10) / 10;
}
