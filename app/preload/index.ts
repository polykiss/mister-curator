import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, isSerializedMisterConnectionError } from '@shared/preload-api';
import type {
  ConnectResult,
  CoreVisibilityChangeWire,
  MisterApi,
  PickedKeyFile,
  RomVisibilityChangeWire,
} from '@shared/preload-api';
import type { MisterSecret } from '@shared/mister-client';
import { MisterConnectionError } from '@shared/types';
import type {
  ConnectionStatus,
  CoreEntry,
  MisterProfile,
  Rom,
} from '@shared/types';

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    if (isSerializedMisterConnectionError(err)) {
      throw new MisterConnectionError(err.code, err.message);
    }
    throw err;
  }
}

const api: MisterApi = {
  listProfiles: () => invoke<MisterProfile[]>(IPC_CHANNELS.listProfiles),
  saveProfile: (profile: MisterProfile, secret: MisterSecret) =>
    invoke<void>(IPC_CHANNELS.saveProfile, profile, secret),
  deleteProfile: (profileId: string) => invoke<void>(IPC_CHANNELS.deleteProfile, profileId),
  connect: (profileId: string) =>
    invoke<ConnectResult>(IPC_CHANNELS.connect, profileId),
  disconnect: () => invoke<void>(IPC_CHANNELS.disconnect),
  getConnectionStatus: () => invoke<ConnectionStatus>(IPC_CHANNELS.getConnectionStatus),
  listAllCoresWithFiles: () =>
    invoke<CoreEntry[]>(IPC_CHANNELS.listAllCoresWithFiles),
  listRoms: (coreId: string) => invoke<Rom[]>(IPC_CHANNELS.listRoms, coreId),
  setRomVisibility: (coreId: string, filename: string, hidden: boolean) =>
    invoke<void>(IPC_CHANNELS.setRomVisibility, coreId, filename, hidden),
  setBulkRomVisibility: (
    coreId: string,
    changes: readonly RomVisibilityChangeWire[],
  ) => invoke<void>(IPC_CHANNELS.setBulkRomVisibility, coreId, changes),
  hideCore: (coreId: string) => invoke<void>(IPC_CHANNELS.hideCore, coreId),
  showCore: (coreId: string) => invoke<void>(IPC_CHANNELS.showCore, coreId),
  setBulkCoreVisibility: (changes: readonly CoreVisibilityChangeWire[]) =>
    invoke<void>(IPC_CHANNELS.setBulkCoreVisibility, changes),
  pickKeyFile: () => invoke<PickedKeyFile | null>(IPC_CHANNELS.pickKeyFile),
  onConnectionStatusChanged: (handler: (status: ConnectionStatus) => void) => {
    const listener = (_event: unknown, status: ConnectionStatus): void => {
      handler(status);
    };
    ipcRenderer.on(IPC_CHANNELS.connectionStatusChanged, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.connectionStatusChanged, listener);
    };
  },
};

contextBridge.exposeInMainWorld('mister', api);
