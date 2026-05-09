import { contextBridge, ipcRenderer } from 'electron';

import type { ConnectionEvent } from '@shared/connection';
import {
  decodeIpcError,
  IPC_CHANNELS,
  setMisterConnectionErrorFactory,
} from '@shared/preload-api';
import type {
  AutoScrapeProgressEvent,
  BulkCoreProgressEvent,
  ConnectResult,
  CoreVisibilityChangeWire,
  MetadataDatabaseProgressEvent,
  MetadataDatabaseState,
  MetadataPrefetchEvent,
  MisterApi,
  PickedKeyFile,
  RomMetadataResolvedEvent,
  RomVisibilityChangeWire,
  SystemFileMarkChangeWire,
} from '@shared/preload-api';
import type {
  MetadataHint,
  RomMetadata,
} from '@shared/metadata-types';
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
  // ─── PR #15: metadata pipeline ──────────────────────────────────
  getRomMetadata: (
    coreId: string,
    romPath: string,
    hint?: MetadataHint,
  ) =>
    invoke<RomMetadata | null>(
      IPC_CHANNELS.getRomMetadata,
      coreId,
      romPath,
      hint,
    ),
  prefetchHashes: (
    allPaths: readonly string[],
    options?: { readonly operationId?: string },
  ) => invoke<void>(IPC_CHANNELS.prefetchHashes, allPaths, options),
  prefetchMetadata: (
    hashes: readonly string[],
    options?: { readonly operationId?: string },
  ) => invoke<void>(IPC_CHANNELS.prefetchMetadata, hashes, options),
  clearMetadataCache: () => invoke<void>(IPC_CHANNELS.clearMetadataCache),
  getBoxArtLocal: (url: string) =>
    invoke<string | null>(IPC_CHANNELS.getBoxArtLocal, url),
  getBoxArtBytes: (url: string) =>
    invoke<Uint8Array | null>(IPC_CHANNELS.getBoxArtBytes, url),
  onMetadataPrefetchProgress: (
    handler: (event: MetadataPrefetchEvent) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: MetadataPrefetchEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.metadataPrefetchProgress, listener);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.metadataPrefetchProgress,
        listener,
      );
    };
  },
  ensureMetadataDatabase: () =>
    invoke<MetadataDatabaseState>(IPC_CHANNELS.ensureMetadataDatabase),
  onMetadataDatabaseProgress: (
    handler: (event: MetadataDatabaseProgressEvent) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: MetadataDatabaseProgressEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.metadataDatabaseProgress, listener);
    return () => {
      ipcRenderer.removeListener(
        IPC_CHANNELS.metadataDatabaseProgress,
        listener,
      );
    };
  },
  prefetchRomsMetadata: (
    coreId: string,
    paths: readonly string[],
    options?: { readonly operationId?: string },
  ) =>
    invoke<void>(
      IPC_CHANNELS.prefetchRomsMetadata,
      coreId,
      paths,
      options,
    ),
  onRomMetadataResolved: (
    handler: (event: RomMetadataResolvedEvent) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: RomMetadataResolvedEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.romMetadataResolved, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.romMetadataResolved, listener);
    };
  },
  onAutoScrapeProgress: (
    handler: (event: AutoScrapeProgressEvent) => void,
  ) => {
    const listener = (
      _event: unknown,
      payload: AutoScrapeProgressEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(IPC_CHANNELS.autoScrapeProgress, listener);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.autoScrapeProgress, listener);
    };
  },
  setAutoScrapeFocus: (coreId: string) =>
    invoke<void>(IPC_CHANNELS.setAutoScrapeFocus, coreId),
};

contextBridge.exposeInMainWorld('mister', api);
