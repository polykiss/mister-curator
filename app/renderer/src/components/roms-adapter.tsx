import { MoreHorizontal, Settings } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { ItemListAdapter } from '@app/renderer/src/components/item-list-adapter';

import { diagLog } from '@shared/diag-log';
import { coreDisplayName } from '@shared/core-matching';
import { countRomGroups } from '@shared/folder-rom';
import { isAutoDetectedSystemFile, isSystemFile } from '@shared/system-files';
import {
  enumerateRomEntries,
  metadataLookupPathFor,
} from '@shared/rom-enumeration';
import type { CoreEntry, Rom } from '@shared/types';

/**
 * Narrows a `Rom.kind` (file / folder-atomic / folder-container) down
 * to the simpler `'file' | 'folder'` shape that `isSystemFile` and
 * `isAutoDetectedSystemFile` expect. The atomic/container distinction
 * doesn't matter for system-file detection — both are folders.
 */
function romKindForSystemCheck(kind: Rom['kind']): 'file' | 'folder' {
  return kind === 'file' ? 'file' : 'folder';
}

/** Last path segment, used in diagnostic logs to keep lines readable. */
function shortName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

/**
 * fix/scrape-and-count-correctness commit 2 — drill-in row count.
 * File rows pass through `countRomGroups` so a multi-track `.cue +
 * .bin` set counts as one game; folder rows (atomic and container)
 * each count as one. Mirrors the matcher's per-bucket grouping so
 * the sidebar's "1234" and the drill-in's "47 ROMs" speak the same
 * language.
 */
function countRomEntries(roms: readonly Rom[]): number {
  let folderCount = 0;
  const fileNames: string[] = [];
  for (const r of roms) {
    if (r.kind === 'file') fileNames.push(r.filename);
    else folderCount += 1;
  }
  return folderCount + countRomGroups(fileNames);
}

import { RomDetailDialog } from '@app/renderer/src/components/RomDetailDialog';
import { RomEditMetadataDialog } from '@app/renderer/src/components/RomEditMetadataDialog';
import { RomSearchScreenScraperDialog } from '@app/renderer/src/components/RomSearchScreenScraperDialog';
import {
  RomRowMenu,
  type RomRowMenuItem,
} from '@app/renderer/src/components/RomRowMenu';
import {
  BackThumbnailCell,
  RomDensityEyeCell,
  RomMetadataInfoCells,
  RomNameInner,
  RomThumbnailCell,
  RomYearCell,
} from '@app/renderer/src/components/RomMetadataCells';
import { SortableHeader } from '@app/renderer/src/components/SortableHeader';
import {
  DEFAULT_SORT,
  nextSortState,
  sortRoms,
  type SortState,
} from '@app/renderer/src/lib/rom-sort';
import { classifyRow } from '@app/renderer/src/lib/row-type';
import type { RomMetadata } from '@shared/metadata-types';
import { Button } from '@app/renderer/src/components/ui/button';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@app/renderer/src/components/ui/table';
import { romsKey, useCores } from '@app/renderer/src/contexts/CoresContext';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import type { VisibilityChange } from '@app/renderer/src/lib/optimistic';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

/**
 * Tooltip for buttons disabled because the SSH session is in a
 * lost-connection / reconnecting state. Mirrors the spec wording.
 */
const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

export interface RomsAdapterProps {
  readonly core: CoreEntry;
}

/**
 * feat/arcade-refactor-1-adapter — RomsPane's logic, exposed through
 * the ItemListAdapter contract. RomsPane.tsx becomes a thin wrapper
 * that calls this hook and routes the result through ItemListPane.
 * Internal state (selection, drill subPath, sort, metadata-by-path,
 * dialog open-states, prefetch orchestration) lives here unchanged
 * from the pre-refactor RomsPane — the only structural change is
 * that the return statement produces an adapter object instead of
 * the full JSX. The shell wraps a `<div className="flex h-full
 * flex-col bg-elevated">` around `content` so the on-screen output
 * is pixel-identical to pre-refactor.
 */
export function useRomsAdapter({ core }: RomsAdapterProps): ItemListAdapter {
  const {
    romsByCore,
    romsLoading,
    ensureRoms,
    refetchRoms,
    setRomVisibility,
    setBulkRomVisibility,
    systemFilesMarks,
    isUserMarked,
    addSystemFileMark,
    removeSystemFileMark,
    setSystemFileMarks,
    setFolderClassification,
  } = useCores();
  const { status } = useConnection();
  // Mid-session disconnect / pre-reconnect state — every mutating
  // button gates on this. Reads (browse, drill, filter) stay enabled
  // so the user can still inspect the cached state.
  const canMutate = status === 'connected';
  // Drilled-in path inside the core. Empty string means top-level.
  // Slash-joined for nested folders (`'1 World A-Z'`,
  // `'parent/child'`). Used for every ROM-level operation; the cores
  // pane and counts always reflect the top-level view.
  const [subPath, setSubPath] = useState<string>('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  // Round 3 default: show hidden ROMs by default — they're typically
  // the user's recent work and they want to see what they did. The
  // user's last choice persists across sessions via localStorage.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenRoms',
    true,
  );
  // System files stay off by default — they're noise (BIOSes, palettes,
  // configs) and the system-files-marks UI is the place to manage them.
  const [showSystem, setShowSystem] = usePersistedBool(
    'mistercurator.showSystemFiles',
    false,
  );
  const [menuFor, setMenuFor] = useState<{
    readonly rom: Rom;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  // PR-D2 (PR #29): edit-metadata modal state. The modal is "open
  // for this row" (path, displayName) — closed when null.
  const [editMetadataFor, setEditMetadataFor] = useState<{
    readonly path: string;
    readonly displayName: string;
  } | null>(null);
  // PR-D2 (PR #29): search-on-ScreenScraper modal state.
  const [searchScreenScraperFor, setSearchScreenScraperFor] = useState<{
    readonly path: string;
    readonly filename: string;
  } | null>(null);
  // feat/metadata-detail-modal: detail-view modal state. Opens on
  // single-click of a file/folder-atomic row's name cell.
  const [detailDialogFor, setDetailDialogFor] = useState<{
    readonly path: string;
    readonly displayName: string;
    readonly filename: string;
  } | null>(null);

  // Reset drill state SYNCHRONOUSLY when the visible core changes so
  // the `ensureRoms` effect below never sees a stale subPath against a
  // new core. Without this, switching from `NEOGEO/1 World A-Z` to
  // Saturn would fire `listRoms('Saturn', '1 World A-Z')` once before
  // the [core.id] reset effect committed — that call fails with
  // "Unknown core: Saturn" in the main-process log.
  // Pattern reference: https://react.dev/reference/react/useState#storing-information-from-previous-renders
  // PR-A item 8: per-pane sort state, no persistence. Switching
  // cores resets to the default (`name asc`) along with subPath /
  // selection / etc.
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  const [trackedCoreId, setTrackedCoreId] = useState(core.id);
  if (trackedCoreId !== core.id) {
    setTrackedCoreId(core.id);
    setSubPath('');
    setSelected(new Set());
    setSortState(DEFAULT_SORT);
  }

  const cacheKey = romsKey(core.id, subPath);
  const roms = romsByCore[cacheKey];
  const loading = romsLoading[cacheKey] ?? false;

  // Reset selection on every drill in/out so a ghost selection from
  // the previous level never leaks into a different list.
  useEffect(() => {
    setSelected(new Set());
  }, [subPath]);

  // Lazy-fetch ROMs at the current (core, subPath) — including after
  // a drill into a container. The render-time reset above guarantees
  // that when this effect fires for a new core, subPath is already ''.
  useEffect(() => {
    void ensureRoms(core.id, subPath);
  }, [core.id, subPath, ensureRoms]);

  // PR #20 round 2 — list-view streaming prefetch. ONE batched IPC
  // call per `roms` change, with per-path results streamed back as
  // they settle. Replaces the round-1 per-row hooks that fired N
  // parallel `getRomMetadata` calls and tipped over WiFi-attached
  // MiSTers (each call cost a sequential SSH `statWitnesses`
  // round-trip).
  //
  // State shape: undefined-by-key = not-yet-resolved (loading);
  // present = settled (matched / unmatched / error).
  const [metadataByPath, setMetadataByPath] = useState<
    Record<string, { metadata: RomMetadata | null; error: boolean }>
  >({});
  useEffect(() => {
    setMetadataByPath({});
    if (!roms || roms.length === 0) return;
    // PR-D1 (PR #27): include atomic folders' contained primary
    // ROM file in the prefetch list so the folder row can show the
    // contained game's box art (with the folder badge overlay).
    // The metadata is keyed by the contained file's hash; the
    // renderer's row render does the lookup via `containedRomPath`.
    // Container folders stay out — they're drilled into for their
    // contents.
    // feat/atomic-folder-consistency: enumerateRomEntries collapses
    // atomic folders to a single entry whose `path` is the contained
    // primary file's path — exactly what the cache wants. The
    // atomicFolderPaths set keys orchestrator name-search hint
    // routing.
    const entries = enumerateRomEntries(roms);
    const filePaths = entries.map((e) => e.path);
    const atomicFolderPaths = entries
      .filter((e) => e.kind === 'atomic-folder')
      .map((e) => e.path);
    if (filePaths.length === 0) return;
    // PR-D1 round 2 (PR #27 round 2): optimistic-render path. Read
    // the disk cache snapshot first (no SSH, no SS — instant) and
    // hydrate `metadataByPath` so rows paint immediately. Then the
    // normal validation prefetch fires below; mtime-batch + per-path
    // refetch update only the rows that changed on-device. Most
    // rows don't change between sessions, so the optimistic paint
    // is correct for the common case.
    let cancelled = false;
    void window.mister
      .getCachedRomsMetadata(core.id, filePaths)
      .then((cached) => {
        if (cancelled) return;
        const seed: Record<
          string,
          { metadata: RomMetadata | null; error: boolean }
        > = {};
        for (const [path, metadata] of Object.entries(cached)) {
          if (metadata !== null) {
            seed[path] = { metadata, error: false };
          }
        }
        // Merge — don't overwrite events that arrived faster than the
        // cache read (rare race; preserve fresher data).
        setMetadataByPath((prev) => ({ ...seed, ...prev }));
      })
      .catch(() => {
        // Cache snapshot failed — not fatal; the validation prefetch
        // below still runs and fills rows the slow way.
      });
    // Operation id scopes the streamed events to THIS pane mount —
    // a quick navigation away starts a fresh prefetch with a new
    // operationId; events from the in-flight prior prefetch are
    // ignored by the listener filter.
    const operationId = `pane-${core.id}-${String(Date.now())}-${String(
      Math.random(),
    )}`;
    diagLog('info', 'roms-pane', '·', 'subscribed', {
      opId: operationId,
      coreId: core.id,
      paths: filePaths.length,
    });
    const unsubscribe = window.mister.onRomMetadataResolved((event) => {
      if (event.operationId !== operationId) return;
      diagLog('info', 'roms-pane', '←', 'resolved-event', {
        opId: operationId,
        path: shortName(event.path),
        source: event.metadata?.source ?? 'none',
        error: event.error ? 1 : undefined,
      });
      setMetadataByPath((prev) => ({
        ...prev,
        [event.path]: { metadata: event.metadata, error: event.error },
      }));
    });
    void window.mister.prefetchRomsMetadata(core.id, filePaths, {
      operationId,
      atomicFolderPaths,
    });
    return () => {
      // Round 2 (PR #27 round 2): cancel the optimistic-cache hydrate
      // if the user navigates away before it lands. Prevents stale
      // cache snapshot from clobbering a fresh pane's metadata.
      cancelled = true;
      diagLog('info', 'roms-pane', '·', 'unsubscribed', {
        opId: operationId,
      });
      unsubscribe();
    };
  }, [roms, core.id]);

  // PR #20 round 3 — resume after reconnect. When the connection comes
  // back up (status flips to 'connected') AFTER a mid-prefetch drop,
  // re-fire the prefetch for paths that still haven't settled OR
  // that errored on the prior attempt. The orchestrator's hash and
  // metadata caches are durable on disk, so the second pass hits warm
  // cache for anything that DID resolve before the drop — this loop
  // is genuinely just the still-pending residue.
  //
  // Triggered on the [status, roms, core.id] tuple — `status` is the
  // signal that we just transitioned, and the ref guards against
  // re-firing while still on the same connected session.
  const wasConnectedRef = useRef(status === 'connected');
  useEffect(() => {
    const wasConnected = wasConnectedRef.current;
    wasConnectedRef.current = status === 'connected';
    // Round 5 — log every fire of the resume effect, before the
    // early-return guards. Tells us whether the effect runs at all
    // on reconnect and which guard (if any) blocks the resume.
    diagLog('info', 'roms-pane', '·', 'resume-effect-fired', {
      status,
      wasConnected: wasConnected ? 1 : 0,
      coreId: core.id,
      romsCount: roms?.length ?? 0,
    });
    if (status !== 'connected') return;
    if (wasConnected) return; // already on a live session, no resume
    if (!roms || roms.length === 0) {
      diagLog('info', 'roms-pane', '·', 'resume-skip-no-roms', {
        coreId: core.id,
      });
      return;
    }
    // feat/atomic-folder-consistency: same enumerateRomEntries shape
    // as the initial-prefetch path. Atomic-folder rows resume their
    // metadata fetch via the contained file's hash on reconnect; the
    // atomicFolderPaths set keys orchestrator name-search hint
    // routing.
    const resumeEntries = enumerateRomEntries(roms);
    const filePaths = resumeEntries.map((e) => e.path);
    const atomicFolderPathsAll = resumeEntries
      .filter((e) => e.kind === 'atomic-folder')
      .map((e) => e.path);
    const pending = filePaths.filter((p) => {
      const entry = metadataByPath[p];
      return entry === undefined || entry.error;
    });
    const pendingSet = new Set(pending);
    const atomicFolderPaths = atomicFolderPathsAll.filter((p) =>
      pendingSet.has(p),
    );
    if (pending.length === 0) {
      diagLog('info', 'roms-pane', '·', 'resume-skip-no-pending', {
        coreId: core.id,
      });
      return;
    }
    // Clear error flags on the residue so rows flip back to skeleton
    // while the re-fetch is in flight.
    setMetadataByPath((prev) => {
      const next = { ...prev };
      for (const p of pending) {
        if (next[p]?.error) delete next[p];
      }
      return next;
    });
    const operationId = `resume-${core.id}-${String(Date.now())}-${String(
      Math.random(),
    )}`;
    diagLog('info', 'roms-pane', '·', 'resume-subscribed', {
      opId: operationId,
      coreId: core.id,
      paths: pending.length,
    });
    const unsubscribe = window.mister.onRomMetadataResolved((event) => {
      if (event.operationId !== operationId) return;
      diagLog('info', 'roms-pane', '←', 'resolved-event', {
        opId: operationId,
        path: shortName(event.path),
        source: event.metadata?.source ?? 'none',
        error: event.error ? 1 : undefined,
      });
      setMetadataByPath((prev) => ({
        ...prev,
        [event.path]: { metadata: event.metadata, error: event.error },
      }));
    });
    void window.mister.prefetchRomsMetadata(core.id, pending, {
      operationId,
      atomicFolderPaths,
    });
    return () => {
      diagLog('info', 'roms-pane', '·', 'resume-unsubscribed', {
        opId: operationId,
      });
      unsubscribe();
    };
    // metadataByPath is intentionally OMITTED from deps — including it
    // would re-fire this effect every time a single resolved event
    // landed (since setMetadataByPath in the parent prefetch effect
    // mutates it), starting a new resume prefetch on every per-row
    // settle. We only want to resume on the connected-transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, roms, core.id]);

  // System-file classification is keyed on (filename, kind). Cache for
  // the current rom list so the renderer doesn't re-classify on every
  // re-render. Uses the combined check — auto-detector OR user-marks.
  const systemFlags = useMemo(() => {
    const map = new Map<string, boolean>();
    for (const r of roms ?? []) {
      map.set(
        r.filename,
        isSystemFile(
          { filename: r.filename, kind: romKindForSystemCheck(r.kind) },
          { marks: systemFilesMarks, coreId: core.id },
        ),
      );
    }
    return map;
  }, [roms, systemFilesMarks, core.id]);

  // The list the user actually sees — hidden + system filters apply
  // independently. Counts in the header reflect this filtered view so
  // "47 ROMs" doesn't include the 12 NEOGEO BIOS files when
  // `showSystem` is off.
  const presentableRoms = useMemo(() => {
    if (!roms) return null;
    const filtered = roms.filter((r) => {
      if (!showHidden && r.hidden) return false;
      if (!showSystem && systemFlags.get(r.filename) === true) return false;
      return true;
    });
    // PR-A item 8: apply the per-pane sort. Folder rows pin to the
    // top alphabetical, file rows follow `sortState`. We project to
    // the sortRoms input shape (rom + metadata), let the pure sort
    // do its work, then project back to the Rom array the rest of
    // the pane consumes.
    const withMeta = filtered.map((rom) => ({
      rom,
      // feat/atomic-folder-consistency: `metadataLookupPathFor`
      // centralizes the atomic-folder-uses-containedRomPath rule.
      // Container folders return null → metadata undefined → row
      // sorts by displayName, same as before.
      metadata:
        metadataByPath[metadataLookupPathFor(rom) ?? rom.path]?.metadata,
    }));
    return sortRoms(withMeta, sortState).map((r) => r.rom);
  }, [roms, showHidden, showSystem, systemFlags, metadataByPath, sortState]);

  // Density-bar denominator for the size column — peer max across the
  // rows actually being rendered. SYSTEM.md §10: ROMs use file size /
  // max visible.
  const maxSizeBytes = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms.reduce(
      (acc, r) => (r.sizeBytes > acc ? r.sizeBytes : acc),
      0,
    );
  }, [presentableRoms]);

  // Counts shown in the header — non-system ROMs only.
  // fix/scrape-and-count-correctness commit 2: file rows pass
  // through `countRomGroups` so a `.cue + .bin` set the user sees
  // as one game contributes 1 to the count instead of N. Folder
  // rows (atomic + container) each count as 1 — atomic folders are
  // already one game per definition; container folders are one
  // navigation row regardless of contents.
  const visibleNonSystem = useMemo(() => {
    if (!roms) return 0;
    return countRomEntries(
      roms.filter((r) => !r.hidden && systemFlags.get(r.filename) !== true),
    );
  }, [roms, systemFlags]);
  const hiddenNonSystem = useMemo(() => {
    if (!roms) return 0;
    return countRomEntries(
      roms.filter((r) => r.hidden && systemFlags.get(r.filename) !== true),
    );
  }, [roms, systemFlags]);
  const systemCount = useMemo(() => {
    if (!roms) return 0;
    return countRomEntries(
      roms.filter((r) => systemFlags.get(r.filename) === true),
    );
  }, [roms, systemFlags]);

  const visibleSelectedCount = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms.filter((r) => selected.has(r.filename) && !r.hidden).length;
  }, [presentableRoms, selected]);

  const hiddenSelectedCount = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms.filter((r) => selected.has(r.filename) && r.hidden).length;
  }, [presentableRoms, selected]);

  // The "Mark selected as system" / "Unmark selected" toolbar buttons
  // operate on whatever the user has selected:
  //   - markable: not currently flagged as system at all (so we won't
  //     touch auto-detected files; they're system already and can't be
  //     unmarked anyway) AND not yet in the marks list
  //   - unmarkable: currently in the marks list (auto-detected files
  //     are excluded — they're heuristic, not stored)
  const markableSelected = useMemo(() => {
    if (!roms) return [];
    return roms.filter((r) => {
      if (!selected.has(r.filename)) return false;
      const auto = isAutoDetectedSystemFile({
        filename: r.filename,
        kind: romKindForSystemCheck(r.kind),
      });
      if (auto) return false;
      return !isUserMarked(core.id, r.filename);
    });
  }, [roms, selected, core.id, isUserMarked]);

  const unmarkableSelected = useMemo(() => {
    if (!roms) return [];
    return roms.filter(
      (r) => selected.has(r.filename) && isUserMarked(core.id, r.filename),
    );
  }, [roms, selected, core.id, isUserMarked]);

  const onToggleSelect = (filename: string, checked: boolean): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(filename);
      else next.delete(filename);
      return next;
    });
  };

  const onToggleAll = (checked: boolean): void => {
    if (!presentableRoms) return;
    setSelected(checked ? new Set(presentableRoms.map((r) => r.filename)) : new Set());
  };

  const onSingleToggle = async (rom: Rom): Promise<void> => {
    try {
      await setRomVisibility(core.id, rom.filename, !rom.hidden, subPath);
    } catch (err) {
      toast.error(`Could not ${rom.hidden ? 'show' : 'hide'} ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const runBulk = async (
    changes: readonly VisibilityChange[],
    action: 'Hid' | 'Restored',
  ): Promise<void> => {
    if (changes.length === 0) return;
    let result;
    try {
      result = await setBulkRomVisibility(core.id, changes, subPath);
    } catch (err) {
      toast.error(`${action} failed`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
      return;
    }
    const summary = summarizeBulkResult({
      action,
      itemNoun: 'ROM',
      succeeded: result.succeeded,
      failed: result.failed,
      failedNames: result.failed.map((f) => f.filename),
    });
    const surface =
      summary.kind === 'success'
        ? toast.success
        : summary.kind === 'partial'
          ? toast.warning
          : toast.error;
    surface(summary.title, { description: summary.description });
  };

  // "Hide all" / "Show all" / selected actions only target NON-system
  // ROMs. We never invite the user to hide a BIOS via a bulk op.
  const candidates = useMemo(() => roms?.filter((r) => systemFlags.get(r.filename) !== true) ?? [], [roms, systemFlags]);

  const onHideAll = (): void => {
    const changes: VisibilityChange[] = candidates
      .filter((r) => !r.hidden)
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Hid');
  };

  const onShowAll = (): void => {
    const changes: VisibilityChange[] = candidates
      .filter((r) => r.hidden)
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Restored');
  };

  const onHideSelected = (): void => {
    if (!presentableRoms) return;
    const changes: VisibilityChange[] = presentableRoms
      .filter(
        (r) =>
          selected.has(r.filename) &&
          !r.hidden &&
          systemFlags.get(r.filename) !== true,
      )
      .map((r) => ({ filename: r.filename, hidden: true }));
    void runBulk(changes, 'Hid');
    setSelected(new Set());
  };

  const onShowSelected = (): void => {
    if (!presentableRoms) return;
    const changes: VisibilityChange[] = presentableRoms
      .filter(
        (r) =>
          selected.has(r.filename) &&
          r.hidden &&
          systemFlags.get(r.filename) !== true,
      )
      .map((r) => ({ filename: r.filename, hidden: false }));
    void runBulk(changes, 'Restored');
    setSelected(new Set());
  };

  const onMarkAsSystem = async (rom: Rom): Promise<void> => {
    try {
      await addSystemFileMark(core.id, rom.filename);
      // The CoresContext refetches the top-level ROM list; if we're
      // drilled in we need to also refetch THIS level so the row picks
      // up its new system status.
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(`Marked ${rom.displayName} as system file`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await removeSystemFileMark(core.id, rom.filename);
              } catch {
                /* swallow */
              }
            })();
          },
        },
      });
    } catch (err) {
      toast.error(`Could not mark ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onMarkSelectedAsSystem = async (): Promise<void> => {
    const targets = markableSelected;
    if (targets.length === 0) return;
    const changes = targets.map((r) => ({ filename: r.filename, marked: true }));
    try {
      await setSystemFileMarks(core.id, changes);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(
        `Marked ${String(targets.length)} file${targets.length === 1 ? '' : 's'} as system`,
        {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await setSystemFileMarks(
                    core.id,
                    targets.map((r) => ({ filename: r.filename, marked: false })),
                  );
                } catch {
                  /* swallow */
                }
              })();
            },
          },
        },
      );
      setSelected(new Set());
    } catch (err) {
      toast.error('Mark as system failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onUnmarkSelected = async (): Promise<void> => {
    const targets = unmarkableSelected;
    if (targets.length === 0) return;
    const changes = targets.map((r) => ({ filename: r.filename, marked: false }));
    try {
      await setSystemFileMarks(core.id, changes);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(
        `Unmarked ${String(targets.length)} file${targets.length === 1 ? '' : 's'}`,
        {
          action: {
            label: 'Undo',
            onClick: () => {
              void (async () => {
                try {
                  await setSystemFileMarks(
                    core.id,
                    targets.map((r) => ({ filename: r.filename, marked: true })),
                  );
                } catch {
                  /* swallow */
                }
              })();
            },
          },
        },
      );
      setSelected(new Set());
    } catch (err) {
      toast.error('Unmark failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onUnmarkSystem = async (rom: Rom): Promise<void> => {
    try {
      await removeSystemFileMark(core.id, rom.filename);
      if (subPath !== '') await refetchRoms(core.id, subPath);
      toast.success(`Unmarked ${rom.displayName}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await addSystemFileMark(core.id, rom.filename);
              } catch {
                /* swallow */
              }
            })();
          },
        },
      });
    } catch (err) {
      toast.error(`Could not unmark ${rom.displayName}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onSetClassification = async (
    rom: Rom,
    classification: 'container' | 'atomic' | null,
  ): Promise<void> => {
    // The override key is the visible (un-dotted) relative path —
    // matches how `listRoms` builds the lookup so a hide/unhide later
    // doesn't break the override.
    const visibleRelPath =
      (subPath === '' ? '' : `${subPath}/`) +
      (rom.hidden ? rom.filename.slice(1) : rom.filename);
    try {
      await setFolderClassification(core.id, visibleRelPath, classification, {
        coreId: core.id,
        subPath,
      });
      toast.success(
        classification === null
          ? `Reset classification for ${rom.displayName}`
          : `Treating ${rom.displayName} as ${classification}`,
      );
    } catch (err) {
      toast.error('Could not update folder classification', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  function buildMenuItems(rom: Rom): readonly RomRowMenuItem[] {
    const items: RomRowMenuItem[] = [];

    // Folder rows get classification overrides — the user can pin a
    // specific folder to container/atomic against the auto-detector.
    // Classification overrides write to an on-MiSTer marks file, so
    // they're gated on a live connection just like system-file marks.
    if (rom.kind !== 'file') {
      const isContainer = rom.kind === 'folder-container';
      items.push({
        label: isContainer ? 'Treat as atomic (one game)' : 'Treat as container (drill in)',
        onSelect: () =>
          void onSetClassification(rom, isContainer ? 'atomic' : 'container'),
        disabled: !canMutate,
        title: canMutate
          ? 'Override the auto-detector for this folder. Persists in the on-MiSTer marks file.'
          : DISCONNECTED_TOOLTIP,
      });
      items.push({
        label: 'Reset to auto-detected',
        onSelect: () => void onSetClassification(rom, null),
        disabled: !canMutate,
        title: canMutate
          ? 'Drop the user override and let the heuristic classify this folder.'
          : DISCONNECTED_TOOLTIP,
      });
    }

    // System-file mark items — auto-detected files cannot be unmarked
    // (the heuristic decides every connection). The disabled item
    // surfaces this without hiding the option.
    const auto = isAutoDetectedSystemFile({
      filename: rom.filename,
      kind: romKindForSystemCheck(rom.kind),
    });
    const marked = isUserMarked(core.id, rom.filename);
    if (auto) {
      items.push({
        label: 'Auto-detected — cannot unmark',
        onSelect: () => undefined,
        disabled: true,
        title:
          'This file matches a built-in system-file pattern (BIOS, config, palette).',
      });
    } else if (marked) {
      items.push({
        label: 'Unmark as system file',
        onSelect: () => void onUnmarkSystem(rom),
        disabled: !canMutate,
        title: canMutate
          ? 'Treat this file as a regular ROM again. Removes it from the system-files list.'
          : DISCONNECTED_TOOLTIP,
      });
    } else {
      items.push({
        label: 'Mark as system file',
        onSelect: () => void onMarkAsSystem(rom),
        disabled: !canMutate,
        title: canMutate
          ? 'Hide this file from the ROM list and exclude it from bulk operations.'
          : DISCONNECTED_TOOLTIP,
      });
    }

    // PR-D2 (PR #29) — manual override entries. "Edit metadata..."
    // opens the field-edit modal; gated on metadata existing for
    // this row. feat/atomic-folder-consistency: the lookup path for
    // atomic folders comes from the central `metadataLookupPathFor`
    // (returns containedRomPath); falls back to rom.path on null
    // (file rows + the defensive empty-atomic-folder case).
    const lookupPath = metadataLookupPathFor(rom) ?? rom.path;
    const hasMetadata = metadataByPath[lookupPath]?.metadata !== undefined &&
      metadataByPath[lookupPath]?.metadata !== null;
    items.push({
      label: 'Edit metadata...',
      onSelect: () =>
        setEditMetadataFor({
          path: lookupPath,
          displayName: metadataByPath[lookupPath]?.metadata?.name ?? rom.displayName,
        }),
      disabled: !hasMetadata,
      title: hasMetadata
        ? 'Override the name, year, genre, rating, tags, or note for this row.'
        : 'No metadata to edit yet — wait for the prefetch to land.',
    });
    // "Find on ScreenScraper..." — always enabled. PR-D2 r2 c2: this
    // is the primary affordance for source='none' rows (the auto-binder
    // missed) so disabling it on those exact rows was the bug. The
    // modal opens regardless of cache state; the bind path inside the
    // modal surfaces its own error toast if there's no cached hash yet.
    // For source='none' (or no metadata), prefix with ★ to signal that
    // this is the recommended next step for that row.
    const sourceState = metadataByPath[lookupPath]?.metadata?.source ?? 'none';
    const isUnmatched = !hasMetadata || sourceState === 'none';
    items.push({
      label: isUnmatched ? '★ Find on ScreenScraper...' : 'Find on ScreenScraper...',
      onSelect: () =>
        setSearchScreenScraperFor({
          path: lookupPath,
          filename: rom.filename,
        }),
      title: isUnmatched
        ? 'Recommended — this row has no automatic match. Search ScreenScraper to bind it manually.'
        : 'Search ScreenScraper for the right match — useful when the auto-binder missed or got it wrong.',
    });

    return items;
  }

  /**
   * Click handler for a row's main button. For container folders,
   * this drills into the folder; for atomic folders and files, the
   * row's normal selection behavior takes over (handled separately).
   */
  function onRowActivate(rom: Rom): void {
    if (rom.kind === 'folder-container' && !rom.hidden) {
      const visibleBase = rom.hidden ? rom.filename.slice(1) : rom.filename;
      const next = subPath === '' ? visibleBase : `${subPath}/${visibleBase}`;
      setSubPath(next);
    }
  }

  function navigateToDepth(targetDepth: number): void {
    setSubPath(subPathAtDepth(subPath, targetDepth));
  }

  const breadcrumb = computeBreadcrumb(core.name, subPath);
  const backRow = computeBackRow(core.name, subPath);

  // feat/arcade-refactor-1-adapter — `containerClassName` carries
  // the pane-elevation accent (SYSTEM.md §4): the ROMs pane sits one
  // step up from the cores pane (`bg-elevated`) so the right side of
  // the split reads as "closer" to the viewer. ItemListPane composes
  // this with the shared `'flex h-full flex-col'` outer container.
  return {
    kind: 'roms',
    containerClassName: 'bg-elevated',
    content: (
      <>
        {/* Header is a vertical stack — path on its own row so a long
          path can scroll horizontally without crowding the toolbar;
          counts; tools; filters. Each row owns its full horizontal
          width. */}
      <header className="space-y-3 border-b border-subtle px-4 py-3">
        <nav
          aria-label="Folder path"
          className="flex items-center gap-1 overflow-x-auto whitespace-nowrap font-mono text-body-sm"
        >
          {breadcrumb.map((seg, i) => (
            <span
              key={`${String(seg.depth)}-${seg.label}`}
              className="flex shrink-0 items-center"
            >
              {i > 0 ? (
                <span aria-hidden className="px-2 select-none text-fg-disabled">
                  /
                </span>
              ) : null}
              {seg.current ? (
                <span
                  aria-current="page"
                  className="font-medium text-fg"
                  title={seg.label}
                >
                  {seg.label}
                </span>
              ) : (
                <button
                  type="button"
                  onClick={() => navigateToDepth(seg.depth)}
                  className="rounded text-fg-body transition-colors hover:text-fg focus-visible:text-fg hover:underline focus-visible:underline focus-visible:outline-none"
                  title={`Go to ${seg.label}`}
                >
                  {seg.label}
                </button>
              )}
            </span>
          ))}
        </nav>
        <p className="font-mono text-body-sm text-fg-muted tabular">
          <span className="text-fg-body">{visibleNonSystem}</span> ROMs ·{' '}
          <span className="text-fg-body">{hiddenNonSystem}</span> hidden
          {systemCount > 0 ? (
            <>
              {' '}
              · <span className="text-fg-body">{systemCount}</span> system
            </>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onHideAll}
            disabled={!canMutate || candidates.every((r) => r.hidden)}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Hide all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onShowAll}
            disabled={!canMutate || candidates.every((r) => !r.hidden)}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Unhide all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onHideSelected}
            disabled={!canMutate || visibleSelectedCount === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Hide selected ({visibleSelectedCount})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={onShowSelected}
            disabled={!canMutate || hiddenSelectedCount === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            Unhide selected ({hiddenSelectedCount})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onMarkSelectedAsSystem()}
            disabled={!canMutate || markableSelected.length === 0}
            title={
              canMutate
                ? "Treat the selected files as system files (BIOS, palette, config). Hidden by default; visible when 'Show system files' is on."
                : DISCONNECTED_TOOLTIP
            }
          >
            Mark as system ({markableSelected.length})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onUnmarkSelected()}
            disabled={!canMutate || unmarkableSelected.length === 0}
            title={
              canMutate
                ? 'Remove the user-system mark from the selected files. Auto-detected system files are not affected.'
                : DISCONNECTED_TOOLTIP
            }
          >
            Unmark system ({unmarkableSelected.length})
          </Button>
        </div>
        <div className="flex flex-wrap gap-4 text-body-sm text-fg-body">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            Show hidden
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-accent"
              checked={showSystem}
              onChange={(e) => setShowSystem(e.target.checked)}
            />
            Show system files
          </label>
        </div>
      </header>

      {/* PR #23 round 5 commit 1: `scroll-themed` reserves a stable
          scrollbar gutter and paints a permanent themed bar so native
          overlay scrollbars on macOS can't fade in over the eye
          column on the right.
          PR #23 round 6: `pr-2.5` (10px) explicit right padding —
          scrollbar-gutter alone wasn't reliable in this Chromium /
          macOS configuration (eye icons still visually overlapped
          the drawn scrollbar). Pinning a 10px gap between the row
          content and the container's right edge guarantees the
          rightmost cell (density + eye stack) sits well clear of
          the scrollbar regardless of how the gutter resolves. */}
      <div className="scroll-themed flex-1 overflow-auto pr-2.5">
        {loading && !roms ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !presentableRoms || presentableRoms.length === 0 ? (
          <div className="p-6 text-body-sm text-fg-muted">
            {(roms ?? []).length === 0
              ? 'No ROMs in this core.'
              : 'Nothing to show. Toggle "Show hidden" or "Show system files" to see more.'}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-10 pl-4">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    aria-label="Select all"
                    checked={
                      presentableRoms.length > 0 &&
                      selected.size === presentableRoms.length
                    }
                    onChange={(e) => onToggleAll(e.target.checked)}
                  />
                </TableHead>
                {/* PR-A item 8 layout: [Box art] [Name] [Year]
                    [Genre] [Rating]. Year promoted out of the
                    name-stack into its own sortable column. Each
                    sortable header is clickable; the active column
                    shows a chevron. Folder rows pin to the top
                    regardless of sort. */}
                <TableHead className="w-16" aria-label="Box art" />
                <SortableHeader
                  label="Name"
                  sortKey="name"
                  sortState={sortState}
                  onSort={(k) =>
                    setSortState((prev) => nextSortState(prev, k))
                  }
                />
                <SortableHeader
                  label="Year"
                  sortKey="year"
                  align="right"
                  className="w-16"
                  sortState={sortState}
                  onSort={(k) =>
                    setSortState((prev) => nextSortState(prev, k))
                  }
                />
                <SortableHeader
                  label="Genre"
                  sortKey="genre"
                  className="w-28"
                  sortState={sortState}
                  onSort={(k) =>
                    setSortState((prev) => nextSortState(prev, k))
                  }
                />
                <SortableHeader
                  label="Rating"
                  sortKey="rating"
                  align="right"
                  className="w-14"
                  sortState={sortState}
                  onSort={(k) =>
                    setSortState((prev) => nextSortState(prev, k))
                  }
                />
                {/* MoreHorizontal column. Sits left of the density+eye
                    right-edge stack so the row's primary visibility
                    toggle owns the far-right slot. */}
                <TableHead className="w-10" aria-label="Actions" />
                {/* Combined density + eye column. Round 5: the two
                    used to live in separate cells with default cell
                    padding between them, which left a too-wide gap
                    versus the cores pane. One cell + a flex stack
                    inside lets density sit flush against the eye
                    icon and the whole stack hugs the row's far edge.
                    Width = 20 (density) + 32 (eye) + a hair of
                    right padding ≈ 52px. */}
                <TableHead
                  className="w-[3.25rem] p-0"
                  aria-label="Intensity / visibility"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backRow ? (
                // PR #23 round 3 part 2: back row uses the standard
                // column layout (checkbox / thumbnail / name / year /
                // genre / rating / actions / density) so the thumbnail
                // column has consistent rhythm with the rest of the
                // list. The thumbnail slot carries a 40px tile with a
                // CornerUpLeft glyph (the round-3 spec's "tile of
                // SOMETHING for every row" rule). Empty cells fill the
                // metadata slots — the back row has no Rom, no metadata,
                // and isn't sortable, so the slots stay visually quiet.
                <TableRow
                  className="cursor-pointer bg-overlay/40 hover:bg-overlay"
                  onClick={() => setSubPath(backRow.targetSubPath)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSubPath(backRow.targetSubPath);
                    }
                  }}
                  tabIndex={0}
                  role="button"
                  aria-label={`Back to ${backRow.parentLabel}`}
                  title={`Back to ${backRow.parentLabel}`}
                >
                  <TableCell className="pl-4" />
                  <BackThumbnailCell />
                  {/* PR #25: same max-w-0 + truncate combo as the
                      ROM-row name cell — long parent labels (deep
                      drill paths) shouldn't push the right-side
                      cells off the visible area either. */}
                  <TableCell className="max-w-0 truncate">
                    <span
                      className="font-mono text-body-sm text-fg-muted"
                      title={`../ ${backRow.parentLabel}`}
                    >
                      ../ {backRow.parentLabel}
                    </span>
                  </TableCell>
                  <TableCell className="w-16" />
                  <TableCell className="w-28" />
                  <TableCell className="w-14" />
                  <TableCell className="w-10" />
                  <TableCell className="w-[3.25rem] p-0" />
                </TableRow>
              ) : null}
              {presentableRoms.map((rom) => {
                const isSelected = selected.has(rom.filename);
                const isSystem = systemFlags.get(rom.filename) === true;
                const isDimmed = rom.hidden || isSystem;
                // PR #23 round 3 part 2: visual row type drives the
                // thumbnail tile variant. Maps from `rom.kind` (file /
                // folder-atomic / folder-container) to one of 'game' /
                // 'single-game-folder' / 'explorable-folder'. The back
                // row is rendered separately above.
                const rowType = classifyRow({ kind: 'rom', rom });
                // PR #20 round 2: metadata streamed from the parent's
                // prefetch effect. undefined = loading; entry present
                // = settled (metadata may be null = unmatched, or
                // error = true = fetch failed).
                // PR-D1 (PR #27): atomic-folder rows look up by the
                // contained primary file's path so the folder row
                // can show the contained game's box art (with the
                // folder badge overlay from round 3 part 2). Files
                // and container folders look up by their own path.
                const metadataLookupPath =
                  rom.kind === 'folder-atomic' &&
                  rom.containedRomPath !== undefined
                    ? rom.containedRomPath
                    : rom.path;
                const metadataState = metadataByPath[metadataLookupPath];
                const metadata = metadataState?.metadata;
                const fetchError = metadataState?.error ?? false;
                // feat/pre-beta-polish-batch (F) — single source of
                // truth for what clicking the row's interactive
                // surfaces does. Used by the thumbnail (new) AND
                // shared in spirit with the name cell's onClick
                // below (kept inline there to preserve the
                // event-shape: preventDefault + ignore hidden
                // containers).
                const openDetail = (): void => {
                  setDetailDialogFor({
                    path: metadataLookupPath,
                    displayName: metadata?.name ?? rom.displayName,
                    filename: rom.filename,
                  });
                };
                const thumbActivate =
                  rom.kind === 'folder-container' && !rom.hidden
                    ? (): void => onRowActivate(rom)
                    : rom.kind === 'file' || rom.kind === 'folder-atomic'
                      ? openDetail
                      : undefined;
                const thumbLabel =
                  rom.kind === 'folder-container' && !rom.hidden
                    ? `Open ${rom.displayName}`
                    : rom.kind === 'file' || rom.kind === 'folder-atomic'
                      ? 'View details'
                      : undefined;
                return (
                  <TableRow
                    key={rom.filename}
                    data-state={isSelected ? 'selected' : undefined}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setMenuFor({ rom, x: e.clientX, y: e.clientY });
                    }}
                    className={cn(
                      // Hidden + system rows lean entirely on dimming
                      // (Round 2 design pass): opacity + italic + a
                      // darker text color. The HIDDEN/SYSTEM badges
                      // that used to sit before the name were removed;
                      // the gear icon below is the only chrome a
                      // system row carries.
                      isDimmed && 'opacity-50 italic text-fg-disabled',
                    )}
                  >
                    <TableCell className="pl-4">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        aria-label={`Select ${rom.displayName}`}
                        checked={isSelected}
                        onChange={(e) => onToggleSelect(rom.filename, e.target.checked)}
                      />
                    </TableCell>
                    {/* PR #20 round 2: thumbnail cell. Metadata
                        streamed from the parent prefetch; box-art
                        bytes still fetched per-row via useBoxArt
                        once the URL resolves. */}
                    <RomThumbnailCell
                      rom={rom}
                      dimmed={isDimmed}
                      metadata={metadata}
                      error={fetchError}
                      rowType={rowType}
                      onClick={thumbActivate}
                      clickLabel={thumbLabel}
                    />
                    {/* PR #25: `max-w-0` is the standard CSS trick that
                        lets a flex/auto-width table cell honor its
                        children's `truncate`. Without it, the cell's
                        intrinsic content size dominates and a 100-
                        char title pushes Year / Genre / Rating off
                        the visible area. Combined with the parent
                        `<table className="table-fixed">` (set in the
                        Table primitive), the name column gets the
                        remaining width after the explicit `w-N`
                        cells and the inner span's `truncate` does
                        the ellipsis. */}
                    {/* feat/metadata-detail-modal: single-click on the
                        name cell now has two behaviors split by row
                        kind. Folder-containers drill (unchanged).
                        Files + atomic folders open the detail modal
                        regardless of metadata state — the modal's
                        empty-state branch handles the no-record case
                        (typically `source: 'none'` sentinels OR rows
                        the prefetch hasn't landed yet) and surfaces
                        "Find on ScreenScraper" as the primary CTA. */}
                    <TableCell
                      className={cn(
                        'max-w-0 truncate',
                        rom.kind === 'folder-container' &&
                          !rom.hidden &&
                          'cursor-pointer',
                        (rom.kind === 'file' ||
                          rom.kind === 'folder-atomic') &&
                          'cursor-pointer',
                      )}
                      onDoubleClick={() => onRowActivate(rom)}
                      onClick={(e) => {
                        if (rom.kind === 'folder-container' && !rom.hidden) {
                          e.preventDefault();
                          onRowActivate(rom);
                          return;
                        }
                        if (
                          rom.kind === 'file' ||
                          rom.kind === 'folder-atomic'
                        ) {
                          e.preventDefault();
                          setDetailDialogFor({
                            path: metadataLookupPath,
                            displayName: metadata?.name ?? rom.displayName,
                            filename: rom.filename,
                          });
                        }
                      }}
                      title={
                        rom.kind === 'folder-container' && !rom.hidden
                          ? `Open ${rom.displayName}`
                          : rom.kind === 'file' ||
                              rom.kind === 'folder-atomic'
                            ? 'View details'
                            : undefined
                      }
                    >
                      {/* PR #20 round 1: name+year stack replaces the
                          plain displayName. The metadata-derived name
                          wins when present (SS canonical), falling
                          back to the on-disk filename. The click
                          handler stays on the parent TableCell so
                          folder-container drill behavior is
                          unchanged.
                          PR #23 round 4: the leading-icon slot now
                          carries the system gear ONLY. The folder
                          glyphs (Folder / FolderOpen) that used to
                          sit next to folder names are redundant —
                          round 3 part 2 put a 40px tile (FolderOpen
                          for explorable folders, box-art + folder
                          badge overlay for single-game folders) in
                          the thumbnail column, so the inline glyph
                          was repeating the same signal next to the
                          name and breaking the column rhythm. */}
                      <RomNameInner
                        rom={rom}
                        dimmed={isDimmed}
                        metadata={metadata}
                        error={fetchError}
                        leadingIcon={
                          isSystem ? (
                            <Settings
                              className="size-3.5 shrink-0"
                              strokeWidth={1.5}
                              aria-label="system file"
                            />
                          ) : null
                        }
                      />
                    </TableCell>
                    {/* PR-A item 8: year promoted out of the name
                        stack into its own column for sort. */}
                    <RomYearCell
                      rom={rom}
                      dimmed={isDimmed}
                      metadata={metadata}
                      error={fetchError}
                    />
                    <RomMetadataInfoCells
                      rom={rom}
                      dimmed={isDimmed}
                      metadata={metadata}
                      error={fetchError}
                    />
                    {/* MoreHorizontal lives left of the density+eye
                        right-edge stack (Round 3 / SYSTEM.md §5). The
                        eye toggle owns the far-right slot so the
                        primary action is always at the same screen
                        position across cores and ROMs lists.
                        `py-0`: the icon button is h-8 (32px); the
                        TableCell default `py-2` would push the cell
                        content to 48px and force the row past its
                        h-10 design height. With py-0 the row stays
                        at 40px and `align-middle` (TableCell default)
                        keeps the button vertically centered — same
                        result the cores pane gets from `flex
                        items-center` on the row. */}
                    <TableCell className="w-10 py-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="More actions"
                        aria-label={`More actions for ${rom.displayName}`}
                        onClick={(e) => {
                          const r = e.currentTarget.getBoundingClientRect();
                          setMenuFor({ rom, x: r.left, y: r.bottom });
                        }}
                      >
                        <MoreHorizontal strokeWidth={1.5} />
                      </Button>
                    </TableCell>
                    {/* Combined density + eye column. PR #23 round 4
                        extracted the cell into RomDensityEyeCell to
                        give the absolute-positioning workaround a
                        stable contract a regression test can pin —
                        see RomMetadataCells.tsx for the long
                        explanation of why `position: absolute` is the
                        only reliable way to fill the row's actual
                        height when the `<tr>` height is
                        content-driven (the 48px thumbnail makes the
                        actual row ~56px, not the declared 40px). */}
                    <RomDensityEyeCell
                      rom={rom}
                      isSystem={isSystem}
                      maxSizeBytes={maxSizeBytes}
                      canMutate={canMutate}
                      disconnectedTooltip={DISCONNECTED_TOOLTIP}
                      onSingleToggle={onSingleToggle}
                    />
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      {menuFor ? (
        <RomRowMenu
          x={menuFor.x}
          y={menuFor.y}
          items={buildMenuItems(menuFor.rom)}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
      {/* PR-D2 (PR #29) — edit-metadata modal. Renders only when a
          row's selected for editing AND its metadata is loaded
          (the menu item gates on hasMetadata; this guard is
          defensive against a race where the metadata vanishes
          between menu-click and modal-open). */}
      {editMetadataFor !== null &&
      metadataByPath[editMetadataFor.path]?.metadata !== null &&
      metadataByPath[editMetadataFor.path]?.metadata !== undefined ? (
        <RomEditMetadataDialog
          path={editMetadataFor.path}
          displayName={editMetadataFor.displayName}
          metadata={metadataByPath[editMetadataFor.path]!.metadata!}
          open
          onOpenChange={(open) => {
            if (!open) setEditMetadataFor(null);
          }}
          onSave={(override) =>
            window.mister.setRomMetadataOverride(
              editMetadataFor.path,
              override,
            )
          }
          onSaved={(updated) => {
            setMetadataByPath((prev) => ({
              ...prev,
              [editMetadataFor.path]: { metadata: updated, error: false },
            }));
          }}
        />
      ) : null}
      {/* PR-D2 (PR #29) — search-on-ScreenScraper modal. */}
      {searchScreenScraperFor !== null ? (
        <RomSearchScreenScraperDialog
          filename={searchScreenScraperFor.filename}
          coreId={core.id}
          coreLabel={coreDisplayName(core.id)}
          open
          onOpenChange={(open) => {
            if (!open) setSearchScreenScraperFor(null);
          }}
          onBind={(game) =>
            window.mister.bindRomMetadataFromSearch(
              core.id,
              searchScreenScraperFor.path,
              game,
            )
          }
          onSaved={(updated) => {
            setMetadataByPath((prev) => ({
              ...prev,
              [searchScreenScraperFor.path]: {
                metadata: updated,
                error: false,
              },
            }));
          }}
        />
      ) : null}
      {/* feat/metadata-detail-modal — rich detail view. Opens on
          single-click of a file / folder-atomic row's name cell.
          Renders unconditionally for any open `detailDialogFor` —
          the modal's empty-state branch handles the no-record case
          (`metadataByPath[path]?.metadata` resolves to undefined or
          null and the dialog renders the filename + Find CTA).
          Edit / Find buttons hand off to the existing modals via
          setEditMetadataFor / setSearchScreenScraperFor — the detail
          dialog closes itself, then the next modal opens. */}
      {detailDialogFor !== null ? (
        <RomDetailDialog
          path={detailDialogFor.path}
          filename={detailDialogFor.filename}
          metadata={metadataByPath[detailDialogFor.path]?.metadata ?? null}
          open
          onOpenChange={(open) => {
            if (!open) setDetailDialogFor(null);
          }}
          onEdit={() => {
            setEditMetadataFor({
              path: detailDialogFor.path,
              displayName: detailDialogFor.displayName,
            });
          }}
          onSearch={() => {
            setSearchScreenScraperFor({
              path: detailDialogFor.path,
              filename: detailDialogFor.filename,
            });
          }}
        />
      ) : null}
      </>
    ),
  };
}

