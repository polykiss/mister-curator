import {
  computeAutoReapplyChanges,
  isCoreHidden,
  isRealCore,
} from '@shared/core-matching';
import { withCoreHidden, withCoreShown } from '@shared/ledger';
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
 * The manager also owns the on-MiSTer hide ledger I/O — the IPC bridge
 * intentionally does not expose ledger reads/writes to the renderer, so
 * the ledger is only ever touched here.
 *
 * Bulk operations forward partial-success results from the client up to
 * the IPC layer, but the manager filters non-real cores out of the input
 * up front (defense-in-depth: the renderer's cores list also filters
 * via isRealCore, but this layer enforces the same guarantee).
 */
export class ConnectionManager {
  private status: ConnectionStatus = 'disconnected';
  private currentProfileId: string | null = null;
  private readonly listeners = new Set<StatusListener>();
  private coresCache: CoreEntry[] = [];

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

    try {
      const profile = await this.store.get(profileId);
      if (!profile) {
        throw new Error(`Profile not found: ${profileId}`);
      }
      const secret: MisterSecret = await this.store.getSecret(profileId);
      await this.client.connect(profile, secret);
      this.currentProfileId = profileId;

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
      this.setStatus('disconnected');
    }
  }

  async listAllCoresWithFiles(): Promise<CoreEntry[]> {
    this.assertConnected();
    const cores = await this.client.listAllCoresWithFiles();
    this.coresCache = [...cores];
    return cores;
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
      throw new Error(
        `Refusing to hide '${coreId}': not a real core.`,
      );
    }
    await this.client.hideCore(core);
    await this.recordHide(core);
  }

  async showCore(coreId: string): Promise<void> {
    this.assertConnected();
    const core = await this.lookupCore(coreId);
    if (!isRealCore(core)) {
      throw new Error(
        `Refusing to show '${coreId}': not a real core.`,
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

    // Resolve coreIds to CoreEntries and filter out anything that isn't a
    // real core. Non-real entries (user folders, arcade placeholder) are
    // reported as failed in the result rather than aborting the batch.
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
      resolved.push({ core, hidden: c.hidden });
    }

    if (resolved.length === 0) {
      return { succeeded: [], failed: upfrontFailed };
    }

    const result = await this.client.setBulkCoreVisibility(resolved);
    const failed = [...upfrontFailed, ...result.failed];

    // Ledger update: only for cores whose renames fully succeeded. A
    // partial failure within a core is impossible because the client
    // wraps each core's renames in `set -e`, so per-core success is
    // all-or-nothing.
    const succeededIds = new Set(result.succeeded);
    let ledger: HideLedger = await this.client.readHideLedger();
    for (const c of resolved) {
      if (!succeededIds.has(c.core.id)) continue;
      ledger = c.hidden
        ? withCoreHidden(ledger, this.toHiddenEntry(c.core))
        : withCoreShown(ledger, c.core.id);
    }
    await this.client.writeHideLedger(ledger);

    return { succeeded: result.succeeded, failed };
  }

  private async runAutoReapply(): Promise<number> {
    const ledger = await this.client.readHideLedger();
    if (ledger.hiddenCores.length === 0) return 0;

    const cores = await this.client.listAllCoresWithFiles();
    this.coresCache = [...cores];

    const changes = computeAutoReapplyChanges(ledger, cores);
    if (changes.length === 0) return 0;

    const coresById = new Map(cores.map((c) => [c.id, c]));
    const resolved: CoreVisibilityChange[] = [];
    for (const c of changes) {
      const core = coresById.get(c.coreId);
      if (!core) continue;
      // computeAutoReapplyChanges already filters arcade and missing,
      // but defense-in-depth: skip anything that isn't a real core.
      if (!isRealCore(core)) continue;
      resolved.push({ core, hidden: c.hidden });
    }
    if (resolved.length === 0) return 0;

    const result = await this.client.setBulkCoreVisibility(resolved);

    // Refresh the cache so subsequent hideCore lookups see the new state.
    const refreshed = await this.client.listAllCoresWithFiles();
    this.coresCache = [...refreshed];

    return result.succeeded.length;
  }

  private async recordHide(core: CoreEntry): Promise<void> {
    const ledger = await this.client.readHideLedger();
    const next = withCoreHidden(ledger, this.toHiddenEntry(core));
    await this.client.writeHideLedger(next);
  }

  private async recordShow(core: CoreEntry): Promise<void> {
    const ledger = await this.client.readHideLedger();
    const next = withCoreShown(ledger, core.id);
    await this.client.writeHideLedger(next);
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
      rbfPaths: canonicalRbfs,
      hiddenAt: new Date().toISOString(),
    };
  }

  private async lookupCore(coreId: string): Promise<CoreEntry> {
    const cached = this.coresCache.find((c) => c.id === coreId);
    if (cached) return cached;

    // Cache miss — refresh and retry once.
    const cores = await this.client.listAllCoresWithFiles();
    this.coresCache = [...cores];
    const fresh = cores.find((c) => c.id === coreId);
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
}

// Re-exported for callers that want the type without importing isCoreHidden.
export { isCoreHidden };
