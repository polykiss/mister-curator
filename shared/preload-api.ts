import type { ConnectionEvent } from '@shared/connection';
import type {
  MetadataHint,
  PrefetchProgress,
  RomMetadata,
  UserMetadataOverride,
} from '@shared/metadata-types';
import type { ScreenScraperGame } from '@shared/screenscraper-types';
import type {
  BulkCoreProgress,
  BulkCoreResult,
  BulkRomResult,
  MisterSecret,
} from '@shared/mister-client';
import type {
  ConnectionErrorCode,
  ConnectionStatus,
  CoreEntry,
  FolderClassifications,
  MisterProfile,
  Rom,
  SystemFilesMarks,
} from '@shared/types';

export const IPC_CHANNELS = {
  listProfiles: 'mister:listProfiles',
  saveProfile: 'mister:saveProfile',
  deleteProfile: 'mister:deleteProfile',
  connect: 'mister:connect',
  disconnect: 'mister:disconnect',
  getConnectionStatus: 'mister:getConnectionStatus',
  listAllCoresWithFiles: 'mister:listAllCoresWithFiles',
  listRoms: 'mister:listRoms',
  setRomVisibility: 'mister:setRomVisibility',
  setBulkRomVisibility: 'mister:setBulkRomVisibility',
  hideCore: 'mister:hideCore',
  showCore: 'mister:showCore',
  setBulkCoreVisibility: 'mister:setBulkCoreVisibility',
  listLedgerCoreIds: 'mister:listLedgerCoreIds',
  clearCache: 'mister:clearCache',
  pickKeyFile: 'mister:pickKeyFile',
  connectionStatusChanged: 'mister:connectionStatusChanged',
  listSystemFileMarks: 'mister:listSystemFileMarks',
  addSystemFileMark: 'mister:addSystemFileMark',
  removeSystemFileMark: 'mister:removeSystemFileMark',
  setSystemFileMarks: 'mister:setSystemFileMarks',
  bulkCoreProgress: 'mister:bulkCoreProgress',
  listFolderClassifications: 'mister:listFolderClassifications',
  setFolderClassification: 'mister:setFolderClassification',
  connectionEvent: 'mister:connectionEvent',
  // PR #15 — metadata pipeline. No UI consumer in this PR; the
  // channels are wired so PR #16/#17 has a stable contract.
  getRomMetadata: 'mister:getRomMetadata',
  prefetchHashes: 'mister:prefetchHashes',
  prefetchMetadata: 'mister:prefetchMetadata',
  clearMetadataCache: 'mister:clearMetadataCache',
  getBoxArtLocal: 'mister:getBoxArtLocal',
  // PR #20 (round 1) — render-side image bytes channel. Sandbox +
  // contextIsolation block file:// from the renderer's http://localhost
  // origin, so the renderer can't display the local-path output of
  // getBoxArtLocal directly. This channel returns the cached file's
  // bytes; the renderer wraps in a Blob + objectURL. If render-time
  // bandwidth becomes an issue (hundreds of visible rows at once), a
  // custom protocol handler is the structural follow-up.
  getBoxArtBytes: 'mister:getBoxArtBytes',
  metadataPrefetchProgress: 'mister:metadataPrefetchProgress',
  // PR #20 round 2 — list-view streaming prefetch. Replaces the
  // round-1 per-row IPC pattern (32 parallel `getRomMetadata`
  // calls per pane mount overwhelmed WiFi-attached MiSTers). The
  // container fires one `prefetchRomsMetadata` and subscribes to
  // `romMetadataResolved` events keyed on operationId.
  prefetchRomsMetadata: 'mister:prefetchRomsMetadata',
  romMetadataResolved: 'mister:romMetadataResolved',
  // PR-D1 round 2 (PR #27 round 2): pure-disk cache read used by
  // RomsPane on click for immediate row paint. No SSH, no SS,
  // never blocks the UI on the auto-scrape engine's gate.
  getCachedRomsMetadata: 'mister:getCachedRomsMetadata',
  // PR-D2 (PR #29) — manual-override write paths for the edit
  // modal (free-form fields) and search modal (jeuid bind).
  setRomMetadataOverride: 'mister:setRomMetadataOverride',
  bindRomMetadataFromSearch: 'mister:bindRomMetadataFromSearch',
  // PR-D2 (PR #29) — name-search invoked from the renderer's
  // search modal. Same SS endpoint the auto-scrape pipeline uses,
  // exposed directly so the UI can drive it interactively.
  searchScreenScraperByName: 'mister:searchScreenScraperByName',
  // Round 3 (OpenVGDB). The renderer prompts the user to download
  // the ~50MB SQLite snapshot; main pulls it down + opens it.
  ensureMetadataDatabase: 'mister:ensureMetadataDatabase',
  metadataDatabaseProgress: 'mister:metadataDatabaseProgress',
  // PR-C (PR #26) — auto-scrape engine. The main process walks every
  // core's metadata in the background (sidebar order). The renderer
  // subscribes to `autoScrapeProgress` to render live progress in
  // the footer-left slot and calls `setAutoScrapeFocus` when the
  // user clicks a core (jumps it to the head of the queue, current
  // active core resumes after).
  autoScrapeProgress: 'mister:autoScrapeProgress',
  setAutoScrapeFocus: 'mister:setAutoScrapeFocus',
  // feat/arcade-phase-1.5 — .mra listing + hide/unhide for the
  // MiSTer arcade menu. Distinct from `mame` core ops (which target
  // .zip ROMs in /media/fat/games/mame/); these target .mra files
  // in /media/fat/_Arcade/ and use the same dot-prefix hide
  // convention.
  listArcadeMraEntries: 'mister:listArcadeMraEntries',
  setArcadeMraVisibility: 'mister:setArcadeMraVisibility',
  setBulkArcadeMraVisibility: 'mister:setBulkArcadeMraVisibility',
} as const;

/** PR #15 prefetch progress kind. Discriminator for the wire event. */
export type MetadataPrefetchKind = 'hash' | 'metadata';

/**
 * PR #20 round 2 — per-path resolution event from the list-view
 * streaming prefetch. The renderer matches `operationId` to the
 * prefetch call it triggered and updates per-row state by `path`.
 * `error: true` means the upstream fetch failed (e.g., SSH dropped);
 * `metadata: null, error: false` means a clean no-match.
 */
export interface RomMetadataResolvedEvent {
  readonly operationId: string;
  readonly path: string;
  readonly metadata: RomMetadata | null;
  readonly error: boolean;
}

/**
 * One progress tick from a long-running metadata prefetch. The
 * `kind` discriminates "hashing the library" from "fetching metadata
 * for the hashed library" — two phases of the same flow.
 */
export interface MetadataPrefetchEvent extends PrefetchProgress {
  readonly operationId: string;
  readonly kind: MetadataPrefetchKind;
}

/**
 * Round 3: streaming progress from the OpenVGDB download. Mirrors
 * the OpenVGDBProgressEvent shape but flattened for cross-process
 * transmission so the renderer doesn't depend on the main-process
 * type.
 */
export type MetadataDatabaseProgressEvent =
  | { readonly kind: 'started' }
  | {
      readonly kind: 'downloading';
      readonly bytesReceived: number;
      readonly bytesTotal: number | null;
    }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Snapshot return value from `mister:ensureMetadataDatabase`. The
 * renderer reads this synchronously and subscribes to the streaming
 * progress channel for live updates.
 */
export interface MetadataDatabaseState {
  readonly ready: boolean;
  readonly downloadInProgress: boolean;
}

/**
 * Wire-side bulk progress event. The renderer uses `operationId` to
 * scope events to the call it actually triggered — concurrent or stale
 * bulk ops can't trample each other.
 */
export interface BulkCoreProgressEvent extends BulkCoreProgress {
  readonly operationId: string;
}

/**
 * PR-C (PR #26) — auto-scrape progress. Two states:
 *   • `active` while the engine is working on a core (`done`/`total`
 *     count individual paths within that core; `coreLabel` is the
 *     display name, e.g. `mame` → "Arcade")
 *   • `idle` when the queue is empty / engine paused / not yet started
 *
 * feat/auto-scrape-persistence: both states carry session
 * completion state so the renderer can:
 *   • render "<N> done · <M> queued" tail in the footer status,
 *   • decorate completed sidebar rows with a check icon.
 */
export type AutoScrapeProgressEvent =
  | {
      readonly state: 'active';
      readonly coreId: string;
      readonly coreLabel: string;
      readonly done: number;
      readonly total: number;
      readonly completedCoreIds: readonly string[];
      readonly remainingCount: number;
    }
  | {
      readonly state: 'idle';
      readonly completedCoreIds: readonly string[];
    };

export interface SystemFileMarkChangeWire {
  readonly filename: string;
  readonly marked: boolean;
}

export interface RomVisibilityChangeWire {
  readonly filename: string;
  readonly hidden: boolean;
}

export interface CoreVisibilityChangeWire {
  readonly coreId: string;
  readonly hidden: boolean;
}

export interface PickedKeyFile {
  readonly path: string;
  readonly content: string;
}

/**
 * Result of a successful `connect()` IPC call. `reappliedCount` is the
 * number of cores that were re-hidden as part of the auto-reapply step
 * (zero unless the profile has `autoReapplyHides` enabled and the device
 * had drifted since the last connection). The renderer surfaces this as
 * a single toast.
 *
 * Note: ledger I/O (`readHideLedger` / `writeHideLedger`) is intentionally
 * NOT exposed on this bridge — the renderer has no direct access to the
 * ledger, only to its consequences (this field, the read-only
 * `listLedgerCoreIds()` for the "Unhide all" target list, and
 * `gamesDirHidden` / `rbfPaths` on each `CoreEntry`). The
 * ConnectionManager owns the ledger.
 */
export interface ConnectResult {
  readonly reappliedCount: number;
}

export interface MisterApi {
  listProfiles(): Promise<MisterProfile[]>;
  saveProfile(profile: MisterProfile, secret: MisterSecret): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;
  /**
   * Open the SSH connection for the given profile. Returns the
   * `reappliedCount` from the auto-reapply step (always 0 when the
   * profile's `autoReapplyHides` is false or undefined).
   */
  connect(profileId: string): Promise<ConnectResult>;
  disconnect(): Promise<void>;
  getConnectionStatus(): Promise<ConnectionStatus>;
  /**
   * Returns the cores list. By default served from the local-disk
   * cache when its mtime witnesses match the device's current state
   * (PR #12) — typically <500ms warm. Pass `forceRefresh: true` to
   * skip the cache and walk the device unconditionally; wired to the
   * renderer's "Refresh" button so the user always has an escape
   * hatch from a stuck or invalidated cache.
   */
  listAllCoresWithFiles(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<CoreEntry[]>;
  /**
   * List ROMs at the optional subPath inside the core's games dir.
   * Empty `subPath` returns top-level entries; a slash-joined path
   * returns the contents of a (drilled-into) container folder.
   *
   * Cache-validated against a single mtime witness for the games-dir
   * (or the drilled-into sub-folder). `forceRefresh` skips the cache.
   */
  listRoms(
    coreId: string,
    subPath?: string,
    options?: { readonly forceRefresh?: boolean },
  ): Promise<Rom[]>;
  setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath?: string,
  ): Promise<void>;
  /**
   * Bulk ROM visibility — does NOT abort on first failure. Returns a
   * structured per-rename result so the renderer can surface partial
   * success ("Hid 45 ROMs. 2 failed: …").
   */
  setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChangeWire[],
    subPath?: string,
  ): Promise<BulkRomResult>;
  hideCore(coreId: string): Promise<void>;
  showCore(coreId: string): Promise<void>;
  /**
   * Bulk core visibility — does NOT abort on first failure. Returns a
   * structured per-core result. Each core's renames are atomic (set -e
   * inside a subshell), but a failure in one core does not affect the
   * others.
   */
  setBulkCoreVisibility(
    changes: readonly CoreVisibilityChangeWire[],
    options?: { readonly operationId?: string },
  ): Promise<BulkCoreResult>;
  /**
   * Read-only IDs from the on-MiSTer hide ledger — the cores
   * MiSTerCurator itself hid in past sessions. Used exclusively to
   * scope the "Unhide all" target list so a bulk un-hide can't sweep
   * up arbitrary dot-prefixed system folders the MiSTer firmware
   * placed there. Single-core hide/show operations do NOT consult
   * this list — the user can hide or unhide any core directly.
   */
  listLedgerCoreIds(): Promise<readonly string[]>;
  /**
   * Subscribe to per-core progress ticks for bulk core-visibility
   * operations. Events arrive in real time as the SSH stream parses
   * each core's outcome — the renderer matches `operationId` to the
   * call it triggered and updates its progress bar.
   */
  onBulkCoreProgress(
    handler: (event: BulkCoreProgressEvent) => void,
  ): () => void;
  pickKeyFile(): Promise<PickedKeyFile | null>;
  onConnectionStatusChanged(handler: (status: ConnectionStatus) => void): () => void;
  /**
   * Subscribe to lifecycle events outside the four-state status
   * machine — connecting-elapsed ticks, auto-retry attempts, the
   * unexpected-disconnect signal, the "we got back in" signal. The
   * renderer uses these to drive the per-profile connecting indicator
   * (round 11 spec: hide for 3s, soften at 8s) and the disconnect
   * banner (round 11 spec: persistent until user dismisses).
   */
  onConnectionEvent(
    handler: (event: ConnectionEvent) => void,
  ): () => void;
  /**
   * Returns the cached user-marks list. Cache is primed on connect and
   * refreshed after every add/remove, so the renderer can call this
   * eagerly without triggering an SSH round-trip.
   */
  listSystemFileMarks(): Promise<SystemFilesMarks>;
  /**
   * Adds a user-defined system-file mark for `(coreId, filename)`.
   * Idempotent at the persistence layer. Returns the refreshed marks
   * list so the renderer doesn't need a follow-up call to repaint.
   */
  addSystemFileMark(coreId: string, filename: string): Promise<SystemFilesMarks>;
  /**
   * Removes a user-defined mark. Idempotent. Returns the refreshed
   * marks list. Auto-detected files are unaffected (they're heuristic,
   * never stored — the UI disables the unmark action for them).
   */
  removeSystemFileMark(
    coreId: string,
    filename: string,
  ): Promise<SystemFilesMarks>;
  /**
   * Apply a batch of mark/unmark changes to one core in a single SSH
   * round-trip. Drives the multi-select "Mark selected as system" /
   * "Unmark selected" actions. Returns the refreshed marks list.
   */
  setSystemFileMarks(
    coreId: string,
    changes: readonly SystemFileMarkChangeWire[],
  ): Promise<SystemFilesMarks>;
  /**
   * Returns the cached per-folder classification overrides. Cache is
   * primed on connect and refreshed after every set.
   */
  listFolderClassifications(): Promise<FolderClassifications>;
  /**
   * Sets or removes a per-folder classification override. Pass
   * `classification: null` to remove. Returns the refreshed list.
   */
  setFolderClassification(
    coreId: string,
    folderPath: string,
    classification: 'container' | 'atomic' | null,
  ): Promise<FolderClassifications>;
  /**
   * Wipe the on-disk cache for the currently-connected host. Hidden
   * command in v0 — exposed via IPC so a future settings UI can wire
   * it up without a protocol change. Safe to call when disconnected
   * (no-op).
   */
  clearCache(): Promise<void>;
  // ─── PR #15: metadata pipeline ────────────────────────────────────
  /**
   * Hash the supplied ROM path on the device, then look up its
   * metadata via ScreenScraper (primary) and TheGamesDB (fallback).
   * Returns null when no session is active, when the file isn't a
   * regular file, or when both upstreams miss.
   *
   * No UI consumer in PR #15 — PR #16/#17 wires this in. The
   * `coreId` argument is unused in v0 but reserved for per-core
   * scoping in a follow-up.
   */
  getRomMetadata(
    coreId: string,
    romPath: string,
    hint?: MetadataHint,
  ): Promise<RomMetadata | null>;
  /**
   * Background hash job for the entire ROM library. Fires
   * `metadataPrefetchProgress` events keyed by `operationId` so the
   * renderer can scope progress to the call it triggered.
   */
  prefetchHashes(
    allPaths: readonly string[],
    options?: { readonly operationId?: string },
  ): Promise<void>;
  /**
   * Background metadata fetch for already-hashed ROMs. Subject to
   * the ScreenScraper rate limit, so a 2000-entry library prefetch
   * takes ~30 minutes. Progress fires per-hash.
   */
  prefetchMetadata(
    hashes: readonly string[],
    options?: { readonly operationId?: string },
  ): Promise<void>;
  /** Wipe the metadata + image caches. Hash cache is independent. */
  clearMetadataCache(): Promise<void>;
  /**
   * Resolve a remote box-art URL to a local file path, downloading
   * lazily on first request. Returns null on fetch failure or when
   * the URL is empty.
   */
  getBoxArtLocal(url: string): Promise<string | null>;
  /**
   * Same lazy-download semantics as `getBoxArtLocal`, but returns the
   * cached file's bytes so the renderer can build an object URL for
   * `<img src>`. The local-path channel exists for tooling/scripts
   * (Node-side) where file:// just works; the renderer needs bytes
   * because Electron's sandbox + contextIsolation block file:// from
   * the renderer's origin. Returns null on download failure or empty
   * URL. Bytes are not cached in the renderer — caller owns the Blob
   * and the objectURL lifecycle.
   */
  getBoxArtBytes(url: string): Promise<Uint8Array | null>;
  /**
   * Subscribe to `metadataPrefetchProgress` events from
   * `prefetchHashes` / `prefetchMetadata`. Returns an unsubscribe
   * function. The renderer matches `operationId` to the call it
   * triggered.
   */
  onMetadataPrefetchProgress(
    handler: (event: MetadataPrefetchEvent) => void,
  ): () => void;
  /**
   * PR #20 round 2 — list-view streaming prefetch. Hashes all
   * supplied paths in one batched SSH round-trip, then iterates
   * per-path metadata sequentially (gated by SS rate limit). Emits
   * one `romMetadataResolved` event per path as it settles. Returns
   * after every path has been emitted.
   *
   * The renderer fires this once per RomsPane mount instead of one
   * `getRomMetadata` per row — the round-1 pattern issued N
   * sequential SSH `statWitnesses` calls per render and tipped over
   * WiFi-attached MiSTers.
   */
  prefetchRomsMetadata(
    coreId: string,
    paths: readonly string[],
    options?: {
      readonly operationId?: string;
      /**
       * PR-D1 round 2 (PR #27 round 2): subset of `paths` whose
       * immediate parent dir is a `folder-atomic` single-game
       * folder. Tells the orchestrator which paths should get the
       * parent-folder name-search hint. Organizational containers
       * (NEOGEO `1 World A-Z`) MUST NOT appear here.
       */
      readonly atomicFolderPaths?: readonly string[];
    },
  ): Promise<void>;
  /**
   * Subscribe to per-path resolution events from
   * `prefetchRomsMetadata`. Returns an unsubscribe function. The
   * renderer matches `operationId` to the prefetch call it
   * triggered and ignores stale events from a prior pane mount.
   */
  onRomMetadataResolved(
    handler: (event: RomMetadataResolvedEvent) => void,
  ): () => void;
  /**
   * PR-D1 round 2 (PR #27 round 2): synchronous-feeling cache read
   * for the optimistic-render path. Returns whatever's already on
   * disk (no SSH, no SS). The renderer paints rows from this
   * snapshot, then `prefetchRomsMetadata` validates + refetches
   * stale rows in the background.
   */
  getCachedRomsMetadata(
    coreId: string,
    paths: readonly string[],
  ): Promise<Record<string, RomMetadata | null>>;
  /**
   * PR-D2 (PR #29) — write a user-defined field-override block onto
   * the cache record for `path`. Pass `undefined` for the override
   * to clear all overrides (Reset). Returns the updated record so
   * the caller can refresh state immediately. Returns `null` when
   * no cache record exists for the path (the user shouldn't have
   * been able to open the edit modal in that case).
   */
  setRomMetadataOverride(
    path: string,
    override: UserMetadataOverride | undefined,
  ): Promise<RomMetadata | null>;
  /**
   * PR-D2 (PR #29) — bind a manual SS jeu (the user's pick from the
   * search modal) to the cache record for `path`. Source flips to
   * `'manual-override'`; existing field overrides on the record
   * are preserved.
   *
   * feat/manual-bind-without-hash: `coreId` is required so the main
   * process can fall back to the synthetic `(coreId, path)` cache
   * key when the path has no md5 on file.
   */
  bindRomMetadataFromSearch(
    coreId: string,
    path: string,
    game: ScreenScraperGame,
  ): Promise<RomMetadata | null>;
  /**
   * PR-D2 (PR #29) — name-search for the search modal. Returns SS
   * candidate games for a free-form term scoped to the core's
   * SS systemeid. The handler resolves coreId → systemeid via
   * `lookupScreenScraperSystemId` (the renderer doesn't import
   * the map directly). Returns an empty array when the core
   * isn't mapped to a SS system or SS isn't configured.
   */
  searchScreenScraperByName(
    coreId: string,
    searchTerm: string,
  ): Promise<readonly ScreenScraperGame[]>;
  /**
   * Round 3: kick off (or check on) the OpenVGDB SQLite download.
   * Returns immediately with the current state — the renderer
   * subscribes to `onMetadataDatabaseProgress` for streaming updates
   * and re-calls this method to learn when the download settles.
   */
  ensureMetadataDatabase(): Promise<MetadataDatabaseState>;
  /**
   * Subscribe to OpenVGDB download progress events. Fires `started`
   * → `downloading*` → `ready` on success, or `error` on a failed
   * attempt. The download itself runs once per session — repeated
   * `ensureMetadataDatabase` calls are no-ops once `ready` fires.
   */
  onMetadataDatabaseProgress(
    handler: (event: MetadataDatabaseProgressEvent) => void,
  ): () => void;
  /**
   * PR-C (PR #26): subscribe to auto-scrape progress events. Fires
   * one `active` event per resolved path while the engine is working
   * on a core, plus an `idle` event when the queue empties / engine
   * pauses on disconnect. Returns an unsubscribe function.
   */
  onAutoScrapeProgress(
    handler: (event: AutoScrapeProgressEvent) => void,
  ): () => void;
  /**
   * PR-C (PR #26): pivot the auto-scrape engine to a specific core
   * (called when the user clicks a sidebar row). Moves `coreId` to
   * the head of the queue; the previously-active core resumes at
   * position 1. No-op if the focused core is already active.
   */
  setAutoScrapeFocus(coreId: string): Promise<void>;
  // feat/arcade-phase-1.5 — .mra listing + hide/unhide. Distinct
  // from `mame` core ops; targets `/media/fat/_Arcade/` instead of
  // `/media/fat/games/mame/`. Same dot-prefix hide convention.
  /**
   * Walk `_Arcade/` and return the parsed `.mra` entries (and
   * subfolders). Cached in ConnectionManager same way the cores
   * list is — refresh on the existing Refresh button.
   */
  listArcadeMraEntries(options?: {
    readonly forceRefresh?: boolean;
  }): Promise<readonly ArcadeMraEntryWire[]>;
  /**
   * Hide / show a single `.mra` entry by toggling the dot-prefix on
   * its filename. `relativePath` is the path under `_Arcade/`
   * (slash-joined for nested entries).
   */
  setArcadeMraVisibility(
    relativePath: string,
    hidden: boolean,
  ): Promise<void>;
  /**
   * Bulk hide / show. Same chunking behavior as
   * `setBulkRomVisibility` (PR #30) — chunks of 100 to stay under
   * dropbear's exec channel buffer.
   */
  setBulkArcadeMraVisibility(
    changes: readonly ArcadeMraVisibilityChangeWire[],
  ): Promise<BulkRomResult>;
}

/** feat/arcade-phase-1.5 — wire shape for `.mra` entries. */
export interface ArcadeMraEntryWire {
  readonly relativePath: string;
  readonly displayName: string;
  readonly kind: 'mra' | 'cores-subfolder' | 'subfolder';
  readonly hidden: boolean;
}

export interface ArcadeMraVisibilityChangeWire {
  readonly relativePath: string;
  readonly hidden: boolean;
}

const VALID_CONNECTION_ERROR_CODES: ReadonlySet<ConnectionErrorCode> = new Set([
  'unreachable',
  'auth_failed',
  'not_a_mister',
  'unknown',
]);

/**
 * Sentinel that lets us smuggle structured error payloads through
 * Electron's `ipcMain.handle` ↔ `ipcRenderer.invoke` channel.
 *
 * Why: Electron serializes thrown Error objects by calling
 * `error.message` + `error.stack`, then wraps the message with
 * "Error invoking remote method '<channel>': ". Custom fields on
 * `Error` subclasses (such as `MisterConnectionError.code`) are
 * stripped. Without help, the renderer sees an opaque `Error` whose
 * `.message` reads like a stack trace fragment — that's how the
 * inline failure card ended up showing the wrapping prefix instead of
 * the friendly copy.
 *
 * The fix is to encode the structured fields *inside* `error.message`
 * with a unique prefix that survives Electron's wrapping verbatim. The
 * preload then scans the wrapped message for the prefix, parses the
 * JSON, and reconstructs a typed error. Any non-marker error passes
 * through untouched.
 */
const IPC_ERROR_MARKER = '__MC_IPC_ERROR_v1__:';

/**
 * Wraps a raw error so it can survive an `ipcMain.handle` round-trip
 * with its structured fields intact. Currently only `MisterConnectionError`
 * gets the structured treatment — anything else passes through.
 */
export function encodeIpcError(err: unknown): unknown {
  if (
    err !== null &&
    typeof err === 'object' &&
    (err as { name?: unknown }).name === 'MisterConnectionError'
  ) {
    const e = err as { code?: unknown; message?: unknown };
    if (typeof e.code === 'string' && typeof e.message === 'string') {
      const payload = JSON.stringify({
        kind: 'MisterConnectionError',
        code: e.code,
        message: e.message,
      });
      return new Error(`${IPC_ERROR_MARKER}${payload}`);
    }
  }
  return err;
}

/**
 * Inverse of `encodeIpcError`. Looks for the marker anywhere in the
 * thrown error's message — Electron prepends its own preamble, so
 * `indexOf` is the right semantic, not `startsWith`.
 */
export function decodeIpcError(err: unknown): unknown {
  const message = err instanceof Error ? err.message : '';
  const idx = message.indexOf(IPC_ERROR_MARKER);
  if (idx < 0) return err;
  try {
    const json = message.slice(idx + IPC_ERROR_MARKER.length);
    const parsed: unknown = JSON.parse(json);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { kind?: unknown }).kind === 'MisterConnectionError'
    ) {
      const p = parsed as { code?: unknown; message?: unknown };
      if (
        typeof p.code === 'string' &&
        VALID_CONNECTION_ERROR_CODES.has(p.code as ConnectionErrorCode) &&
        typeof p.message === 'string'
      ) {
        // Construct the typed error with the original message — the
        // renderer's failure card layer pivots off `code` to look up
        // the friendly copy, but having `message` available preserves
        // the underlying detail for the `'unknown'` branch.
        return rebuildMisterConnectionError(
          p.code as ConnectionErrorCode,
          p.message,
        );
      }
    }
  } catch {
    // Malformed payload — fall through to the raw error.
  }
  return err;
}

/**
 * Indirection through a getter so this module doesn't pull in
 * `MisterConnectionError` (a class) at preload-bundle time when the
 * renderer is the only place that imports it. Set lazily by the
 * preload at startup.
 */
let misterConnectionErrorFactory:
  | ((code: ConnectionErrorCode, message: string) => Error)
  | null = null;

export function setMisterConnectionErrorFactory(
  factory: (code: ConnectionErrorCode, message: string) => Error,
): void {
  misterConnectionErrorFactory = factory;
}

function rebuildMisterConnectionError(
  code: ConnectionErrorCode,
  message: string,
): Error {
  if (misterConnectionErrorFactory !== null) {
    return misterConnectionErrorFactory(code, message);
  }
  // Fallback: a plain Error tagged with the fields. Better than
  // losing the code entirely in the unlikely case the factory wasn't
  // wired up; the renderer can still feature-test the shape.
  const fallback = new Error(message);
  Object.assign(fallback, { name: 'MisterConnectionError', code });
  return fallback;
}

/** Test-only: exposed so unit tests can assert on the marker. */
export const __TEST_IPC_ERROR_MARKER = IPC_ERROR_MARKER;
