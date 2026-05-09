/**
 * Shared ScreenScraper types — the parsed `jeu` shape returned by
 * the SS service. Lives in `shared/` so both the main process and
 * the renderer (via the preload bridge) can type their IPC traffic
 * around it.
 *
 * PR-D2 (PR #29): the search modal in the renderer hands a candidate
 * `ScreenScraperGame` back to main as the "Use this match" payload.
 * Both sides need the same structural type — moved here from the
 * main-only module so both can import.
 */

/**
 * Parsed `jeuInfos` payload normalised into a stable shape. Round-1
 * scope: the fields the renderer's list view needs (name, year,
 * genre, publisher, box art) plus the SS-only extras the detail
 * modal will surface (description, developer, players, rating,
 * alternate art).
 */
export interface ScreenScraperGame {
  /** ScreenScraper internal game id — unique within their archive. */
  readonly id: number;
  /** Region-preferred name. Falls back through REGION_ORDER. */
  readonly name: string;
  /**
   * Canonical SS system name (`response.jeu.systeme.nom`). Round 4
   * sources the system label from the API response itself rather than
   * a coreId→name table maintained in lockstep with SS — the response
   * is the source of truth. Null when the response omits the field.
   */
  readonly system: string | null;
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
 * Parsed-but-unsurfaced art URLs. The detail-modal UI consumes
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
