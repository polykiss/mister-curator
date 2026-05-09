import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import type { RomMetadata } from '@shared/metadata-types';
import { IPC_CHANNELS } from '@shared/preload-api';

import { CacheManager } from '@app/main/cache/cache-manager';
import type { CacheEvent } from '@app/main/cache/cache-types';
import { createMisterClient } from '@app/main/clients';
import { ConnectionManager } from '@app/main/ipc/connection-manager';
import { registerIpcHandlers } from '@app/main/ipc/register';
import { HashService } from '@app/main/metadata/hash-service';
import { ImageCache } from '@app/main/metadata/image-cache';
import { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import { lookupScreenScraperSystemId } from '@app/main/metadata/screenscraper-system-map';
import {
  MetadataOrchestrator,
  type SystemIdResolver,
} from '@app/main/metadata/metadata-orchestrator';
import { MetadataService } from '@app/main/metadata/metadata-service';
import { OpenVGDBService } from '@app/main/metadata/openvgdb-service';
import { ScreenScraperService } from '@app/main/metadata/screenscraper-service';
import { ProfileStore } from '@app/main/storage/profile-store';

function resolveClientMode(): 'real' | 'fake' {
  return process.env['MISTERCURATOR_CLIENT_MODE'] === 'fake' ? 'fake' : 'real';
}

// Round 10 (PR #20) — extracted to `screenscraper-system-map.ts` so
// the live coreId→systemeid mappings stay unit-testable. Add entries
// there, not here.
const resolveScreenScraperSystemId: SystemIdResolver = ({ coreId }) =>
  lookupScreenScraperSystemId(coreId);

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

  // PR #15 round 3 + PR #16 round 2 metadata pipeline. All caches
  // live under `<userData>/metadata/` so the user can wipe the lot
  // with one rm.
  //
  // Round 2 added ScreenScraper as the primary source ahead of
  // OpenVGDB + libretro. SS requires `SCREENSCRAPER_DEV_ID` and
  // `SCREENSCRAPER_DEV_PASSWORD`; user creds (`SCREENSCRAPER_SSID` /
  // `SCREENSCRAPER_SSPASSWORD`) are optional and unlock the higher
  // member-tier quota. Without dev creds the service stays
  // unavailable and MetadataService silently falls through to
  // OpenVGDB + libretro (PR #15's existing chain).
  const metadataRoot = path.join(app.getPath('userData'), 'metadata');
  const hashService = new HashService(metadataRoot);
  const openVgdb = new OpenVGDBService(metadataRoot);
  const thumbnails = new LibretroThumbnailsFetcher();
  const screenScraper = new ScreenScraperService({
    devId: process.env['SCREENSCRAPER_DEV_ID'] ?? null,
    devPassword: process.env['SCREENSCRAPER_DEV_PASSWORD'] ?? null,
    ssid: process.env['SCREENSCRAPER_SSID'] ?? null,
    sspassword: process.env['SCREENSCRAPER_SSPASSWORD'] ?? null,
    logger: (msg) => {
      console.warn(msg);
    },
  });
  const metadataService = new MetadataService(
    metadataRoot,
    openVgdb,
    thumbnails,
    screenScraper,
    {
      logger: (msg) => {
        console.warn(msg);
      },
    },
  );
  const imageCache = new ImageCache(path.join(metadataRoot, 'images'));
  const metadataOrchestrator = new MetadataOrchestrator(
    hashService,
    metadataService,
    imageCache,
    openVgdb,
    resolveScreenScraperSystemId,
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

  // Round 3: separate emitter for OpenVGDB download progress. Same
  // fan-out shape as the prefetch one so PR #16's UI can model both
  // the same way.
  type DbEvent =
    | { kind: 'started' }
    | { kind: 'downloading'; bytesReceived: number; bytesTotal: number | null }
    | { kind: 'ready' }
    | { kind: 'error'; message: string };
  const metadataDatabaseListeners = new Set<(event: DbEvent) => void>();
  const emitMetadataDatabaseProgress = (event: DbEvent): void => {
    for (const fn of metadataDatabaseListeners) {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    }
  };

  // PR #20 round 2: per-path resolution events from the list-view
  // streaming prefetch. Same fan-out shape as the other emitters.
  interface RomMetadataResolved {
    operationId: string;
    path: string;
    metadata: RomMetadata | null;
    error: boolean;
  }
  const romMetadataResolvedListeners = new Set<
    (event: RomMetadataResolved) => void
  >();
  const emitRomMetadataResolved = (event: RomMetadataResolved): void => {
    for (const fn of romMetadataResolvedListeners) {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    }
  };

  registerIpcHandlers(
    manager,
    profileStore,
    metadataOrchestrator,
    emitMetadataProgress,
    emitMetadataDatabaseProgress,
    emitRomMetadataResolved,
  );

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
  metadataDatabaseListeners.add((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.metadataDatabaseProgress, event);
    }
  });
  romMetadataResolvedListeners.add((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.romMetadataResolved, event);
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
      metadataDatabaseListeners.add((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(
            IPC_CHANNELS.metadataDatabaseProgress,
            event,
          );
        }
      });
      romMetadataResolvedListeners.add((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(
            IPC_CHANNELS.romMetadataResolved,
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
