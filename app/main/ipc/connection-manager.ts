import {
  backoffDelayMs,
  RECONNECT_BACKOFF_MS,
  type ConnectionEvent,
} from '@shared/connection';
import {
  computeAutoReapplyChanges,
  isCoreExternallyHidden,
  isCoreHidden,
  isRealCore,
} from '@shared/core-matching';
import {
  EMPTY_LEDGER,
  ledgerEqual,
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
import { EMPTY_FOLDER_CLASSIFICATIONS } from '@shared/folder-classifications';
import { EMPTY_SYSTEM_FILES_MARKS } from '@shared/system-files-marks';
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
}

/**
 * Owns the singleton IMisterClient and the ConnectionStatus state machine.
 * The renderer talks to this through IPC; main pushes status transitions
 * back to any registered listener (typically a webContents.send adapter).
 *
 * Owns the on-MiSTer hide ledger. Treats it as a *permission slip*:
 *
 *   - The cores list returned to the renderer is enriched with
 *     `managedByApp = true` iff the ledger has an entry for the core.
 *     The renderer uses this to gate the un-hide UI and to count
 *     "hidden externally" cores separately.
 *   - `showCore` / un-hide paths refuse to operate on a core that is
 *     NOT in the ledger. Pre-existing dot-prefixed directories from
 *     MiSTer's stock state (or other tools) are left alone.
 *   - `hideCore` / hide paths only ever add entries we just renamed.
 *     The ledger is therefore always a strict subset of the things on
 *     disk that we intend to manage.
 *
 * Ledger I/O is intentionally NOT exposed on the IPC bridge — the
 * renderer only sees its consequences (managedByApp, the reappliedCount
 * from connect, success/failure of hide/show).
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

  constructor(
    private readonly client: IMisterClient,
    private readonly store: ProfileStore,
  ) {}

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getCurrentProfileId(): string | null {
    return this.currentProfileId;
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
      await this.client.connect(profile, secret);
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

      // Prime the ledger cache. readHideLedger self-heals as a side
      // effect — drops stale `_hidden` etc. entries and rewrites.
      this.ledgerCache = await this.client.readHideLedger();
      // Prime the system-files marks cache. Cheap (small JSON file) and
      // we want the cores list to reflect marks immediately.
      this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
      this.folderClassificationsCache =
        await this.client.readFolderClassifications();

      let reappliedCount = 0;
      if (profile.autoReapplyHides === true) {
        reappliedCount = await this.runAutoReapply();
      }

      this.setStatus('connected');
      return { reappliedCount };
    } catch (err) {
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
    if (this.unsubscribeUnexpectedDisconnect) {
      this.unsubscribeUnexpectedDisconnect();
      this.unsubscribeUnexpectedDisconnect = null;
    }
    try {
      await this.client.disconnect();
    } finally {
      this.currentProfileId = null;
      this.coresCache = [];
      this.ledgerCache = EMPTY_LEDGER;
      this.systemFilesMarksCache = EMPTY_SYSTEM_FILES_MARKS;
      this.folderClassificationsCache = EMPTY_FOLDER_CLASSIFICATIONS;
      this.setStatus('disconnected');
    }
  }

  async listAllCoresWithFiles(): Promise<CoreEntry[]> {
    this.assertConnected();
    const raw = await this.client.listAllCoresWithFiles(
      this.systemFilesMarksCache,
    );
    const enriched = raw.map((c) => ({
      ...c,
      managedByApp: this.ledgerHasCore(c.id),
    }));
    this.coresCache = enriched;
    return enriched;
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
    return this.systemFilesMarksCache;
  }

  async removeSystemFileMark(
    coreId: string,
    filename: string,
  ): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.client.removeSystemFileMark(coreId, filename);
    this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
    return this.systemFilesMarksCache;
  }

  async setSystemFileMarks(
    coreId: string,
    changes: readonly SystemFileMarkChange[],
  ): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.client.setSystemFileMarks(coreId, changes);
    this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
    return this.systemFilesMarksCache;
  }

  async listRoms(coreId: string, subPath = ''): Promise<Rom[]> {
    this.assertConnected();
    const core = this.coresCache.find((c) => c.id === coreId);
    // Externally-hidden cores (rbf visible, games dir hidden by an
    // external tool) are not browsable through this app — their dir
    // isn't part of the user's curated library and the path can be
    // case-mismatched too. Return an empty list so the renderer
    // doesn't trigger an "Unknown core" stack trace; the cores list
    // disables click-through anyway (see CoresPane).
    if (core && isCoreExternallyHidden(core)) {
      return [];
    }
    const dirBase = this.resolveOnDiskGamesDirBasename(coreId);
    const roms = await this.client.listRoms(
      dirBase,
      subPath,
      this.folderClassificationsCache,
    );
    if (dirBase === coreId) return roms;
    // Translate the on-disk basename back to the canonical coreId so
    // the renderer's view stays casing/dot agnostic. The on-disk path
    // (`rom.path`) stays as the actual on-disk path so renames target
    // the right file.
    return roms.map((r) => ({ ...r, coreId }));
  }

  async setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath = '',
  ): Promise<void> {
    this.assertConnected();
    const dirBase = this.resolveOnDiskGamesDirBasename(coreId);
    await this.client.setRomVisibility(dirBase, filename, hidden, subPath);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
    subPath = '',
  ): Promise<BulkRomResult> {
    this.assertConnected();
    const dirBase = this.resolveOnDiskGamesDirBasename(coreId);
    return this.client.setBulkRomVisibility(dirBase, changes, subPath);
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
  private resolveOnDiskGamesDirBasename(coreId: string): string {
    const core = this.coresCache.find((c) => c.id === coreId);
    if (!core || !core.gamesDirExists) return coreId;
    const base = core.gamesDirName ?? core.id;
    return core.gamesDirHidden ? `.${base}` : base;
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
  }

  async showCore(coreId: string): Promise<void> {
    this.assertConnected();
    const core = await this.lookupCore(coreId);
    if (!isRealCore(core)) {
      throw new Error(`Refusing to show '${coreId}': not a real core.`);
    }
    if (!this.ledgerHasCore(core.id)) {
      throw new Error(
        `Refusing to show '${core.id}': not managed by MiSTerCurator (likely hidden by another tool — we will not modify it).`,
      );
    }
    await this.client.showCore(core);
    await this.recordShow(core);
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
      if (!c.hidden && !this.ledgerHasCore(core.id)) {
        // Permission slip: the un-hide path refuses cores the app didn't
        // hide. This is what protects the ~40+ pre-existing dot-prefixed
        // directories on a real MiSTer from being un-hidden by the user
        // accidentally clicking "Unhide all".
        upfrontFailed.push({
          coreId: core.id,
          reason: 'not managed by MiSTerCurator (we will not modify it)',
        });
        continue;
      }
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

    return { succeeded: result.succeeded, failed };
  }

  private async runAutoReapply(): Promise<number> {
    if (this.ledgerCache.hiddenCores.length === 0) return 0;

    const cores = await this.client.listAllCoresWithFiles(
      this.systemFilesMarksCache,
    );
    this.coresCache = cores;

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

    // Refresh the cache so subsequent hideCore lookups see the new state.
    const refreshed = await this.client.listAllCoresWithFiles(
      this.systemFilesMarksCache,
    );
    this.coresCache = refreshed.map((c) => ({
      ...c,
      managedByApp: this.ledgerHasCore(c.id),
    }));

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

  private ledgerHasCore(coreId: string): boolean {
    const lower = coreId.toLowerCase();
    return this.ledgerCache.hiddenCores.some(
      (e) => e.coreId.toLowerCase() === lower,
    );
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
    this.setStatus('disconnected');
    this.emitConnectionEvent({ type: 'disconnected-unexpected', profileId });
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
        try {
          this.ledgerCache = await this.client.readHideLedger();
          this.systemFilesMarksCache = await this.client.readSystemFilesMarks();
          this.folderClassificationsCache =
            await this.client.readFolderClassifications();
        } catch {
          // Cache priming is best-effort during reconnect; the next
          // explicit refresh will catch anything we missed.
        }
        this.setStatus('connected');
        this.emitConnectionEvent({ type: 'reconnected', profileId });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (token !== this.autoRetryToken) return;
    this.emitConnectionEvent({
      type: 'auto-retry-failed',
      profileId,
      underlyingMessage: lastError,
    });
  }
}

// Re-exported for callers that want the type without importing isCoreHidden.
export { isCoreHidden };
