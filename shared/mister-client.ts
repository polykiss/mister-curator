import type { CoreEntry, HideLedger, MisterProfile, Rom } from '@shared/types';

export type MisterSecret =
  | { readonly type: 'key'; readonly privateKey: string }
  | { readonly type: 'password'; readonly password: string };

export interface RomVisibilityChange {
  readonly filename: string;
  readonly hidden: boolean;
}

/**
 * A single core-visibility change in a batched operation. The full
 * CoreEntry is passed (not just an id) so the implementation can
 * short-circuit no-ops without a lookup round-trip.
 */
export interface CoreVisibilityChange {
  readonly core: CoreEntry;
  readonly hidden: boolean;
}

/**
 * Per-rom result of a batched ROM visibility operation. Bulk ROM
 * operations do NOT abort on first failure: each rename runs
 * independently, and a partial failure produces a partial result rather
 * than throwing. The caller surfaces whichever toast variant matches.
 */
export interface BulkRomResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly filename: string; readonly reason: string }[];
}

/**
 * Per-core result of a batched core-visibility operation. A core is
 * considered "succeeded" only if every rename it owned (games dir +
 * each matching .rbf / .mgl) committed. Any rename failure within a
 * core marks that core as failed (and leaves the ledger entry for it
 * untouched in ConnectionManager).
 */
export interface BulkCoreResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly coreId: string; readonly reason: string }[];
}

export interface IMisterClient {
  connect(profile: MisterProfile, secret: MisterSecret): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /**
   * Lists every core the device knows about — joined across `_Console`,
   * `_Computer`, `_Other`, `_Utility`, `_Arcade` and `games/`. Replaces
   * the older `listCores()` which only saw `games/` subdirectories.
   */
  listAllCoresWithFiles(): Promise<CoreEntry[]>;

  listRoms(coreId: string): Promise<Rom[]>;

  setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void>;

  /**
   * Apply many ROM visibility changes in a single batched SSH call.
   * Per-rename results are aggregated and returned — a single failed
   * `mv` does NOT abort the batch (defensive against races, perms,
   * etc). The caller decides how to react.
   */
  setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<BulkRomResult>;

  /**
   * Hide a single core: rename its games dir AND every matching rbf
   * (file or folder) to dot-prefixed form, atomically in one SSH call.
   * No-op (zero SSH calls) when the core is already fully hidden.
   * Refuses to operate on arcade cores.
   */
  hideCore(core: CoreEntry): Promise<void>;
  showCore(core: CoreEntry): Promise<void>;

  /**
   * Apply many core-visibility changes in a single batched SSH call.
   * Each core's renames run inside a `set -e` subshell so the core
   * itself is atomic, but a failure in one core does NOT abort the
   * other cores in the batch. Per-core results are returned.
   *
   * No-op changes (already in desired state) are skipped silently. If
   * every change is a no-op, zero SSH calls are issued and the result
   * is `{ succeeded: [], failed: [] }`.
   */
  setBulkCoreVisibility(
    changes: readonly CoreVisibilityChange[],
  ): Promise<BulkCoreResult>;

  /**
   * Read and parse the on-MiSTer hide ledger
   * (`/media/fat/.mistercurator/state.json`). Returns the empty ledger
   * if the file is missing or empty.
   */
  readHideLedger(): Promise<HideLedger>;

  /**
   * Atomically (re)write the ledger via a temp file + rename.
   */
  writeHideLedger(ledger: HideLedger): Promise<void>;
}
