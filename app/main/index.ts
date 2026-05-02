import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { IPC_CHANNELS } from '@shared/preload-api';

import { createMisterClient } from '@app/main/clients';
import { ConnectionManager } from '@app/main/ipc/connection-manager';
import { registerIpcHandlers } from '@app/main/ipc/register';
import { ProfileStore } from '@app/main/storage/profile-store';

function resolveClientMode(): 'real' | 'fake' {
  return process.env['MISTERCURATOR_CLIENT_MODE'] === 'fake' ? 'fake' : 'real';
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });

  window.on('ready-to-show', () => {
    window.show();
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl !== undefined) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}

void app.whenReady().then(() => {
  const profileStore = new ProfileStore({
    profilesPath: path.join(app.getPath('userData'), 'profiles.json'),
    secretsPath: path.join(app.getPath('userData'), 'secrets.json'),
  });

  const client = createMisterClient(resolveClientMode());
  const manager = new ConnectionManager(client, profileStore);

  registerIpcHandlers(manager, profileStore);

  const window = createWindow();

  manager.onStatusChange((status) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.connectionStatusChanged, status);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const newWindow = createWindow();
      manager.onStatusChange((status) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(IPC_CHANNELS.connectionStatusChanged, status);
        }
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
