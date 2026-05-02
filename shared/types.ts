export interface MisterProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: 'key' | 'password';
  readonly keyPath?: string;
  /**
   * When true, on each successful connect the app reads the on-MiSTer hide
   * ledger and re-applies any cores that have been un-hidden externally
   * (typically by a MiSTer update that re-deployed the .rbf or games dir).
   *
   * Treated as `false` when undefined — older profiles persisted before
   * this field existed remain opt-out without a migration step.
   */
  readonly autoReapplyHides?: boolean;
}

export type CoreCategory = 'Console' | 'Computer' | 'Other' | 'Utility' | 'Arcade' | 'Unknown';

/**
 * Everything the renderer needs to know about a core. Replaces the older
 * games-dir-only `Core` type — `CoreEntry` now also covers cores that have
 * a .rbf but no games directory, folder-shaped cores under `_Computer/`,
 * arcade cores (read-only), and the orphan-games-dir edge case
 * (`category: 'Unknown'`).
 *
 * Counts (`romCount`, `hiddenCount`) are zero when `gamesDirExists` is
 * false. `rbfPaths` lists every matching .rbf file or folder-shaped core
 * directory under `_Console/_Computer/_Other/_Utility/_Arcade/`; multiple
 * versions of the same core map to multiple entries in this list.
 */
export interface CoreEntry {
  readonly id: string;
  readonly name: string;
  readonly romCount: number;
  readonly hiddenCount: number;
  readonly category: CoreCategory;
  readonly rbfPaths: readonly string[];
  readonly gamesDirExists: boolean;
  readonly gamesDirHidden: boolean;
}

export interface Rom {
  readonly coreId: string;
  readonly filename: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  readonly hidden: boolean;
  readonly path: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ConnectionErrorCode = 'unreachable' | 'auth_failed' | 'not_a_mister' | 'unknown';

export interface ConnectionError {
  readonly code: ConnectionErrorCode;
  readonly message: string;
}

export class MisterConnectionError extends Error implements ConnectionError {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = 'MisterConnectionError';
    this.code = code;
  }
}

/**
 * One entry in the on-MiSTer hide ledger.
 *
 * `rbfPaths` snapshots the .rbf files / folder-shaped core directories that
 * were hidden alongside the games dir. We re-record them rather than
 * recompute on auto-reapply so a core that picked up a fresh .rbf after a
 * MiSTer update is still re-hidden using the *current* matching rbfs at
 * apply time, not stale ones from when it was first hidden.
 */
export interface HiddenCoreEntry {
  readonly coreId: string;
  readonly gamesDirHidden: boolean;
  readonly rbfPaths: readonly string[];
  readonly hiddenAt: string;
}

export interface HideLedger {
  readonly schemaVersion: 1;
  readonly hiddenCores: readonly HiddenCoreEntry[];
}
