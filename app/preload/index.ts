import { contextBridge, ipcRenderer } from 'electron';

import type { ConnectionEvent } from '@shared/connection';
import {
  decodeIpcError,
  IPC_CHANNELS,
  setMisterConnectionErrorFactory,
} from '@shared/preload-api';
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

// Wire up the error reconstructor before any IPC call goes out so
// that `decodeIpcError` can hand back proper `MisterConnectionError`
// instances. The renderer relies on `instanceof` checks (and on
// `error.code`) to render the friendly per-code failure copy.
setMisterConnectionErrorFactory((code, message) => new MisterConnectionError(code, message));

async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    // Electron wraps the original `error.message` with
    // "Error invoking remote method '<channel>': …", so the structured
    // payload main encoded survives at the tail of the message.
    // `decodeIpcError` finds the marker and rebuilds a typed error.
    throw decodeIpcError(err);
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
  listAllCoresWithFiles: (options?: { readonly forceRefresh?: boolean }) =>
    invoke<CoreEntry[]>(IPC_CHANNELS.listAllCoresWithFiles, options),
  listRoms: (
    coreId: string,
    subPath?: string,
    options?: { readonly forceRefresh?: boolean },
  ) => invoke<Rom[]>(IPC_CHANNELS.listRoms, coreId, subPath, options),
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
  listLedgerCoreIds: () =>
    invoke<readonly string[]>(IPC_CHANNELS.listLedgerCoreIds),
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
  clearCache: () => invoke<void>(IPC_CHANNELS.clearCache),
};

contextBridge.exposeInMainWorld('mister', api);
