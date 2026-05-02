import type { MisterSecret } from '@shared/mister-client';
import type {
  ConnectionErrorCode,
  ConnectionStatus,
  Core,
  MisterProfile,
  Rom,
} from '@shared/types';

export const IPC_CHANNELS = {
  listProfiles: 'mister:listProfiles',
  saveProfile: 'mister:saveProfile',
  deleteProfile: 'mister:deleteProfile',
  connect: 'mister:connect',
  disconnect: 'mister:disconnect',
  getConnectionStatus: 'mister:getConnectionStatus',
  listCores: 'mister:listCores',
  listRoms: 'mister:listRoms',
  setRomVisibility: 'mister:setRomVisibility',
  setBulkRomVisibility: 'mister:setBulkRomVisibility',
  pickKeyFile: 'mister:pickKeyFile',
  connectionStatusChanged: 'mister:connectionStatusChanged',
} as const;

export interface RomVisibilityChangeWire {
  readonly filename: string;
  readonly hidden: boolean;
}

export interface PickedKeyFile {
  readonly path: string;
  readonly content: string;
}

export interface MisterApi {
  listProfiles(): Promise<MisterProfile[]>;
  saveProfile(profile: MisterProfile, secret: MisterSecret): Promise<void>;
  deleteProfile(profileId: string): Promise<void>;
  connect(profileId: string): Promise<void>;
  disconnect(): Promise<void>;
  getConnectionStatus(): Promise<ConnectionStatus>;
  listCores(): Promise<Core[]>;
  listRoms(coreId: string): Promise<Rom[]>;
  setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void>;
  setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChangeWire[],
  ): Promise<void>;
  pickKeyFile(): Promise<PickedKeyFile | null>;
  onConnectionStatusChanged(handler: (status: ConnectionStatus) => void): () => void;
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
