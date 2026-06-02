import { FolderOpen, CornerUpLeft, ImageOff, MoreHorizontal, Settings } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import { diagLog } from '@shared/diag-log';

import { BackThumbnailCell, RomDensityEyeCell, RomMetadataInfoCells, RomNameInner, RomYearCell } from '@app/renderer/src/components/RomMetadataCells';
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
import type { RomsViewProps } from '@app/renderer/src/lib/roms-view-props';
import { classifyRow } from '@app/renderer/src/lib/row-type';

const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

/** Larger thumbnail cell for detailed list mode — uses boxArtUrl directly. */
function DetailedThumbnailCell({
  boxArtUrl,
  altText,
  rowType,
  onClick,
  clickLabel,
}: {
  readonly boxArtUrl: string | null;
  readonly altText: string;
  readonly rowType: ReturnType<typeof classifyRow>;
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
      if (!cancelled) diagLog('error', 'boxart', '✗', 'detailed-thumb', { err: String(err) });
    });
    return () => { cancelled = true; };
  }, [boxArtUrl]);

  const interactiveProps = onClick !== undefined ? {
    onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClick(); },
    role: 'button' as const,
    tabIndex: 0,
    title: clickLabel,
    'aria-label': clickLabel,
  } : {};

  const imgContent = rowType === 'explorable-folder' ? (
    <div className="flex h-20 w-16 items-center justify-center rounded-sm bg-overlay/40 text-fg-muted">
      <FolderOpen className="size-6" strokeWidth={1.5} aria-hidden />
    </div>
  ) : rowType === 'back' ? (
    <div className="flex h-20 w-16 items-center justify-center rounded-sm bg-overlay/40 text-fg-muted">
      <CornerUpLeft className="size-6" strokeWidth={1.5} aria-hidden />
    </div>
  ) : objectUrl !== null ? (
    <img
      src={objectUrl}
      alt={altText}
      className="h-20 w-auto max-w-[4rem] rounded-sm object-contain"
      loading="lazy"
      decoding="async"
    />
  ) : (
    <div className="flex h-20 w-16 items-center justify-center rounded-sm bg-overlay/40 text-fg-disabled">
      <ImageOff className="size-4" strokeWidth={1.5} aria-hidden />
    </div>
  );

  return (
    <TableCell
      className={cn('w-20 p-1', onClick !== undefined && 'cursor-pointer')}
      {...interactiveProps}
    >
      {imgContent}
    </TableCell>
  );
}

/**
 * Detailed table-based ROM list. Same contract as RomListView but with
 * larger artwork (~80px tall) and a two-line description excerpt below
 * the game name. Accepts the same RomsViewProps — works for both ROM
 * and arcade panes via arcadeContext.
 */
export function RomDetailedListView({
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
}: RomsViewProps): JSX.Element {
  return (
    <div ref={scrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
      {loading && !roms ? (
        <div className="space-y-1 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[88px] w-full" />
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
                  <button type="button" onClick={onClearFilter} className="underline hover:text-fg">
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
                  checked={presentableRoms.length > 0 && selected.size === presentableRoms.length}
                  onChange={(e) => onToggleAll(e.target.checked)}
                />
              </TableHead>
              <TableHead className="w-20" aria-label="Box art" />
              <SortableHeader label="Name" sortKey="name" sortState={sortState} onSort={onSortChange} />
              <SortableHeader label="Year" sortKey="year" align="right" className="w-16" sortState={sortState} onSort={onSortChange} />
              <SortableHeader label="Genre" sortKey="genre" className="w-28" sortState={sortState} onSort={onSortChange} />
              <SortableHeader label="Rating" sortKey="rating" align="right" className="w-14" sortState={sortState} onSort={onSortChange} />
              <TableHead className="w-10" aria-label="Actions" />
              <SortableHeader label="Size" sortKey="size" className="w-[3.25rem] p-0" sortState={sortState} onSort={onSortChange} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {backRow ? (
              <TableRow
                className="cursor-pointer bg-overlay/40 hover:bg-overlay"
                onClick={() => setSubPath(backRow.targetSubPath)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSubPath(backRow.targetSubPath); } }}
                tabIndex={0} role="button"
                aria-label={`Back to ${backRow.parentLabel}`}
                title={`Back to ${backRow.parentLabel}`}
              >
                <TableCell className="pl-4" />
                <BackThumbnailCell />
                <TableCell className="max-w-0 truncate">
                  <span className="font-mono text-body-sm text-fg-muted" title={`../ ${backRow.parentLabel}`}>
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
              const isFolder = arcadeContext?.isFolderRow(rom) ?? false;
              const classification = arcadeContext?.playabilityByPath.get(rom.filename) ?? null;
              const isMissing = classification === 'missing';
              const checkboxKey = arcadeContext?.checkboxKey(rom) ?? rom.filename;
              const isSelected = selected.has(checkboxKey);
              const isSystem = systemFlags.get(rom.filename) === true;
              const isDimmed = rom.hidden || isSystem;
              const rowType = classifyRow({ kind: 'rom', rom });
              const metadataLookupPath =
                rom.kind === 'folder-atomic' && rom.containedRomPath !== undefined
                  ? rom.containedRomPath : rom.path;
              const metadataState = metadataByPath[metadataLookupPath];
              const metadata = metadataState?.metadata;
              const fetchError = metadataState?.error ?? false;
              const description = metadata?.description ?? null;

              const openDetail = (): void => {
                if (arcadeContext) {
                  arcadeContext.openDetail(rom, metadata ?? null);
                } else {
                  setDetailDialogFor({ path: metadataLookupPath, displayName: metadata?.name ?? rom.displayName, filename: rom.filename });
                }
              };

              const thumbActivate =
                rom.kind === 'folder-container' && !rom.hidden ? (): void => onRowActivate(rom)
                : rom.kind === 'file' || rom.kind === 'folder-atomic' ? openDetail
                : undefined;

              return (
                <TableRow
                  key={rom.filename}
                  data-rom-row={rom.filename}
                  data-state={isSelected ? 'selected' : undefined}
                  onContextMenu={arcadeContext ? undefined : (e) => { e.preventDefault(); setMenuFor({ rom, x: e.clientX, y: e.clientY }); }}
                  onClick={isFolder ? () => onRowActivate(rom) : undefined}
                  onKeyDown={isFolder ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowActivate(rom); } } : undefined}
                  tabIndex={isFolder ? 0 : undefined}
                  role={isFolder ? 'button' : undefined}
                  aria-label={isFolder ? `Open ${rom.displayName}` : undefined}
                  className={cn(
                    'group/row',
                    isDimmed && 'opacity-50 italic text-fg-disabled',
                    isFolder && 'cursor-pointer hover:bg-overlay/40',
                  )}
                >
                  {isFolder ? (
                    <TableCell className="w-10 pl-4" />
                  ) : (
                    <TableCell className="pl-4">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        aria-label={`Select ${rom.displayName}`}
                        checked={isSelected}
                        onChange={(e) => { e.stopPropagation(); onToggleSelect(checkboxKey, e.target.checked); }}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </TableCell>
                  )}
                  <DetailedThumbnailCell
                    boxArtUrl={metadata?.boxArtUrl ?? null}
                    altText={metadata?.name ?? rom.displayName}
                    rowType={rowType}
                    onClick={thumbActivate}
                    clickLabel={rowType === 'explorable-folder' ? `Open ${rom.displayName}` : 'View details'}
                  />
                  <TableCell
                    className={cn(
                      'max-w-0',
                      rom.kind === 'folder-container' && !rom.hidden && 'cursor-pointer',
                      (rom.kind === 'file' || rom.kind === 'folder-atomic') && 'cursor-pointer',
                    )}
                    onDoubleClick={() => onRowActivate(rom)}
                    onClick={(e) => {
                      if (rom.kind === 'folder-container' && !rom.hidden) { e.preventDefault(); onRowActivate(rom); return; }
                      if (rom.kind === 'file' || rom.kind === 'folder-atomic') { e.preventDefault(); openDetail(); }
                    }}
                    title={rom.kind === 'folder-container' && !rom.hidden ? `Open ${rom.displayName}` : rom.kind === 'file' || rom.kind === 'folder-atomic' ? 'View details' : undefined}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1">
                        <RomNameInner
                          rom={rom}
                          dimmed={isDimmed}
                          metadata={metadata}
                          error={fetchError}
                          leadingIcon={isSystem ? <Settings className="size-3.5 shrink-0" strokeWidth={1.5} aria-label="system file" /> : null}
                        />
                        {description && !isFolder ? (
                          <p className="mt-1 line-clamp-2 text-caption text-fg-muted overflow-hidden">
                            {description}
                          </p>
                        ) : null}
                      </div>
                      {isMissing ? (
                        <span className="inline-block shrink-0 rounded border border-destructive/40 bg-destructive/15 px-1 text-caption uppercase tracking-[0.06em] text-destructive" title="At least one ROM zip referenced by this .mra is not present in games/mame/ or games/hbmame/.">
                          Missing ROMs
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <RomYearCell rom={rom} dimmed={isDimmed} metadata={metadata} error={fetchError} />
                  <RomMetadataInfoCells rom={rom} dimmed={isDimmed} metadata={metadata} error={fetchError} />
                  {isFolder ? (
                    <TableCell className="w-10" />
                  ) : (
                    <TableCell className="w-10 py-0">
                      <Button
                        variant="ghost" size="icon" title="More actions"
                        aria-label={`More actions for ${rom.displayName}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const r = e.currentTarget.getBoundingClientRect();
                          if (arcadeContext) {
                            arcadeContext.openMenu(rom, metadata ?? null, r.left, r.bottom);
                          } else {
                            setMenuFor({ rom, x: r.left, y: r.bottom });
                          }
                        }}
                      >
                        <MoreHorizontal strokeWidth={1.5} />
                      </Button>
                    </TableCell>
                  )}
                  {isFolder ? (
                    <TableCell className="w-[3.25rem] p-0" />
                  ) : (
                    <RomDensityEyeCell
                      rom={rom}
                      isSystem={isSystem}
                      maxSizeBytes={maxSizeBytes}
                      canMutate={canMutate}
                      disconnectedTooltip={DISCONNECTED_TOOLTIP}
                      onSingleToggle={arcadeContext?.singleToggle ?? onSingleToggle}
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
