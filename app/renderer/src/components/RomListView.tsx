import { CornerUpLeft, FolderOpen, ImageOff, MoreHorizontal, Settings } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { diagLog } from '@shared/diag-log';

import { BackThumbnailCell, RomDensityEyeCell, RomMetadataInfoCells, RomNameInner, RomThumbnailCell, RomYearCell } from '@app/renderer/src/components/RomMetadataCells';
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
import { cn } from '@app/renderer/src/lib/cn';
import { nextSortState } from '@app/renderer/src/lib/rom-sort';
import type { RomsViewProps, ViewSize } from '@app/renderer/src/lib/roms-view-props';
import { classifyRow } from '@app/renderer/src/lib/row-type';

// ── Size-aware rendering (PR I-4 unification) ──────────────────────────────
// S = minimal compact rows (original RomListView behaviour, 48px thumb)
// M/L/XL = growing rows with box art + description (absorb RomDetailedListView)
const THUMB_PX: Record<ViewSize, number> = { S: 48, M: 80, L: 120, XL: 160 };
const DESCRIPTION_LINE_CLAMP: Record<ViewSize, string | null> = {
  S: null, M: 'line-clamp-2', L: 'line-clamp-3', XL: 'line-clamp-4',
};
// Max aspect ratio supported at M/L/XL (4:3 landscape). Both the TableHead
// width and the DetailedThumbnailCell container use this so the column is
// always wide enough for any art, while the container clips overflow so art
// can NEVER bleed into the name column. Module-level so header + cell share it.
const THUMB_ASPECT = 4 / 3;

/** Larger thumbnail cell used at M/L/XL sizes — fetches boxArtUrl directly. */
function DetailedThumbnailCell({
  boxArtUrl,
  altText,
  rowType,
  thumbPx,
  onClick,
  clickLabel,
}: {
  readonly boxArtUrl: string | null;
  readonly altText: string;
  readonly rowType: ReturnType<typeof classifyRow>;
  readonly thumbPx: number;
  readonly onClick?: () => void;
  readonly clickLabel?: string;
}): JSX.Element {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const lastFetchRef = useRef<{ url: string; objectUrl: string } | null>(null);

  useEffect(() => {
    return () => {
      if (lastFetchRef.current) {
        URL.revokeObjectURL(lastFetchRef.current.objectUrl);
        lastFetchRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!boxArtUrl) return;
    const last = lastFetchRef.current;
    if (last?.url === boxArtUrl) { setObjectUrl(last.objectUrl); return; }
    if (last) { URL.revokeObjectURL(last.objectUrl); lastFetchRef.current = null; }
    let cancelled = false;
    void window.mister.getBoxArtBytes(boxArtUrl).then((bytes) => {
      if (cancelled || !bytes || bytes.byteLength === 0) return;
      const blob = new Blob([new Uint8Array(bytes)]);
      const created = URL.createObjectURL(blob);
      lastFetchRef.current = { url: boxArtUrl, objectUrl: created };
      setObjectUrl(created);
    }).catch((err: unknown) => {
      if (!cancelled) diagLog('error', 'boxart', '✗', 'list-thumb-lg', { err: String(err) });
    });
    return () => { cancelled = true; };
  }, [boxArtUrl]);

  // Container dimensions — fixed box, clips to prevent any art from
  // bleeding into the name column. THUMB_ASPECT is module-level and
  // matches the TableHead width so the column is always exactly right.
  const containerW = Math.round(thumbPx * THUMB_ASPECT);
  const tileStyle = { height: `${thumbPx}px`, width: `${containerW}px` };
  const interactiveProps = onClick !== undefined ? {
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClick(); },
    role: 'button' as const,
    tabIndex: 0,
    title: clickLabel,
    'aria-label': clickLabel,
  } : {};

  const imgContent = rowType === 'explorable-folder' ? (
    <div className="flex items-center justify-center rounded-md bg-overlay/40 text-fg-muted" style={tileStyle}>
      <FolderOpen className="size-6" strokeWidth={1.5} aria-hidden />
    </div>
  ) : rowType === 'back' ? (
    <div className="flex items-center justify-center rounded-md bg-overlay/40 text-fg-muted" style={tileStyle}>
      <CornerUpLeft className="size-6" strokeWidth={1.5} aria-hidden />
    </div>
  ) : objectUrl !== null ? (
    // Hard clipping container — image fills the box with object-contain so
    // it can NEVER overflow into the adjacent name column regardless of
    // aspect ratio. Portrait art letterboxes; landscape art fills width.
    <div className="overflow-hidden rounded-md" style={tileStyle}>
      <img src={objectUrl} alt={altText} className="h-full w-full object-contain"
        loading="lazy" decoding="async" />
    </div>
  ) : (
    <div className="flex items-center justify-center rounded-md bg-overlay/40 text-fg-disabled" style={tileStyle}>
      <ImageOff className="size-4" strokeWidth={1.5} aria-hidden />
    </div>
  );

  return (
    <TableCell
      className={cn('p-1', onClick !== undefined && 'cursor-pointer')}
      style={{ width: `${containerW + 8}px` }}
      {...interactiveProps}
    >
      {imgContent}
    </TableCell>
  );
}

/** Tooltip for buttons disabled because the SSH session was lost. */
const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

/**
 * Dense table-based ROM list. Pure presentation component — receives all
 * data and handlers from the adapter via `RomsViewProps`. Extracted from
 * the inline rendering block in roms-adapter.tsx (PR I-1 refactor) to
 * enable PR I-2's swappable view modes (detailed list, poster grid).
 *
 * When `arcadeContext` is supplied the component renders arcade-specific
 * variants (Missing ROMs badge, empty cells for subfolder rows, etc.).
 * When absent every arcade conditional is a no-op and ROM-pane behavior
 * is unchanged.
 *
 * `viewSize` controls row density:
 *   S  — compact 48px thumbnail, no description (original minimal behaviour)
 *   M  — 80px thumbnail + 2-line description
 *   L  — 120px thumbnail + 3-line description
 *   XL — 160px thumbnail + 4-line description
 */
export function RomListView({
  loading,
  roms,
  presentableRoms,
  deferredFilter,
  onClearFilter,
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
  arcadeContext,
  viewSize = 'S',
}: RomsViewProps): JSX.Element {
  const thumbPx = THUMB_PX[viewSize];
  const isDetailed = thumbPx > 48;
  const clampClass = DESCRIPTION_LINE_CLAMP[viewSize];
  const skeletonH = isDetailed ? thumbPx + 8 : 40;
  return (
    /* PR #23 round 5 commit 1: `scroll-themed` reserves a stable
       scrollbar gutter and paints a permanent themed bar so native
       overlay scrollbars on macOS can't fade in over the eye
       column on the right.
       PR #23 round 6: `pr-2.5` (10px) explicit right padding —
       scrollbar-gutter alone wasn't reliable in this Chromium /
       macOS configuration (eye icons still visually overlapped
       the drawn scrollbar). Pinning a 10px gap between the row
       content and the container's right edge guarantees the
       rightmost cell (density + eye stack) sits well clear of
       the scrollbar regardless of how the gutter resolves. */
    <div ref={scrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
      {loading && !roms ? (
        <div className="space-y-1 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} style={{ height: `${skeletonH}px` }} className="w-full" />
          ))}
        </div>
      ) : !presentableRoms || presentableRoms.length === 0 ? (
        <div className="p-6 text-body-sm text-fg-muted">
          {(roms ?? []).length === 0
            ? 'No ROMs in this core.'
            : deferredFilter !== ''
              ? (
                <>
                  No ROMs match &ldquo;{deferredFilter}&rdquo;.{' '}
                  <button
                    type="button"
                    onClick={onClearFilter}
                    className="underline hover:text-fg"
                  >
                    Clear filter
                  </button>
                </>
              )
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
                  regardless of sort. Column width grows with size. */}
              {isDetailed
                ? <TableHead style={{ width: `${Math.round(thumbPx * THUMB_ASPECT) + 8}px` }} aria-label="Box art" />
                : <TableHead className="w-16" aria-label="Box art" />}
              <SortableHeader
                label="Name"
                sortKey="name"
                sortState={sortState}
                onSort={(k) => onSortChange(k)}
              />
              <SortableHeader
                label="Year"
                sortKey="year"
                align="right"
                className="w-16"
                sortState={sortState}
                onSort={(k) => onSortChange(k)}
              />
              <SortableHeader
                label="Genre"
                sortKey="genre"
                className="w-28"
                sortState={sortState}
                onSort={(k) => onSortChange(k)}
              />
              <SortableHeader
                label="Rating"
                sortKey="rating"
                align="right"
                className="w-14"
                sortState={sortState}
                onSort={(k) => onSortChange(k)}
              />
              {/* MoreHorizontal column. Sits left of the density+eye
                  right-edge stack so the row's primary visibility
                  toggle owns the far-right slot. */}
              <TableHead className="w-10" aria-label="Actions" />
              {/* Combined density + eye column. "Size" label centered
                  over the 24px density bar only (D29: pr-8 offsets
                  the 32px eye slot so text-center lands on the bar).
                  Width = 24 (density w-6) + 32 (eye) = 56px (w-[3.5rem]). */}
              <TableHead className="w-[3.5rem] p-0 pr-8 text-center">
                <button
                  type="button"
                  onClick={() => onSortChange('size')}
                  className="inline-flex w-full items-center justify-center text-inherit transition-colors hover:text-fg"
                  aria-label={`Sort by Size${sortState.key === 'size' ? ` (currently ${sortState.dir})` : ''}`}
                  aria-sort={sortState.key === 'size' ? (sortState.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                >
                  Size
                </button>
              </TableHead>
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
                <TableCell className="w-[3.5rem] p-0" />
              </TableRow>
            ) : null}
            {presentableRoms.map((rom) => {
              // ── Arcade-specific per-row values ────────────────────────
              // All default to the ROM-pane behavior when arcadeContext
              // is absent. The ROM pane never sees arcade-specific state.
              const isFolder = arcadeContext?.isFolderRow(rom) ?? false;
              const classification =
                arcadeContext?.playabilityByPath.get(rom.filename) ?? null;
              const isMissing = classification === 'missing';
              const checkboxKey = arcadeContext?.checkboxKey(rom) ?? rom.filename;
              // ─────────────────────────────────────────────────────────
              const isSelected = selected.has(checkboxKey);
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
                if (arcadeContext) {
                  arcadeContext.openDetail(rom, metadata ?? null);
                } else {
                  setDetailDialogFor({
                    path: metadataLookupPath,
                    displayName: metadata?.name ?? rom.displayName,
                    filename: rom.filename,
                  });
                }
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
                  data-rom-row={rom.filename}
                  data-state={isSelected ? 'selected' : undefined}
                  onContextMenu={
                    arcadeContext
                      ? undefined
                      : (e) => {
                          e.preventDefault();
                          setMenuFor({ rom, x: e.clientX, y: e.clientY });
                        }
                  }
                  // Arcade subfolder rows are drillable via a row-level
                  // click (mirrors the arcade-adapter's pre-refactor
                  // behavior). ROM pane folder-containers drill via the
                  // name cell onClick — the TableRow itself stays inert.
                  onClick={
                    isFolder ? () => onRowActivate(rom) : undefined
                  }
                  onKeyDown={
                    isFolder
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowActivate(rom);
                          }
                        }
                      : undefined
                  }
                  tabIndex={isFolder ? 0 : undefined}
                  role={isFolder ? 'button' : undefined}
                  aria-label={
                    isFolder ? `Open ${rom.displayName}` : undefined
                  }
                  className={cn(
                    'group/row',
                    // Hidden + system rows lean entirely on dimming
                    // (Round 2 design pass): opacity + italic + a
                    // darker text color. The HIDDEN/SYSTEM badges
                    // that used to sit before the name were removed;
                    // the gear icon below is the only chrome a
                    // system row carries.
                    isDimmed && 'opacity-50 italic text-fg-disabled',
                    // Arcade folder rows get cursor + hover treatment
                    // on the entire row (the row IS the drill action).
                    isFolder && 'cursor-pointer hover:bg-overlay/40',
                  )}
                >
                  {/* Arcade subfolder rows skip the checkbox and use an
                      empty spacer so column widths stay consistent. */}
                  {isFolder ? (
                    <TableCell className="w-10 pl-4" />
                  ) : (
                    <TableCell className="pl-4">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        aria-label={`Select ${rom.displayName}`}
                        checked={isSelected}
                        onChange={(e) => {
                          e.stopPropagation();
                          onToggleSelect(checkboxKey, e.target.checked);
                        }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </TableCell>
                  )}
                  {/* Thumbnail: compact (S) uses the shared RomThumbnailCell;
                      larger sizes (M/L/XL) use DetailedThumbnailCell with
                      boxArtUrl directly for pixel-accurate sizing. */}
                  {isDetailed ? (
                    <DetailedThumbnailCell
                      boxArtUrl={metadata?.boxArtUrl ?? null}
                      altText={metadata?.name ?? rom.displayName}
                      rowType={rowType}
                      thumbPx={thumbPx}
                      onClick={thumbActivate}
                      clickLabel={thumbLabel}
                    />
                  ) : (
                    <RomThumbnailCell
                      rom={rom}
                      dimmed={isDimmed}
                      metadata={metadata}
                      error={fetchError}
                      rowType={rowType}
                      onClick={thumbActivate}
                      clickLabel={thumbLabel}
                    />
                  )}
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
                        // Routes through arcadeContext.openDetail when in
                        // arcade pane; otherwise uses the standard ROM shape.
                        openDetail();
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
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1">
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
                          descriptionContent={
                            clampClass && !isFolder && metadata?.description
                              ? (
                                <p className={cn('mt-1 overflow-hidden text-caption text-fg-muted', clampClass)}>
                                  {metadata.description}
                                </p>
                              )
                              : null
                          }
                        />
                      </div>
                      {/* Arcade-only: "Missing ROMs" badge shown when
                          the .mra's required ZIP is absent on disk. */}
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
                  {/* Arcade subfolder rows skip the kebab menu. */}
                  {isFolder ? (
                    <TableCell className="w-10" />
                  ) : (
                    <TableCell className="w-10 py-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="More actions"
                        aria-label={`More actions for ${rom.displayName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          if (arcadeContext) {
                            arcadeContext.openMenu(
                              rom,
                              metadata ?? null,
                              r.left,
                              r.bottom,
                            );
                          } else {
                            setMenuFor({ rom, x: r.left, y: r.bottom });
                          }
                        }}
                      >
                        <MoreHorizontal strokeWidth={1.5} />
                      </Button>
                    </TableCell>
                  )}
                  {/* Combined density + eye column. PR #23 round 4
                      extracted the cell into RomDensityEyeCell to
                      give the absolute-positioning workaround a
                      stable contract a regression test can pin —
                      see RomMetadataCells.tsx for the long
                      explanation of why `position: absolute` is the
                      only reliable way to fill the row's actual
                      height when the `<tr>` height is
                      content-driven (the 48px thumbnail makes the
                      actual row ~56px, not the declared 40px).
                      Arcade subfolder rows skip this cell too. */}
                  {isFolder ? (
                    <TableCell className="w-[3.5rem] p-0" />
                  ) : (
                    <RomDensityEyeCell
                      rom={rom}
                      isSystem={isSystem}
                      maxSizeBytes={maxSizeBytes}
                      canMutate={canMutate}
                      disconnectedTooltip={DISCONNECTED_TOOLTIP}
                      onSingleToggle={
                        arcadeContext?.singleToggle ?? onSingleToggle
                      }
                    />
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

// Re-export nextSortState so callers that previously used it inline
// can build the onSortChange handler without an extra import.
export { nextSortState };
