import { Eye, EyeOff, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import type { ArcadeMraEntry } from '@shared/arcade-mra';
import type { RomMetadata } from '@shared/metadata-types';
import type {
  ArcadeMraEntryWire,
  ArcadePlayabilityWire,
} from '@shared/preload-api';
import type { ItemListAdapter } from '@app/renderer/src/components/item-list-adapter';
import {
  BackThumbnailCell,
  RomDensityEyeCell,
  RomMetadataInfoCells,
  RomNameInner,
  RomThumbnailCell,
  RomYearCell,
} from '@app/renderer/src/components/RomMetadataCells';
import { RomDetailDialog } from '@app/renderer/src/components/RomDetailDialog';
import { RomSearchScreenScraperDialog } from '@app/renderer/src/components/RomSearchScreenScraperDialog';
import { SortableHeader } from '@app/renderer/src/components/SortableHeader';
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
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { entriesAtDepth, makeArcadeRom } from '@app/renderer/src/lib/arcade-row';
import {
  computeBackRow,
  computeBreadcrumb,
  subPathAtDepth,
} from '@app/renderer/src/lib/breadcrumb';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import {
  DEFAULT_SORT,
  nextSortState,
  sortRoms,
  type SortState,
} from '@app/renderer/src/lib/rom-sort';
import { classifyRow } from '@app/renderer/src/lib/row-type';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

/**
 * feat/arcade-phase-1.5 — pane for managing `.mra` files under
 * `_Arcade/`. Distinct from RomsPane (which is heavy with metadata
 * + sort + drilling + system-file marks); this is a focused
 * listing + hide/unhide surface.
 *
 * PR 2/2 (feat/arcade-ux-and-ledger) layered on:
 *   • MISSING ROMS pill per row sourced from `getArcadePlayability`.
 *   • "Auto-hide missing ROMs" persisted checkbox in the header,
 *     backed by the per-host ledger (default ON). Flipping it
 *     runs the rule diff via setArcadeAutoHideEnabled.
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
  const { status } = useConnection();
  const canMutate = status === 'connected';

  const [entries, setEntries] = useState<readonly ArcadeMraEntry[] | null>(
    null,
  );
  const [playability, setPlayability] =
    useState<ArcadePlayabilityWire | null>(null);
  const [autoHideEnabled, setAutoHideEnabled] = useState<boolean | null>(null);
  const [autoHidePending, setAutoHidePending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
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
  // feat/arcade-parity-3-ui (G8) — per-pane sort state, not persisted
  // (matches RomsPane). Switching panes resets to the default.
  const [sortState, setSortState] = useState<SortState>(DEFAULT_SORT);
  // feat/arcade-parity-3-ui (G15) — drill location inside `_Arcade/`.
  // Empty string = root; slash-joined for nested folders (e.g.
  // `_Konami`, `_Konami/sub`).
  const [subPath, setSubPath] = useState<string>('');
  // feat/arcade-parity-3-ui — detail-dialog target. Carries the entry
  // shape needed to render the modal (relativePath drives the metadata
  // lookup). Null when closed.
  const [detailDialogFor, setDetailDialogFor] = useState<{
    readonly relativePath: string;
    readonly displayName: string;
    readonly filename: string;
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

  const refresh = useCallback(
    async (forceRefresh = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const [wire, play, enabled] = await Promise.all([
          window.mister.listArcadeMraEntries({ forceRefresh }),
          window.mister.getArcadePlayability(),
          window.mister.getArcadeAutoHideEnabled(),
        ]);
        setEntries(wireToEntries(wire));
        setPlayability(play);
        setAutoHideEnabled(enabled);
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

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

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

  // Enrich each entry with a synthetic Rom (kind='file' for mras,
  // 'folder-container' for subfolders so `sortRoms` pins them) plus
  // the cached metadata record. `rom.filename === entry.relativePath`
  // is bijective with the entry, used to round-trip back after sort.
  const enrichedPresentable = useMemo(
    () =>
      presentable.map((entry) => ({
        ...entry,
        rom: makeArcadeRom(entry),
        metadata: metadataByMra[entry.relativePath] ?? null,
      })),
    [presentable, metadataByMra],
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

  const visibleCount = mraRows.filter((e) => !e.hidden).length;
  const hiddenCount = mraRows.filter((e) => e.hidden).length;

  const onToggleSingle = async (entry: ArcadeMraEntry): Promise<void> => {
    if (!canMutate) return;
    const next = !entry.hidden;
    setPendingPaths((prev) => {
      const out = new Set(prev);
      out.add(entry.relativePath);
      return out;
    });
    try {
      await window.mister.setArcadeMraVisibility(entry.relativePath, next);
      await refresh(true);
    } catch (err) {
      toast.error(
        `Could not ${next ? 'hide' : 'show'} ${entry.displayName}`,
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    } finally {
      setPendingPaths((prev) => {
        const out = new Set(prev);
        out.delete(entry.relativePath);
        return out;
      });
    }
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

  /**
   * Toggle the persisted auto-hide preference. The main-process
   * call also applies the rule diff (hides every missing-ROM mra
   * on OFF→ON, restores every auto-hidden mra on ON→OFF), so we
   * refresh the entry list + playability after a successful flip.
   *
   * The checkbox flips optimistically so the user sees the change
   * land immediately even though the bulk SSH rename takes ~3-5s
   * for a typical 100-mra diff. On failure we revert and surface
   * the toast.
   */
  const onToggleAutoHide = async (next: boolean): Promise<void> => {
    if (!canMutate || autoHideEnabled === null) return;
    const prev = autoHideEnabled;
    setAutoHidePending(true);
    setAutoHideEnabled(next);
    try {
      await window.mister.setArcadeAutoHideEnabled(next);
      await refresh(true);
    } catch (err) {
      setAutoHideEnabled(prev);
      toast.error(
        `Could not ${next ? 'enable' : 'disable'} auto-hide`,
        {
          description: err instanceof Error ? err.message : 'Unexpected error.',
        },
      );
    } finally {
      setAutoHidePending(false);
    }
  };

  const breadcrumb = computeBreadcrumb('Arcade', subPath);
  const backRow = computeBackRow('Arcade', subPath);
  const isDrilled = subPath !== '';

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
        {isDrilled ? (
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
        ) : null}
        <div className="flex items-baseline gap-3">
          <h2 className="text-heading text-fg">Arcade</h2>
          <span className="font-mono text-body-sm text-fg-muted tabular">
            {visibleCount}
            {hiddenCount > 0 ? (
              <span className="text-fg-disabled"> ({hiddenCount})</span>
            ) : null}
          </span>
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
            <EyeOff strokeWidth={1.5} />
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
            <Eye strokeWidth={1.5} />
            Show all
          </Button>
          <label
            className={cn(
              'ml-auto flex items-center gap-2 text-body-sm text-fg-body',
              (!canMutate || autoHidePending || autoHideEnabled === null) &&
                'opacity-60',
            )}
            title={
              canMutate
                ? 'When on, .mras whose ROM zips are missing from games/mame/ + games/hbmame/ are dot-prefixed so the MiSTer arcade menu only shows what you can actually play.'
                : 'Reconnect to change.'
            }
          >
            <input
              type="checkbox"
              className="accent-accent"
              checked={autoHideEnabled ?? true}
              disabled={
                !canMutate || autoHidePending || autoHideEnabled === null
              }
              onChange={(e) => void onToggleAutoHide(e.target.checked)}
            />
            Auto-hide missing ROMs
            {autoHidePending ? (
              <Loader2
                className="ml-1 size-3.5 animate-spin text-fg-muted"
                strokeWidth={1.5}
              />
            ) : null}
          </label>
          <label className="flex items-center gap-2 text-body-sm text-fg-body">
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
      <div className="scroll-themed flex-1 overflow-auto pr-2.5">
        {loading && entries === null ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : error !== null ? (
          <div className="p-4 text-body-sm text-destructive">{error}</div>
        ) : entries === null || mraRows.length === 0 ? (
          <div className="p-4 text-body-sm text-fg-muted">
            No .mra files found in _Arcade/.
          </div>
        ) : enrichedPresentable.length === 0 && backRow === null ? (
          <div className="p-4 text-body-sm text-fg-muted">
            All .mra files are hidden — toggle &ldquo;Show hidden&rdquo; to manage them.
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
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
                  className="w-28 normal-case"
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
                <TableHead
                  className="w-[3.25rem] p-0"
                  aria-label="Visibility"
                />
              </TableRow>
            </TableHeader>
            <TableBody>
              {backRow !== null ? (
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
                  <BackThumbnailCell />
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
                  <TableCell className="w-[3.25rem] p-0" />
                </TableRow>
              ) : null}
              {enrichedPresentable.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="p-4 text-body-sm text-fg-muted"
                  >
                    This folder is empty.
                  </TableCell>
                </TableRow>
              ) : null}
              {sortedRows.map((entry) => {
                const rom = entry.rom;
                const metadata = entry.metadata;
                const isPending = pendingPaths.has(entry.relativePath);
                const classification =
                  playabilityByPath.get(entry.relativePath) ?? null;
                const isMissing = classification === 'missing';
                const isFolder = entry.kind !== 'mra';
                const rowType = classifyRow({ kind: 'rom', rom });
                const arcadeEntry: ArcadeMraEntry = {
                  relativePath: entry.relativePath,
                  displayName: entry.displayName,
                  kind: entry.kind,
                  hidden: entry.hidden,
                };
                return (
                  <TableRow
                    key={entry.relativePath}
                    className={cn(
                      'group/row',
                      entry.hidden &&
                        'opacity-50 italic text-fg-disabled',
                      isFolder && 'cursor-pointer hover:bg-overlay/40',
                    )}
                    onClick={
                      isFolder
                        ? () => setSubPath(entry.relativePath)
                        : undefined
                    }
                    onKeyDown={
                      isFolder
                        ? (e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              setSubPath(entry.relativePath);
                            }
                          }
                        : undefined
                    }
                    tabIndex={isFolder ? 0 : undefined}
                    role={isFolder ? 'button' : undefined}
                    aria-label={
                      isFolder ? `Open ${entry.displayName}` : undefined
                    }
                  >
                    <RomThumbnailCell
                      rom={rom}
                      metadata={metadata}
                      error={false}
                      dimmed={entry.hidden}
                      rowType={rowType}
                    />
                    <TableCell
                      className={cn(
                        'max-w-0',
                        entry.hidden && 'opacity-50 italic',
                        !isFolder && 'cursor-pointer',
                      )}
                      onClick={
                        isFolder
                          ? undefined
                          : (e) => {
                              e.stopPropagation();
                              setDetailDialogFor({
                                relativePath: entry.relativePath,
                                displayName:
                                  metadata?.name ?? rom.displayName,
                                filename: rom.filename,
                              });
                            }
                      }
                      title={!isFolder ? 'View details' : undefined}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <RomNameInner
                            rom={rom}
                            metadata={metadata}
                            error={false}
                            dimmed={entry.hidden}
                          />
                        </div>
                        {isMissing ? (
                          <span
                            className="inline-block shrink-0 rounded border border-destructive/40 bg-destructive/15 px-1 text-caption uppercase tracking-[0.06em] text-destructive"
                            title="At least one ROM zip referenced by this .mra is not present in games/mame/ or games/hbmame/."
                          >
                            Missing ROMs
                          </span>
                        ) : null}
                      </div>
                    </TableCell>
                    <RomYearCell
                      rom={rom}
                      metadata={metadata}
                      error={false}
                      dimmed={entry.hidden}
                    />
                    <RomMetadataInfoCells
                      rom={rom}
                      metadata={metadata}
                      error={false}
                      dimmed={entry.hidden}
                    />
                    {isFolder ? (
                      <TableCell className="w-[3.25rem] p-0" />
                    ) : isPending ? (
                      <TableCell className="relative w-[3.25rem] p-0">
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Loader2
                            className="size-4 animate-spin text-fg-muted"
                            strokeWidth={1.5}
                          />
                        </div>
                      </TableCell>
                    ) : (
                      <RomDensityEyeCell
                        rom={rom}
                        isSystem={false}
                        maxSizeBytes={0}
                        canMutate={canMutate}
                        disconnectedTooltip="Reconnect to make changes."
                        onSingleToggle={() => {
                          void onToggleSingle(arcadeEntry);
                        }}
                      />
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>
      </>
    ),
    // feat/arcade-parity-3-ui — metadata detail modal. Opens on click
    // of the name cell. Renders unconditionally for any open
    // `detailDialogFor`; the dialog's empty-state branch handles
    // entries whose ScreenScraper match hasn't landed yet (placeholder
    // box art + "No metadata yet" note).
    //
    // feat/arcade-manual-ss-search — Edit stays v0.2
    // (`allowEdit={false}`), Find-on-ScreenScraper is wired now
    // (`allowSearch={true}`). Clicking Find closes the detail dialog
    // and opens the SS search modal; the search modal's `onBind`
    // routes through the arcade-specific IPC that resolves the
    // primary zip md5 server-side.
    extras: (
      <>
        {detailDialogFor !== null ? (
          <RomDetailDialog
            path={detailDialogFor.relativePath}
            filename={detailDialogFor.filename}
            metadata={metadataByMra[detailDialogFor.relativePath] ?? null}
            open
            onOpenChange={(open) => {
              if (!open) setDetailDialogFor(null);
            }}
            onEdit={() => {
              /* arcade edit-metadata dialog is v0.2; the Edit button
                 is hidden by `allowEdit={false}`, this callback never
                 fires. */
            }}
            onSearch={() => {
              setSearchScreenScraperFor(detailDialogFor);
            }}
            allowEdit={false}
            allowSearch
          />
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
      </>
    ),
  };
}

function wireToEntries(
  wire: readonly ArcadeMraEntryWire[],
): readonly ArcadeMraEntry[] {
  // The wire shape is structurally identical to ArcadeMraEntry — the
  // cast is safe and avoids a per-row clone for ~thousands of entries.
  return wire as readonly ArcadeMraEntry[];
}

