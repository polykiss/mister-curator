import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import {
  arcadeMraHiddenPath,
  arcadeMraVisiblePath,
} from '@shared/ledger';
import type { RomMetadata } from '@shared/metadata-types';
import type {
  ArcadeMraEntryWire,
  ArcadePlayabilityWire,
} from '@shared/preload-api';
import type { ItemListAdapter } from '@app/renderer/src/components/item-list-adapter';
import { RomDetailDialog } from '@app/renderer/src/components/RomDetailDialog';
import { RomEditMetadataDialog } from '@app/renderer/src/components/RomEditMetadataDialog';
import {
  RomRowMenu,
  type RomRowMenuItem,
} from '@app/renderer/src/components/RomRowMenu';
import { RomSearchScreenScraperDialog } from '@app/renderer/src/components/RomSearchScreenScraperDialog';
import { Button } from '@app/renderer/src/components/ui/button';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { entriesAtDepth, makeArcadeRom } from '@app/renderer/src/lib/arcade-row';
import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import {
  DEFAULT_SORT,
  nextSortState,
  sortRoms,
  type SortKey,
  type SortState,
} from '@app/renderer/src/lib/rom-sort';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';
import { usePersistedString } from '@app/renderer/src/lib/use-persisted-string';
import { filterArcadeEntries } from '@app/renderer/src/lib/filter-arcade';
import { FilterInput } from '@app/renderer/src/components/FilterInput';
import { RomListView } from '@app/renderer/src/components/RomListView';
import { RomDetailedListView } from '@app/renderer/src/components/RomDetailedListView';
import { RomPosterView } from '@app/renderer/src/components/RomPosterView';
import { ViewModeToggle } from '@app/renderer/src/components/ViewModeToggle';
import { SizeControl } from '@app/renderer/src/components/SizeControl';
import type { ArcadeRowContext, ViewMode, ViewSize } from '@app/renderer/src/lib/roms-view-props';

/**
 * feat/arcade-phase-1.5 — pane for managing `.mra` files under
 * `_Arcade/`. Distinct from RomsPane (which is heavy with metadata
 * + sort + drilling + system-file marks); this is a focused
 * listing + hide/unhide surface.
 *
 * PR 2/2 (feat/arcade-ux-and-ledger) layered on:
 *   • MISSING ROMS pill per row sourced from `getArcadePlayability`.
 *   • Auto-hide preference backed by the per-host ledger (default ON).
 *     Toggled from SettingsDialog; runs the rule diff on change.
 *   • Three-state eye-toggle tooltip: "Hide" / "Show (you hid this)"
 *     / "Show (auto-hidden because ROMs are missing)".
 *
 * feat/arcade-parity-3-ui — full visual parity with RomsPane:
 *   • Cell parity: box-art thumbnail, name + filename subline,
 *     year / genre / rating, density+eye stack. Drives the same
 *     RomMetadataCells primitives RomsPane uses.
 *   • Sortable headers for Name / Year / Genre / Rating — full
 *     parity with RomsPane's four sortable columns.
 *   • Subfolder drill: per-pane `subPath` state with the same
 *     breadcrumb + synthetic back-row pattern as RomsPane. Subfolder
 *     entries (`_Konami/`, `cores/`, etc.) render as drillable folder
 *     rows; clicking enters the directory.
 *   • Loading skeleton parity: replaces the centered spinner with 8
 *     skeleton rows so the cold-load layout matches the ROMs pane.
 *
 * `feat/arcade-refactor-1-adapter` — exposes ArcadeMraPane's logic
 * through the ItemListAdapter contract. ArcadeMraPane.tsx is a thin
 * wrapper that routes this hook's result through ItemListPane.
 */
export function useArcadeAdapter(): ItemListAdapter {
  const { status, currentProfile } = useConnection();
  const host = currentProfile?.host ?? 'default';
  const [viewMode, setViewMode] = usePersistedString<ViewMode>(
    `mistercurator.viewMode.arcade.${host}`,
    'list',
    ['list', 'detailed', 'poster'],
  );
  const [viewSize, setViewSize] = usePersistedString<ViewSize>(
    `mistercurator.viewSize.arcade.${host}`,
    'M',
    ['S', 'M', 'L', 'XL'],
  );
  // feat/pre-beta-polish-batch — single-toggle hide/show writes
  // through to the sidebar Arcade row's hidden-count badge via this
  // helper so the badge updates with the same click that flips the
  // pane row's eye icon. (Pre-fix the badge waited for the next
  // CoresContext refresh.)
  const {
    adjustArcadeHiddenCount,
    romCacheVersion,
    updateModeActive,
    autoHideEnabled,
  } = useCores();
  // Also gate on !updateModeActive: while update mode is active the
  // hidden-file state is intentionally in flux and mutations are unsafe.
  const canMutate = status === 'connected' && !updateModeActive;

  const [entries, setEntries] = useState<readonly ArcadeMraEntry[] | null>(
    null,
  );
  const [playability, setPlayability] =
    useState<ArcadePlayabilityWire | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // feat/arcade-parity-2-metadata — cached ScreenScraper metadata per
  // playable `.mra`, keyed by relativePath. Populated by a cache-only
  // IPC after the entries+playability load resolves. PR C reads it
  // through `enrichedPresentable` and threads it into the metadata
  // cells alongside RomsPane's by-path map.
  const [metadataByMra, setMetadataByMra] = useState<
    Record<string, RomMetadata | null>
  >({});
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenArcadeMras',
    false,
  );
  // feat/arcade-bulk-select-and-toolbar — per-row bulk selection.
  // Keyed by arcadeMraVisiblePath(entry.relativePath) so the key is
  // stable across hide/show (the dot-prefix rename doesn't orphan it).
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // feat/arcade-parity-3-ui (G8) — per-pane sort state, not persisted
  // (matches RomsPane). Switching panes resets to the default.
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  // feat/filter-as-you-type (#21) — per-pane text filter. Not persisted.
  const [filterText, setFilterText] = useState('');
  const deferredFilter = useDeferredValue(filterText);
  const filterInputRef = useRef<HTMLInputElement | null>(null);
  // feat/arcade-parity-3-ui (G15) — drill location inside `_Arcade/`.
  // Empty string = root; slash-joined for nested folders (e.g.
  // `_Konami`, `_Konami/sub`).
  const [subPath, setSubPath] = useState<string>('');
  // feat/arcade-parity-3-ui — detail-dialog target. Carries the entry
  // shape needed to render the modal (relativePath drives the metadata
  // lookup). Null when closed. `canManageMetadata` + `playability`
  // snapshot the entry's classification at click time so the dialog's
  // Find button greys out only for missing-zip rows (no-roms-needed
  // entries are bindable through the parallel arcade-mra-overrides
  // store), and the empty-state copy can pick the right wording.
  const [detailDialogFor, setDetailDialogFor] = useState<{
    readonly relativePath: string;
    readonly displayName: string;
    readonly filename: string;
    readonly canManageMetadata: boolean;
    readonly playability:
      | 'playable'
      | 'missing'
      | 'no-roms-needed'
      | null;
  } | null>(null);
  // feat/arcade-manual-ss-search — Find-on-ScreenScraper modal target.
  // Opened from the detail dialog's "Find on ScreenScraper..." button.
  // Carries the same shape as `detailDialogFor` plus a `path`
  // (relativePath, used only for `searchScreenScraperFor` identity);
  // the bind path is resolved on the main side via
  // `bindArcadeMetadataFromSearch` so the renderer doesn't need to
  // know the primary zip.
  const [searchScreenScraperFor, setSearchScreenScraperFor] = useState<{
    readonly relativePath: string;
    readonly displayName: string;
    readonly filename: string;
  } | null>(null);
  // feat/arcade-polish-context-menu — per-row more-menu anchor. The
  // dropdown carries "Find on ScreenScraper..." + "Edit Metadata..."
  // for visual parity with RomsPane. Both items are disabled when the
  // row's primary zip isn't present (no md5 to bind/edit against);
  // see `canManageMetadata` below.
  const [menuFor, setMenuFor] = useState<{
    readonly entry: {
      readonly relativePath: string;
      readonly displayName: string;
      readonly filename: string;
    };
    readonly canManageMetadata: boolean;
    readonly hasMetadata: boolean;
    readonly x: number;
    readonly y: number;
  } | null>(null);
  // feat/arcade-bind-density-edit — edit-metadata modal target.
  // Carries the entry plus a snapshot of its current metadata so the
  // dialog can render the form pre-filled. Closing setEditMetadataFor
  // to null tears the dialog down.
  const [editMetadataFor, setEditMetadataFor] = useState<{
    readonly relativePath: string;
    readonly displayName: string;
    readonly metadata: RomMetadata;
  } | null>(null);

  const refresh = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const [wire, play] = await Promise.all([
          window.mister.listArcadeMraEntries({ forceRefresh }),
          window.mister.getArcadePlayability(),
        ]);
        setEntries(wireToEntries(wire));
        setPlayability(play);
        void window.mister
          .getArcadeMetadataBatch()
          .then((batch) => setMetadataByMra(batch))
          .catch(() => {
            // Best-effort — empty map keeps cells rendering em-dashes.
          });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load arcade entries.';
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Track whether this is the initial mount so we can distinguish
  // the lazy first-load (forceRefresh: false — allow the in-memory
  // cache to hit) from a re-fire triggered by the user pressing
  // Refresh (romCacheVersion bumps — forceRefresh: true to bypass
  // the stale arcade listing cache and reload from device).
  const isInitialArcadeMountRef = useRef(true);
  useEffect(() => {
    const forceRefresh = !isInitialArcadeMountRef.current;
    isInitialArcadeMountRef.current = false;
    void refresh(forceRefresh);
    // romCacheVersion: re-fire when CoresContext clears its ROM cache
    // (user pressed Refresh). Parity with the roms-adapter ensureRoms
    // effect so both panes reflect the Refresh in a single click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refresh, romCacheVersion]);

  // Every `.mra` at any depth — drives the header chip and the
  // Hide all / Show all bulk buttons. Pre-PR-C this filtered to
  // top-level mras only because nested mras weren't reachable; the
  // drill view now exposes them so the counts reflect the tree.
  const mraRows = useMemo(() => {
    if (entries === null) return [];
    return entries.filter((e) => e.kind === 'mra');
  }, [entries]);

  const playabilityByPath = useMemo(() => {
    const map = new Map<string, 'playable' | 'missing' | 'no-roms-needed'>();
    if (playability === null) return map;
    for (const p of playability.playable) map.set(p, 'playable');
    for (const p of playability.missing) map.set(p, 'missing');
    for (const p of playability.noRomsNeeded) map.set(p, 'no-roms-needed');
    return map;
  }, [playability]);

  // Entries at the current drill depth. Subfolder entries (kind !==
  // 'mra') pass through as drillable rows; the back-row is rendered
  // separately above this list. `showHidden` is threaded into the
  // depth filter so:
  //   • hidden mras / subfolders at this depth disappear when off, and
  //   • a folder whose subtree contains ONLY hidden mras (the live
  //     `_alternatives/` case where every alt is auto-hidden) also
  //     disappears, instead of surfacing as a row that drills into an
  //     empty list.
  const presentable = useMemo(
    () => (entries === null ? [] : entriesAtDepth(entries, subPath, showHidden)),
    [entries, subPath, showHidden],
  );

  // feat/filter-as-you-type (#21) — text filter applied after visibility
  // filtering but before sort. `deferredFilter` defers the computation so
  // keystrokes stay responsive. allEntries is passed for subfolder child
  // matching (a subfolder row is included when a descendant .mra matches).
  const filteredPresentable = useMemo(
    () => filterArcadeEntries(presentable, deferredFilter, metadataByMra, entries ?? []),
    [presentable, deferredFilter, metadataByMra, entries],
  );

  // Enrich each entry with a synthetic Rom (kind='file' for mras,
  // 'folder-container' for subfolders so `sortRoms` pins them) plus
  // the cached metadata record. `rom.filename === entry.relativePath`
  // is bijective with the entry, used to round-trip back after sort.
  const enrichedPresentable = useMemo(
    () =>
      filteredPresentable.map((entry) => ({
        ...entry,
        rom: makeArcadeRom(entry),
        metadata: metadataByMra[entry.relativePath] ?? null,
      })),
    [filteredPresentable, metadataByMra],
  );

  const sortedRows = useMemo(() => {
    const sorted = sortRoms(
      enrichedPresentable.map((r) => ({ rom: r.rom, metadata: r.metadata })),
      sortState,
    );
    const byPath = new Map(
      enrichedPresentable.map((r) => [r.rom.filename, r]),
    );
    const out: (typeof enrichedPresentable)[number][] = [];
    for (const s of sorted) {
      const matched = byPath.get(s.rom.filename);
      if (matched !== undefined) out.push(matched);
    }
    return out;
  }, [enrichedPresentable, sortState]);

  // Purge stale selections whenever the visible row set changes (filter
  // toggle, hide operation, subPath change). Uses the normalized key so
  // a hide/show that changes relativePath doesn't orphan a selection.
  useEffect(() => {
    setSelectedKeys((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(
        sortedRows
          .filter((r) => r.kind === 'mra')
          .map((r) => arcadeMraVisiblePath(r.relativePath)),
      );
      const next = new Set<string>();
      for (const k of prev) {
        if (visible.has(k)) next.add(k);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [sortedRows]);

  const visibleSelectedCount = useMemo(
    () =>
      sortedRows.filter(
        (r) =>
          r.kind === 'mra' &&
          !r.hidden &&
          selectedKeys.has(arcadeMraVisiblePath(r.relativePath)),
      ).length,
    [sortedRows, selectedKeys],
  );

  const hiddenSelectedCount = useMemo(
    () =>
      sortedRows.filter(
        (r) =>
          r.kind === 'mra' &&
          r.hidden &&
          selectedKeys.has(arcadeMraVisiblePath(r.relativePath)),
      ).length,
    [sortedRows, selectedKeys],
  );

  // feat/arcade-polish-context-menu — density-bar denominator. Max
  // primary-zip size across the currently-visible rows (matches the
  // RomsPane convention: per-pane peer max, not a global). Folder
  // rows contribute 0, so they don't skew the scale.
  const maxSizeBytes = useMemo(() => {
    let max = 0;
    for (const row of enrichedPresentable) {
      if (row.rom.sizeBytes > max) max = row.rom.sizeBytes;
    }
    return max;
  }, [enrichedPresentable]);

  const visibleCount = mraRows.filter((e) => !e.hidden).length;
  const hiddenCount = mraRows.filter((e) => e.hidden).length;

  // refactor/arcade-under-rom-list-view: sort-change callback and
  // metadataByPath conversion needed by RomListView.
  const onSortChange = useCallback((key: SortKey) => {
    setSortState((prev) => nextSortState(prev, key));
  }, []);

  // metadataByPath for RomListView: convert metadataByMra (keyed by
  // relativePath) to the {metadata, error} shape keyed by rom.path
  // (/media/fat/_Arcade/${relativePath}).
  const metadataByPathForView = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(metadataByMra).map(([k, v]) => [
          `/media/fat/_Arcade/${k}`,
          { metadata: v, error: false as const },
        ]),
      ),
    [metadataByMra],
  );

  // systemFlags: arcade has no system-file concept; use a stable empty map.
  const EMPTY_SYSTEM_FLAGS = useMemo(() => new Map<string, boolean>(), []);
  // feat/filter-as-you-type (#21) — count of .mra entries in the
  // filtered view at the current depth (used for "Showing N of M").
  const filteredMraCount = filteredPresentable.filter((e) => e.kind === 'mra').length;
  const preFilterMraCount = presentable.filter((e) => e.kind === 'mra').length;

  /**
   * feat/pre-beta-polish-batch — optimistic single-toggle hide/show.
   *
   * Pre-fix: click → spinner → SSH rename (~hundreds of ms) → refresh
   * (re-list `_Arcade/` + re-parse mras + re-fetch metadata) → eye
   * icon flips. The user perceives this as the row being unresponsive
   * for the full SSH round-trip.
   *
   * Post-fix: the eye icon, the row's dimmed state, and the sidebar
   * Arcade row's `(hiddenCount)` badge all flip on the click; the
   * SSH rename runs in the background. If the rename rejects, every
   * piece of optimistic state reverts and a toast surfaces the
   * reason. No refresh on success — the optimistic state matches
   * what a fresh listing would return.
   *
   * State touched (and reverted on failure):
   *   • `entries[i].hidden`        flip
   *   • `entries[i].relativePath`  dot-prefix add/strip via
   *                                arcadeMraHiddenPath / Visible
   *   • `metadataByMra` key        re-keyed so the row's metadata
   *                                stays attached through the path
   *                                rename
   *   • CoresContext.cores         hiddenCount ±1 on the synthetic
   *                                Arcade row (sidebar badge)
   */
  /**
   * feat/detail-modal-nav-hide — Promise-returning core of the
   * optimistic hide/show. The row-view eye toggle wraps this in a
   * fire-and-forget catch + toast (`onToggleSingle` below); the
   * detail-dialog's hide button awaits this so it can advance
   * on success / surface a toast and stay on failure. The optimistic
   * UI flips (entry.hidden, relativePath, metadata key, sidebar
   * hidden-count) happen synchronously BEFORE the SSH call so the
   * row's eye flips the instant the click lands; on rejection
   * every flip reverts in the inverse order and the promise rejects.
   */
  const applyArcadeMraVisibility = (
    entry: ArcadeMraEntry,
    next: boolean,
  ): Promise<void> => {
    const originalPath = entry.relativePath;
    const predictedPath = next
      ? arcadeMraHiddenPath(originalPath)
      : arcadeMraVisiblePath(originalPath);
    // 1. Flip the pane row.
    setEntries((prev) => {
      if (prev === null) return prev;
      return prev.map((e) =>
        e.relativePath === originalPath
          ? { ...e, hidden: next, relativePath: predictedPath }
          : e,
      );
    });
    // 2. Move the metadata under the new key so the row keeps its
    //    box art / title across the flip.
    setMetadataByMra((prev) => {
      if (!(originalPath in prev)) return prev;
      const rekeyed: Record<string, RomMetadata | null> = {};
      for (const [key, value] of Object.entries(prev)) {
        if (key === originalPath) continue;
        rekeyed[key] = value;
      }
      rekeyed[predictedPath] = prev[originalPath] ?? null;
      return rekeyed;
    });
    // 3. Nudge the sidebar Arcade row's hidden-count badge.
    adjustArcadeHiddenCount(next ? 1 : -1);

    // 4. Background SSH rename. On rejection, revert every
    //    optimistic write and re-throw so awaiting callers can
    //    decide whether to surface a toast / skip an advance.
    return window.mister
      .setArcadeMraVisibility(originalPath, next)
      .catch((err: unknown) => {
        adjustArcadeHiddenCount(next ? -1 : 1);
        setMetadataByMra((prev) => {
          if (!(predictedPath in prev)) return prev;
          const rekeyed: Record<string, RomMetadata | null> = {};
          for (const [key, value] of Object.entries(prev)) {
            if (key === predictedPath) continue;
            rekeyed[key] = value;
          }
          rekeyed[originalPath] = prev[predictedPath] ?? null;
          return rekeyed;
        });
        setEntries((prev) => {
          if (prev === null) return prev;
          return prev.map((e) =>
            e.relativePath === predictedPath
              ? { ...e, hidden: entry.hidden, relativePath: originalPath }
              : e,
          );
        });
        throw err;
      });
  };

  /**
   * feat/pre-beta-polish-batch — optimistic single-toggle hide/show
   * (row-view eye button). Fire-and-forget wrapper that surfaces a
   * toast on failure.
   */
  const onToggleSingle = (entry: ArcadeMraEntry): void => {
    if (!canMutate) return;
    captureArcadeScrollAnchor();
    const next = !entry.hidden;
    void applyArcadeMraVisibility(entry, next).catch((err: unknown) => {
      arcadePendingScrollRef.current = null; // discard on error
      toast.error(
        `${next ? 'Hide' : 'Show'} failed: ${entry.displayName}`,
        {
          description:
            err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    });
  };

  // refactor/arcade-under-rom-list-view: ArcadeRowContext bundles the 6
  // arcade/ROM behavioral differences so RomListView stays generic.
  const arcadeRowContext: ArcadeRowContext = {
    isFolderRow: (rom) => rom.kind === 'folder-container',
    playabilityByPath,
    checkboxKey: (rom) => arcadeMraVisiblePath(rom.filename),
    openDetail: (rom, metadata) => {
      const classification = playabilityByPath.get(rom.filename) ?? null;
      const canManageMetadata =
        classification === 'playable' || classification === 'no-roms-needed';
      setDetailDialogFor({
        relativePath: rom.filename,
        displayName: metadata?.name ?? rom.displayName,
        filename: rom.filename,
        canManageMetadata,
        playability: classification,
      });
    },
    openMenu: (rom, metadata, x, y) => {
      const classification = playabilityByPath.get(rom.filename) ?? null;
      const canManageMetadata =
        classification === 'playable' || classification === 'no-roms-needed';
      setMenuFor({
        entry: {
          relativePath: rom.filename,
          displayName: metadata?.name ?? rom.displayName,
          filename: rom.filename,
        },
        canManageMetadata,
        hasMetadata: metadata !== null,
        x,
        y,
      });
    },
    singleToggle: (rom) =>
      onToggleSingle({
        relativePath: rom.filename,
        displayName: rom.displayName,
        kind: 'mra',
        hidden: rom.hidden,
      }),
  };

  // onRowActivate for RomListView: drills into arcade subfolder rows
  // (isFolder rows get row-level onClick → onRowActivate in RomListView).
  const onRowActivateArcade = (rom: { readonly filename: string }): void => {
    setSubPath(rom.filename);
  };

  const runBulk = async (target: 'hide' | 'show'): Promise<void> => {
    const changes = mraRows
      .filter((e) => (target === 'hide' ? !e.hidden : e.hidden))
      .map((e) => ({ relativePath: e.relativePath, hidden: target === 'hide' }));
    if (changes.length === 0) return;
    try {
      const result = await window.mister.setBulkArcadeMraVisibility(changes);
      const summary = summarizeBulkResult({
        action: target === 'hide' ? 'Hid' : 'Restored',
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
      await refresh(true);
    } catch (err) {
      toast.error(
        target === 'hide' ? 'Hid failed' : 'Restored failed',
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    }
  };

  const onToggleSelect = (key: string, checked: boolean): void => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const onToggleAll = (checked: boolean): void => {
    setSelectedKeys(
      checked
        ? new Set(
            sortedRows
              .filter((r) => r.kind === 'mra')
              .map((r) => arcadeMraVisiblePath(r.relativePath)),
          )
        : new Set(),
    );
  };

  const onHideSelected = async (): Promise<void> => {
    const targets = sortedRows.filter(
      (r) =>
        r.kind === 'mra' &&
        !r.hidden &&
        selectedKeys.has(arcadeMraVisiblePath(r.relativePath)),
    );
    if (targets.length === 0) return;
    const pathMap = new Map<string, string>(
      targets.map((t) => [t.relativePath, arcadeMraHiddenPath(t.relativePath)]),
    );
    setEntries((prev) => {
      if (prev === null) return prev;
      return prev.map((e) => {
        const predicted = pathMap.get(e.relativePath);
        return predicted !== undefined
          ? { ...e, hidden: true, relativePath: predicted }
          : e;
      });
    });
    setMetadataByMra((prev) => {
      const next: Record<string, RomMetadata | null> = {};
      for (const [key, value] of Object.entries(prev)) {
        const predicted = pathMap.get(key);
        next[predicted ?? key] = value;
      }
      return next;
    });
    adjustArcadeHiddenCount(targets.length);
    setSelectedKeys(new Set());
    try {
      const changes = targets.map((t) => ({
        relativePath: t.relativePath,
        hidden: true,
      }));
      const result = await window.mister.setBulkArcadeMraVisibility(changes);
      const summary = summarizeBulkResult({
        action: 'Hid',
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
      if (result.failed.length > 0) await refresh(true);
    } catch (err) {
      const reverseMap = new Map<string, string>(
        targets.map((t) => [arcadeMraHiddenPath(t.relativePath), t.relativePath]),
      );
      setEntries((prev) => {
        if (prev === null) return prev;
        return prev.map((e) => {
          const original = reverseMap.get(e.relativePath);
          return original !== undefined
            ? { ...e, hidden: false, relativePath: original }
            : e;
        });
      });
      setMetadataByMra((prev) => {
        const next: Record<string, RomMetadata | null> = {};
        for (const [key, value] of Object.entries(prev)) {
          const original = reverseMap.get(key);
          next[original ?? key] = value;
        }
        return next;
      });
      adjustArcadeHiddenCount(-targets.length);
      toast.error('Hide selected failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onShowSelected = async (): Promise<void> => {
    const targets = sortedRows.filter(
      (r) =>
        r.kind === 'mra' &&
        r.hidden &&
        selectedKeys.has(arcadeMraVisiblePath(r.relativePath)),
    );
    if (targets.length === 0) return;
    const pathMap = new Map<string, string>(
      targets.map((t) => [t.relativePath, arcadeMraVisiblePath(t.relativePath)]),
    );
    setEntries((prev) => {
      if (prev === null) return prev;
      return prev.map((e) => {
        const predicted = pathMap.get(e.relativePath);
        return predicted !== undefined
          ? { ...e, hidden: false, relativePath: predicted }
          : e;
      });
    });
    setMetadataByMra((prev) => {
      const next: Record<string, RomMetadata | null> = {};
      for (const [key, value] of Object.entries(prev)) {
        const predicted = pathMap.get(key);
        next[predicted ?? key] = value;
      }
      return next;
    });
    adjustArcadeHiddenCount(-targets.length);
    setSelectedKeys(new Set());
    try {
      const changes = targets.map((t) => ({
        relativePath: t.relativePath,
        hidden: false,
      }));
      const result = await window.mister.setBulkArcadeMraVisibility(changes);
      const summary = summarizeBulkResult({
        action: 'Restored',
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
      if (result.failed.length > 0) await refresh(true);
    } catch (err) {
      const reverseMap = new Map<string, string>(
        targets.map((t) => [arcadeMraVisiblePath(t.relativePath), t.relativePath]),
      );
      setEntries((prev) => {
        if (prev === null) return prev;
        return prev.map((e) => {
          const original = reverseMap.get(e.relativePath);
          return original !== undefined
            ? { ...e, hidden: true, relativePath: original }
            : e;
        });
      });
      setMetadataByMra((prev) => {
        const next: Record<string, RomMetadata | null> = {};
        for (const [key, value] of Object.entries(prev)) {
          const original = reverseMap.get(key);
          next[original ?? key] = value;
        }
        return next;
      });
      adjustArcadeHiddenCount(targets.length);
      toast.error('Unhide selected failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  // Refresh arcade entries when auto-hide is toggled from the Settings
  // modal. CoresContext.setAutoHideEnabled handles the IPC write and
  // optimistic state update; this effect fires when the context value
  // changes so the arcade pane reflects the on-device rule diff
  // (entries un-dotted or re-dotted after the bulk rename) without
  // requiring the user to manually Refresh. Skip the first settled
  // value (initial load from null → bool) since the pane is already
  // loading at that point.
  const prevAutoHideRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (autoHideEnabled === null) return;
    if (prevAutoHideRef.current !== null && prevAutoHideRef.current !== autoHideEnabled) {
      void refresh(true);
    }
    prevAutoHideRef.current = autoHideEnabled;
  }, [autoHideEnabled, refresh]);

  // Bug E — scroll preservation for arcade single-toggle (mirrors the
  // roms-adapter pattern). Anchor the first partially-visible row
  // before the optimistic flip; restore after the list re-renders.
  const arcadeScrollContainerRef = useRef<HTMLDivElement>(null);
  const arcadePendingScrollRef = useRef<{
    readonly filename: string;
    readonly offset: number;
  } | null>(null);
  const captureArcadeScrollAnchor = useCallback(() => {
    const el = arcadeScrollContainerRef.current;
    if (!el) return;
    const elTop = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>('[data-arcade-row]');
    for (const row of rows) {
      if (row.getBoundingClientRect().bottom > elTop + 1) {
        arcadePendingScrollRef.current = {
          filename: row.getAttribute('data-arcade-row') ?? '',
          offset: row.getBoundingClientRect().top - elTop,
        };
        return;
      }
    }
  }, []);
  useLayoutEffect(() => {
    const restore = arcadePendingScrollRef.current;
    if (!restore || !arcadeScrollContainerRef.current) return;
    arcadePendingScrollRef.current = null;
    const el = arcadeScrollContainerRef.current;
    const row = el.querySelector<HTMLElement>(
      `[data-arcade-row="${CSS.escape(restore.filename)}"]`,
    );
    if (!row) return;
    const elTop = el.getBoundingClientRect().top;
    el.scrollTop += row.getBoundingClientRect().top - elTop - restore.offset;
  }, [sortedRows]);

  // feat/filter-as-you-type (#21) — Cmd/Ctrl+F focuses the filter input.
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

  const breadcrumb = computeBreadcrumb('Arcade', subPath);
  const backRow = computeBackRow('Arcade', subPath);

  function navigateToDepth(targetDepth: number): void {
    setSubPath(subPathAtDepth(subPath, targetDepth));
  }

  // feat/arcade-refactor-1-adapter — `containerClassName` is the
  // pane's surface tone; ItemListPane composes it with the shared
  // `'flex h-full flex-col'` outer container.
  return {
    kind: 'arcade',
    containerClassName: 'bg-canvas',
    content: (
      <>
      <header className="flex flex-col gap-3 border-b border-subtle bg-chrome px-4 py-3">
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
          {deferredFilter !== '' ? (
            <>
              Showing{' '}
              <span className="text-fg-body">{filteredMraCount}</span> of{' '}
              <span className="text-fg-body">{preFilterMraCount}</span> ROMs ·{' '}
              <span className="text-fg-body">{hiddenCount}</span> hidden
            </>
          ) : (
            <>
              <span className="text-fg-body">{visibleCount}</span> ROMs ·{' '}
              <span className="text-fg-body">{hiddenCount}</span> hidden
            </>
          )}
        </p>
        {/* feat/filter-as-you-type (#21) */}
        <div className="flex items-center gap-2">
          <FilterInput
            value={filterText}
            onChange={setFilterText}
            placeholder="Filter MRAs…"
            inputRef={filterInputRef}
          />
          <ViewModeToggle value={viewMode} onChange={setViewMode} />
          {viewMode !== 'list' ? (
            <SizeControl value={viewSize} onChange={setViewSize} />
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runBulk('hide')}
            disabled={!canMutate || mraRows.every((r) => r.hidden)}
            title={
              canMutate
                ? 'Hide every visible .mra so it disappears from the MiSTer arcade menu.'
                : 'Reconnect to make changes.'
            }
          >
            Hide all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void runBulk('show')}
            disabled={!canMutate || mraRows.every((r) => !r.hidden)}
            title={
              canMutate
                ? 'Restore every hidden .mra back into the MiSTer arcade menu.'
                : 'Reconnect to make changes.'
            }
          >
            Unhide all
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onHideSelected()}
            disabled={!canMutate || visibleSelectedCount === 0}
            title={canMutate ? undefined : 'Reconnect to make changes.'}
          >
            Hide selected ({visibleSelectedCount})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onShowSelected()}
            disabled={!canMutate || hiddenSelectedCount === 0}
            title={canMutate ? undefined : 'Reconnect to make changes.'}
          >
            Unhide selected ({hiddenSelectedCount})
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
        </div>
      </header>

      {/* feat/arcade-scrollbar-gap-parity — match RomsPane + CoresPane:
          `scroll-themed` reserves a stable scrollbar gutter and paints a
          permanent themed bar; `pr-2.5` adds the explicit 10px right
          padding so the rightmost cell (density + eye stack) sits well
          clear of the scrollbar. Without these, arcade rows extended
          to a slightly different right edge than RomsPane rows because
          the macOS overlay scrollbar shifted them inward. */}
      {loading && entries === null ? (
        <div className="scroll-themed flex-1 overflow-auto pr-2.5">
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </div>
      ) : error !== null ? (
        <div ref={arcadeScrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
          <div className="p-4 text-body-sm text-destructive">{error}</div>
        </div>
      ) : entries === null || mraRows.length === 0 ? (
        <div ref={arcadeScrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
          <div className="p-4 text-body-sm text-fg-muted">
            No .mra files found in _Arcade/.
          </div>
        </div>
      ) : enrichedPresentable.length === 0 && backRow === null ? (
        <div ref={arcadeScrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
          <div className="p-4 text-body-sm text-fg-muted">
            {deferredFilter !== '' ? (
              <>
                No MRAs match &ldquo;{deferredFilter}&rdquo;.{' '}
                <button
                  type="button"
                  onClick={() => setFilterText('')}
                  className="underline hover:text-fg"
                >
                  Clear filter
                </button>
              </>
            ) : 'All .mra files are hidden \u2014 toggle "Show hidden" to manage them.'}
          </div>
        </div>
      ) : (
        (() => {
          const sharedProps = {
            loading: false,
            roms: enrichedPresentable.map((e) => e.rom),
            presentableRoms: sortedRows.map((e) => e.rom),
            deferredFilter,
            onClearFilter: () => setFilterText(''),
            scrollContainerRef: arcadeScrollContainerRef,
            sortState,
            onSortChange,
            selected: selectedKeys,
            metadataByPath: metadataByPathForView,
            systemFlags: EMPTY_SYSTEM_FLAGS,
            maxSizeBytes,
            canMutate,
            backRow,
            onToggleAll,
            onToggleSelect,
            onSingleToggle: arcadeRowContext.singleToggle,
            onRowActivate: onRowActivateArcade,
            setSubPath,
            setMenuFor: () => { /* no-op: handled by arcadeContext.openMenu */ },
            setDetailDialogFor: () => { /* no-op: handled by arcadeContext.openDetail */ },
            arcadeContext: arcadeRowContext,
            viewSize,
          } as const;
          if (viewMode === 'detailed') return <RomDetailedListView {...sharedProps} />;
          if (viewMode === 'poster') return <RomPosterView {...sharedProps} />;
          return <RomListView {...sharedProps} />;
        })()
      )}
      </>
    ),
    // feat/arcade-parity-3-ui — metadata detail modal. Opens on click
    // of the name cell. Renders unconditionally for any open
    // `detailDialogFor`; the dialog's empty-state branch handles
    // entries whose ScreenScraper match hasn't landed yet (placeholder
    // box art + "No metadata yet" note).
    //
    // feat/arcade-noromsneeded-overrides — `allowSearch` is derived
    // from the entry's playability (captured at click time):
    //   • playable / no-roms-needed → enabled (zip-md5 or mra-keyed
    //     override store handles the bind).
    //   • missing                   → disabled; can't bind without a
    //                                 zip on disk.
    // The empty-state copy branches three ways via emptyStateBody so
    // the wording matches the actual user recourse for each state.
    extras: (
      <>
        {detailDialogFor !== null ? (
          (() => {
            // feat/detail-modal-nav-hide — power-curation flow over
            // the SAME `sortedRows` list (mras + subfolders the user
            // currently sees, in their currently-applied sort order).
            // Nav goes between MRA rows ONLY — subfolder rows aren't
            // openable in the detail dialog so they're filtered out
            // for navigation index math. Hide flips the current
            // entry's visibility via the optimistic
            // `applyArcadeMraVisibility` path; on SSH success the
            // dialog auto-advances (or closes at the end).
            const mraOnly = sortedRows.filter(
              (r) => r.kind === 'mra',
            );
            const idx = mraOnly.findIndex(
              (r) => r.relativePath === detailDialogFor.relativePath,
            );
            const openAtEntry = (target: (typeof mraOnly)[number]): void => {
              const classification =
                playabilityByPath.get(target.relativePath) ?? null;
              const canManageMetadata =
                classification === 'playable' ||
                classification === 'no-roms-needed';
              const meta = metadataByMra[target.relativePath] ?? null;
              setDetailDialogFor({
                relativePath: target.relativePath,
                displayName: meta?.name ?? target.displayName,
                filename: target.rom.filename,
                canManageMetadata,
                playability: classification,
              });
            };
            const handlePrev = (): void => {
              if (idx <= 0) return;
              const prev = mraOnly[idx - 1];
              if (prev !== undefined) {
                openAtEntry(prev);
                arcadeScrollContainerRef.current
                  ?.querySelector(`[data-arcade-row="${CSS.escape(prev.rom.filename)}"]`)
                  ?.scrollIntoView({ block: 'nearest' });
              }
            };
            const handleNext = (): void => {
              if (idx < 0 || idx >= mraOnly.length - 1) return;
              const next = mraOnly[idx + 1];
              if (next !== undefined) {
                openAtEntry(next);
                arcadeScrollContainerRef.current
                  ?.querySelector(`[data-arcade-row="${CSS.escape(next.rom.filename)}"]`)
                  ?.scrollIntoView({ block: 'nearest' });
              }
            };
            const advanceOrClose = (): void => {
              if (idx >= 0 && idx < mraOnly.length - 1) {
                const next = mraOnly[idx + 1];
                if (next !== undefined) {
                  openAtEntry(next);
                  return;
                }
              }
              setDetailDialogFor(null);
            };
            const currentEntry = idx >= 0 ? mraOnly[idx] : undefined;
            // missing-zip arcade rows can't be hidden via the dot
            // rename — the file IS the `.mra` but the playability
            // checker reads its referenced zips. The eye toggle in
            // the row view is wired anyway (hide still works on the
            // .mra itself), so allow the dialog button too unless
            // we're disconnected.
            const hideAction =
              currentEntry !== undefined && canMutate
                ? {
                    currentHidden: currentEntry.hidden,
                    onToggle: () => {
                      const next = !currentEntry.hidden;
                      void applyArcadeMraVisibility(
                        currentEntry,
                        next,
                      ).then(
                        () => {
                          advanceOrClose();
                        },
                        (err: unknown) => {
                          toast.error(
                            `${next ? 'Hide' : 'Show'} failed: ${currentEntry.displayName}`,
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
            const hasNext = idx >= 0 && idx < mraOnly.length - 1;
            return (
              <RomDetailDialog
                path={detailDialogFor.relativePath}
                filename={detailDialogFor.filename}
                metadata={metadataByMra[detailDialogFor.relativePath] ?? null}
                open
                onOpenChange={(open) => {
                  if (!open) setDetailDialogFor(null);
                }}
                onEdit={() => {
                  // feat/arcade-edit-detail-alignment — Edit Metadata
                  // is now wired into the detail dialog (was
                  // context-menu only). The dialog only renders the
                  // PopulatedDetailDialog when `metadata !== null`,
                  // so by the time onEdit fires we always have a
                  // record to hand to RomEditMetadataDialog.
                  const meta =
                    metadataByMra[detailDialogFor.relativePath] ?? null;
                  if (meta === null) return;
                  setEditMetadataFor({
                    relativePath: detailDialogFor.relativePath,
                    displayName: detailDialogFor.displayName,
                    metadata: meta,
                  });
                }}
                onSearch={() => {
                  setSearchScreenScraperFor({
                    relativePath: detailDialogFor.relativePath,
                    displayName: detailDialogFor.displayName,
                    filename: detailDialogFor.filename,
                  });
                }}
                allowEdit={detailDialogFor.canManageMetadata}
                allowSearch={detailDialogFor.canManageMetadata}
                emptyStateBody={arcadeEmptyStateBody(
                  detailDialogFor.playability,
                )}
                onPrev={hasPrev ? handlePrev : undefined}
                onNext={hasNext ? handleNext : undefined}
                navPosition={
                  idx >= 0
                    ? { current: idx + 1, total: mraOnly.length }
                    : undefined
                }
                hideAction={hideAction}
              />
            );
          })()
        ) : null}
        {searchScreenScraperFor !== null ? (
          <RomSearchScreenScraperDialog
            filename={searchScreenScraperFor.filename}
            // SS systemeid resolution uses coreId='mame' → 75, the
            // same id the auto-scrape pass uses for arcade entries.
            coreId="mame"
            coreLabel="Arcade"
            open
            onOpenChange={(open) => {
              if (!open) setSearchScreenScraperFor(null);
            }}
            onBind={(game) =>
              window.mister.bindArcadeMetadataFromSearch(
                searchScreenScraperFor.relativePath,
                game,
              )
            }
            onSaved={() => {
              // The bind writes by primary-zip md5; every .mra
              // sharing that zip sees the new record. A full refresh
              // is the simplest correct way to surface the update —
              // the metadata batch IPC is cache-only (no SSH) so the
              // refresh is cheap.
              void refresh(false);
            }}
          />
        ) : null}
        {editMetadataFor !== null ? (
          <RomEditMetadataDialog
            path={editMetadataFor.relativePath}
            displayName={editMetadataFor.displayName}
            metadata={editMetadataFor.metadata}
            open
            onOpenChange={(open) => {
              if (!open) setEditMetadataFor(null);
            }}
            onSave={(override) =>
              window.mister.setArcadeMetadataOverride(
                editMetadataFor.relativePath,
                override,
              )
            }
            onSaved={() => {
              void refresh(false);
            }}
          />
        ) : null}
        {menuFor !== null
          ? (() => {
              const target = menuFor.entry;
              const canSearch = menuFor.canManageMetadata;
              const canEdit = menuFor.canManageMetadata && menuFor.hasMetadata;
              const missingZipTooltip =
                'Install the ROM to enable metadata search.';
              const noMetadataTooltip =
                'No metadata yet — use Find on ScreenScraper first.';
              const items: readonly RomRowMenuItem[] = [
                {
                  label: 'Find on ScreenScraper...',
                  onSelect: () => setSearchScreenScraperFor(target),
                  disabled: !canSearch,
                  title: canSearch ? undefined : missingZipTooltip,
                },
                {
                  label: 'Edit Metadata...',
                  onSelect: () => {
                    const meta =
                      metadataByMra[target.relativePath] ?? null;
                    if (meta === null) return;
                    setEditMetadataFor({
                      relativePath: target.relativePath,
                      displayName: target.displayName,
                      metadata: meta,
                    });
                  },
                  disabled: !canEdit,
                  title: canEdit
                    ? undefined
                    : menuFor.canManageMetadata
                      ? noMetadataTooltip
                      : missingZipTooltip,
                },
              ];
              return (
                <RomRowMenu
                  x={menuFor.x}
                  y={menuFor.y}
                  items={items}
                  onClose={() => setMenuFor(null)}
                />
              );
            })()
          : null}
      </>
    ),
  };
}

/**
 * feat/arcade-noromsneeded-overrides — three-tier empty-state copy
 * for the arcade detail dialog. `undefined` means "use the dialog's
 * default text" (i.e., the playable case, where the auto-scrape pass
 * might still match the entry on its own).
 */
function arcadeEmptyStateBody(
  playability: 'playable' | 'missing' | 'no-roms-needed' | null,
): string | undefined {
  if (playability === 'missing') {
    return 'Install the ROM zip to enable metadata search.';
  }
  if (playability === 'no-roms-needed') {
    // No auto-scrape recourse for these (TTL games like Pong have no
    // zip to hash; the prefetch never reaches them). Manual search is
    // the only path, so drop the "or wait for the prefetch to land"
    // tail from the default copy.
    return 'ScreenScraper hasn\'t matched this entry. Click "Find on ScreenScraper" to search manually.';
  }
  return undefined;
}

function wireToEntries(
  wire: readonly ArcadeMraEntryWire[],
): readonly ArcadeMraEntry[] {
  // The wire shape is structurally identical to ArcadeMraEntry — the
  // cast is safe and avoids a per-row clone for ~thousands of entries.
  return wire as readonly ArcadeMraEntry[];
}

