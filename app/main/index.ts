import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { IPC_CHANNELS } from '@shared/preload-api';

import { CacheManager } from '@app/main/cache/cache-manager';
import type { CacheEvent } from '@app/main/cache/cache-types';
import { createMisterClient } from '@app/main/clients';
import { ConnectionManager } from '@app/main/ipc/connection-manager';
import { registerIpcHandlers } from '@app/main/ipc/register';
import { ScreenScraperClient } from '@app/main/metadata/clients/screenscraper-client';
import { TheGamesDBClient } from '@app/main/metadata/clients/thegamesdb-client';
import { HashService } from '@app/main/metadata/hash-service';
import { ImageCache } from '@app/main/metadata/image-cache';
import { MetadataOrchestrator } from '@app/main/metadata/metadata-orchestrator';
import { MetadataService } from '@app/main/metadata/metadata-service';
import { ProfileStore } from '@app/main/storage/profile-store';

function resolveClientMode(): 'real' | 'fake' {
  return process.env['MISTERCURATOR_CLIENT_MODE'] === 'fake' ? 'fake' : 'real';
}

/**
 * Build the dev-time cache event logger. Off by default; enable with
 * `MISTERCURATOR_CACHE_LOG=1` to confirm hit/miss/stale behavior
 * during development. The renderer never sees these — they're a
 * main-process diagnostic only.
 */
function cacheEventLogger(): ((event: CacheEvent) => void) | undefined {
  if (process.env['MISTERCURATOR_CACHE_LOG'] !== '1') return undefined;
  return (event: CacheEvent): void => {
    const tag = `cache.${event.kind}`;
    const ctx: string[] = [`surface=${event.surface}`, `host=${event.host}`];
    if (event.coreId !== undefined) ctx.push(`coreId=${event.coreId}`);
    if (event.subPath !== undefined) ctx.push(`subPath="${event.subPath}"`);
    if (event.evictedCoreId !== undefined) ctx.push(`evicted=${event.evictedCoreId}`);
    if (event.note !== undefined) ctx.push(`note="${event.note}"`);
    process.stderr.write(`${tag} ${ctx.join(' ')}\n`);
  };
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
  // PR #12 cache. Lives at <userData>/cache/<host>/. Documented in
  // AGENTS.md so users / support can locate it for diagnostic
  // deletion. The optional logger is gated on
  // MISTERCURATOR_CACHE_LOG=1 so dev runs can confirm hit/miss
  // behavior without flooding production stderr.
  const cache = new CacheManager(path.join(app.getPath('userData'), 'cache'), {
    onEvent: cacheEventLogger(),
  });
  const manager = new ConnectionManager(client, profileStore, cache);

  // PR #15 metadata pipeline. The four services live under a single
  // `<userData>/metadata/` root so the user can blow it all away in
  // one rm. ScreenScraper runs anonymous-tier; TheGamesDB only fires
  // when METADATA_THEGAMESDB_KEY is set in the environment. Either
  // can be hard-disabled via METADATA_DISABLE_* flags.
  const metadataRoot = path.join(app.getPath('userData'), 'metadata');
  const hashService = new HashService(metadataRoot);
  const screenScraper = new ScreenScraperClient({
    disabled: process.env['METADATA_DISABLE_SCREENSCRAPER'] === '1',
  });
  const theGamesDb = new TheGamesDBClient({
    apiKey: process.env['METADATA_THEGAMESDB_KEY'] ?? null,
    disabled: process.env['METADATA_DISABLE_THEGAMESDB'] === '1',
  });
  const metadataService = new MetadataService(
    metadataRoot,
    screenScraper,
    theGamesDb,
  );
  const imageCache = new ImageCache(path.join(metadataRoot, 'images'));
  const metadataOrchestrator = new MetadataOrchestrator(
    hashService,
    metadataService,
    imageCache,
    () => manager.getActiveSession(),
  );

  // Aggregator for metadata-prefetch progress. The IPC handler calls
  // this; we forward to every live BrowserWindow via webContents.send.
  // (Same shape as `bulkCoreProgress` and `connectionStatusChanged`.)
  const metadataPrefetchListeners = new Set<
    (event: {
      operationId: string;
      kind: 'hash' | 'metadata';
      done: number;
      total: number;
      currentPath?: string;
    }) => void
  >();
  const emitMetadataProgress = (event: {
    operationId: string;
    kind: 'hash' | 'metadata';
    done: number;
    total: number;
    currentPath?: string;
  }): void => {
    for (const fn of metadataPrefetchListeners) {
      try {
        fn(event);
      } catch {
        /* never let a window-listener error break a prefetch */
      }
    }
  };

  registerIpcHandlers(manager, profileStore, metadataOrchestrator, emitMetadataProgress);

  const window = createWindow();

  manager.onStatusChange((status) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.connectionStatusChanged, status);
    }
  });
  manager.onBulkProgress((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.bulkCoreProgress, event);
    }
  });
  manager.onConnectionEvent((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.connectionEvent, event);
    }
  });
  metadataPrefetchListeners.add((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.metadataPrefetchProgress, event);
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
      manager.onBulkProgress((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(IPC_CHANNELS.bulkCoreProgress, event);
        }
      });
      manager.onConnectionEvent((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(IPC_CHANNELS.connectionEvent, event);
        }
      });
      metadataPrefetchListeners.add((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(
            IPC_CHANNELS.metadataPrefetchProgress,
            event,
          );
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
