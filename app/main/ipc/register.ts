import { promises as fs } from 'node:fs';

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { IPC_CHANNELS } from '@shared/preload-api';
import type {
  ConnectResult,
  CoreVisibilityChangeWire,
  PickedKeyFile,
  RomVisibilityChangeWire,
} from '@shared/preload-api';
import type { MisterSecret } from '@shared/mister-client';
import type { MisterProfile } from '@shared/types';

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
    return handler(...(args as unknown as TArgs));
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

  handle<[string], unknown>(IPC_CHANNELS.listRoms, (coreId) =>
    manager.listRoms(coreId),
  );

  handle<[string, string, boolean], void>(
    IPC_CHANNELS.setRomVisibility,
    (coreId, filename, hidden) =>
      manager.setRomVisibility(coreId, filename, hidden),
  );

  handle<[string, readonly RomVisibilityChangeWire[]], void>(
    IPC_CHANNELS.setBulkRomVisibility,
    (coreId, changes) => manager.setBulkRomVisibility(coreId, changes),
  );

  handle<[string], void>(IPC_CHANNELS.hideCore, (coreId) =>
    manager.hideCore(coreId),
  );

  handle<[string], void>(IPC_CHANNELS.showCore, (coreId) =>
    manager.showCore(coreId),
  );

  handle<[readonly CoreVisibilityChangeWire[]], void>(
    IPC_CHANNELS.setBulkCoreVisibility,
    (changes) => manager.setBulkCoreVisibility(changes),
  );

  ipcMain.handle(
    IPC_CHANNELS.pickKeyFile,
    async (event: IpcMainInvokeEvent): Promise<PickedKeyFile | null> => {
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
    },
  );
}
