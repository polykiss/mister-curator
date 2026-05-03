import { promises as fs } from 'node:fs';

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { encodeIpcError, IPC_CHANNELS } from '@shared/preload-api';
import type {
  ConnectResult,
  CoreVisibilityChangeWire,
  PickedKeyFile,
  RomVisibilityChangeWire,
  SystemFileMarkChangeWire,
} from '@shared/preload-api';
import type {
  BulkCoreResult,
  BulkRomResult,
  MisterSecret,
} from '@shared/mister-client';
import type {
  FolderClassifications,
  MisterProfile,
  SystemFilesMarks,
} from '@shared/types';

import type { ConnectionManager } from '@app/main/ipc/connection-manager';
import type { ProfileStore } from '@app/main/storage/profile-store';

type IpcHandler<TArgs extends readonly unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult> | TResult;

function handle<TArgs extends readonly unknown[], TResult>(
  channel: string,
  handler: IpcHandler<TArgs, TResult>,
): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    try {
      return await handler(...(args as unknown as TArgs));
    } catch (err) {
      // Re-throw with structured fields encoded in the message so the
      // preload can rebuild a typed `MisterConnectionError` on the
      // other side (Electron strips custom `Error` subclass fields).
      throw encodeIpcError(err);
    }
  });
}

export function registerIpcHandlers(
  manager: ConnectionManager,
  store: ProfileStore,
): void {
  handle<[], MisterProfile[]>(IPC_CHANNELS.listProfiles, () => store.list());

  handle<[MisterProfile, MisterSecret], void>(
    IPC_CHANNELS.saveProfile,
    (profile, secret) => store.upsert(profile, secret),
  );

  handle<[string], void>(IPC_CHANNELS.deleteProfile, (profileId) =>
    store.delete(profileId),
  );

  handle<[string], ConnectResult>(IPC_CHANNELS.connect, (profileId) =>
    manager.connect(profileId),
  );

  handle<[], void>(IPC_CHANNELS.disconnect, () => manager.disconnect());

  handle(IPC_CHANNELS.getConnectionStatus, () => manager.getStatus());

  handle(IPC_CHANNELS.listAllCoresWithFiles, () => manager.listAllCoresWithFiles());

  handle<[string, string | undefined], unknown>(
    IPC_CHANNELS.listRoms,
    (coreId, subPath) => manager.listRoms(coreId, subPath),
  );

  handle<[string, string, boolean, string | undefined], void>(
    IPC_CHANNELS.setRomVisibility,
    (coreId, filename, hidden, subPath) =>
      manager.setRomVisibility(coreId, filename, hidden, subPath),
  );

  handle<
    [string, readonly RomVisibilityChangeWire[], string | undefined],
    BulkRomResult
  >(
    IPC_CHANNELS.setBulkRomVisibility,
    (coreId, changes, subPath) =>
      manager.setBulkRomVisibility(coreId, changes, subPath),
  );

  handle<[string], void>(IPC_CHANNELS.hideCore, (coreId) =>
    manager.hideCore(coreId),
  );

  handle<[string], void>(IPC_CHANNELS.showCore, (coreId) =>
    manager.showCore(coreId),
  );

  handle<
    [readonly CoreVisibilityChangeWire[], { readonly operationId?: string } | undefined],
    BulkCoreResult
  >(
    IPC_CHANNELS.setBulkCoreVisibility,
    (changes, options) => manager.setBulkCoreVisibility(changes, options),
  );

  handle<[], SystemFilesMarks>(IPC_CHANNELS.listSystemFileMarks, () =>
    manager.listSystemFileMarks(),
  );

  handle<[string, string], SystemFilesMarks>(
    IPC_CHANNELS.addSystemFileMark,
    (coreId, filename) => manager.addSystemFileMark(coreId, filename),
  );

  handle<[string, string], SystemFilesMarks>(
    IPC_CHANNELS.removeSystemFileMark,
    (coreId, filename) => manager.removeSystemFileMark(coreId, filename),
  );

  handle<[string, readonly SystemFileMarkChangeWire[]], SystemFilesMarks>(
    IPC_CHANNELS.setSystemFileMarks,
    (coreId, changes) => manager.setSystemFileMarks(coreId, changes),
  );

  handle<[], FolderClassifications>(IPC_CHANNELS.listFolderClassifications, () =>
    manager.listFolderClassifications(),
  );

  handle<
    [string, string, 'container' | 'atomic' | null],
    FolderClassifications
  >(IPC_CHANNELS.setFolderClassification, (coreId, folderPath, classification) =>
    manager.setFolderClassification(
      coreId,
      folderPath,
      classification ?? undefined,
    ),
  );

  ipcMain.handle(
    IPC_CHANNELS.pickKeyFile,
    async (event: IpcMainInvokeEvent): Promise<PickedKeyFile | null> => {
      try {
        const window = BrowserWindow.fromWebContents(event.sender);
        const options = {
          properties: ['openFile' as const],
          title: 'Select an SSH private key',
        };
        const result = window
          ? await dialog.showOpenDialog(window, options)
          : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) {
          return null;
        }
        const filePath = result.filePaths[0];
        if (filePath === undefined) return null;
        const content = await fs.readFile(filePath, 'utf-8');
        return { path: filePath, content };
      } catch (err) {
        throw encodeIpcError(err);
      }
    },
  );
}
