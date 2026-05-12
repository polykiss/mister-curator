import { promises as fs } from 'node:fs';

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import {
  type ArcadeMraEntry,
  ARCADE_VIRTUAL_CORE_ID,
} from '@shared/arcade-mra';
import { diagLog, makeIdGen } from '@shared/diag-log';
import { encodeIpcError, IPC_CHANNELS } from '@shared/preload-api';
import type {
  ConnectResult,
  CoreVisibilityChangeWire,
  PickedKeyFile,
  RomVisibilityChangeWire,
  SystemFileMarkChangeWire,
} from '@shared/preload-api';
import type {
  MetadataHint,
  RomMetadata,
  UserMetadataOverride,
} from '@shared/metadata-types';
import type { ScreenScraperGame } from '@shared/screenscraper-types';
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

import type {
  ArcadePlayabilityIpc,
  ConnectionManager,
} from '@app/main/ipc/connection-manager';
import type { MetadataOrchestrator } from '@app/main/metadata/metadata-orchestrator';
import { lookupScreenScraperSystemId } from '@app/main/metadata/screenscraper-system-map';
import type { ScreenScraperService } from '@app/main/metadata/screenscraper-service';
import type { AutoScrapeEngine } from '@app/main/services/auto-scrape-engine';
import type { ProfileStore } from '@app/main/storage/profile-store';

type IpcHandler<TArgs extends readonly unknown[], TResult> = (
  ...args: TArgs
) => Promise<TResult> | TResult;

/**
 * Round 4 — module-level IPC call-id generator. Each handler invocation
 * gets a unique id so the start / resolve / reject log lines correlate.
 */
const nextIpcCallId = makeIdGen('ipc-');

function handle<TArgs extends readonly unknown[], TResult>(
  channel: string,
  handler: IpcHandler<TArgs, TResult>,
): void {
  ipcMain.handle(channel, async (_event: IpcMainInvokeEvent, ...args: unknown[]) => {
    const callId = nextIpcCallId();
    const start = Date.now();
    diagLog('info', 'ipc', '→', 'invoke', {
      callId,
      method: channel,
      args: args.length,
    });
    try {
      const result = await handler(...(args as unknown as TArgs));
      diagLog('info', 'ipc', '←', 'resolved', {
        callId,
        method: channel,
        ms: Date.now() - start,
      });
      return result;
    } catch (err) {
      diagLog('error', 'ipc', '✗', 'rejected', {
        callId,
        method: channel,
        ms: Date.now() - start,
        err:
          err instanceof Error
            ? `${err.name}: ${err.message}`
            : String(err),
      });
      // Re-throw with structured fields encoded in the message so the
      // preload can rebuild a typed `MisterConnectionError` on the
      // other side (Electron strips custom `Error` subclass fields).
      throw encodeIpcError(err);
    }
  });
}

/**
 * Forward a metadata-prefetch progress tick to the renderer. The wiring
 * layer (`app/main/index.ts`) plumbs each window's `webContents.send`
 * into here so the IPC handlers stay window-agnostic.
 */
export type MetadataPrefetchEmitter = (event: {
  readonly operationId: string;
  readonly kind: 'hash' | 'metadata';
  readonly done: number;
  readonly total: number;
  readonly currentPath?: string;
}) => void;

/**
 * PR #20 round 2: per-path resolution events from the list-view
 * streaming prefetch. Mirrors the `RomMetadataResolvedEvent` shape
 * in `shared/preload-api.ts` (kept inline to keep this module
 * dependency-light).
 */
export type RomMetadataResolvedEmitter = (event: {
  readonly operationId: string;
  readonly path: string;
  readonly metadata: RomMetadata | null;
  readonly error: boolean;
}) => void;

/**
 * Round 3: emitter for OpenVGDB download progress (separate channel
 * from the prefetch one — different event shape, different lifecycle).
 */
export type MetadataDatabaseEmitter = (
  event:
    | { readonly kind: 'started' }
    | {
        readonly kind: 'downloading';
        readonly bytesReceived: number;
        readonly bytesTotal: number | null;
      }
    | { readonly kind: 'ready' }
    | { readonly kind: 'error'; readonly message: string },
) => void;

export function registerIpcHandlers(
  manager: ConnectionManager,
  store: ProfileStore,
  metadata: MetadataOrchestrator,
  emitMetadataProgress: MetadataPrefetchEmitter,
  emitMetadataDatabaseProgress: MetadataDatabaseEmitter,
  emitRomMetadataResolved: RomMetadataResolvedEmitter,
  autoScrapeEngine: AutoScrapeEngine,
  // PR-D2 (PR #29): the search modal calls jeuRecherche directly via
  // a renderer-driven IPC; the SS service is passed in so the
  // handler can reach it.
  screenScraper: ScreenScraperService | null,
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

  handle<[{ readonly forceRefresh?: boolean } | undefined], unknown>(
    IPC_CHANNELS.listAllCoresWithFiles,
    (options) => manager.listAllCoresWithFiles(options ?? {}),
  );

  handle<
    [string, string | undefined, { readonly forceRefresh?: boolean } | undefined],
    unknown
  >(
    IPC_CHANNELS.listRoms,
    (coreId, subPath, options) => manager.listRoms(coreId, subPath, options ?? {}),
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

  handle<[], readonly string[]>(IPC_CHANNELS.listLedgerCoreIds, () =>
    manager.listLedgerCoreIds(),
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

  handle<[], void>(IPC_CHANNELS.clearCache, () =>
    manager.clearCacheForCurrentHost(),
  );

  // ─── PR #15: metadata pipeline ─────────────────────────────────────
  let nextMetadataOpId = 1;
  const newOpId = (): string => `mop-${String(nextMetadataOpId++)}`;

  handle<
    [string, string, MetadataHint | undefined],
    RomMetadata | null
  >(IPC_CHANNELS.getRomMetadata, (coreId, romPath, hint) =>
    metadata.getRomMetadata(coreId, romPath, hint ?? {}),
  );

  handle<
    [readonly string[], { readonly operationId?: string } | undefined],
    void
  >(IPC_CHANNELS.prefetchHashes, async (allPaths, options) => {
    const operationId = options?.operationId ?? newOpId();
    await metadata.prefetchHashes(allPaths, (event) => {
      emitMetadataProgress({ operationId, kind: 'hash', ...event });
    });
  });

  handle<
    [readonly string[], { readonly operationId?: string } | undefined],
    void
  >(IPC_CHANNELS.prefetchMetadata, async (hashes, options) => {
    const operationId = options?.operationId ?? newOpId();
    await metadata.prefetchMetadata(hashes, (event) => {
      emitMetadataProgress({ operationId, kind: 'metadata', ...event });
    });
  });

  handle<[], void>(IPC_CHANNELS.clearMetadataCache, () =>
    metadata.clearMetadataCache(),
  );

  handle<[string], string | null>(IPC_CHANNELS.getBoxArtLocal, (url) =>
    metadata.getBoxArtLocal(url),
  );

  handle<[string], Uint8Array | null>(IPC_CHANNELS.getBoxArtBytes, (url) =>
    metadata.getBoxArtBytes(url),
  );

  handle<
    [
      string,
      readonly string[],
      {
        readonly operationId?: string;
        /**
         * PR-D1 round 2 (PR #27 round 2): paths the renderer knows
         * to be inside `folder-atomic` single-game folders. Forwarded
         * to the orchestrator's `parentFolderIsAtomic` per-path
         * decision so only those paths get the parent-folder
         * name-search hint. Undefined / omitted = no atomic paths.
         */
        readonly atomicFolderPaths?: readonly string[];
      } | undefined,
    ],
    void
  >(IPC_CHANNELS.prefetchRomsMetadata, async (coreId, paths, options) => {
    const operationId = options?.operationId ?? newOpId();
    const atomicSet =
      options?.atomicFolderPaths === undefined
        ? undefined
        : new Set(options.atomicFolderPaths);
    await metadata.getRomsMetadata(
      coreId,
      paths,
      (event) => {
        emitRomMetadataResolved({ operationId, ...event });
      },
      undefined,
      atomicSet,
    );
  });

  // PR-C (PR #26): renderer-driven pivot. The CoresPane click handler
  // calls this on every core selection so the auto-scrape engine
  // jumps to the user's focus. No-op if the focused core is already
  // active.
  handle<[string], void>(IPC_CHANNELS.setAutoScrapeFocus, (coreId) => {
    // feat/arcade-phase-1.5 — the synthetic Arcade row routes to
    // ArcadeMraPane (not the auto-scrape pipeline) so a focus
    // event for it is meaningless. Skipping at the IPC boundary
    // keeps the engine's queue clean — pre-skip the engine would
    // queue `__arcade__`, fail listRoms on the non-existent
    // `/media/fat/games/__arcade__/`, and bury the failure in
    // its per-core try/catch.
    if (coreId === ARCADE_VIRTUAL_CORE_ID) return;
    autoScrapeEngine.setFocus(coreId);
  });

  // feat/arcade-phase-1.5 — .mra listing + hide/unhide.
  handle<
    [{ readonly forceRefresh?: boolean } | undefined],
    readonly ArcadeMraEntry[]
  >(IPC_CHANNELS.listArcadeMraEntries, (options) =>
    manager.listArcadeMraEntries(options ?? {}),
  );
  handle<[string, boolean], void>(
    IPC_CHANNELS.setArcadeMraVisibility,
    (relativePath, hidden) =>
      manager.setArcadeMraVisibility(relativePath, hidden),
  );
  handle<
    [readonly { readonly relativePath: string; readonly hidden: boolean }[]],
    BulkRomResult
  >(IPC_CHANNELS.setBulkArcadeMraVisibility, (changes) =>
    manager.setBulkArcadeMraVisibility(changes),
  );

  // feat/arcade-playability-data (PR 1/2) — playability buckets
  // for the active connection. The manager hydrates the snapshot
  // on connect (cold ~2-3s, cached <50ms); this IPC is the thin
  // pass-through PR-2's UI will consume.
  handle<[], ArcadePlayabilityIpc>(
    IPC_CHANNELS.getArcadePlayability,
    () => manager.getArcadePlayability(),
  );

  // PR-D1 round 2 (PR #27 round 2): pure-disk cache snapshot for the
  // optimistic-render path. RomsPane fires this on mount/click for
  // immediate row paint, then dispatches the normal validation
  // prefetch in the background.
  handle<[string, readonly string[]], Record<string, RomMetadata | null>>(
    IPC_CHANNELS.getCachedRomsMetadata,
    (coreId, paths) => metadata.readCachedRomsMetadata(coreId, paths),
  );

  // PR-D2 (PR #29) — manual-override write paths. Edit modal calls
  // `setRomMetadataOverride` for free-form field overrides; search
  // modal calls `bindRomMetadataFromSearch` to pin a SS jeuid.
  // Both return the updated record so the renderer can refresh
  // its `metadataByPath` immediately without a follow-up read.
  handle<
    [string, UserMetadataOverride | undefined],
    RomMetadata | null
  >(IPC_CHANNELS.setRomMetadataOverride, (path, override) =>
    metadata.setUserMetadataOverride(path, override),
  );
  handle<[string, string, ScreenScraperGame], RomMetadata | null>(
    IPC_CHANNELS.bindRomMetadataFromSearch,
    (coreId, path, game) =>
      metadata.bindManualMetadataOverride(coreId, path, game),
  );

  // PR-D2 (PR #29) — name-search for the search modal. Resolves
  // coreId → SS systemeid via the same map the auto-scrape
  // pipeline uses. Returns empty array when:
  //   • SS isn't configured (matches auto-scrape's silent-skip);
  //   • the core isn't mapped to a SS systemeid (Arcade hbmame /
  //     AO486 / etc. — search modal will show "no matches" and
  //     the user can still try the edit modal for free-form
  //     overrides).
  //
  // feat/manual-search-observability: emits two diag lines per
  // click — `ss-manual-search-attempt` before the call (records
  // service state + input) and `ss-manual-search-result` after
  // (records outcome + granular reason on empty). Lets a future
  // "No matches found" report be traced to one of seven distinct
  // silent-return paths via grep `ss-manual-search`. No behavior
  // change — empty paths still return empty.
  handle<[string, string], readonly ScreenScraperGame[]>(
    IPC_CHANNELS.searchScreenScraperByName,
    async (coreId, searchTerm) => {
      const startMs = Date.now();
      const systemId = lookupScreenScraperSystemId(coreId);
      const status = screenScraper?.getStatus();
      diagLog('info', 'meta', '·', 'ss-manual-search-attempt', {
        coreId,
        systemId: systemId ?? undefined,
        searchTerm,
        status,
        hasCredentials:
          screenScraper !== null && screenScraper.isConfigured ? 1 : 0,
      });
      if (screenScraper === null) {
        diagLog('info', 'meta', '·', 'ss-manual-search-result', {
          coreId,
          outcome: 'empty',
          reason: 'service-null',
          count: 0,
          ms: Date.now() - startMs,
        });
        return [];
      }
      if (systemId === null) {
        diagLog('info', 'meta', '·', 'ss-manual-search-result', {
          coreId,
          outcome: 'empty',
          reason: 'no-system-mapping',
          count: 0,
          ms: Date.now() - startMs,
        });
        return [];
      }
      const outcome = await screenScraper.searchByName({
        systemId,
        searchTerm,
      });
      if (outcome.kind === 'ok') {
        diagLog('info', 'meta', '·', 'ss-manual-search-result', {
          coreId,
          outcome: 'results',
          count: outcome.results.length,
          ms: Date.now() - startMs,
        });
        return outcome.results;
      }
      diagLog('info', 'meta', '·', 'ss-manual-search-result', {
        coreId,
        outcome: 'empty',
        reason: outcome.reason,
        status: outcome.status,
        httpStatus: outcome.httpStatus,
        count: 0,
        ms: Date.now() - startMs,
      });
      return [];
    },
  );

  handle<[], { readonly ready: boolean; readonly downloadInProgress: boolean }>(
    IPC_CHANNELS.ensureMetadataDatabase,
    () =>
      metadata.ensureMetadataDatabase((event) => {
        // Strip the `path` field from the underlying `ready` payload —
        // the renderer doesn't need to know where on disk the file
        // lives, and surfacing it across processes adds noise.
        if (event.kind === 'ready') {
          emitMetadataDatabaseProgress({ kind: 'ready' });
        } else {
          emitMetadataDatabaseProgress(event);
        }
      }),
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
