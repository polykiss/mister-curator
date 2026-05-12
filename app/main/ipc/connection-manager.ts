import {
  backoffDelayMs,
  RECONNECT_BACKOFF_MS,
  type ConnectionEvent,
} from '@shared/connection';
import {
  ARCADE_MRA_META_WITNESS_PATHS,
  CORES_CACHE_WITNESS_PATHS,
  MISTER_GAMES_DIR,
  romsCacheWitnessPath,
} from '@shared/constants';
import {
  computePlayability,
  type ArcadeMraMeta,
  type Playability,
} from '@shared/arcade-mra-parse';
import {
  applyCoreVisibilityChange,
  computeAutoReapplyChanges,
  isCoreHidden,
  isRealCore,
} from '@shared/core-matching';
import {
  arcadeMraVisiblePath,
  DEFAULT_ARCADE_AUTO_HIDE_ENABLED,
  EMPTY_LEDGER,
  healArcadeLedger,
  healLedger,
  ledgerEqual,
  withArcadeAutoHideEnabled,
  withArcadeAutoHidden,
  withArcadeTombstoneAdded,
  withArcadeTombstoneRemoved,
  withCoreHidden,
  withCoreShown,
} from '@shared/ledger';
import type {
  BulkCoreProgress,
  BulkCoreResult,
  BulkRomResult,
  CoreVisibilityChange,
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
  SystemFileMarkChange,
} from '@shared/mister-client';
import {
  type ArcadeMraEntry,
  parseArcadeMraEntries,
} from '@shared/arcade-mra';
import { diagLog } from '@shared/diag-log';
import { EMPTY_FOLDER_CLASSIFICATIONS } from '@shared/folder-classifications';
import { mergeRecursivePathsWithAtomicFolders } from '@shared/rom-enumeration';
import { EMPTY_SYSTEM_FILES_MARKS } from '@shared/system-files-marks';
import { witnessesMatch } from '@app/main/cache/cache-types';
import type {
  ConnectionStatus,
  CoreEntry,
  FolderClassificationOverride,
  FolderClassifications,
  HiddenCoreEntry,
  HideLedger,
  MisterProfile,
  Rom,
  SystemFilesMarks,
} from '@shared/types';

import type { CacheManager } from '@app/main/cache/cache-manager';
import type { ProfileStore } from '@app/main/storage/profile-store';

type StatusListener = (status: ConnectionStatus) => void;
type BulkProgressListener = (event: BulkCoreProgressBroadcast) => void;
type ConnectionEventListener = (event: ConnectionEvent) => void;

/**
 * Bulk core-visibility progress broadcast to listeners (typically the
 * window webContents adapter). Wraps the client-level event with an
 * `operationId` the renderer uses to scope progress to the call it
 * actually triggered — concurrent or stale ops can't trample each
 * other's progress bar.
 */
export interface BulkCoreProgressBroadcast extends BulkCoreProgress {
  readonly operationId: string;
}

export interface ConnectResult {
  /** Number of cores re-hidden by the auto-reapply step (0 when disabled). */
  readonly reappliedCount: number;
  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — one-shot signal that the
   * arcade auto-hide rule transitioned this connect from "no
   * mras auto-hidden" to "N mras auto-hidden". The renderer fires
   * a single toast off this; subsequent connects (where the ledger
   * already has entries) surface `null` even if the rule re-runs
   * idempotently. Distinct from "rule produced ≥1 hide right now":
   * the rule may apply more hides on a normal reconnect (e.g. a
   * new missing-ROM .mra arrived); only the EMPTY→non-empty edge
   * triggers the toast.
   */
  readonly firstConnectArcadeAutoHidden: number | null;
}

/**
 * feat/arcade-playability-data (PR 1/2) — in-memory snapshot
 * computed from one round of `parseArcadeMras` + a
 * `listArcadeZipBasenames` walk. Three derived sets keyed by
 * `ArcadeMraMeta.relativePath`; the renderer-facing IPC slices
 * these into the simple `{ playable, missing, noRomsNeeded }`
 * shape PR-2's UI consumes.
 *
 * Held in the manager so the IPC handler doesn't have to do the
 * computation per-call — the underlying data only changes when
 * the user adds/removes a .mra or a zip (witness-checked) or
 * forces a refresh.
 */
export interface ArcadePlayabilitySnapshot {
  readonly entries: readonly ArcadeMraMeta[];
  readonly zipBasenames: ReadonlySet<string>;
  /** relativePath → playability classification. */
  readonly byPath: ReadonlyMap<string, Playability>;
}

/**
 * Shape returned by `getArcadePlayability` over IPC. Three
 * mutually-exclusive `relativePath` buckets (the playability
 * classification of every .mra) plus `autoHidden` — the visible-
 * path form of every entry the auto-hide rule has put into hidden
 * state, surfaced so the renderer can pick the right eye-toggle
 * tooltip without a second round-trip.
 */
export interface ArcadePlayabilityIpc {
  readonly playable: readonly string[];
  readonly missing: readonly string[];
  readonly noRomsNeeded: readonly string[];
  readonly autoHidden: readonly string[];
}

/**
 * Owns the singleton IMisterClient and the ConnectionStatus state machine.
 * The renderer talks to this through IPC; main pushes status transitions
 * back to any registered listener (typically a webContents.send adapter).
 *
 * Owns the on-MiSTer hide ledger. Round 5 model: the ledger is purely
 * a *bookkeeping artifact* for "Unhide all". It is NOT a permission
 * slip — single-core hide/show operations no longer consult it, so
 * the user can hide or unhide ANY core (including ones the firmware
 * or other tools dot-prefixed before MiSTerCurator existed) with one
 * click. The ledger's only remaining UI-visible role is to scope the
 * "Unhide all" target list via `listLedgerCoreIds()` so a bulk
 * un-hide can't sweep up arbitrary system folders the MiSTer placed
 * there.
 *
 * Bookkeeping rules:
 *   - `hideCore` / `setBulkCoreVisibility(hidden=true)` add the core
 *     to the ledger after a successful rename.
 *   - `showCore` / `setBulkCoreVisibility(hidden=false)` remove the
 *     core from the ledger after a successful rename. (Idempotent —
 *     removing a non-existent entry is a no-op.)
 *   - `healLedger` runs on connect and drops entries whose cores no
 *     longer exist on the device.
 *
 * Ledger I/O is NOT exposed on the IPC bridge directly — the renderer
 * sees its consequences (the reappliedCount from connect, the result
 * of hide/show, and the read-only `listLedgerCoreIds()`).
 */
export class ConnectionManager {
  private status: ConnectionStatus = 'disconnected';
  private currentProfileId: string | null = null;
  private readonly listeners = new Set<StatusListener>();
  private readonly bulkProgressListeners = new Set<BulkProgressListener>();
  private readonly connectionEventListeners = new Set<ConnectionEventListener>();
  private nextOperationId = 1;
  /**
   * Monotonic token for the active auto-retry cycle. Incrementing it
   * cancels any in-flight retry loop — needed when the user clicks
   * "Disconnect" or starts a manual reconnect mid-cycle.
   */
  private autoRetryToken = 0;
  /** Cleanup for the unexpected-disconnect subscription (set on connect). */
  private unsubscribeUnexpectedDisconnect: (() => void) | null = null;
  private coresCache: CoreEntry[] = [];
  /**
   * In-memory copy of the on-MiSTer ledger. Populated by `readLedgerFresh`
   * on connect, and kept in sync with every successful hide/show. The
   * renderer's cores list is enriched against this cache.
   */
  private ledgerCache: HideLedger = EMPTY_LEDGER;
  /**
   * In-memory copy of the user-marked system-files list. Populated on
   * connect and kept in sync with add/remove ops. Passed through to
   * `client.listAllCoresWithFiles` so the per-core counts respect any
   * marks the user has placed.
   */
  private systemFilesMarksCache: SystemFilesMarks = EMPTY_SYSTEM_FILES_MARKS;
  /**
   * In-memory copy of the per-folder classification overrides. Populated
   * on connect, refreshed on every set. Threaded through `listRoms` so
   * folder-ROM `kind` reflects user overrides.
   */
  private folderClassificationsCache: FolderClassifications =
    EMPTY_FOLDER_CLASSIFICATIONS;
  /**
   * feat/arcade-phase-1.5 — in-memory copy of the parsed `.mra`
   * entries under `_Arcade/`. Populated on first
   * `listArcadeMraEntries` call (lazy — many users won't navigate
   * to the Arcade row), invalidated on disconnect + on the
   * `forceRefresh` path used by the Refresh button.
   */
  private arcadeMraCache: readonly ArcadeMraEntry[] | null = null;
  /**
   * feat/arcade-playability-data (PR 1/2) — in-memory snapshot of
   * pre-parsed .mra metadata + zip-basename set, hydrated on
   * connect by `loadArcadeData()`. Distinct from `arcadeMraCache`
   * above: that one carries the raw listing the renderer's
   * ArcadeMraPane consumes; THIS one carries the playability slice
   * the UI in PR-2 will consume.
   *
   * Reset on disconnect + on explicit `loadArcadeData({
   * forceRefresh: true })`. Survives between IPC calls for as long
   * as the connection stays up — playability doesn't change unless
   * the user adds/removes a .mra or a zip, both of which would
   * trip the cache's witnesses on the next connect.
   */
  private arcadePlayabilityCache: ArcadePlayabilitySnapshot | null = null;
  /**
   * Host of the active connection — used to key the on-disk cache
   * (PR #12). Captured on connect alongside `currentProfileId` so a
   * write-through after a hide/show targets the right host's cache
   * even if the profile has been edited since.
   */
  private currentHost: string | null = null;

  constructor(
    private readonly client: IMisterClient,
    private readonly store: ProfileStore,
    private readonly cache: CacheManager,
  ) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getCurrentProfileId(): string | null {
    return this.currentProfileId;
  }

  /**
   * PR #15: surface the active session (client + host) so the metadata
   * orchestrator can run hashes against the same SSH connection
   * everything else uses. Returns null when disconnected — the
   * orchestrator treats that as "no work to do".
   */
  getActiveSession(): { readonly client: IMisterClient; readonly host: string } | null {
    if (this.status !== 'connected' || this.currentHost === null) return null;
    return { client: this.client, host: this.currentHost };
  }

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onBulkProgress(listener: BulkProgressListener): () => void {
    this.bulkProgressListeners.add(listener);
    return () => {
      this.bulkProgressListeners.delete(listener);
    };
  }

  onConnectionEvent(listener: ConnectionEventListener): () => void {
    this.connectionEventListeners.add(listener);
    return () => {
      this.connectionEventListeners.delete(listener);
    };
  }

  async connect(profileId: string): Promise<ConnectResult> {
    // A manual connect (or reconnect) cancels any in-flight auto-retry
    // cycle so the two don't race each other.
    this.autoRetryToken += 1;

    if (this.status === 'connected') {
      try {
        await this.client.disconnect();
      } catch {
        // Best-effort; we're about to start fresh anyway.
      }
    }

    this.setStatus('connecting');
    this.coresCache = [];
    this.ledgerCache = EMPTY_LEDGER;
    this.systemFilesMarksCache = EMPTY_SYSTEM_FILES_MARKS;
    this.folderClassificationsCache = EMPTY_FOLDER_CLASSIFICATIONS;
    this.arcadeMraCache = null;
    this.arcadePlayabilityCache = null;
    this.currentHost = null;

    // Connecting-elapsed ticker. Fires every second while the connect
    // is in flight; the renderer uses these to drive the delayed-
    // reveal "Connecting…" indicator (no flicker on fast connects,
    // soft-escalation if the box is slow). The shared
    // `formatConnectingMessage` reads `elapsedMs` and decides what to
    // show — keeping the policy in one place.
    const startedAt = Date.now();
    const ticker = setInterval(() => {
      this.emitConnectionEvent({
        type: 'connecting-elapsed',
        profileId,
        elapsedMs: Date.now() - startedAt,
      });
    }, 1000);

    try {
      const profile = await this.store.get(profileId);
      if (!profile) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      const secret: MisterSecret = await this.store.getSecret(profileId);
      diagLog('info', 'conn', '→', 'connecting', {
        profileId,
        host: profile.host,
      });
      // feat/connecting-screen-status — emit phase label so the
      // inline "Connecting…" UI can name the current step. The
      // emit rides the same `connectionEvent` IPC as the elapsed
      // ticker; the renderer's reveal-delay still applies, so a
      // fast connect that never trips `CONNECTING_REVEAL_MS`
      // shows nothing to the user.
      this.emitConnectionEvent({
        type: 'connect-phase',
        profileId,
        phase: 'transport',
      });
      await this.client.connect(profile, secret);
      diagLog('info', 'conn', '·', 'transport-ready', {
        profileId,
        host: profile.host,
        ms: Date.now() - startedAt,
      });
      this.emitConnectionEvent({
        type: 'connect-phase',
        profileId,
        phase: 'priming',
      });
      this.currentProfileId = profileId;

      // Hook the unexpected-disconnect channel from the freshly-
      // connected client. Stale subscriptions from a previous
      // connection (if any) get cleaned up first.
      if (this.unsubscribeUnexpectedDisconnect) {
        this.unsubscribeUnexpectedDisconnect();
      }
      this.unsubscribeUnexpectedDisconnect = this.client.onUnexpectedDisconnect(
        () => {
          this.handleUnexpectedDisconnect();
        },
      );

      // PR #12 prime: one SSH command returns ledger + marks +
      // classifications + cores-cache witnesses. Replaces three
      // sequential reads with one round trip — load-bearing for the
      // <1s warm-connect target.
      const prime = await this.client.primeConnect(CORES_CACHE_WITNESS_PATHS);
      this.ledgerCache = prime.ledger;
      this.systemFilesMarksCache = prime.marks;
      this.folderClassificationsCache = prime.classifications;
      this.currentHost = profile.host;

      // PR #12 cache lookup. On hit we skip the 7s walk entirely.
      // On miss/stale, the cache stays cold until the first explicit
      // listAllCoresWithFiles call.
      const cached = await this.cache.getCoresCache(profile.host);
      if (cached !== null && witnessesMatch(cached.witnesses, prime.witnesses)) {
        this.coresCache = [...cached.data];
        // PR #12 round 3: emit cache.hit so MISTERCURATOR_CACHE_LOG=1
        // surfaces the warm-reconnect path. CacheManager fires miss
        // itself when the file is absent; the witness-match decision
        // happens here in the manager (only it has the fresh mtimes
        // from `primeConnect`), so the hit event also has to fire
        // here through CacheManager.recordHit.
        this.cache.recordHit('cores', { host: profile.host });
      } else if (cached !== null) {
        // Stale — file existed, schema validated, but mtime witnesses
        // moved on. Distinct from `miss` so dev logs can tell apart
        // "cache empty" from "cache went out of date."
        this.cache.recordStale('cores', { host: profile.host });
        await this.cache.invalidateCoresCache(profile.host).catch(() => {
          /* swallow */
        });
      }

      // Ledger self-heal — was inside `client.readHideLedger`; moved
      // here so we can use cached cores when the cache hits, avoiding
      // an extra listAllCoresWithFiles walk during heal.
      if (this.ledgerCache.hiddenCores.length > 0) {
        // feat/connecting-screen-status — only emit the
        // 'cores-walk' phase when we're about to actually walk
        // (i.e. the cache miss path). A warm reconnect skips the
        // SSH cost and so skips the label.
        if (this.coresCache.length === 0) {
          this.emitConnectionEvent({
            type: 'connect-phase',
            profileId,
            phase: 'cores-walk',
          });
        }
        const coresForHeal =
          this.coresCache.length > 0
            ? this.coresCache
            : await this.fetchAndCacheCores();
        const healed = healLedger(this.ledgerCache, coresForHeal);
        if (!ledgerEqual(this.ledgerCache, healed)) {
          const dropped =
            this.ledgerCache.hiddenCores.length - healed.hiddenCores.length;
          console.log(
            `Ledger self-healed: dropped ${String(dropped)} stale entries.`,
          );
          await this.client.writeHideLedger(healed);
          this.ledgerCache = healed;
        }
      }

      let reappliedCount = 0;
      if (profile.autoReapplyHides === true) {
        reappliedCount = await this.runAutoReapply();
      }

      // feat/arcade-playability-data (PR 1/2) — pre-compute the
      // arcade playability snapshot so PR-2's UI lands warm. Cache
      // hit on a warm reconnect; cold walk on first connect. Wrap
      // in try/catch — a transient SSH glitch here shouldn't keep
      // the rest of the app from coming online. The snapshot
      // hydrates lazily on the IPC fallback path if this misses.
      let firstConnectArcadeAutoHidden: number | null = null;
      try {
        // feat/connecting-screen-status — `loadArcadeData` is the
        // expensive phase on a cold cache (the awk-over-N-mras
        // SSH pass). Always emit; a cache hit drains in <200ms
        // and never reveals the label because the reveal-delay
        // hasn't expired yet.
        this.emitConnectionEvent({
          type: 'connect-phase',
          profileId,
          phase: 'arcade-parse',
        });
        const snapshot = await this.loadArcadeData();
        // feat/arcade-ux-and-ledger (PR 2/2) — heal stale arcade
        // ledger entries (mras that vanished between sessions) and
        // run the auto-hide pass against the current snapshot.
        // Returns the empty→non-empty edge if it fired; the
        // renderer's toast reads off ConnectResult.
        //
        // feat/connecting-screen-status — emit the 'auto-hide'
        // phase only when the rule has work to do: auto-hide is
        // enabled AND there are missing-ROM mras in the snapshot.
        // The other branches (rule off, no missing) drain
        // instantly and don't warrant a label flip.
        const autoHideEnabled =
          this.ledgerCache.arcadeAutoHideEnabled ??
          DEFAULT_ARCADE_AUTO_HIDE_ENABLED;
        const hasMissing = [...snapshot.byPath.values()].some(
          (v) => v === 'missing',
        );
        if (autoHideEnabled && hasMissing) {
          this.emitConnectionEvent({
            type: 'connect-phase',
            profileId,
            phase: 'auto-hide',
          });
        }
        firstConnectArcadeAutoHidden = await this.healAndApplyArcadeAutoHide(
          snapshot,
        );
      } catch (err) {
        diagLog('warn', 'arcade', '·', 'playability-scan failed', {
          err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }

      this.setStatus('connected');
      diagLog('info', 'conn', '←', 'connected', {
        profileId,
        host: profile.host,
        ms: Date.now() - startedAt,
        reappliedCount,
      });
      return { reappliedCount, firstConnectArcadeAutoHidden };
    } catch (err) {
      diagLog('error', 'conn', '✗', 'connect-failed', {
        profileId,
        ms: Date.now() - startedAt,
        err: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
      this.currentProfileId = null;
      this.setStatus('error');
      throw err;
    } finally {
      clearInterval(ticker);
    }
  }

  async disconnect(): Promise<void> {
    // Clean disconnect — cancel any in-flight auto-retry first so a
    // pending reconnect doesn't race the user's intent.
    this.autoRetryToken += 1;
    diagLog('info', 'conn', '·', 'user-disconnect', {
      profileId: this.currentProfileId ?? undefined,
    });
    if (this.unsubscribeUnexpectedDisconnect) {
      this.unsubscribeUnexpectedDisconnect();
      this.unsubscribeUnexpectedDisconnect = null;
    }
    try {
      await this.client.disconnect();
    } finally {
      this.currentProfileId = null;
      this.currentHost = null;
      this.coresCache = [];
      this.ledgerCache = EMPTY_LEDGER;
      this.systemFilesMarksCache = EMPTY_SYSTEM_FILES_MARKS;
      this.folderClassificationsCache = EMPTY_FOLDER_CLASSIFICATIONS;
      this.arcadeMraCache = null;
      this.arcadePlayabilityCache = null;
      this.setStatus('disconnected');
    }
  }

  /**
   * The cores list as the renderer sees it. Hits the in-memory cache
   * (populated by either the on-connect cache lookup or a previous
   * fetch). On a true miss falls through to `fetchAndCacheCores`,
   * which runs the SSH walk and writes the result to disk.
   *
   * `forceRefresh` bypasses both the in-memory cache and the on-disk
   * cache, walks the network, then writes the fresh result to disk
   * — wired to the renderer's "Refresh" button so the user always
   * has an escape hatch from a stuck cache.
   */
  async listAllCoresWithFiles(
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<CoreEntry[]> {
    this.assertConnected();
    if (options.forceRefresh) {
      if (this.currentHost !== null) {
        await this.cache.invalidateCoresCache(this.currentHost).catch(() => {
          /* swallow — the disk cache being out of sync isn't fatal */
        });
      }
      return this.fetchAndCacheCores();
    }
    if (this.coresCache.length > 0) {
      return this.coresCache;
    }
    return this.fetchAndCacheCores();
  }

  /**
   * feat/arcade-phase-1.5 — list `.mra` entries under `_Arcade/`.
   * Cached in memory same shape as `listAllCoresWithFiles`. The
   * Refresh button drops the cache via `forceRefresh: true`; lazy
   * initialization on the cache-miss path means many users never
   * pay the SSH cost (those who don't navigate to the Arcade row).
   */
  async listArcadeMraEntries(
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<readonly ArcadeMraEntry[]> {
    this.assertConnected();
    if (options.forceRefresh) {
      this.arcadeMraCache = null;
    }
    if (this.arcadeMraCache !== null) {
      return this.arcadeMraCache;
    }
    const raw = await this.client.listArcadeRawListing();
    const entries = parseArcadeMraEntries(raw);
    this.arcadeMraCache = entries;
    return entries;
  }

  /**
   * feat/arcade-phase-1.5 — toggle a single `.mra` entry's
   * visibility. Invalidates the arcade cache so the next listing
   * reflects the rename.
   */
  async setArcadeMraVisibility(
    relativePath: string,
    hidden: boolean,
  ): Promise<void> {
    this.assertConnected();
    await this.client.setArcadeMraVisibility(relativePath, hidden);
    this.arcadeMraCache = null;
    // The playability snapshot keys off `relativePath`, which flips
    // when a .mra is hidden (`Foo.mra` ↔ `.Foo.mra`). Invalidating
    // forces the next `loadArcadeData` to re-walk; the on-disk
    // cache will miss on witnesses too (`_Arcade/` mtime bumped),
    // so both layers stay coherent without a write-through here.
    this.arcadePlayabilityCache = null;
    // feat/arcade-ux-and-ledger (PR 2/2) — apply the three-state
    // transition for a user-initiated hide/show. See
    // `applyUserMraVisibilityToLedger` for the rules.
    await this.applyUserMraVisibilityToLedger([{ relativePath, hidden }]);
  }

  /**
   * feat/arcade-phase-1.5 — bulk variant. Same chunking + result
   * shape as `setBulkRomVisibility` (PR #30). Invalidates the
   * arcade cache so the next listing reflects the renames.
   */
  async setBulkArcadeMraVisibility(
    changes: readonly { readonly relativePath: string; readonly hidden: boolean }[],
  ): Promise<BulkRomResult> {
    this.assertConnected();
    const result = await this.client.setBulkArcadeMraVisibility(changes);
    this.arcadeMraCache = null;
    this.arcadePlayabilityCache = null;
    await this.applyUserMraVisibilityToLedger(changes);
    return result;
  }

  /**
   * feat/arcade-playability-data (PR 1/2) — hydrate the in-memory
   * playability snapshot. Called once per connect (after
   * `primeConnect`, before the auto-scrape engine starts) and
   * on-demand by `getArcadePlayability` when the snapshot is null
   * (defensive — connect should have populated it).
   *
   * Cache flow:
   *   1. `forceRefresh` → skip the cache lookup and walk the device.
   *   2. Otherwise read the per-host `arcade-mra-meta.json` cache
   *      file. If schema- and host-valid AND its witnesses match
   *      the fresh ones, serve it (warm path).
   *   3. Otherwise walk the device (`parseArcadeMras` +
   *      `listArcadeZipBasenames` + `statWitnesses`), persist, and
   *      hydrate the snapshot.
   *
   * Witnesses cover `_Arcade/` + both zip dirs (see
   * `ARCADE_MRA_META_WITNESS_PATHS`). Any of: adding a .mra,
   * hiding/showing a .mra (rename bumps `_Arcade/` mtime), adding
   * or removing a zip in either dir — flips one witness and the
   * cache misses on next connect.
   *
   * Emits a `[arcade] · playability-scan done` diag line per
   * resolution (hit or miss) so the live-verify trace shows the
   * cold/warm timings.
   */
  async loadArcadeData(
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<ArcadePlayabilitySnapshot> {
    // Use currentHost rather than `assertConnected` for the gate.
    // `connect()` sets currentHost the moment primeConnect succeeds
    // (well before setStatus('connected')), so the in-connect-flow
    // call to this method works. Disconnect clears currentHost
    // back to null, so external IPC callers can't sneak in either.
    const host = this.currentHost;
    if (host === null) {
      throw new Error('Not connected to a MiSTer.');
    }
    const startedAt = Date.now();
    if (options.forceRefresh) {
      this.arcadePlayabilityCache = null;
      await this.cache.invalidateArcadeMraMetaCache(host).catch(() => {
        /* swallow — cache invalidation is best-effort */
      });
    } else if (this.arcadePlayabilityCache !== null) {
      // In-memory hit; no log line — this is the IPC fast-path
      // re-entry, not a real scan.
      return this.arcadePlayabilityCache;
    }
    // Stat the fresh witnesses BEFORE the cache lookup so the
    // comparison uses the same epoch values as the eventual
    // write-through (mirrors `fetchAndCacheCores`).
    const witnesses = await this.client.statWitnesses(
      ARCADE_MRA_META_WITNESS_PATHS,
    );
    if (!options.forceRefresh) {
      const cached = await this.cache.getArcadeMraMetaCache(host);
      if (cached !== null && witnessesMatch(cached.witnesses, witnesses)) {
        this.cache.recordHit('arcade', { host });
        const snapshot = buildPlayabilitySnapshot(
          cached.entries,
          cached.zipBasenames,
        );
        this.arcadePlayabilityCache = snapshot;
        const buckets = bucketByPlayability(snapshot);
        diagLog('info', 'arcade', '·', 'playability-scan done', {
          totalMras: snapshot.entries.length,
          playable: buckets.playable.length,
          missing: buckets.missing.length,
          noRomsNeeded: buckets.noRomsNeeded.length,
          ms: Date.now() - startedAt,
          cached: 'true',
        });
        return snapshot;
      }
      if (cached !== null) {
        this.cache.recordStale('arcade', { host });
        await this.cache.invalidateArcadeMraMetaCache(host).catch(() => {
          /* swallow */
        });
      }
    }
    // Cold path — walk the device.
    const [entries, zipBasenames] = await Promise.all([
      this.client.parseArcadeMras(),
      this.client.listArcadeZipBasenames(),
    ]);
    await this.cache
      .setArcadeMraMetaCache(host, entries, zipBasenames, witnesses)
      .catch(() => {
        /* swallow — disk cache write failure shouldn't fail the scan */
      });
    const snapshot = buildPlayabilitySnapshot(entries, zipBasenames);
    this.arcadePlayabilityCache = snapshot;
    const buckets = bucketByPlayability(snapshot);
    diagLog('info', 'arcade', '·', 'playability-scan done', {
      totalMras: snapshot.entries.length,
      playable: buckets.playable.length,
      missing: buckets.missing.length,
      noRomsNeeded: buckets.noRomsNeeded.length,
      ms: Date.now() - startedAt,
      cached: 'false',
    });
    return snapshot;
  }

  /**
   * feat/arcade-playability-data (PR 1/2) — IPC-shaped getter.
   * Returns the three relativePath buckets the renderer will
   * consume in PR-2. Hydrates the snapshot on demand if it
   * happened to be null (e.g. connect happened before this PR
   * shipped's IPC was registered and the user kept the session
   * open across an upgrade — defensive only).
   */
  async getArcadePlayability(): Promise<ArcadePlayabilityIpc> {
    const snapshot =
      this.arcadePlayabilityCache ?? (await this.loadArcadeData());
    return {
      ...bucketByPlayability(snapshot),
      autoHidden: [...(this.ledgerCache.arcadeAutoHidden ?? [])],
    };
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — return the persisted
   * auto-hide preference for the active connection. Defaults to
   * `DEFAULT_ARCADE_AUTO_HIDE_ENABLED` when the ledger field is
   * absent (first connect after PR-2 ships).
   */
  getArcadeAutoHideEnabled(): boolean {
    return (
      this.ledgerCache.arcadeAutoHideEnabled ??
      DEFAULT_ARCADE_AUTO_HIDE_ENABLED
    );
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — flip the persisted
   * preference and apply the rule diff.
   *
   *   • ON: hide every entry in `missing − tombstones − user-hidden`;
   *     update `arcadeAutoHidden` to that set.
   *   • OFF: un-hide every entry in `arcadeAutoHidden`; clear the
   *     ledger field.
   *
   * Idempotent: setting to the same value as today is a no-op
   * (zero SSH ops, zero ledger writes). The renderer reads the
   * effect through the connection-event broadcast so the badge
   * + count update without a round-trip refresh.
   */
  async setArcadeAutoHideEnabled(
    enabled: boolean,
  ): Promise<void> {
    this.assertConnected();
    const current = this.getArcadeAutoHideEnabled();
    if (current === enabled) return;
    const next = withArcadeAutoHideEnabled(this.ledgerCache, enabled);
    await this.persistLedger(next);
    // Apply the diff to on-disk visibility. Use the in-memory
    // snapshot; it should be hot from connect. `loadArcadeData`
    // gives us a fresh snapshot if not.
    const snapshot =
      this.arcadePlayabilityCache ?? (await this.loadArcadeData());
    await this.applyArcadeAutoHideRule(snapshot);
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — set or clear a single
   * tombstone (user-shown-despite-missing). Does NOT itself flip
   * the on-disk visibility — the caller is expected to also call
   * `setArcadeMraVisibility` if a rename is needed. Used by the
   * renderer's eye-toggle path when promoting an auto-hidden row
   * to "show despite missing".
   *
   * In practice, the renderer doesn't call this directly today:
   * the ledger transitions are folded into `setArcadeMraVisibility`
   * via `applyUserMraVisibilityToLedger`. This setter exists for
   * symmetry with the other arcade IPCs and for the renderer's
   * "exempt this row from future auto-hide" gesture in a future
   * PR (where it would be a separate menu item, not the eye
   * toggle).
   */
  async setArcadeUserShownDespiteMissing(
    relativePath: string,
    on: boolean,
  ): Promise<void> {
    this.assertConnected();
    const visible = arcadeMraVisiblePath(relativePath);
    const next = on
      ? withArcadeTombstoneAdded(this.ledgerCache, visible)
      : withArcadeTombstoneRemoved(this.ledgerCache, visible);
    if (next === this.ledgerCache) return;
    await this.persistLedger(next);
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — connect-time arcade
   * ledger maintenance:
   *   1. Self-heal: drop ledger entries pointing at .mras that no
   *      longer exist on the device.
   *   2. Apply the auto-hide rule against the current snapshot
   *      (no-op if the preference is OFF).
   *
   * Returns the "empty → non-empty" edge count for the renderer
   * toast: `null` if the toast shouldn't fire (already non-empty
   * before this connect, or stayed empty); a positive number if
   * `arcadeAutoHidden` went from empty to that many entries on
   * this pass.
   */
  private async healAndApplyArcadeAutoHide(
    snapshot: ArcadePlayabilitySnapshot,
  ): Promise<number | null> {
    // Self-heal first so the auto-hide application reasons against
    // a ledger that matches the current on-device set.
    const healed = healArcadeLedger(this.ledgerCache, snapshot.entries);
    if (healed !== this.ledgerCache) {
      await this.persistLedger(healed);
    }
    const wasEmpty =
      (this.ledgerCache.arcadeAutoHidden ?? []).length === 0;
    await this.applyArcadeAutoHideRule(snapshot);
    const nowCount = (this.ledgerCache.arcadeAutoHidden ?? []).length;
    if (wasEmpty && nowCount > 0) {
      return nowCount;
    }
    return null;
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — apply the auto-hide rule
   * against the current snapshot:
   *
   *   shouldBeHidden = (missing − tombstones) ∩ (NOT user-hidden)
   *   toHide = shouldBeHidden − currently auto-hidden
   *   toShow = currently auto-hidden − shouldBeHidden
   *
   * The "user-hidden" exclusion prevents the rule from chasing a
   * mra the user has separately dot-prefixed by hand. That entry
   * stays hidden; the ledger does NOT claim it as auto-hidden.
   *
   * When the preference is OFF: `shouldBeHidden = ∅`. The pass
   * un-hides every entry in arcadeAutoHidden and clears the
   * ledger field. Tombstones survive (they're user prefs).
   *
   * Both the hide and show sides go through the existing
   * `client.setBulkArcadeMraVisibility` so the 100-per-chunk
   * shell scripting and per-item failure reporting are reused.
   * A bulk-rename failure logs the failed paths and continues —
   * the ledger only records paths that successfully renamed, so
   * partial failure self-corrects on next connect.
   */
  private async applyArcadeAutoHideRule(
    snapshot: ArcadePlayabilitySnapshot,
  ): Promise<void> {
    const enabled = this.getArcadeAutoHideEnabled();
    const buckets = bucketByPlayability(snapshot);
    const tombstones = new Set(
      this.ledgerCache.arcadeUserShownDespiteMissing ?? [],
    );
    // visible → current on-disk state from the snapshot.
    interface CurrentState {
      readonly hidden: boolean;
      readonly currentRelPath: string;
    }
    const currentByVisible = new Map<string, CurrentState>();
    for (const entry of snapshot.entries) {
      const visible = arcadeMraVisiblePath(entry.relativePath);
      currentByVisible.set(visible, {
        hidden: entry.hidden,
        currentRelPath: entry.relativePath,
      });
    }
    const previousAutoHidden = new Set(this.ledgerCache.arcadeAutoHidden ?? []);
    const shouldBeHidden = new Set<string>();
    if (enabled) {
      for (const missingPath of buckets.missing) {
        // `missing` is keyed by relativePath in the snapshot —
        // which itself can be either visible or dot-prefixed
        // depending on the current on-disk state. Normalise.
        const visible = arcadeMraVisiblePath(missingPath);
        if (tombstones.has(visible)) continue;
        const state = currentByVisible.get(visible);
        if (state === undefined) continue;
        // If the entry is already hidden AND we didn't auto-hide
        // it last time, the user (or another tool) hid it
        // manually. Don't claim it for the auto-hide ledger.
        if (state.hidden && !previousAutoHidden.has(visible)) continue;
        shouldBeHidden.add(visible);
      }
    }
    // Hide diff: in shouldBeHidden, not currently hidden.
    // Show diff: previously-auto-hidden, not in shouldBeHidden.
    const toHide: { relativePath: string; hidden: true }[] = [];
    const toShow: { relativePath: string; hidden: false }[] = [];
    for (const visible of shouldBeHidden) {
      const state = currentByVisible.get(visible);
      if (state === undefined) continue;
      if (!state.hidden) {
        toHide.push({ relativePath: state.currentRelPath, hidden: true });
      }
    }
    for (const visible of previousAutoHidden) {
      if (shouldBeHidden.has(visible)) continue;
      const state = currentByVisible.get(visible);
      if (state === undefined) continue;
      if (state.hidden) {
        toShow.push({ relativePath: state.currentRelPath, hidden: false });
      }
    }
    let hideOk = new Set<string>();
    let showOk = new Set<string>();
    if (toHide.length > 0) {
      const result = await this.client.setBulkArcadeMraVisibility(toHide);
      hideOk = new Set(result.succeeded);
      if (result.failed.length > 0) {
        diagLog('warn', 'arcade', '·', 'auto-hide partial-fail', {
          attempted: toHide.length,
          succeeded: result.succeeded.length,
          failed: result.failed.length,
        });
      }
    }
    if (toShow.length > 0) {
      const result = await this.client.setBulkArcadeMraVisibility(toShow);
      showOk = new Set(result.succeeded);
      if (result.failed.length > 0) {
        diagLog('warn', 'arcade', '·', 'auto-show partial-fail', {
          attempted: toShow.length,
          succeeded: result.succeeded.length,
          failed: result.failed.length,
        });
      }
    }
    // Compute the new ledger set — visible paths only:
    //   • Drop any previously-auto-hidden that successfully showed.
    //   • Add the visible-path form of every successful hide.
    //   • Anything that failed stays where it was: previously-
    //     auto-hidden that failed to show stays in the ledger;
    //     a should-hide that failed to hide does NOT enter the
    //     ledger (we never claim auto-hide on a path we couldn't
    //     rename).
    const next = new Set<string>(previousAutoHidden);
    for (const change of toShow) {
      if (showOk.has(change.relativePath)) {
        next.delete(arcadeMraVisiblePath(change.relativePath));
      }
    }
    for (const change of toHide) {
      if (hideOk.has(change.relativePath)) {
        next.add(arcadeMraVisiblePath(change.relativePath));
      }
    }
    const nextSorted = [...next].sort();
    const prevSorted = [...(this.ledgerCache.arcadeAutoHidden ?? [])].sort();
    const changed =
      nextSorted.length !== prevSorted.length ||
      nextSorted.some((v, i) => v !== prevSorted[i]);
    if (changed) {
      const newLedger = withArcadeAutoHidden(this.ledgerCache, nextSorted);
      await this.persistLedger(newLedger);
    }
    if (toHide.length > 0 || toShow.length > 0) {
      diagLog('info', 'arcade', '·', 'auto-hide applied', {
        enabled: enabled ? 'true' : 'false',
        hidden: hideOk.size,
        shown: showOk.size,
        tombstones: tombstones.size,
        ledgerSize: next.size,
      });
      // Any successful rename bumps _Arcade/ mtime, so the
      // playability snapshot we computed is now stale w.r.t. the
      // hidden-flag of those entries. Drop the in-memory copy +
      // the on-disk cache so the next read re-walks. Cheap
      // (top-level mras only) and the renderer triggers a fresh
      // listArcadeMraEntries soon after anyway.
      this.arcadePlayabilityCache = null;
      this.arcadeMraCache = null;
      if (this.currentHost !== null) {
        await this.cache
          .invalidateArcadeMraMetaCache(this.currentHost)
          .catch(() => {
            /* swallow */
          });
      }
    }
  }

  /**
   * feat/arcade-ux-and-ledger (PR 2/2) — apply the user-initiated
   * hide/show ledger transitions for a batch of changes.
   *
   *   • If the user is HIDING: remove the visible path from
   *     tombstones (they're reversing a prior "show despite
   *     missing" stance) AND from arcadeAutoHidden (defensive —
   *     a user-hide isn't an auto-hide).
   *   • If the user is SHOWING and the path was in arcadeAutoHidden:
   *     promote to a tombstone, drop from arcadeAutoHidden. The
   *     row stays exempt from future auto-hide passes.
   *   • If the user is SHOWING and the path was NOT in
   *     arcadeAutoHidden: no ledger update. (User-hide being
   *     undone; nothing to track.)
   *
   * Called from `setArcadeMraVisibility` / `setBulkArcadeMraVisibility`
   * AFTER the on-disk rename succeeds. A partial-success bulk
   * may have already updated the ledger for entries that did
   * succeed; we run the ledger update against the renderer's
   * input list (matching the existing semantics where the
   * renderer doesn't see per-entry failure attribution for
   * single calls). Best-effort.
   */
  private async applyUserMraVisibilityToLedger(
    changes: readonly { readonly relativePath: string; readonly hidden: boolean }[],
  ): Promise<void> {
    let ledger = this.ledgerCache;
    const prevAutoHidden = new Set(ledger.arcadeAutoHidden ?? []);
    let autoHiddenChanged = false;
    const nextAutoHidden = new Set(prevAutoHidden);
    for (const change of changes) {
      const visible = arcadeMraVisiblePath(change.relativePath);
      if (change.hidden) {
        // User hides — clear any tombstone for this row + remove
        // from auto-hidden (we're not the ones doing it).
        ledger = withArcadeTombstoneRemoved(ledger, visible);
        if (nextAutoHidden.delete(visible)) autoHiddenChanged = true;
      } else if (prevAutoHidden.has(visible)) {
        // User shows an auto-hidden row → tombstone it.
        ledger = withArcadeTombstoneAdded(ledger, visible);
        nextAutoHidden.delete(visible);
        autoHiddenChanged = true;
      }
    }
    if (autoHiddenChanged) {
      ledger = withArcadeAutoHidden(ledger, [...nextAutoHidden].sort());
    }
    if (ledger !== this.ledgerCache) {
      await this.persistLedger(ledger);
    }
  }

  /**
   * Write a new ledger value to the on-MiSTer state.json and
   * update the in-memory cache atomically (write first, then
   * cache — if the write throws we keep serving the old cache).
   */
  private async persistLedger(next: HideLedger): Promise<void> {
    if (ledgerEqual(this.ledgerCache, next)) return;
    await this.client.writeHideLedger(next);
    this.ledgerCache = next;
  }

  /**
   * Network fetch path for `listAllCoresWithFiles`. Walks the device,
   * stats the cores witnesses, writes both to the on-disk cache, and
   * updates `coresCache` in memory.
   *
   * Witnesses are stat'd AFTER the fetch so they reflect the device
   * state at or after the data was generated. If a write happened
   * during the walk, the post-fetch stat captures it and the cache
   * will invalidate on next validate (one extra refetch, never stale
   * data served).
   */
  private async fetchAndCacheCores(): Promise<CoreEntry[]> {
    const cores = await this.client.listAllCoresWithFiles(
      this.systemFilesMarksCache,
    );
    this.coresCache = cores;
    if (this.currentHost !== null) {
      try {
        const witnesses = await this.client.statWitnesses(
          CORES_CACHE_WITNESS_PATHS,
        );
        await this.cache.setCoresCache(this.currentHost, cores, witnesses);
      } catch {
        // Stat or write failure → drop the cache so the next session
        // refetches rather than serves something we can't validate.
        // The `note` flags this as recovery in the dev log so it's
        // distinguishable from routine user-initiated invalidates.
        await this.cache
          .invalidateCoresCache(this.currentHost, { note: 'write-failed' })
          .catch(() => {
            /* swallow */
          });
      }
    }
    return cores;
  }

  /**
   * Read-only view of the on-MiSTer hide ledger — the IDs of cores
   * MiSTerCurator itself hid in past sessions. The renderer uses this
   * to scope its "Unhide all" target list (preventing a bulk un-hide
   * from un-prefixing arbitrary firmware-placed dot folders). Single
   * hide/show operations don't touch this list.
   */
  async listLedgerCoreIds(): Promise<readonly string[]> {
    this.assertConnected();
    return this.ledgerCache.hiddenCores.map((e) => e.coreId);
  }

  async listSystemFileMarks(): Promise<SystemFilesMarks> {
    this.assertConnected();
    return this.systemFilesMarksCache;
  }

  async addSystemFileMark(
    coreId: string,
    filename: string,
  ): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.client.addSystemFileMark(coreId, filename);
    this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
    await this.invalidateAfterMarksChange(coreId);
    return this.systemFilesMarksCache;
  }

  async removeSystemFileMark(
    coreId: string,
    filename: string,
  ): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.client.removeSystemFileMark(coreId, filename);
    this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
    await this.invalidateAfterMarksChange(coreId);
    return this.systemFilesMarksCache;
  }

  async setSystemFileMarks(
    coreId: string,
    changes: readonly SystemFileMarkChange[],
  ): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.client.setSystemFileMarks(coreId, changes);
    this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
    await this.invalidateAfterMarksChange(coreId);
    return this.systemFilesMarksCache;
  }

  /**
   * Marks changes shift romCount (in the cores list) and the system-
   * flag flag inside Rom[] (for the listRoms list of `coreId`). Both
   * cache files are out-of-date until a fresh fetch — invalidate.
   * Cheaper alternatives (delta-update each cache file) are possible
   * but error-prone; v0 invalidates and refetches lazily.
   */
  private async invalidateAfterMarksChange(coreId: string): Promise<void> {
    if (this.currentHost === null) return;
    this.coresCache = [];
    await Promise.all([
      this.cache.invalidateCoresCache(this.currentHost),
      this.cache.invalidateRomsCache(this.currentHost, coreId),
    ]).catch(() => {
      /* best-effort */
    });
  }

  /**
   * Lists the ROM-shaped entries at `<coreId>/<subPath>`. PR #12:
   * cache-first via the on-disk roms cache, validated against the
   * one-path mtime witness (`/media/fat/games/<onDiskBasename>` for
   * the top level, plus `/<subPath>` for drills).
   *
   * `forceRefresh` skips the cache and writes a fresh entry — wired
   * to the renderer's Refresh button.
   */
  async listRoms(
    coreId: string,
    subPath = '',
    options: { readonly forceRefresh?: boolean } = {},
  ): Promise<Rom[]> {
    this.assertConnected();

    // fix/scrape-and-count-correctness commit 4 — alias drill-in.
    // If subPath points at one of this core's alias dirs (e.g.
    // NeoGeo-CD/ folded under NeoGeo), the SSH walk targets the
    // alias dir on the device. The returned Roms get their coreId
    // rewritten to the primary so the renderer's coreId-keyed
    // lookups stay consistent, and the alias name re-prepends to
    // their relativePath so further drill-in keeps the prefix.
    const redirect = this.resolveAliasRedirect(coreId, subPath);
    const sshCoreId = redirect?.coreId ?? coreId;
    const sshSubPath = redirect?.subPath ?? subPath;

    const dirBase = this.resolveOnDiskGamesDirBasename(sshCoreId);
    const witnessPath = romsCacheWitnessPath(dirBase, sshSubPath);

    const finalize = (roms: readonly Rom[]): Rom[] => {
      if (redirect) {
        return roms.map((r) => ({
          ...r,
          coreId,
          relativePath:
            r.relativePath !== undefined && r.relativePath !== ''
              ? `${redirect.coreId}/${r.relativePath}`
              : redirect.coreId,
        }));
      }
      // Top-level of the primary: append synthetic 'folder-container'
      // rows for each alias dir so the user can drill into them. The
      // synthetic row's `path` points at /media/fat/games/<aliasDir>
      // — the actual alias dir on the device — so any future
      // operation that consults `path` directly stays correct.
      if (subPath === '') {
        const core = this.coresCache.find((c) => c.id === coreId);
        const extras = core?.extraGamesDirNames ?? [];
        if (extras.length > 0) {
          const synthetic: Rom[] = extras.map((name) => ({
            coreId,
            filename: name,
            displayName: name,
            sizeBytes: 0,
            hidden: false,
            path: `${MISTER_GAMES_DIR}/${name}`,
            kind: 'folder-container',
            relativePath: name,
          }));
          return [...roms, ...synthetic];
        }
      }
      return [...roms];
    };

    if (!options.forceRefresh && this.currentHost !== null) {
      const slot = await this.cache.getRomsCache(
        this.currentHost,
        sshCoreId,
        sshSubPath,
      );
      if (slot !== null) {
        // Stat the single witness in one round trip and compare. The
        // stat itself is ~50ms — a worthwhile trade against the
        // multi-second walk of a large core's games dir (X68000:
        // ~600 folders, was 7s pre-cache).
        try {
          const fresh = await this.client.statWitnesses([witnessPath]);
          if (witnessesMatch(slot.witnesses, fresh)) {
            this.cache.recordHit('roms', {
              host: this.currentHost,
              coreId: sshCoreId,
              subPath: sshSubPath,
            });
            return finalize(slot.data);
          }
          // Witnesses moved — emit stale and fall through. Don't
          // invalidate the file here: the upcoming
          // `fetchAndCacheRoms` will rewrite the slot in place via
          // `setRomsCache`, which preserves the other subPath slots
          // in the same core file. A blanket `invalidateRomsCache`
          // would drop those siblings unnecessarily.
          this.cache.recordStale('roms', {
            host: this.currentHost,
            coreId: sshCoreId,
            subPath: sshSubPath,
          });
        } catch {
          // Witness stat failure → fall through to network fetch.
          // The fall-through write will refresh whatever it can.
        }
      }
    }

    const fresh = await this.fetchAndCacheRoms(
      sshCoreId,
      dirBase,
      sshSubPath,
      witnessPath,
    );
    return finalize(fresh);
  }

  /**
   * Network fetch + cache write path for listRoms. Stat-after-fetch
   * mirrors the cores-cache write path: witnesses recorded with the
   * data reflect the post-fetch device state, so a write during the
   * walk surfaces as a cache miss next time, never as stale data.
   */
  private async fetchAndCacheRoms(
    coreId: string,
    dirBase: string,
    subPath: string,
    witnessPath: string,
  ): Promise<Rom[]> {
    const fetched = await this.client.listRoms(
      dirBase,
      subPath,
      this.folderClassificationsCache,
    );
    // Translate the on-disk basename back to the canonical coreId so
    // the renderer's view stays casing/dot agnostic. The on-disk path
    // (`rom.path`) stays as the actual on-disk path so renames target
    // the right file.
    const roms =
      dirBase === coreId ? fetched : fetched.map((r) => ({ ...r, coreId }));

    if (this.currentHost !== null) {
      try {
        const witnesses = await this.client.statWitnesses([witnessPath]);
        await this.cache.setRomsCache(
          this.currentHost,
          coreId,
          subPath,
          roms,
          witnesses,
        );
      } catch {
        await this.cache
          .invalidateRomsCache(this.currentHost, coreId, {
            note: 'write-failed',
          })
          .catch(() => {
            /* swallow */
          });
      }
    }
    return roms;
  }

  async setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath = '',
  ): Promise<void> {
    this.assertConnected();
    // commit 4: alias drill-in → rename targets the alias dir on the
    // device; both the alias and primary cache slots get invalidated
    // since either could be rendering the affected ROM.
    const redirect = this.resolveAliasRedirect(coreId, subPath);
    const sshCoreId = redirect?.coreId ?? coreId;
    const sshSubPath = redirect?.subPath ?? subPath;
    const dirBase = this.resolveOnDiskGamesDirBasename(sshCoreId);
    await this.client.setRomVisibility(dirBase, filename, hidden, sshSubPath);
    // ROM rename changes the games dir's mtime → roms cache for this
    // core is invalidated. We don't try to delta-update Rom[] in
    // place; simpler and safer to drop and refetch on next browse.
    await this.invalidateRomsAfterMutation(sshCoreId);
    if (redirect) await this.invalidateRomsAfterMutation(coreId);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
    subPath = '',
  ): Promise<BulkRomResult> {
    this.assertConnected();
    const redirect = this.resolveAliasRedirect(coreId, subPath);
    const sshCoreId = redirect?.coreId ?? coreId;
    const sshSubPath = redirect?.subPath ?? subPath;
    const dirBase = this.resolveOnDiskGamesDirBasename(sshCoreId);
    const result = await this.client.setBulkRomVisibility(
      dirBase,
      changes,
      sshSubPath,
    );
    // Invalidate even on partial failure — a non-empty `succeeded`
    // means at least one rename committed and the cache is stale.
    if (result.succeeded.length > 0 || result.failed.length > 0) {
      await this.invalidateRomsAfterMutation(sshCoreId);
      if (redirect) await this.invalidateRomsAfterMutation(coreId);
    }
    return result;
  }

  /** Drop the on-disk roms cache for `coreId`. Best-effort. */
  private async invalidateRomsAfterMutation(coreId: string): Promise<void> {
    if (this.currentHost === null) return;
    await this.cache.invalidateRomsCache(this.currentHost, coreId).catch(() => {
      /* swallow */
    });
  }

  /**
   * Resolve the on-disk basename of a core's games dir from its
   * canonical id. Returns `coreId` unchanged when no `CoreEntry` is
   * cached (defensive — keeps legacy IPC paths working) or when the
   * id and the on-disk basename agree.
   *
   * Real MiSTers carry case mismatches (`.rbf` named `Atari7800` next
   * to `games/.ATARI7800/`) that the matcher dedupes by lowercase id;
   * this method threads the actual on-disk basename — including the
   * leading dot when hidden — back to the client so paths target the
   * right directory.
   */
  /**
   * PR-C round 2 (PR #26): recursive ROM-file path list for one
   * core, filtered by the sidebar-count predicate
   * (`shouldCountAsRom` + `isLaunchableRomExtension`). The
   * auto-scrape engine queues this so its footer total matches the
   * sidebar's integer count — pre-round-2 the engine asked
   * `listRoms(coreId, '', {})` and got only top-level entries.
   *
   * feat/atomic-folder-consistency: the recursive list is now
   * post-filtered against the top-level atomic-folder set. For each
   * top-level atomic folder (e.g. an X68000 multi-disk game folder),
   * we drop EVERY contained-file path the recursive find produced
   * and replace them with the folder's single contained primary
   * path (`Rom.containedRomPath`). For X68000 with ~647 atomic
   * floppy folders × 2.25 disks each, that's ~1455 paths reduced
   * to ~647 — every disk no longer gets hashed individually + the
   * same folder-name search no longer runs 2-4 times per game.
   *
   * The returned set carries the atomic-folder paths so the
   * orchestrator's `getRomsMetadata(atomicFolderPaths)` can route
   * those paths' name-search through the parent folder name (the
   * strongest hint when hash misses on a floppy disk image, which
   * is essentially never indexed by SS at the disk level).
   *
   * Nested classification — atomic folders inside a top-level
   * container — is out of scope for this commit. Top-level
   * containers' contents pass through verbatim (the recursive
   * find result), same as today.
   *
   * Per-core SSH find runs lazily when the engine reaches the core
   * (~1-2s), not upfront. For 60 cores total that's ~60-120s of
   * SSH overhead spread across the multi-minute scraping window —
   * negligible relative to scrape time.
   */
  async listAllRomPathsForCore(coreId: string): Promise<{
    readonly paths: readonly string[];
    readonly atomicFolderPaths: ReadonlySet<string>;
  }> {
    this.assertConnected();
    const gamesDirBasename = this.resolveOnDiskGamesDirBasename(coreId);

    // Recursive find: every launchable file under the games dir,
    // classification-blind.
    const recursivePaths = await this.client.listRecursiveRomFiles({
      coreId,
      gamesDirBasename,
      marks: this.systemFilesMarksCache,
    });
    // Top-level row classification — `listRoms` returns one Rom per
    // top-level entry with a `kind` discriminator + `containedRomPath`
    // for atomic folders.
    const topLevelRoms = await this.client.listRoms(
      coreId,
      '',
      this.folderClassificationsCache,
    );
    // The merge: dedupe contained-file paths inside top-level atomic
    // folders to a single representative each, plus the
    // atomicFolderPaths set the orchestrator routes name-search hints
    // by. See `mergeRecursivePathsWithAtomicFolders` for the full
    // rule + nested-classification scope note.
    return mergeRecursivePathsWithAtomicFolders({
      recursivePaths,
      topLevelRoms,
    });
  }

  private resolveOnDiskGamesDirBasename(coreId: string): string {
    const core = this.coresCache.find((c) => c.id === coreId);
    if (!core || !core.gamesDirExists) return coreId;
    const base = core.gamesDirName ?? core.id;
    return core.gamesDirHidden ? `.${base}` : base;
  }

  /**
   * fix/scrape-and-count-correctness commit 4 — alias-dir redirect.
   *
   * When a CoreEntry has `extraGamesDirNames` (NeoGeo carries
   * `['NeoGeo-CD']`) and the caller's subPath starts with one of
   * those names, the SSH-layer call should target the alias dir on
   * the device — `/media/fat/games/NeoGeo-CD/...` — instead of the
   * primary's nested path. Returns the (coreId, subPath) the SSH
   * layer should use, or `null` when no redirect applies.
   *
   * Pure read against `coresCache`; no I/O.
   */
  private resolveAliasRedirect(
    coreId: string,
    subPath: string,
  ): { readonly coreId: string; readonly subPath: string } | null {
    if (subPath === '') return null;
    const core = this.coresCache.find((c) => c.id === coreId);
    if (!core?.extraGamesDirNames || core.extraGamesDirNames.length === 0) {
      return null;
    }
    const slash = subPath.indexOf('/');
    const head = slash < 0 ? subPath : subPath.slice(0, slash);
    if (!core.extraGamesDirNames.includes(head)) return null;
    const tail = slash < 0 ? '' : subPath.slice(slash + 1);
    return { coreId: head, subPath: tail };
  }

  async listFolderClassifications(): Promise<FolderClassifications> {
    this.assertConnected();
    return this.folderClassificationsCache;
  }

  async setFolderClassification(
    coreId: string,
    folderPath: string,
    classification: 'container' | 'atomic' | undefined,
  ): Promise<FolderClassifications> {
    this.assertConnected();
    if (classification === undefined) {
      await this.client.setFolderClassification({
        coreId,
        folderPath,
        classification: undefined,
      });
    } else {
      const override: FolderClassificationOverride = {
        coreId,
        folderPath,
        classification,
        setAt: new Date().toISOString(),
      };
      await this.client.setFolderClassification(override);
    }
    this.folderClassificationsCache =
      await this.client.readFolderClassifications();
    // Folder-classification changes flip Rom.kind (container ↔ atomic)
    // for the affected core's listRoms output. cores cache is
    // unaffected (kind isn't part of CoreEntry).
    if (this.currentHost !== null) {
      await this.cache.invalidateRomsCache(this.currentHost, coreId).catch(() => {
        /* swallow */
      });
    }
    return this.folderClassificationsCache;
  }

  async hideCore(coreId: string): Promise<void> {
    this.assertConnected();
    const core = await this.lookupCore(coreId);
    if (!isRealCore(core)) {
      throw new Error(`Refusing to hide '${coreId}': not a real core.`);
    }
    await this.client.hideCore(core);
    await this.recordHide(core);
    this.applyCachedVisibilityFlip(core.id, true);
    await this.writeThroughAfterCoreMutation(coreId);
  }

  async showCore(coreId: string): Promise<void> {
    this.assertConnected();
    const core = await this.lookupCore(coreId);
    if (!isRealCore(core)) {
      throw new Error(`Refusing to show '${coreId}': not a real core.`);
    }
    // Round 5: no ledger gate on single-core un-hide. The user can
    // un-hide any core in the cores list, including those dot-prefixed
    // by other tools or the firmware. `recordShow` is still called so
    // the ledger stays in sync with our own bookkeeping (a no-op when
    // the core wasn't in the ledger to begin with).
    await this.client.showCore(core);
    await this.recordShow(core);
    this.applyCachedVisibilityFlip(core.id, false);
    await this.writeThroughAfterCoreMutation(coreId);
  }

  /**
   * After a successful single-core hide/show: re-stat cores witnesses,
   * write the delta-updated `coresCache` back to disk, and drop the
   * roms cache for the affected core (its games dir was renamed,
   * so any cached top-level/sub-path slots key on a stale on-disk
   * basename).
   *
   * Best-effort: any failure invalidates the cores cache so the next
   * session refetches rather than serving stale.
   */
  private async writeThroughAfterCoreMutation(coreId: string): Promise<void> {
    if (this.currentHost === null) return;
    try {
      const witnesses = await this.client.statWitnesses(CORES_CACHE_WITNESS_PATHS);
      await this.cache.setCoresCache(
        this.currentHost,
        this.coresCache,
        witnesses,
      );
      await this.cache.invalidateRomsCache(this.currentHost, coreId);
    } catch {
      await this.cache
        .invalidateCoresCache(this.currentHost, { note: 'write-failed' })
        .catch(() => {
          /* swallow */
        });
      await this.cache
        .invalidateRomsCache(this.currentHost, coreId, { note: 'write-failed' })
        .catch(() => {
          /* swallow */
        });
    }
  }

  /**
   * Update the in-memory cores cache after a successful hide/show so
   * a subsequent `lookupCore(coreId)` returns the post-rename rbfPaths
   * and `gamesDirHidden` flag — without that, computing the next
   * rename for the same core would target the OLD on-disk paths and
   * be a no-op.
   */
  private applyCachedVisibilityFlip(coreId: string, hidden: boolean): void {
    this.coresCache = this.coresCache.map((c) =>
      c.id === coreId ? applyCoreVisibilityChange(c, hidden) : c,
    );
  }

  async setBulkCoreVisibility(
    changes: readonly { readonly coreId: string; readonly hidden: boolean }[],
    options: { readonly operationId?: string } = {},
  ): Promise<BulkCoreResult> {
    this.assertConnected();
    if (changes.length === 0) return { succeeded: [], failed: [] };

    const resolved: CoreVisibilityChange[] = [];
    const upfrontFailed: { coreId: string; reason: string }[] = [];
    for (const c of changes) {
      let core: CoreEntry;
      try {
        core = await this.lookupCore(c.coreId);
      } catch (err) {
        upfrontFailed.push({
          coreId: c.coreId,
          reason: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      if (!isRealCore(core)) {
        upfrontFailed.push({
          coreId: c.coreId,
          reason: 'not a real core (likely a user folder or the Arcade placeholder)',
        });
        continue;
      }
      // Round 5: no ledger gate. The renderer's "Unhide all" pre-
      // filters its bulk-call payload via `listLedgerCoreIds()`, so
      // by the time we get here the un-hide list is already scoped
      // to cores we hid ourselves. Other callers (single-core hide /
      // show via the eye icon) operate on whatever the user clicked.
      resolved.push({ core, hidden: c.hidden });
    }

    if (resolved.length === 0) {
      return { succeeded: [], failed: upfrontFailed };
    }

    const operationId = options.operationId ?? `op-${String(this.nextOperationId++)}`;
    const result = await this.client.setBulkCoreVisibility(resolved, {
      onProgress: (event) => {
        const broadcast: BulkCoreProgressBroadcast = { operationId, ...event };
        for (const listener of this.bulkProgressListeners) {
          try {
            listener(broadcast);
          } catch {
            /* swallow — never let UI errors break a bulk op */
          }
        }
      },
    });
    const failed = [...upfrontFailed, ...result.failed];

    // Ledger update: only for cores whose renames fully succeeded.
    const succeededIds = new Set(result.succeeded);
    let ledger = this.ledgerCache;
    for (const c of resolved) {
      if (!succeededIds.has(c.core.id)) continue;
      ledger = c.hidden
        ? withCoreHidden(ledger, this.toHiddenEntry(c.core))
        : withCoreShown(ledger, c.core.id);
    }
    if (!ledgerEqual(ledger, this.ledgerCache)) {
      await this.client.writeHideLedger(ledger);
      this.ledgerCache = ledger;
    }

    // Apply the same flip to coresCache so a follow-up lookupCore on
    // any of these ids sees the post-rename state. Without this, a
    // back-to-back bulk hide → bulk show on the same core sees stale
    // rbfPaths and computes an empty rename plan.
    for (const c of resolved) {
      if (succeededIds.has(c.core.id)) {
        this.applyCachedVisibilityFlip(c.core.id, c.hidden);
      }
    }

    // PR #12 cache write-through. One stat batch covers every
    // succeeded core's witnesses (the cores cache uses the 5 shared
    // category/games-dir paths). Per-core roms cache files are
    // dropped one-by-one — their on-disk basenames just changed.
    if (this.currentHost !== null && succeededIds.size > 0) {
      try {
        const witnesses = await this.client.statWitnesses(CORES_CACHE_WITNESS_PATHS);
        await this.cache.setCoresCache(
          this.currentHost,
          this.coresCache,
          witnesses,
        );
        await Promise.all(
          [...succeededIds].map((id) =>
            this.cache.invalidateRomsCache(this.currentHost as string, id),
          ),
        );
      } catch {
        await this.cache
          .invalidateCoresCache(this.currentHost, { note: 'write-failed' })
          .catch(() => {
            /* swallow */
          });
      }
    }

    return { succeeded: result.succeeded, failed };
  }

  /**
   * Wipes the entire on-disk cache for the current host. Wired to the
   * "Clear cache" hidden command (no UI surface yet, v0). Safe to call
   * when disconnected — does nothing.
   */
  async clearCacheForCurrentHost(): Promise<void> {
    if (this.currentHost === null) return;
    await this.cache.clearHost(this.currentHost);
    this.coresCache = [];
  }

  private async runAutoReapply(): Promise<number> {
    if (this.ledgerCache.hiddenCores.length === 0) return 0;

    // Use the cache-aware path so a warm-connect reapply doesn't pay
    // the 7s walk twice. `listAllCoresWithFiles` returns cached data
    // when valid; only fetches on miss.
    const cores = await this.listAllCoresWithFiles();

    const changes = computeAutoReapplyChanges(this.ledgerCache, cores);
    if (changes.length === 0) return 0;

    const coresById = new Map(cores.map((c) => [c.id, c]));
    const resolved: CoreVisibilityChange[] = [];
    for (const c of changes) {
      const core = coresById.get(c.coreId);
      if (!core) continue;
      if (!isRealCore(core)) continue;
      resolved.push({ core, hidden: c.hidden });
    }
    if (resolved.length === 0) return 0;

    const result = await this.client.setBulkCoreVisibility(resolved);

    // After bulk renames the cores list is stale. Force a fresh
    // refetch so subsequent hideCore lookups see post-rename rbfPaths
    // — and write-through the new state to the on-disk cache.
    await this.listAllCoresWithFiles({ forceRefresh: true });

    return result.succeeded.length;
  }

  private async recordHide(core: CoreEntry): Promise<void> {
    const next = withCoreHidden(this.ledgerCache, this.toHiddenEntry(core));
    await this.client.writeHideLedger(next);
    this.ledgerCache = next;
  }

  private async recordShow(core: CoreEntry): Promise<void> {
    const next = withCoreShown(this.ledgerCache, core.id);
    await this.client.writeHideLedger(next);
    this.ledgerCache = next;
  }

  private toHiddenEntry(core: CoreEntry): HiddenCoreEntry {
    const canonicalRbfs = core.rbfPaths.map((p) => {
      const slash = p.lastIndexOf('/');
      const dir = slash < 0 ? '' : p.slice(0, slash);
      const base = slash < 0 ? p : p.slice(slash + 1);
      const undotted = base.startsWith('.') ? base.slice(1) : base;
      return dir === '' ? undotted : `${dir}/${undotted}`;
    });
    return {
      coreId: core.id,
      gamesDirHidden: core.gamesDirExists,
      gamesDirName: core.gamesDirName,
      rbfPaths: canonicalRbfs,
      hiddenAt: new Date().toISOString(),
    };
  }

  private async lookupCore(coreId: string): Promise<CoreEntry> {
    const lower = coreId.toLowerCase();
    const cached = this.coresCache.find((c) => c.id.toLowerCase() === lower);
    if (cached) return cached;

    // Cache miss — refresh and retry once.
    await this.listAllCoresWithFiles();
    const fresh = this.coresCache.find((c) => c.id.toLowerCase() === lower);
    if (!fresh) {
      throw new Error(`Unknown core: ${coreId}`);
    }
    return fresh;
  }

  private assertConnected(): void {
    if (this.status !== 'connected') {
      throw new Error('Not connected to a MiSTer.');
    }
  }

  private setStatus(next: ConnectionStatus): void {
    if (this.status === next) return;
    this.status = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  private emitConnectionEvent(event: ConnectionEvent): void {
    for (const listener of this.connectionEventListeners) {
      try {
        listener(event);
      } catch {
        /* never let a UI throw kill the connection lifecycle */
      }
    }
  }

  /**
   * Invoked when the underlying client tells us the SSH transport
   * dropped on its own. Marks the manager as 'disconnected' (writes
   * fail loudly), broadcasts the event so the renderer can show a
   * stale-state banner, and kicks off the auto-retry loop. Idempotent
   * w.r.t. close+error firing in quick succession (the client already
   * dedups).
   */
  private handleUnexpectedDisconnect(): void {
    const profileId = this.currentProfileId;
    if (profileId === null) return;
    diagLog('warn', 'conn', '✗', 'unexpected-disconnect', { profileId });
    // Round 5 — emit the event BEFORE flipping status. The renderer
    // delivers IPC events as separate tasks, so a `setStatus(...)`-
    // before-event order produces a brief render where the renderer
    // sees `status='disconnected' && lostConnection=false`. The
    // CoresContext wipe-effect's transient-drop guard checks
    // `lostConnection`, so that inter-event window passed the wipe
    // guard and nullified `romsByCore` even on transient drops —
    // which in turn tore down the initial-prefetch effect (logged
    // `roms-pane unsubscribed` in round 4) and prevented the resume
    // effect from re-firing on reconnect (no `roms` to enumerate).
    //
    // Emitting the event first means the renderer sees
    // `lostConnection=true` BEFORE `status='disconnected'`, so the
    // wipe guard holds across the cycle.
    this.emitConnectionEvent({ type: 'disconnected-unexpected', profileId });
    this.setStatus('disconnected');
    void this.runAutoRetry(profileId);
  }

  /**
   * Auto-reconnect loop on the documented backoff schedule. Each
   * attempt runs the same `connect()` path the user would (but
   * without rewinding `currentProfileId`, since we know which profile
   * we're targeting). The token guards against overlapping cycles
   * when the user manually reconnects or disconnects mid-loop.
   */
  private async runAutoRetry(profileId: string): Promise<void> {
    const token = ++this.autoRetryToken;
    let profile: MisterProfile | null;
    try {
      profile = (await this.store.get(profileId)) ?? null;
    } catch {
      profile = null;
    }
    if (profile === null || token !== this.autoRetryToken) return;
    let secret: MisterSecret;
    try {
      secret = await this.store.getSecret(profileId);
    } catch {
      // Secrets gone (profile deleted mid-cycle, etc.) — surface as
      // exhausted-retries so the renderer falls into banner state.
      this.emitConnectionEvent({
        type: 'auto-retry-failed',
        profileId,
        underlyingMessage: 'Stored credentials no longer available.',
      });
      return;
    }

    let lastError = 'Connection lost.';
    for (let attempt = 0; attempt < RECONNECT_BACKOFF_MS.length; attempt += 1) {
      const delay = backoffDelayMs(attempt);
      if (delay === undefined) break;
      if (token !== this.autoRetryToken) return;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delay);
      });
      if (token !== this.autoRetryToken) return;
      diagLog('info', 'conn', '→', 'reconnect-attempt', {
        profileId,
        attempt: attempt + 1,
        totalAttempts: RECONNECT_BACKOFF_MS.length,
        delayMs: delay,
      });
      this.emitConnectionEvent({
        type: 'auto-retry-attempt',
        profileId,
        attempt: attempt + 1,
        totalAttempts: RECONNECT_BACKOFF_MS.length,
      });
      try {
        await this.client.connect(profile, secret);
        if (token !== this.autoRetryToken) {
          // Got cancelled while we were connecting; tear down so the
          // canonical session isn't leaked.
          try {
            await this.client.disconnect();
          } catch {
            /* swallow */
          }
          return;
        }
        // Re-hook the unexpected-disconnect listener for the new
        // session and re-prime caches so the renderer sees fresh data.
        if (this.unsubscribeUnexpectedDisconnect) {
          this.unsubscribeUnexpectedDisconnect();
        }
        this.unsubscribeUnexpectedDisconnect = this.client.onUnexpectedDisconnect(
          () => {
            this.handleUnexpectedDisconnect();
          },
        );
        this.currentProfileId = profileId;
        this.currentHost = profile.host;
        try {
          // Reuse the same prime path as a fresh connect — keeps the
          // reconnect cost on the same <1s budget as the initial
          // connect. On a cache hit we skip the cores walk entirely.
          const prime = await this.client.primeConnect(CORES_CACHE_WITNESS_PATHS);
          this.ledgerCache = prime.ledger;
          this.systemFilesMarksCache = prime.marks;
          this.folderClassificationsCache = prime.classifications;
          const cached = await this.cache.getCoresCache(profile.host);
          if (
            cached !== null &&
            witnessesMatch(cached.witnesses, prime.witnesses)
          ) {
            this.coresCache = [...cached.data];
            this.cache.recordHit('cores', { host: profile.host });
          } else {
            if (cached !== null) {
              this.cache.recordStale('cores', { host: profile.host });
              await this.cache
                .invalidateCoresCache(profile.host)
                .catch(() => {
                  /* swallow */
                });
            }
            this.coresCache = [];
          }
        } catch {
          // Cache priming is best-effort during reconnect; the next
          // explicit refresh will catch anything we missed.
        }
        this.setStatus('connected');
        diagLog('info', 'conn', '←', 'reconnect-success', {
          profileId,
          attempt: attempt + 1,
        });
        this.emitConnectionEvent({ type: 'reconnected', profileId });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        diagLog('warn', 'conn', '✗', 'reconnect-attempt-failed', {
          profileId,
          attempt: attempt + 1,
          err: lastError,
        });
      }
    }

    if (token !== this.autoRetryToken) return;
    diagLog('error', 'conn', '✗', 'reconnect-exhausted', {
      profileId,
      attempts: RECONNECT_BACKOFF_MS.length,
      err: lastError,
    });
    this.emitConnectionEvent({
      type: 'auto-retry-failed',
      profileId,
      underlyingMessage: lastError,
    });
  }
}

// Re-exported for callers that want the type without importing isCoreHidden.
export { isCoreHidden };

/**
 * feat/arcade-playability-data (PR 1/2) — build the in-memory
 * playability snapshot from a parsed `entries` list + a flat
 * `zipBasenames` array. Dedupes the basenames into a Set, then
 * applies `computePlayability` once per entry. Pure — no side
 * effects, so unit-testable independently of `ConnectionManager`.
 */
export function buildPlayabilitySnapshot(
  entries: readonly ArcadeMraMeta[],
  zipBasenames: readonly string[],
): ArcadePlayabilitySnapshot {
  const zipSet = new Set(zipBasenames);
  const byPath = new Map<string, Playability>();
  for (const entry of entries) {
    byPath.set(entry.relativePath, computePlayability(entry, zipSet));
  }
  return { entries, zipBasenames: zipSet, byPath };
}

/**
 * feat/arcade-playability-data (PR 1/2) — bucket the snapshot's
 * `byPath` map into the three flat lists used internally and
 * surfaced (with `autoHidden` added) over IPC. Order within each
 * bucket follows `entries` document order (mirrors the awk's
 * `find` output order — typically filesystem-natural).
 *
 * Returns the three-bucket subset only; the IPC handler stitches
 * `autoHidden` from the ledger before sending to the renderer.
 */
export interface ArcadePlayabilityBuckets {
  readonly playable: readonly string[];
  readonly missing: readonly string[];
  readonly noRomsNeeded: readonly string[];
}

export function bucketByPlayability(
  snapshot: ArcadePlayabilitySnapshot,
): ArcadePlayabilityBuckets {
  const playable: string[] = [];
  const missing: string[] = [];
  const noRomsNeeded: string[] = [];
  for (const entry of snapshot.entries) {
    const classification = snapshot.byPath.get(entry.relativePath);
    if (classification === 'playable') {
      playable.push(entry.relativePath);
    } else if (classification === 'missing') {
      missing.push(entry.relativePath);
    } else if (classification === 'no-roms-needed') {
      noRomsNeeded.push(entry.relativePath);
    }
  }
  return { playable, missing, noRomsNeeded };
}
