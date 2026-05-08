import type { MetadataHint, RomMetadata } from '@shared/metadata-types';

const ENDPOINT = 'https://api.screenscraper.fr/api2/jeuInfos.php';
const SOFTNAME = 'mistercurator';
const DEFAULT_MIN_INTERVAL_MS = 1100;
const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Region preference for picking text/image fields out of ScreenScraper's
 * regional arrays. "us" first because the MiSTer userbase is heavily
 * North American; "wor" (worldwide), "eu", and "ss" cover the rest.
 * After this list, any region is acceptable as a final fallback.
 */
const REGION_ORDER = ['us', 'wor', 'eu', 'jp', 'ss'] as const;

/** Box-art media types in fallback order — matches the spec. */
const BOX_ART_TYPES = ['box-2D', 'box-3D', 'wheel'] as const;
const SCREENSHOT_TYPES = ['ss'] as const;
const TITLE_TYPES = ['sstitle'] as const;

export interface ScreenScraperClientOptions {
  /** Test seam — defaults to global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Test seam for the rate-limit waiter. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test seam — wall-clock source. */
  readonly now?: () => number;
  /** When true, all calls return null without hitting the network. */
  readonly disabled?: boolean;
  /** Minimum gap between requests, in ms. Default 1100. */
  readonly minIntervalMs?: number;
  /** Cap on retry attempts after a 429 / 5xx. Default 4. */
  readonly maxRetries?: number;
  /** Cap on the exponential-backoff delay. Default 30s. */
  readonly maxBackoffMs?: number;
  /** Per-request fetch timeout. Default 15s. */
  readonly timeoutMs?: number;
}

/**
 * Anonymous-tier ScreenScraper client. Hits `jeuInfos.php` keyed by
 * md5; the response gets normalized into the `RomMetadata` shape.
 *
 * Rate limit: ~1 request/sec across all anonymous traffic. The client
 * enforces a 1.1s floor between requests via a single-flight queue.
 * 429 responses retry with exponential backoff capped at 30s.
 *
 * Disabled-mode: when `METADATA_DISABLE_SCREENSCRAPER=1` is set in the
 * environment (or `disabled: true` is passed explicitly), every call
 * returns null without touching the network. This is the bypass the
 * spec calls for if ScreenScraper's TOS becomes a concern.
 */
export class ScreenScraperClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly nowImpl: () => number;
  private readonly disabled: boolean;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly maxBackoffMs: number;
  private readonly timeoutMs: number;

  /** Promise chain serializing all requests for the rate-limit floor. */
  private queue: Promise<unknown> = Promise.resolve();
  /**
   * Wall-clock at the end of the most recent request, or null if no
   * request has run yet. The null sentinel makes the first call free
   * — there's no prior request to space against.
   */
  private lastCallAt: number | null = null;

  constructor(options: ScreenScraperClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.nowImpl = options.now ?? Date.now;
    this.disabled = options.disabled ?? false;
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Look up metadata by md5. Returns null on no-match (404 or empty
   * response), on persistent rate-limit / server failure, and when the
   * client is disabled. The hint is a tie-breaker that future
   * versions may use to filter ambiguous matches; v0 ignores it.
   */
  async getByMd5(
    md5: string,
    hint?: MetadataHint,
  ): Promise<RomMetadata | null> {
    void hint; // v0 ignores the hint; reserved for future tie-breaking
    if (this.disabled) return null;
    if (!isMd5Hex(md5)) return null;
    return this.enqueue(() => this.fetchByMd5(md5));
  }

  // ─── internals ─────────────────────────────────────────────────────

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(async () => {
      // Rate-limit the START of consecutive requests, not the gap
      // between end-of-one and start-of-next. ScreenScraper's "1 req
      // /sec" is per call attempt — a slow call shouldn't earn extra
      // throttling for the next one.
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

  private async fetchByMd5(md5: string): Promise<RomMetadata | null> {
    const url = `${ENDPOINT}?softname=${SOFTNAME}&output=json&md5=${md5}`;
    let attempt = 0;
    while (true) {
      let res: Response;
      try {
        res = await this.fetchWithTimeout(url);
      } catch {
        // Network-level error → retry like a 5xx. After exhaustion,
        // null so the caller can fall through to TheGamesDB.
        if (attempt >= this.maxRetries) return null;
        await this.sleepImpl(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt >= this.maxRetries) return null;
        await this.sleepImpl(this.backoffMs(attempt));
        attempt += 1;
        continue;
      }
      if (res.status === 404) return null;
      if (!res.ok) return null;
      // ScreenScraper sometimes returns 200 + a payload that's HTML or
      // an error string when the hash isn't recognized. Catch parse
      // failures and treat them as "no match".
      let json: unknown;
      try {
        json = await res.json();
      } catch {
        return null;
      }
      return mapJeuToMetadata(json, md5, this.nowImpl);
    }
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    // Native AbortController is supported in Node 18+ / Electron 33.
    // We don't rely on AbortSignal.timeout to keep things explicit
    // and testable.
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

// ─── response → RomMetadata mapping (exported for test access) ──────

/**
 * Normalize a parsed `jeuInfos.php` response into our cross-cutting
 * `RomMetadata` shape. Returns null when no `jeu` is present.
 *
 * Exported so the response-mapping is testable without spinning up a
 * full client + mock fetch chain.
 */
export function mapJeuToMetadata(
  json: unknown,
  hash: string,
  now: () => number,
): RomMetadata | null {
  const jeu = readPath<unknown>(json, ['response', 'jeu']);
  if (jeu === null || typeof jeu !== 'object') return null;
  const j = jeu as Record<string, unknown>;
  const fetchedAt = new Date(now()).toISOString();
  return {
    version: 1,
    hash,
    name: pickRegionalText(j.noms) ?? '(unknown)',
    year: parseYear(pickRegionalText(j.dates)),
    publisher: readNestedText(j.editeur),
    developer: readNestedText(j.developpeur),
    genre: pickGenre(j.genres),
    players: readNestedText(j.joueurs),
    criticScore: scaleNoteOutOf20(readNestedText(j.note)),
    ageRating: pickClassification(j.classifications),
    description: pickSynopsis(j.synopsis),
    boxArtUrl: pickMedia(j.medias, BOX_ART_TYPES),
    screenshotUrls: pickAllMedia(j.medias, SCREENSHOT_TYPES),
    titleScreenUrl: pickMedia(j.medias, TITLE_TYPES),
    source: 'screenscraper',
    fetchedAt,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function isMd5Hex(s: string): boolean {
  if (s.length !== 32) return false;
  for (let i = 0; i < 32; i += 1) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLowerHex = c >= 97 && c <= 102;
    const isUpperHex = c >= 65 && c <= 70;
    if (!isDigit && !isLowerHex && !isUpperHex) return false;
  }
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
 * pick the highest-priority entry's text. Returns null if no entry has
 * a usable text field.
 */
function pickRegionalText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (v): v is Record<string, unknown> =>
      v !== null && typeof v === 'object' && 'text' in v,
  );
  for (const r of REGION_ORDER) {
    const hit = items.find((it) => it.region === r);
    if (hit !== undefined && typeof hit.text === 'string' && hit.text.length > 0) {
      return hit.text;
    }
  }
  // Any region as final fallback.
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

function pickGenre(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const first = value[0];
  if (first === null || typeof first !== 'object') return null;
  const noms = (first as Record<string, unknown>).noms;
  return pickRegionalText(noms);
}

function pickClassification(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  // Prefer ESRB if present, else the first.
  for (const c of value) {
    if (c !== null && typeof c === 'object') {
      const o = c as Record<string, unknown>;
      if (o.type === 'ESRB' && typeof o.text === 'string') return o.text;
    }
  }
  const first = value[0];
  if (first !== null && typeof first === 'object') {
    const t = (first as Record<string, unknown>).text;
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return null;
}

function pickSynopsis(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const items = value.filter(
    (v): v is Record<string, unknown> => v !== null && typeof v === 'object',
  );
  // Language preference: en, then any.
  const en = items.find((it) => it.langue === 'en');
  if (en !== undefined && typeof en.text === 'string') return en.text;
  for (const it of items) {
    if (typeof it.text === 'string' && it.text.length > 0) return it.text;
  }
  return null;
}

function pickMedia(value: unknown, types: readonly string[]): string | null {
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

function pickMediaForType(items: readonly unknown[], type: string): string | null {
  // Region-preferenced pick: us → wor → ... → any.
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

function parseYear(text: string | null): number | null {
  if (text === null) return null;
  // ScreenScraper returns either a year or a full date. Take the
  // first 4 digits.
  const match = /\b(\d{4})\b/.exec(text);
  if (!match) return null;
  const y = Number.parseInt(match[1] ?? '', 10);
  if (!Number.isFinite(y)) return null;
  if (y < 1970 || y > 2100) return null;
  return y;
}

function scaleNoteOutOf20(text: string | null): number | null {
  if (text === null) return null;
  const n = Number.parseFloat(text);
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 20) return null;
  // Round to one decimal place at /100 for stable storage.
  return Math.round(n * 5 * 10) / 10;
}
