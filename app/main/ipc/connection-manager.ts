import {
  computeAutoReapplyChanges,
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
  BulkCoreResult,
  BulkRomResult,
  CoreVisibilityChange,
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
} from '@shared/mister-client';
import type {
  ConnectionStatus,
  CoreEntry,
  HiddenCoreEntry,
  HideLedger,
  Rom,
} from '@shared/types';

import type { ProfileStore } from '@app/main/storage/profile-store';

type StatusListener = (status: ConnectionStatus) => void;

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
  private coresCache: CoreEntry[] = [];
  /**
   * In-memory copy of the on-MiSTer ledger. Populated by `readLedgerFresh`
   * on connect, and kept in sync with every successful hide/show. The
   * renderer's cores list is enriched against this cache.
   */
  private ledgerCache: HideLedger = EMPTY_LEDGER;

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

  async connect(profileId: string): Promise<ConnectResult> {
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

    try {
      const profile = await this.store.get(profileId);
      if (!profile) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      const secret: MisterSecret = await this.store.getSecret(profileId);
      await this.client.connect(profile, secret);
      this.currentProfileId = profileId;

      // Prime the ledger cache. readHideLedger self-heals as a side
      // effect — drops stale `_hidden` etc. entries and rewrites.
      this.ledgerCache = await this.client.readHideLedger();

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
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.disconnect();
    } finally {
      this.currentProfileId = null;
      this.coresCache = [];
      this.ledgerCache = EMPTY_LEDGER;
      this.setStatus('disconnected');
    }
  }

  async listAllCoresWithFiles(): Promise<CoreEntry[]> {
    this.assertConnected();
    const raw = await this.client.listAllCoresWithFiles();
    const enriched = raw.map((c) => ({
      ...c,
      managedByApp: this.ledgerHasCore(c.id),
    }));
    this.coresCache = enriched;
    return enriched;
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    return this.client.listRoms(coreId);
  }

  async setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
  ): Promise<void> {
    this.assertConnected();
    await this.client.setRomVisibility(coreId, filename, hidden);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<BulkRomResult> {
    this.assertConnected();
    return this.client.setBulkRomVisibility(coreId, changes);
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
        // accidentally clicking "Show all hidden".
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

    const result = await this.client.setBulkCoreVisibility(resolved);
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

    const cores = await this.client.listAllCoresWithFiles();
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
    const refreshed = await this.client.listAllCoresWithFiles();
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
}

// Re-exported for callers that want the type without importing isCoreHidden.
export { isCoreHidden };
