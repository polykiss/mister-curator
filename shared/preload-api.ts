import type {
  BulkCoreResult,
  BulkRomResult,
  MisterSecret,
} from '@shared/mister-client';
import type {
  ConnectionErrorCode,
  ConnectionStatus,
  CoreEntry,
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
  pickKeyFile: 'mister:pickKeyFile',
  connectionStatusChanged: 'mister:connectionStatusChanged',
  listSystemFileMarks: 'mister:listSystemFileMarks',
  addSystemFileMark: 'mister:addSystemFileMark',
  removeSystemFileMark: 'mister:removeSystemFileMark',
} as const;

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
 * ledger, only to its consequences (this field, and `gamesDirHidden` /
 * `rbfPaths` on each `CoreEntry`). The ConnectionManager owns the ledger.
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
  listAllCoresWithFiles(): Promise<CoreEntry[]>;
  listRoms(coreId: string): Promise<Rom[]>;
  setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void>;
  /**
   * Bulk ROM visibility — does NOT abort on first failure. Returns a
   * structured per-rename result so the renderer can surface partial
   * success ("Hid 45 ROMs. 2 failed: …").
   */
  setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChangeWire[],
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
  ): Promise<BulkCoreResult>;
  pickKeyFile(): Promise<PickedKeyFile | null>;
  onConnectionStatusChanged(handler: (status: ConnectionStatus) => void): () => void;
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
}

const VALID_CONNECTION_ERROR_CODES: ReadonlySet<ConnectionErrorCode> = new Set([
  'unreachable',
  'auth_failed',
  'not_a_mister',
  'unknown',
]);

/**
 * Recognises the wire shape of a serialized MisterConnectionError that has
 * crossed the IPC boundary. Used by the preload bridge to rebuild a proper
 * MisterConnectionError instance so renderer code can `instanceof`-check it.
 */
export function isSerializedMisterConnectionError(
  err: unknown,
): err is { name: 'MisterConnectionError'; code: ConnectionErrorCode; message: string } {
  if (err === null || typeof err !== 'object') return false;
  const candidate = err as Record<string, unknown>;
  if (candidate.name !== 'MisterConnectionError') return false;
  if (typeof candidate.message !== 'string') return false;
  if (typeof candidate.code !== 'string') return false;
  return VALID_CONNECTION_ERROR_CODES.has(candidate.code as ConnectionErrorCode);
}
