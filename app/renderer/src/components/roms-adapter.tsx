import { Button } from '@app/renderer/src/components/ui/button';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { RomListView } from '@app/renderer/src/components/RomListView';
import { DEFAULT_SORT, nextSortState, sortRoms, type SortKey, type SortState } from '@app/renderer/src/lib/rom-sort';
import type { RomMetadata } from '@shared/metadata-types';
import { romsKey, useCores } from '@app/renderer/src/contexts/CoresContext';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import type { VisibilityChange } from '@app/renderer/src/lib/optimistic';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';
import { usePersistedString } from '@app/renderer/src/lib/use-persisted-string';
import { filterRoms } from '@app/renderer/src/lib/filter-roms';
import { FilterInput } from '@app/renderer/src/components/FilterInput';
import { RomPosterView } from '@app/renderer/src/components/RomPosterView';
import { ViewModeToggle } from '@app/renderer/src/components/ViewModeToggle';
import { SizeControl } from '@app/renderer/src/components/SizeControl';
import type { ViewMode, ViewSize } from '@app/renderer/src/lib/roms-view-props';

/**
 * fix/render-cascade-hide-unhide Fix 1: returns a copy of `prev`
 * keeping only keys that appear in `newPaths`. For a typical
 * hide/unhide where no paths are added or removed, the result
 * contains the same entries as `prev` — existing metadata survives
 * the roms reference change.
 *
 * Exported for unit testing.
 */
export function diffMetadataByPath<T>(
  prev: Readonly<Record<string, T>>,
  newPaths: ReadonlySet<string>,
): Record<string, T> {
  const result: Record<string, T> = {};
  for (const key of Object.keys(prev)) {
    if (newPaths.has(key)) result[key] = prev[key]!;
  }
  return result;
}

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
    romCacheVersion,
    updateModeActive,
  } = useCores();
  const { status, currentProfile } = useConnection();
  const host = currentProfile?.host ?? 'default';
  const [viewMode, setViewMode] = usePersistedString<ViewMode>(
    `mistercurator.viewMode.roms.${host}`,
    'list',
    ['list', 'poster'],
  );
  const [viewSize, setViewSize] = usePersistedString<ViewSize>(
    `mistercurator.viewSize.roms.${host}`,
    'M',
    ['S', 'M', 'L', 'XL'],
  );
  // Mid-session disconnect / pre-reconnect state — every mutating
  // button gates on this. Reads (browse, drill, filter) stay enabled
  // so the user can still inspect the cached state.
  // Also gate on !updateModeActive: while update mode is active the
  // hidden-file state is intentionally in flux and mutations are unsafe.
  const canMutate = status === 'connected' && !updateModeActive;
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
  const onSortChange = useCallback((key: SortKey) => {
    setSortState((prev) => nextSortState(prev, key));
  }, []);
  // feat/filter-as-you-type (#21) — per-pane text filter. Resets on
  // core switch (same synchronous pattern as sortState). Not persisted.
  const [filterText, setFilterText] = useState('');
  const deferredFilter = useDeferredValue(filterText);
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  const [trackedCoreId, setTrackedCoreId] = useState(core.id);
  if (trackedCoreId !== core.id) {
    setTrackedCoreId(core.id);
    setSubPath('');
    setSelected(new Set());
    setSortState(DEFAULT_SORT);
    setFilterText('');
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
  // romCacheVersion is included so the effect re-fires after a full
  // Refresh (which clears romsByCore but doesn't change core.id or
  // subPath), preventing the "No ROMs in this core" empty state until
  // the user navigates away and back (Bug C).
  useEffect(() => {
    void ensureRoms(core.id, subPath);
  }, [core.id, subPath, ensureRoms, romCacheVersion]);

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

  // fix/render-cascade-hide-unhide Fix 2: shared rAF handle + pending
  // batch for the main prefetch and resume-on-reconnect listeners.
  // Both listeners write here; the rAF coalesces N events per frame
  // into one setMetadataByPath call.
  const rafHandleRef = useRef<number | null>(null);
  const pendingBatchRef = useRef<
    Record<string, { metadata: RomMetadata | null; error: boolean }>
  >({});

  useEffect(() => {
    if (!roms || roms.length === 0) {
      setMetadataByPath({});
      return;
    }
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
    // fix/render-cascade-hide-unhide Fix 1: diff instead of unconditional
    // wipe. For a typical hide/unhide where no paths are added or removed,
    // this is a no-op — existing metadata survives the roms reference change.
    const filePathSet = new Set(filePaths);
    setMetadataByPath((prev) => diffMetadataByPath(prev, filePathSet));
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
      // fix/render-cascade-hide-unhide Fix 2: accumulate events and flush
      // once per animation frame — N rapid resolves → 1 setState call.
      pendingBatchRef.current[event.path] = {
        metadata: event.metadata,
        error: event.error,
      };
      if (rafHandleRef.current === null) {
        rafHandleRef.current = requestAnimationFrame(() => {
          rafHandleRef.current = null;
          const batch = pendingBatchRef.current;
          pendingBatchRef.current = {};
          setMetadataByPath((prev) => ({ ...prev, ...batch }));
        });
      }
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
      if (rafHandleRef.current !== null) {
        cancelAnimationFrame(rafHandleRef.current);
        rafHandleRef.current = null;
      }
      pendingBatchRef.current = {};
      diagLog('info', 'roms-pane', '·', 'unsubscribed', {
        opId: operationId,
      });
      unsubscribe();
    };
  }, [roms, core.id]);

  // Bug E — scroll-position preservation around single-entry
  // hide/show. When "Show hidden" is off, hiding a row removes it from
  // `presentableRoms` and the list shrinks, causing the viewport to
  // jump. We capture the first row that's at least partially in view
  // (the "anchor") just before the optimistic state update, then
  // scroll the container so that anchor is at the same viewport-
  // relative position after the re-render.
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  // { filename, offset } — filename of the anchor row, offset = its
  // top edge's distance below the scroll container's top edge (pixels).
  const pendingScrollRestoreRef = useRef<{
    readonly filename: string;
    readonly offset: number;
  } | null>(null);

  // Capture scroll anchor. Call BEFORE applying any visibility change.
  const captureScrollAnchor = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const elTop = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>('[data-rom-row]');
    for (const row of rows) {
      const bottom = row.getBoundingClientRect().bottom;
      if (bottom > elTop + 1) {
        const filename = row.getAttribute('data-rom-row') ?? '';
        const rowTop = row.getBoundingClientRect().top;
        pendingScrollRestoreRef.current = {
          filename,
          offset: rowTop - elTop,
        };
        return;
      }
    }
  }, []);

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
      // fix/render-cascade-hide-unhide Fix 2: same rAF batching as
      // the main prefetch listener — coalesce reconnect-resume events.
      pendingBatchRef.current[event.path] = {
        metadata: event.metadata,
        error: event.error,
      };
      if (rafHandleRef.current === null) {
        rafHandleRef.current = requestAnimationFrame(() => {
          rafHandleRef.current = null;
          const batch = pendingBatchRef.current;
          pendingBatchRef.current = {};
          setMetadataByPath((prev) => ({ ...prev, ...batch }));
        });
      }
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

  // fix/render-cascade-hide-unhide Fix 3: identity-only key for
  // scroll-restore. Depends on ROM presence/visibility but NOT on
  // metadataByPath or sortState, so the scroll-restore useLayoutEffect
  // fires only when the visible set changes (hide/unhide), not on
  // every metadata update.
  const romScrollKey = useMemo(() => {
    if (!roms) return null;
    return roms
      .filter((r) => {
        if (!showHidden && r.hidden) return false;
        if (!showSystem && systemFlags.get(r.filename) === true) return false;
        return true;
      })
      .map((r) => r.filename);
  }, [roms, showHidden, showSystem, systemFlags]);

  // The list the user actually sees — visibility filters, text filter,
  // and sort all applied in sequence.
  // feat/filter-as-you-type (#21): `deferredFilter` runs the text
  // filter at deferred priority so keystrokes stay responsive even on
  // lists with hundreds of entries.
  const presentableRoms = useMemo(() => {
    if (!roms) return null;
    const visibilityFiltered = roms.filter((r) => {
      if (!showHidden && r.hidden) return false;
      if (!showSystem && systemFlags.get(r.filename) === true) return false;
      return true;
    });
    const textFiltered = filterRoms(visibilityFiltered, deferredFilter, metadataByPath);
    // PR-A item 8: apply the per-pane sort. Folder rows pin to the
    // top alphabetical, file rows follow `sortState`. We project to
    // the sortRoms input shape (rom + metadata), let the pure sort
    // do its work, then project back to the Rom array the rest of
    // the pane consumes.
    const withMeta = textFiltered.map((rom) => ({
      rom,
      // feat/atomic-folder-consistency: `metadataLookupPathFor`
      // centralizes the atomic-folder-uses-containedRomPath rule.
      // Container folders return null → metadata undefined → row
      // sorts by displayName, same as before.
      metadata:
        metadataByPath[metadataLookupPathFor(rom) ?? rom.path]?.metadata,
    }));
    return sortRoms(withMeta, sortState).map((r) => r.rom);
  }, [roms, showHidden, showSystem, systemFlags, metadataByPath, sortState, deferredFilter]);

  // Pre-filter count (visibility only, no text filter) — used by the
  // header to show "Showing N of M" when the text filter is active.
  const preFilterCount = useMemo(() => {
    if (!roms) return 0;
    return roms.filter((r) => {
      if (!showHidden && r.hidden) return false;
      if (!showSystem && systemFlags.get(r.filename) === true) return false;
      return true;
    }).length;
  }, [roms, showHidden, showSystem, systemFlags]);

  // After each visible-ROM-set change, restore scroll if an anchor
  // was captured. useLayoutEffect fires before the browser paints,
  // preventing the visible jump. Depends on romScrollKey (identity
  // only, no metadata) so metadata updates don't trigger this.
  useLayoutEffect(() => {
    const restore = pendingScrollRestoreRef.current;
    if (!restore || !scrollContainerRef.current) return;
    pendingScrollRestoreRef.current = null;
    const el = scrollContainerRef.current;
    const row = el.querySelector<HTMLElement>(
      `[data-rom-row="${CSS.escape(restore.filename)}"]`,
    );
    if (!row) return;
    const elTop = el.getBoundingClientRect().top;
    el.scrollTop += row.getBoundingClientRect().top - elTop - restore.offset;
  }, [romScrollKey]);

  // feat/filter-as-you-type (#21) — Cmd/Ctrl+F focuses the filter
  // input. Mounted while this pane is active; cleans up on unmount so
  // it doesn't fire when the arcade pane is open instead.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        filterInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  // Density-bar denominator — peer max across file + folder-atomic rows.
  // folder-atomic rows ARE single games (multi-track CD, X68000-style);
  // their aggregate sizeBytes reflects one game's weight and should
  // participate in the scale. folder-container rows are excluded: their
  // aggregate spans many games and would compress every other bar.
  const maxSizeBytes = useMemo(() => {
    if (!presentableRoms) return 0;
    return presentableRoms
      .filter((r) => r.kind !== 'folder-container')
      .reduce((acc, r) => (r.sizeBytes > acc ? r.sizeBytes : acc), 0);
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
    captureScrollAnchor();
    try {
      await setRomVisibility(core.id, rom.filename, !rom.hidden, subPath);
    } catch (err) {
      pendingScrollRestoreRef.current = null; // discard on error
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
          {deferredFilter !== '' && presentableRoms !== null ? (
            <>
              Showing{' '}
              <span className="text-fg-body">{presentableRoms.length}</span> of{' '}
              <span className="text-fg-body">{preFilterCount}</span> ROMs ·{' '}
              <span className="text-fg-body">{hiddenNonSystem}</span> hidden
              {systemCount > 0 ? (
                <> · <span className="text-fg-body">{systemCount}</span> system</>
              ) : null}
            </>
          ) : (
            <>
              <span className="text-fg-body">{visibleNonSystem}</span> ROMs ·{' '}
              <span className="text-fg-body">{hiddenNonSystem}</span> hidden
              {systemCount > 0 ? (
                <>
                  {' '}
                  · <span className="text-fg-body">{systemCount}</span> system
                </>
              ) : null}
            </>
          )}
        </p>
        {/* feat/filter-as-you-type (#21) */}
        <div className="flex items-center gap-2">
          <FilterInput
            value={filterText}
            onChange={setFilterText}
            placeholder="Filter ROMs…"
            inputRef={filterInputRef}
          />
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          <SizeControl value={viewSize} onChange={setViewSize} />
        </div>
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

      {(() => {
        const sharedProps = {
          loading,
          roms,
          presentableRoms: presentableRoms ?? [],
          deferredFilter,
          onClearFilter: () => setFilterText(''),
          scrollContainerRef,
          sortState,
          onSortChange,
          selected,
          metadataByPath,
          systemFlags,
          maxSizeBytes,
          canMutate,
          backRow,
          onToggleAll,
          onToggleSelect,
          onSingleToggle,
          onRowActivate,
          setSubPath,
          setMenuFor,
          setDetailDialogFor,
          viewSize,
        } as const;
        if (viewMode === 'poster') return <RomPosterView {...sharedProps} />;
        return <RomListView {...sharedProps} />;
      })()}
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
        (() => {
          // feat/detail-modal-nav-hide — power-curation flow: prev /
          // next navigate the dialog over the SAME presentableRoms
          // list the user sees (same sort, same hidden/system
          // filters, same drill subPath). Hide flips the current
          // entry's visibility via the existing optimistic
          // setRomVisibility path; on SSH success the dialog
          // auto-advances to the next entry (or closes at end).
          const idx = presentableRoms === null
            ? -1
            : presentableRoms.findIndex(
                (r) => r.filename === detailDialogFor.filename,
              );
          const openAtRom = (next: Rom): void => {
            const lookupPath = metadataLookupPathFor(next) ?? next.path;
            const nextMeta = metadataByPath[lookupPath]?.metadata;
            setDetailDialogFor({
              path: lookupPath,
              displayName: nextMeta?.name ?? next.displayName,
              filename: next.filename,
            });
          };
          const handlePrev = (): void => {
            if (presentableRoms === null || idx <= 0) return;
            const prev = presentableRoms[idx - 1];
            if (prev !== undefined) {
              openAtRom(prev);
              scrollContainerRef.current
                ?.querySelector(`[data-rom-row="${CSS.escape(prev.filename)}"]`)
                ?.scrollIntoView({ block: 'nearest' });
            }
          };
          const handleNext = (): void => {
            if (
              presentableRoms === null ||
              idx < 0 ||
              idx >= presentableRoms.length - 1
            )
              return;
            const next = presentableRoms[idx + 1];
            if (next !== undefined) {
              openAtRom(next);
              scrollContainerRef.current
                ?.querySelector(`[data-rom-row="${CSS.escape(next.filename)}"]`)
                ?.scrollIntoView({ block: 'nearest' });
            }
          };
          const advanceOrClose = (): void => {
            if (
              presentableRoms !== null &&
              idx >= 0 &&
              idx < presentableRoms.length - 1
            ) {
              const next = presentableRoms[idx + 1];
              if (next !== undefined) openAtRom(next);
              return;
            }
            // Boundary — last entry just got hidden; close the
            // dialog rather than wrap around.
            setDetailDialogFor(null);
          };
          const currentRom =
            idx >= 0 && presentableRoms !== null
              ? (presentableRoms[idx] ?? null)
              : null;
          const hideAction =
            currentRom !== null && canMutate
              ? {
                  currentHidden: currentRom.hidden,
                  onToggle: () => {
                    const target = !currentRom.hidden;
                    void setRomVisibility(
                      core.id,
                      currentRom.filename,
                      target,
                      subPath,
                    ).then(
                      () => {
                        advanceOrClose();
                      },
                      (err: unknown) => {
                        toast.error(
                          `${target ? 'Hide' : 'Show'} failed: ${currentRom.displayName}`,
                          {
                            description:
                              err instanceof Error
                                ? err.message
                                : 'Unexpected error.',
                          },
                        );
                      },
                    );
                  },
                }
              : undefined;
          const hasPrev = idx > 0;
          const hasNext =
            presentableRoms !== null && idx >= 0 && idx < presentableRoms.length - 1;
          // Each direction independently maps to defined / undefined
          // so the dialog renders disabled buttons at boundaries
          // (per the user spec) and hides the whole nav strip only
          // when neither direction is reachable (single-entry list
          // or detailDialogFor entry not found in the visible list).
          return (
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
              onPrev={hasPrev ? handlePrev : undefined}
              onNext={hasNext ? handleNext : undefined}
              navPosition={
                presentableRoms !== null && idx >= 0
                  ? { current: idx + 1, total: presentableRoms.length }
                  : undefined
              }
              hideAction={hideAction}
            />
          );
        })()
      ) : null}
      </>
    ),
  };
}

