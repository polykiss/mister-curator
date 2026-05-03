import { contextBridge, ipcRenderer } from 'electron';

import type { ConnectionEvent } from '@shared/connection';
import { IPC_CHANNELS, isSerializedMisterConnectionError } from '@shared/preload-api';
import type {
  BulkCoreProgressEvent,
  ConnectResult,
  CoreVisibilityChangeWire,
  MisterApi,
  PickedKeyFile,
  RomVisibilityChangeWire,
  SystemFileMarkChangeWire,
} from '@shared/preload-api';
import type {
  BulkCoreResult,
  BulkRomResult,
  MisterSecret,
} from '@shared/mister-client';
import { MisterConnectionError } from '@shared/types';
import type {
  ConnectionStatus,
  CoreEntry,
  FolderClassifications,
  MisterProfile,
  Rom,
  SystemFilesMarks,
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
  listRoms: (coreId: string, subPath?: string) =>
    invoke<Rom[]>(IPC_CHANNELS.listRoms, coreId, subPath),
  setRomVisibility: (
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath?: string,
  ) =>
    invoke<void>(
      IPC_CHANNELS.setRomVisibility,
      coreId,
      filename,
      hidden,
      subPath,
    ),
  setBulkRomVisibility: (
    coreId: string,
    changes: readonly RomVisibilityChangeWire[],
    subPath?: string,
  ) =>
    invoke<BulkRomResult>(
      IPC_CHANNELS.setBulkRomVisibility,
      coreId,
      changes,
      subPath,
    ),
  hideCore: (coreId: string) => invoke<void>(IPC_CHANNELS.hideCore, coreId),
  showCore: (coreId: string) => invoke<void>(IPC_CHANNELS.showCore, coreId),
  setBulkCoreVisibility: (
    changes: readonly CoreVisibilityChangeWire[],
    options?: { readonly operationId?: string },
  ) =>
    invoke<BulkCoreResult>(
      IPC_CHANNELS.setBulkCoreVisibility,
      changes,
      options,
    ),
  onBulkCoreProgress: (handler: (event: BulkCoreProgressEvent) => void) => {
    const listener = (_event: unknown, payload: BulkCoreProgressEvent): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.bulkCoreProgress, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.bulkCoreProgress, listener);
    };
  },
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
  onConnectionEvent: (handler: (event: ConnectionEvent) => void) => {
    const listener = (_event: unknown, payload: ConnectionEvent): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.connectionEvent, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.connectionEvent, listener);
    };
  },
  listSystemFileMarks: () =>
    invoke<SystemFilesMarks>(IPC_CHANNELS.listSystemFileMarks),
  addSystemFileMark: (coreId: string, filename: string) =>
    invoke<SystemFilesMarks>(IPC_CHANNELS.addSystemFileMark, coreId, filename),
  removeSystemFileMark: (coreId: string, filename: string) =>
    invoke<SystemFilesMarks>(
      IPC_CHANNELS.removeSystemFileMark,
      coreId,
      filename,
    ),
  setSystemFileMarks: (
    coreId: string,
    changes: readonly SystemFileMarkChangeWire[],
  ) =>
    invoke<SystemFilesMarks>(IPC_CHANNELS.setSystemFileMarks, coreId, changes),
  listFolderClassifications: () =>
    invoke<FolderClassifications>(IPC_CHANNELS.listFolderClassifications),
  setFolderClassification: (
    coreId: string,
    folderPath: string,
    classification: 'container' | 'atomic' | null,
  ) =>
    invoke<FolderClassifications>(
      IPC_CHANNELS.setFolderClassification,
      coreId,
      folderPath,
      classification,
    ),
};

contextBridge.exposeInMainWorld('mister', api);
