import path from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import type { RomMetadata } from '@shared/metadata-types';
import { IPC_CHANNELS } from '@shared/preload-api';
import type { UpdateModeProgressEvent } from '@shared/preload-api';

import { CacheManager } from '@app/main/cache/cache-manager';
import type { CacheEvent } from '@app/main/cache/cache-types';
import {
  MISTER_CACHE_DIR_NAME,
  migrateOldCacheDirIfNeeded,
} from '@app/main/cache/userdata-paths';
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
import {
  MetadataService,
  normalizeFolderAtomicHashKeys,
  pruneEmptyHashEntriesFromHashesJson,
  removePoisonedEmptyHashRecord,
} from '@app/main/metadata/metadata-service';
import { OpenVGDBService } from '@app/main/metadata/openvgdb-service';
import { ScreenScraperService } from '@app/main/metadata/screenscraper-service';
import { SystemCatalogService } from '@app/main/metadata/system-catalog-service';
import { AutoScrapeEngine } from '@app/main/services/auto-scrape-engine';
import { groupByPrimaryZipBasename } from '@app/main/services/arcade-prefetch-paths';
import { ARCADE_VIRTUAL_CORE_ID } from '@shared/arcade-mra';
import { MISTER_ARCADE_ZIP_DIRS } from '@shared/constants';
import { ScrapeStateStore } from '@app/main/services/scrape-state';
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

void app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData');
  const profileStore = new ProfileStore({
    profilesPath: path.join(userDataDir, 'profiles.json'),
    secretsPath: path.join(userDataDir, 'secrets.json'),
  });

  // feat/cache-path-rename — one-shot migration off the
  // case-insensitive-APFS-colliding `<userData>/cache/` (which
  // Chromium silently wiped between sessions; see PR #59). Idempotent
  // and cheap on no-op; runs synchronously before CacheManager so
  // any prior-session subdirs land at the new path before the cache
  // touches anything.
  try {
    const result = await migrateOldCacheDirIfNeeded(userDataDir);
    if (result.moved.length > 0 || result.skippedDestinationExists.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[cache] migration: moved=${String(result.moved.length)} skipped=${String(result.skippedDestinationExists.length)}`,
      );
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cache] migration: unexpected error', err);
  }

  const client = createMisterClient(resolveClientMode());
  // PR #12 cache. Lives at <userData>/mister-cache/<host>/. The
  // directory name avoids the `<userData>/cache/` ↔ `<userData>/Cache/`
  // collision with Chromium's HTTP cache on case-insensitive
  // filesystems. Documented in AGENTS.md so users / support can
  // locate it for diagnostic deletion. The optional logger is gated
  // on MISTERCURATOR_CACHE_LOG=1 so dev runs can confirm hit/miss
  // behavior without flooding production stderr.
  const cache = new CacheManager(path.join(userDataDir, MISTER_CACHE_DIR_NAME), {
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

  // fix/zero-byte-hash-guard — one-shot cleanup for the poisoned
  // empty-hash by-hash record written by pre-fix app versions.
  // Idempotent: no-op when the file is already absent.
  try {
    await removePoisonedEmptyHashRecord(metadataRoot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cache-migration] failed to remove poisoned empty-hash record:', err);
  }

  // fix/zero-byte-hash-guard follow-up — prune stale hashes.json
  // entries whose md5 equals the empty-content hash. These are
  // harmless post-fix (FIX B short-circuits the SS lookup) but are
  // bookkeeping debt. Scans all per-host dirs under metadataRoot;
  // each affected hashes.json is atomically rewritten with those
  // entries removed.
  try {
    await pruneEmptyHashEntriesFromHashesJson(metadataRoot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cache-migration] failed to prune empty-hash entries:', err);
  }

  // fix/folder-atomic-rom-path-stability — normalize hashes.json keys
  // whose parent directory segment is dot-prefixed (hidden folder-atomic
  // ROMs written by pre-fix app versions). One atomic rewrite per
  // affected host; idempotent on subsequent launches.
  try {
    await normalizeFolderAtomicHashKeys(metadataRoot);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[cache-migration] failed to normalize folder-atomic hash keys:', err);
  }

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

  // feat/system-catalog-data-layer (#30 PR-1) — dedicated SS instance
  // for catalog fetches so catalog calls never queue-starve ROM scraping.
  const screenScraperForCatalog = new ScreenScraperService({
    devId: process.env['SCREENSCRAPER_DEV_ID'] ?? null,
    devPassword: process.env['SCREENSCRAPER_DEV_PASSWORD'] ?? null,
    ssid: process.env['SCREENSCRAPER_SSID'] ?? null,
    sspassword: process.env['SCREENSCRAPER_SSPASSWORD'] ?? null,
    logger: (msg) => { console.warn(msg); },
  });
  const systemLogoCache = new ImageCache(path.join(metadataRoot, 'system-logos'));
  const systemCatalog = new SystemCatalogService(
    screenScraperForCatalog,
    systemLogoCache,
    path.join(metadataRoot, 'system-catalog.json'),
  );

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

  // feat/update-mode: streaming progress from applyUpdateMode /
  // restoreFromSnapshot. Same fan-out shape as the other emitters.
  const updateModeProgressListeners = new Set<
    (event: UpdateModeProgressEvent) => void
  >();
  const emitUpdateModeProgress = (event: UpdateModeProgressEvent): void => {
    for (const fn of updateModeProgressListeners) {
      try {
        fn(event);
      } catch {
        /* swallow */
      }
    }
  };

  // PR-C (PR #26) — auto-scrape engine. Walks every core's metadata
  // in the background on connect, sidebar order. Pause/resume tied
  // to connection lifecycle (see manager.onStatusChange below).
  // Deps:
  //   • listRomPaths → ConnectionManager.listRoms (top-level files
  //     only; folder-atomic scraping is a separate scope per the
  //     PR-C "Out of scope" list).
  //   • scrape → MetadataOrchestrator.getRomsMetadata, threading
  //     the engine's shouldAbort callback so setFocus pivots land
  //     within one path's wall time.
  // feat/auto-scrape-persistence — per-host store of "lastScrapedAt"
  // timestamps. Lives at <userData>/scrape-state/<host>/scrape-state.json.
  // Read on connect to seed the engine's in-session completed set so
  // recently-scraped cores skip immediately; written per-core
  // completion via the engine's onCompletion subscription below.
  const scrapeStateStore = new ScrapeStateStore(
    path.join(app.getPath('userData'), 'scrape-state'),
  );
  /**
   * Cores scraped within this window persist as "done" across
   * reconnects. One hour matches the spec; tuneable here without
   * touching the store. Outside the window the persisted state is
   * ignored and the core re-walks (the metadata cache still
   * provides the warm fast-path; only the SSH walk + per-path
   * orchestrator iteration get re-run, which is cheap on a warm
   * cache).
   */
  const SCRAPE_FRESHNESS_WINDOW_MS = 60 * 60 * 1000;

  const autoScrapeEngine = new AutoScrapeEngine({
    // PR-C round 2: recursive ROM-file path list, filtered by the
    // sidebar-count predicate (shouldCountAsRom +
    // isLaunchableRomExtension). Round 1 used `manager.listRoms`
    // which returned only top-level entries — a GBA core with 145
    // ROMs (most in nested folders) showed as "GBA · 39/62" in the
    // footer. The new wrapper does an SSH find for the whole core
    // tree and returns absolute paths, so the engine queues
    // exactly the files the sidebar count promised.
    listRomPaths: async (coreId) => {
      // feat/arcade-parity-2-metadata — arcade pass. ARCADE_VIRTUAL_CORE_ID
      // is the engine sentinel for the synthetic Arcade row.
      // listRomPaths returns one pseudo-path per UNIQUE primary zip
      // (deduped across .mras — parent + clone usually share a zip);
      // the orchestrator's getArcadeMetadata emits one event per
      // group so the engine's done/total ticking is accurate.
      if (coreId === ARCADE_VIRTUAL_CORE_ID) {
        const snapshot = manager.getArcadePlayabilitySnapshot();
        if (snapshot === null) {
          return { paths: [], atomicFolderPaths: new Set() };
        }
        const playable = snapshot.entries.filter(
          (e) => snapshot.byPath.get(e.relativePath) === 'playable',
        );
        const groups = groupByPrimaryZipBasename(
          playable,
          snapshot.zipBasenames,
        );
        // Pseudo-paths for accounting only — the actual zip path
        // resolves inside getArcadeMetadata via statPathsWithSize
        // (snapshot's zipBasenames union doesn't preserve per-dir
        // membership). Pick the first MAME dir for the synthesised
        // string; the engine matches events by COUNT, not path.
        const paths = groups.map(
          (g) => `${MISTER_ARCADE_ZIP_DIRS[0]}/${g.zipBasename}`,
        );
        return { paths, atomicFolderPaths: new Set() };
      }
      return manager.listAllRomPathsForCore(coreId);
    },
    scrape: async (coreId, targets, onPathResolved, shouldAbort) => {
      // feat/arcade-parity-2-metadata — arcade pass dispatches to
      // getArcadeMetadata, which builds .mra-derived SS hints
      // (displayName + setname) rather than the path-derived hints
      // getRomsMetadata uses. Same `onPathResolved` signature so the
      // engine's progress ticking is uniform across coreIds.
      if (coreId === ARCADE_VIRTUAL_CORE_ID) {
        const snapshot = manager.getArcadePlayabilitySnapshot();
        if (snapshot === null) return;
        const playable = snapshot.entries.filter(
          (e) => snapshot.byPath.get(e.relativePath) === 'playable',
        );
        await metadataOrchestrator.getArcadeMetadata(
          playable,
          snapshot.zipBasenames,
          () => onPathResolved(),
          shouldAbort,
        );
        return;
      }
      // feat/atomic-folder-consistency: forward `atomicFolderPaths`
      // so the orchestrator routes those paths' name-search through
      // the parent folder name (the strongest hint when the disk
      // image's hash misses, which is essentially always for floppy
      // formats SS doesn't index per-disk).
      await metadataOrchestrator.getRomsMetadata(
        coreId,
        targets.paths,
        () => onPathResolved(),
        shouldAbort,
        targets.atomicFolderPaths,
      );
    },
  });

  registerIpcHandlers(
    manager,
    profileStore,
    metadataOrchestrator,
    emitMetadataProgress,
    emitMetadataDatabaseProgress,
    emitRomMetadataResolved,
    autoScrapeEngine,
    // PR-D2 (PR #29): the search modal calls jeuRecherche directly
    // via a renderer-driven IPC; pass the SS service through.
    screenScraper,
    emitUpdateModeProgress,
    // feat/system-catalog-data-layer (#30 PR-1)
    systemCatalog,
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

  // PR-C (PR #26) — bridge engine progress events to the renderer
  // so the footer-left can render the live "<core> · <done>/<total>"
  // string. The engine itself doesn't import Electron, so the
  // window.webContents.send wrapper lives here.
  autoScrapeEngine.onProgress((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.autoScrapeProgress, event);
    }
  });

  updateModeProgressListeners.add((event) => {
    if (!window.isDestroyed()) {
      window.webContents.send(IPC_CHANNELS.updateModeProgress, event);
    }
  });

  // feat/auto-scrape-persistence — persist per-core completion
  // timestamps. The engine fires only for fully-scraped cores
  // (aborted scrapes don't fire), so this never races against a
  // pivot. Best-effort write: a failed disk write logs but doesn't
  // throw; the in-memory completed set still works for the rest
  // of this session.
  autoScrapeEngine.onCompletion(({ coreId }) => {
    const session = manager.getActiveSession();
    if (session === null) return;
    void scrapeStateStore.markScraped(session.host, coreId).catch(() => {
      /* swallow — disk-write failure shouldn't break the engine */
    });
  });

  // PR-C (PR #26) — lifecycle: start the engine on connect (with
  // the sidebar core list in display order), pause on every other
  // status.
  //
  // feat/auto-scrape-persistence: on connect, also seed the
  // engine's in-session completed Set with cores scraped within
  // the freshness window. Those cores skip immediately on the
  // queue walk — pre-fix every reconnect re-walked everything,
  // burning user wall-time on cores that DID finish last session.
  manager.onStatusChange(async (status) => {
    if (status !== 'connected') {
      autoScrapeEngine.pause();
      return;
    }
    // feat/system-catalog-data-layer (#30 PR-1) — load or fetch the
    // system catalog on connect so sidebar names are available
    // immediately. Best-effort: failure doesn't block the connect flow.
    void systemCatalog.ensureCatalog().catch((err: unknown) => {
      console.warn('[system-catalog] ensureCatalog failed on connect:', err instanceof Error ? err.message : err);
    });
    // fix/count-and-status-indicator commit 4 — lazy v3→v4 hash-cache
    // migration. Runs once per connect, before the first prefetch
    // queues anything. v3 entries with mtimes that still match get
    // their `diskSizeBytes` populated from a stat batch; the rest
    // fall through to the existing rehash path. Eliminates the mass
    // re-hash that the v3→v4 strategy bump from PR #42 commit 1
    // would otherwise force.
    const session = manager.getActiveSession();
    if (session !== null) {
      try {
        await hashService.migrateV3Entries(session.client, session.host);
      } catch {
        // Migration failure is best-effort. The strict v4 validator
        // rejects v3 files on next loadEntries, so the existing
        // rehash path takes over — no worse off than before.
      }
    }
    try {
      const cores = await manager.listAllCoresWithFiles({});
      // feat/arcade-phase-1.5 — drop the synthetic Arcade row.
      // It carries `gamesDirExists: true` so it appears in the
      // sidebar as actionable, but it has no scrape work
      // (Phase 2 will handle .mra metadata via XML parse, not
      // hash-based scraping). Without this guard the engine
      // would queue `__arcade__`, call `listRoms` which throws
      // for the non-existent `/media/fat/games/__arcade__/`
      // dir, and noise up the per-core try/catch.
      const realCoreIds = cores
        .filter((c) => c.gamesDirExists)
        .filter((c) => c.category !== 'Arcade')
        .map((c) => c.id);
      // feat/arcade-parity-2-metadata — queue the arcade pass when
      // there's a playability snapshot with at least one playable
      // entry. The snapshot is hot from connect's loadArcadeData
      // (the arcade-mra-meta cache write happens before this status
      // listener fires); if for some reason it isn't, skip — the
      // user can manually refresh later.
      //
      // Position: arcade goes FIRST in the queue, not last. Pre-fix
      // it was appended (tail), which meant the engine processed
      // every real core before reaching it. With Saturn's first-
      // encounter wrapper-zip hash timeouts (120s × N before PR #58's
      // sentinel kicks in), the queue took 10-20+ minutes to reach
      // arcade on a fresh install — the user's wait window expired
      // long before any arcade `[prefetch] → start` log fired (Phase
      // 1 investigation of the PR-62 live trace). Arcade is the
      // user-stated priority surface for the whole arcade parity
      // sequence, so it owns the front of the queue. Regular cores
      // keep their existing alphabetical/category order behind it.
      const arcadeIds: string[] = [];
      const arcadeSnapshot = manager.getArcadePlayabilitySnapshot();
      if (arcadeSnapshot !== null) {
        const anyPlayable = arcadeSnapshot.entries.some(
          (e) =>
            arcadeSnapshot.byPath.get(e.relativePath) === 'playable',
        );
        if (anyPlayable) arcadeIds.push(ARCADE_VIRTUAL_CORE_ID);
      }
      const coreIds = [...arcadeIds, ...realCoreIds];
      const session = manager.getActiveSession();
      const alreadyCompleted =
        session !== null
          ? await scrapeStateStore.coresScrapedWithin(
              session.host,
              SCRAPE_FRESHNESS_WINDOW_MS,
            )
          : new Set<string>();
      autoScrapeEngine.start(coreIds, alreadyCompleted);
    } catch {
      // listAllCoresWithFiles can fail (SSH dropped right after
      // connect). The engine stays idle; the next status flip
      // (likely 'disconnected' shortly after) is handled above.
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
      autoScrapeEngine.onProgress((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(IPC_CHANNELS.autoScrapeProgress, event);
        }
      });
      updateModeProgressListeners.add((event) => {
        if (!newWindow.isDestroyed()) {
          newWindow.webContents.send(IPC_CHANNELS.updateModeProgress, event);
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
