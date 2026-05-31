import { promises as fsPromises } from 'node:fs';

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
const SYSTEMS_ENDPOINT = 'https://api.screenscraper.fr/api2/systemesListe.php';

/**
 * MD5 of zero bytes. A zip file whose inner content extracts to
 * nothing produces this hash; ScreenScraper happens to have a
 * cross-system stub entry for it, so sending it returns a wrong match
 * that poisons the by-hash cache for every other zero-byte file.
 * Never send this hash to SS — it cannot identify any real ROM.
 */
export const EMPTY_CONTENT_MD5 = 'd41d8cd98f00b204e9800998ecf8427e';
/**
 * PR-D1 (PR #27): name-search endpoint. Used as a fallback when
 * `jeuInfos.php` returns no match for a known hash AND OpenVGDB
 * also misses — lets us recover NEOGEO romset-style names
 * (`mslug2`, `kof97`) and arcade titles via the filename / parent-
 * folder hint extracted in `filename-hint.ts`.
 *
 * Same auth, same rate-limit gap (1.1s shared with `jeuInfos`), same
 * redaction rules. Spec referenced `neoclone.screenscraper.fr` which
 * isn't a documented SS subdomain — using the standard
 * `api.screenscraper.fr` host to match the existing `jeuInfos`
 * client. If SS adds a separate name-search subdomain later, change
 * here.
 */
const SEARCH_ENDPOINT =
  'https://api.screenscraper.fr/api2/jeuRecherche.php';
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

/**
 * System logo media type preference order for `systemesListe.php`.
 * Monochrome SVG logos look cleanest in a dark-themed sidebar; coloured
 * PNG 'logo' is a decent fallback. The wheel/marquee types are
 * game-cabinet art, not clean system logos — prefer the explicit logo
 * types first.
 */
const SYSTEM_LOGO_MEDIA_TYPES = ['logo-monochrome', 'logo-monochrome-svg', 'logo-svg', 'wheel'] as const;

/**
 * feat/system-catalog-data-layer (#30 PR-1) — one entry from the
 * `systemesListe.php` catalog: the system's SS id, the best English
 * display name, and the URL of the best available logo (null when SS
 * has no logo for this system).
 */
export interface SystemCatalogEntry {
  readonly id: number;
  readonly displayName: string;
  readonly logoUrl: string | null;
}

/**
 * Full catalog keyed by SS system id. Returned by
 * `ScreenScraperService.fetchSystemCatalog()`.
 */
export type SystemCatalog = ReadonlyMap<number, SystemCatalogEntry>;

export type ScreenScraperStatus =
  | 'available'
  | 'unavailable'
  | 'rate-limited'
  | 'quota-exceeded';

/**
 * feat/manual-search-observability — discriminated outcome for
 * `searchByName`. The IPC handler at `app/main/ipc/register.ts`
 * reads the `reason` field on the empty branch to emit a granular
 * `ss-manual-search-result` diag line, so a "No matches found"
 * dialog message can be traced to one of five service-layer
 * silent-return paths instead of being conflated as "SS said no."
 *
 * Two additional reasons (`service-null`, `no-system-mapping`)
 * fire in the IPC handler BEFORE `searchByName` is called, so
 * they're handled at that layer and never appear here.
 */
export type ScreenScraperSearchOutcome =
  | { readonly kind: 'ok'; readonly results: readonly ScreenScraperGame[] }
  | {
      readonly kind: 'empty';
      readonly reason:
        | 'no-credentials'
        | 'service-unavailable'
        | 'fetch-failed'
        | 'parser-empty'
        | 'all-parsed-dropped';
      /**
       * The actual ScreenScraperStatus when reason='service-unavailable'.
       * Disambiguates the four sub-states ('rate-limited',
       * 'quota-exceeded', 'unavailable' from auth-failed/blacklisted/
       * no-creds — though the no-creds case is its own reason above).
       */
      readonly status?: ScreenScraperStatus;
      /**
       * Last HTTP status seen when reason='fetch-failed'. Undefined
       * when the failure was a pre-response network/timeout error.
       */
      readonly httpStatus?: number;
    };

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

// PR-D2 (PR #29): types moved to `shared/screenscraper-types.ts` so
// the preload bridge + renderer can import them too. Re-exported
// here for back-compat — existing consumers (orchestrator, tests)
// keep importing from this module.
import type { ScreenScraperGame } from '@shared/screenscraper-types';

export type {
  ScreenScraperGame,
  ScreenScraperExtraArt,
} from '@shared/screenscraper-types';

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
  /**
   * When set, a raw response body that passes HTTP 200 but fails
   * `parseSystemCatalog` is written here for post-mortem inspection.
   * Credentials are redacted before writing.
   */
  readonly debugDumpPath?: string;
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
  private readonly debugDumpPath: string | null;

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

  /**
   * fix/system-catalog-visibility-and-latch (#64) — reset transient
   * error latches so a caller can retry. Intended for the dedicated
   * catalog-service instance; the ROM-scraping instance keeps its
   * latched state to avoid hammering SS with wrong credentials.
   *
   * Clears: authFailed, rateLimitedUntil.
   * Leaves: blacklisted, quotaExceeded (permanent/day-scoped).
   */
  resetAuthState(): void {
    this.authFailed = false;
    this.rateLimitedUntil = null;
  }

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
    this.debugDumpPath = options.debugDumpPath ?? null;
  }

  /**
   * feat/manual-search-observability — public accessor for the
   * configured-credentials flag. `getStatus()` collapses
   * no-credentials, authFailed, and blacklisted into the same
   * `'unavailable'` value; the manual-search IPC handler wants to
   * surface the no-credentials case distinctly in its attempt log.
   */
  get isConfigured(): boolean {
    return this.hasCredentials;
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
    // Sending the empty-content MD5 (d41d8cd…) to SS returns a
    // cross-system stub that would poison the by-hash cache for every
    // other zero-byte file. A romSize of 0 is equally invalid — skip
    // both and let the caller fall through to name-search / sentinel.
    if (
      query.md5 === EMPTY_CONTENT_MD5 ||
      (query.romSize !== undefined && query.romSize === 0)
    ) {
      return null;
    }
    return this.enqueue(() => this.doLookup(query));
  }

  /**
   * PR-D1 (PR #27) — name-search fallback. Calls
   * `jeuRecherche.php?systemeid=<id>&recherche=<term>` and returns
   * SS's ranked candidate games (top result first). Caller scores
   * each candidate against the search term via `name-match.ts` and
   * decides whether to bind.
   *
   * Uses the SAME enqueue gate / 1.1s rate-limit / retry rules as
   * `lookup` — name-search calls share the rate budget with hash
   * lookups so we never exceed the SS API floor across mixed
   * traffic.
   */
  async searchByName(args: {
    readonly systemId: number;
    readonly searchTerm: string;
  }): Promise<ScreenScraperSearchOutcome> {
    if (!this.hasCredentials) {
      return { kind: 'empty', reason: 'no-credentials' };
    }
    const status = this.getStatus();
    if (status !== 'available') {
      return { kind: 'empty', reason: 'service-unavailable', status };
    }
    const term = args.searchTerm.trim();
    // Empty-after-trim keeps the existing silent-skip behavior; the
    // IPC handler guards against this earlier but the service stays
    // defensive. Treated as parser-empty since there's nothing to
    // parse — distinct from a fetched empty response we'd also call
    // parser-empty, but functionally identical for log readers.
    if (term === '') {
      return { kind: 'empty', reason: 'parser-empty' };
    }
    return this.enqueue(() => this.doSearchByName(args.systemId, term));
  }

  /**
   * feat/system-catalog-data-layer (#30 PR-1) — fetch the full SS
   * system catalog from `systemesListe.php`. Returns a Map of all
   * systems (SS system id → display name + logo URL), or null when:
   *   - credentials are absent
   *   - the service is rate-limited / unavailable
   *   - the request fails after retries
   *   - the response is unparseable
   *
   * Uses the same rate-limit queue and retry logic as `lookup` and
   * `searchByName` — callers should use a dedicated
   * `ScreenScraperService` instance so this fetch doesn't stall the
   * per-ROM scraping queue.
   */
  async fetchSystemCatalog(): Promise<SystemCatalog | null> {
    if (!this.hasCredentials) {
      this.logger(
        '[ScreenScraper] system-catalog: credentials not configured — set SCREENSCRAPER_DEV_ID and SCREENSCRAPER_DEV_PASSWORD.',
      );
      return null;
    }
    const status = this.getStatus();
    if (status !== 'available') {
      this.logger(
        `[ScreenScraper] system-catalog: service not available (status=${status}); skipping fetch.`,
      );
      return null;
    }
    return this.enqueue(() => this.doFetchSystemCatalog());
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
    const outcome = await this.fetchWithRetries(url);
    if (outcome.kind !== 'ok') return null;
    return parseScreenScraperResponse(outcome.body);
  }

  /**
   * PR-D1 (PR #27): name-search executor. Mirrors `doLookup`'s
   * shape (build URL → shared fetch+retry → parse) but calls
   * `parseScreenScraperSearchResponse` against the array-of-jeux
   * shape that `jeuRecherche.php` returns.
   */
  private async doSearchByName(
    systemId: number,
    searchTerm: string,
  ): Promise<ScreenScraperSearchOutcome> {
    const url = this.buildSearchUrl(systemId, searchTerm);
    const outcome = await this.fetchWithRetries(url);
    if (outcome.kind !== 'ok') {
      return {
        kind: 'empty',
        reason: 'fetch-failed',
        httpStatus: outcome.httpStatus,
      };
    }
    // feat/manual-search-observability: the parser-empty case
    // (`response.jeux` missing or non-array) and the
    // all-parsed-dropped case (every per-jeu parse returned null)
    // were collapsed before. Split them so the trace tells us
    // whether SS returned an unexpected body shape vs returned a
    // response with jeux we couldn't extract names from.
    const jeux = readPath<unknown>(outcome.body, ['response', 'jeux']);
    if (!Array.isArray(jeux)) {
      return { kind: 'empty', reason: 'parser-empty' };
    }
    const results = parseScreenScraperSearchResponse(outcome.body);
    if (results.length === 0) {
      // jeux was an array but every entry failed to parse, OR jeux
      // was empty. Both surface as no usable matches; the input
      // length tells the user whether SS sent jeux at all.
      return jeux.length === 0
        ? { kind: 'empty', reason: 'parser-empty' }
        : { kind: 'empty', reason: 'all-parsed-dropped' };
    }
    return { kind: 'ok', results };
  }

  /**
   * fix/system-catalog-visibility-and-latch (#64) — standalone fetch
   * that bypasses `fetchWithRetries` so the catalog call never mutates
   * `authFailed` / `rateLimitedUntil` / `quotaExceeded` on the
   * dedicated catalog-service instance. Full request-level diagnostics
   * via `this.logger` so failures are visible in the Terminal even when
   * the renderer swallows the error.
   */
  private async doFetchSystemCatalog(): Promise<SystemCatalog | null> {
    const url = this.buildSystemsUrl();
    const safeUrl = redactScreenScraperUrl(url);
    this.logger(`[ScreenScraper] system-catalog: fetching ${safeUrl}`);

    let res: Response;
    try {
      res = await this.fetchWithTimeout(url);
    } catch (err) {
      this.logger(
        `[ScreenScraper] system-catalog: network error — ` +
          `${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      return null;
    }

    this.logger(
      `[ScreenScraper] system-catalog: response status=${String(res.status)} ok=${String(res.ok)}`,
    );

    let text: string;
    try {
      text = await res.text();
    } catch {
      this.logger('[ScreenScraper] system-catalog: failed to read response body');
      return null;
    }

    if (!res.ok) {
      this.logger(
        `[ScreenScraper] system-catalog: non-2xx body (first 500)="${text.slice(0, 500)}"`,
      );
      return null;
    }

    let body: unknown;
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      this.logger(
        `[ScreenScraper] system-catalog: JSON parse failed body (first 500)="${text.slice(0, 500)}"`,
      );
      return null;
    }

    const catalog = parseSystemCatalog(body);
    if (catalog === null) {
      this.logger(
        `[ScreenScraper] system-catalog: parseSystemCatalog returned null body (first 3000)="${text.slice(0, 3000)}"`,
      );
      await this.dumpDebugResponse(text);
    }
    return catalog;
  }

  /**
   * Shared fetch + retry + status-handling routine. Returns either
   * the parsed JSON body on success OR a structured failure with
   * the last httpStatus seen (when applicable). Both `doLookup`
   * (jeuInfos) and `doSearchByName` (jeuRecherche) call this with
   * the appropriate URL — the only difference between them is the
   * per-endpoint response shape which the caller handles with its
   * own parser.
   *
   * feat/manual-search-observability: the return type widened from
   * `unknown | null` to a discriminated union so the search-by-name
   * caller can thread the failure cause into its outcome envelope.
   * Hash-lookup callers (doLookup) still collapse a failure to
   * `null` immediately — no behavior change for that branch.
   */
  private async fetchWithRetries(
    url: string,
  ): Promise<
    | { readonly kind: 'ok'; readonly body: unknown }
    | { readonly kind: 'fail'; readonly httpStatus?: number }
  > {
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
          return { kind: 'fail' };
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
          return { kind: 'fail', httpStatus: 401 };
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
      if (res.status === 404) return { kind: 'fail', httpStatus: 404 };
      // 426: software blacklisted. Fatal config — only fixable by
      // changing the softname identifier upstream. Latch unavailable
      // with a distinct log line.
      if (res.status === 426) {
        this.blacklisted = true;
        this.logger(
          '[ScreenScraper] HTTP 426 — this software\'s softname is blacklisted. ' +
            'Disabling for this session. The MiSTerCurator softname needs to be updated.',
        );
        return { kind: 'fail', httpStatus: 426 };
      }
      if (res.status === 429) {
        if (attempts429 >= MAX_429_RETRIES) {
          this.enterRateLimitedCooldown('rate-limit (HTTP 429) budget exhausted');
          return { kind: 'fail', httpStatus: 429 };
        }
        const backoff = this.backoffMs(attempts429);
        if (total429BackoffMs + backoff > TOTAL_429_BUDGET_MS) {
          this.enterRateLimitedCooldown(
            `rate-limit (HTTP 429) aggregate budget (${String(TOTAL_429_BUDGET_MS)}ms) exhausted`,
          );
          return { kind: 'fail', httpStatus: 429 };
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
        return { kind: 'fail', httpStatus: 430 };
      }
      if (res.status === 431) {
        this.quotaExceeded = true;
        this.logger(
          '[ScreenScraper] HTTP 431 — too many ROMs not recognised today. ' +
            'Disabled to avoid further KO penalty.',
        );
        return { kind: 'fail', httpStatus: 431 };
      }
      if (res.status >= 500) {
        if (attempts5xx >= MAX_5XX_RETRIES) {
          this.logger(
            `[ScreenScraper] HTTP ${String(res.status)} persisted after ${String(attempts5xx + 1)} attempts; ` +
              `giving up on ${redactScreenScraperUrl(url)}`,
          );
          return { kind: 'fail', httpStatus: res.status };
        }
        await this.sleepImpl(this.backoffMs(attempts5xx));
        attempts5xx += 1;
        continue;
      }
      if (!res.ok) {
        this.logger(
          `[ScreenScraper] unexpected HTTP ${String(res.status)} on ${redactScreenScraperUrl(url)}; treating as no-match.`,
        );
        return { kind: 'fail', httpStatus: res.status };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { kind: 'fail', httpStatus: res.status };
      }
      return { kind: 'ok', body };
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
    this.applyAuthAndOutputParams(u);
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

  /**
   * PR-D1 (PR #27): build the `jeuRecherche.php` URL. Same auth + output
   * params as `buildUrl`; only the `recherche` and `systemeid`
   * differ. URL.searchParams URL-encodes the search term so spaces
   * and punctuation in game names ("Metal Slug 2 (USA)") survive.
   */
  private buildSearchUrl(systemId: number, searchTerm: string): string {
    const u = new URL(SEARCH_ENDPOINT);
    this.applyAuthAndOutputParams(u);
    u.searchParams.set('systemeid', String(systemId));
    u.searchParams.set('recherche', searchTerm);
    return u.toString();
  }

  private buildSystemsUrl(): string {
    const u = new URL(SYSTEMS_ENDPOINT);
    this.applyAuthAndOutputParams(u);
    return u.toString();
  }

  /**
   * Write a parse-failed response body to `debugDumpPath` for post-mortem
   * inspection. Credentials are scrubbed before writing. No-ops silently
   * if `debugDumpPath` is null or the write fails.
   */
  private async dumpDebugResponse(rawBody: string): Promise<void> {
    if (this.debugDumpPath === null) return;
    const redacted = rawBody
      .replace(/devid=[^&"\s]*/gi, 'devid=[redacted]')
      .replace(/devpassword=[^&"\s]*/gi, 'devpassword=[redacted]');
    try {
      await fsPromises.writeFile(this.debugDumpPath, redacted, 'utf8');
      this.logger(
        `[ScreenScraper] system-catalog: wrote raw response to ${this.debugDumpPath} for inspection`,
      );
    } catch (err) {
      this.logger(
        `[ScreenScraper] system-catalog: failed to write debug dump — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Apply the SS auth + output-format params shared by every endpoint.
   * Extracted so the jeuInfos and jeuRecherche URL builders share a
   * single source for credential injection — adding a new SS endpoint
   * means one new builder, not duplicating the auth wiring.
   */
  private applyAuthAndOutputParams(u: URL): void {
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
  return parseSingleJeu(jeu);
}

/**
 * PR-D1 (PR #27): parse a `jeuRecherche.php` response. Returns the
 * candidate games in SS's response order (most relevant first).
 *
 * Response shape: `{ response: { jeux: [<jeu>, <jeu>, ...] } }`. Each
 * `jeu` has the same shape as the single-`jeu` payload from
 * `jeuInfos`, so the per-game parser is shared. Empty array returned
 * when:
 *   • body is missing / non-object
 *   • `response.jeux` is missing or not an array
 *   • every individual jeu fails to parse (no name, missing id)
 */
export function parseScreenScraperSearchResponse(
  body: unknown,
): readonly ScreenScraperGame[] {
  if (body === null || typeof body !== 'object') return [];
  const jeux = readPath<unknown>(body, ['response', 'jeux']);
  if (!Array.isArray(jeux)) return [];
  const out: ScreenScraperGame[] = [];
  for (const j of jeux) {
    const parsed = parseSingleJeu(j);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

/**
 * feat/system-catalog-data-layer (#30 PR-1) — parse a
 * `systemesListe.php` response. Returns a Map of all systems keyed
 * by SS system id, or null when the body is unparseable / empty.
 *
 * Exported for direct test access without a full client + mock fetch.
 */
export function parseSystemCatalog(body: unknown): SystemCatalog | null {
  if (body === null || typeof body !== 'object') return null;
  const systemes = readPath<unknown>(body, ['response', 'systemes']);
  if (!Array.isArray(systemes)) return null;
  const entries = new Map<number, SystemCatalogEntry>();
  for (const s of systemes) {
    if (s === null || typeof s !== 'object') continue;
    const sys = s as Record<string, unknown>;
    const idRaw = sys.id;
    const id =
      typeof idRaw === 'number'
        ? idRaw
        : typeof idRaw === 'string'
          ? Number.parseInt(idRaw, 10)
          : NaN;
    if (!Number.isFinite(id)) continue;
    const displayName = pickSystemName(sys.noms);
    if (displayName === null) continue;
    const logoUrl = pickMedia(sys.medias, SYSTEM_LOGO_MEDIA_TYPES);
    entries.set(id, { id, displayName, logoUrl });
  }
  return entries.size > 0 ? entries : null;
}

/**
 * PR-D1 (PR #27): single-jeu parser shared between `jeuInfos`
 * (one game) and `jeuRecherche` (array of games). Extracted from the
 * original `parseScreenScraperResponse` body so both endpoints route
 * through the same field-extraction logic — adding new metadata
 * fields means changing one place.
 */
function parseSingleJeu(jeu: unknown): ScreenScraperGame | null {
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
  const system = readSystemName(j.systeme);
  return {
    id,
    name,
    system,
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
 * fix/#65 — `systemesListe.php` returns `noms` as a flat object with
 * region-suffixed keys (`nom_us`, `nom_eu`, …), not as the regional
 * array used by `jeuInfos`. Priority: nom_us → nom_eu → any nom_* key.
 */
function pickSystemName(noms: unknown): string | null {
  if (noms === null || typeof noms !== 'object' || Array.isArray(noms)) return null;
  const obj = noms as Record<string, unknown>;
  for (const key of ['nom_us', 'nom_eu']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('nom_') && typeof v === 'string' && v.length > 0) return v;
  }
  return null;
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

/**
 * Read SS's canonical system label from `response.jeu.systeme`.
 *
 * The SS docs describe the field as `{ id, nom, parentid }`, but the
 * JSON response (output=json) actually delivers `{ id, text }` — the
 * docs were written against the XML output where `text` is the
 * element body. Verified empirically against the live API for round
 * 5; round 4 shipped reading `.nom` (per the docs) and got null for
 * every record.
 *
 * Try `.text` first (production reality), fall back to `.nom`
 * (docs-as-written, in case SS ever aligns the JSON to the docs),
 * null otherwise.
 */
function readSystemName(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  const text = obj.text;
  if (typeof text === 'string' && text.length > 0) return text;
  const nom = obj.nom;
  if (typeof nom === 'string' && nom.length > 0) return nom;
  return null;
}

/**
 * chore/search-and-filter-cleanup commit 3: prefer English for genre
 * names.
 *
 * SS genre `noms` are LANGUAGE-keyed (`langue: 'en' | 'de' | 'fr' …`),
 * NOT region-keyed. Pre-fix the code routed through `pickRegionalText`,
 * which looks for the `region` field — never present on genres — and
 * fell through to "first non-empty text," which depended on response
 * order and surfaced German entries like "Kampf / Versus, Kampf"
 * instead of the English "Fighting".
 *
 * Output is deduped case-insensitively in case SS lists the same genre
 * twice (one game cataloged with both an "Action" and a duplicate
 * "Action" entry under different SS genre IDs).
 */
function pickAllGenres(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of value) {
    if (g === null || typeof g !== 'object') continue;
    const noms = (g as Record<string, unknown>).noms;
    const name = pickGenreNameEnglishFirst(noms);
    if (name === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Walk a SS `noms` array (`[ { langue: 'en', text: '...' }, ... ]`)
 * and return the English entry's text when present, else the first
 * non-empty text. Mirrors the language-preference logic
 * `pickSynopsis` already uses for game descriptions.
 */
function pickGenreNameEnglishFirst(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && 'text' in v,
  );
  const en = items.find((it) => it.langue === 'en');
  if (en !== undefined && typeof en.text === 'string' && en.text.length > 0) {
    return en.text;
  }
  for (const it of items) {
    if (typeof it.text === 'string' && it.text.length > 0) return it.text;
  }
  return null;
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
