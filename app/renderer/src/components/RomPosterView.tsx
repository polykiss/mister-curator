import { Eye, EyeOff, FolderOpen, ImageOff } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';
import { diagLog } from '@shared/diag-log';

import { Button } from '@app/renderer/src/components/ui/button';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { cn } from '@app/renderer/src/lib/cn';
import { isPinnedRow } from '@app/renderer/src/lib/rom-sort';
import type { RomsViewProps, ViewSize } from '@app/renderer/src/lib/roms-view-props';

const TILE_MIN_WIDTH: Record<ViewSize, number> = { S: 100, M: 160, L: 220, XL: 280 };
import {
  displayGenre as displayGenreOf,
  displayName as displayNameOf,
  displayRating as displayRatingOf,
  displayYear as displayYearOf,
} from '@app/renderer/src/lib/metadata-display';
import { formatRating, pickPrimaryGenre } from '@app/renderer/src/lib/rom-metadata-format';
import { formatGenreList } from '@app/renderer/src/lib/genre-format';

const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

/** Poster tile art — manages its own objectURL lifecycle. */
function PosterArt({
  boxArtUrl,
  altText,
  isFolder,
}: {
  readonly boxArtUrl: string | null;
  readonly altText: string;
  readonly isFolder: boolean;
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
      if (!cancelled) diagLog('error', 'boxart', '✗', 'poster-art', { err: String(err) });
    });
    return () => { cancelled = true; };
  }, [boxArtUrl]);

  if (isFolder) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-overlay/40 text-fg-muted">
        <FolderOpen className="size-8" strokeWidth={1.5} aria-hidden />
      </div>
    );
  }
  if (objectUrl !== null) {
    return (
      <img src={objectUrl} alt={altText} className="h-full w-full object-cover" loading="lazy" decoding="async" />
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center bg-overlay/40 text-fg-disabled">
      <ImageOff className="size-5" strokeWidth={1.5} aria-hidden />
    </div>
  );
}

/** Individual poster tile. Renders art + metadata + hover controls. */
function PosterTile({
  rom,
  metadata,
  isSelected,
  isDimmed,
  isFolder,
  isMissing,
  checkboxKey,
  canMutate,
  onOpenDetail,
  onToggleSelect,
  onEyeToggle,
}: {
  readonly rom: Rom;
  readonly metadata: RomMetadata | null | undefined;
  readonly isSelected: boolean;
  readonly isDimmed: boolean;
  readonly isFolder: boolean;
  readonly isMissing: boolean;
  readonly checkboxKey: string;
  readonly canMutate: boolean;
  readonly onOpenDetail: () => void;
  readonly onToggleSelect: (key: string, checked: boolean) => void;
  readonly onEyeToggle: () => void;
}): JSX.Element {
  const displayName = metadata !== null && metadata !== undefined
    ? displayNameOf(metadata) : rom.displayName;
  const year = metadata ? displayYearOf(metadata) : null;
  const genre = metadata ? pickPrimaryGenre(formatGenreList(displayGenreOf(metadata))) : null;
  const rating = metadata ? formatRating(displayRatingOf(metadata)) : null;
  const metaParts = [year !== null ? String(year) : null, genre, rating !== null ? String(rating) : null]
    .filter((p): p is string => p !== null);
  const metaLine = metaParts.join(' · ');

  return (
    <div
      className={cn(
        'group/tile relative flex flex-col overflow-hidden rounded-md cursor-pointer',
        'bg-surface border border-subtle transition-colors hover:border-accent/50',
        isSelected && 'ring-2 ring-accent',
        isDimmed && 'opacity-50',
      )}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('input,button')) return;
        onOpenDetail();
      }}
      role="button"
      tabIndex={0}
      aria-label={displayName}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpenDetail(); } }}
    >
      {/* Art area — 3:4 portrait ratio */}
      <div className="aspect-[3/4] w-full overflow-hidden">
        <PosterArt
          boxArtUrl={metadata?.boxArtUrl ?? null}
          altText={displayName}
          isFolder={isFolder}
        />
      </div>

      {/* Info below art */}
      <div className="flex flex-col gap-0.5 px-2 py-1.5">
        <span className="truncate text-body-sm font-medium text-fg" title={displayName}>
          {displayName}
        </span>
        {metaLine ? (
          <span className="truncate text-caption text-fg-muted">{metaLine}</span>
        ) : null}
      </div>

      {/* Missing ROMs badge (arcade only) */}
      {isMissing ? (
        <div className="absolute bottom-[3.5rem] left-1 right-1">
          <span className="inline-block w-full truncate rounded border border-destructive/40 bg-destructive/15 px-1 text-center text-caption uppercase tracking-[0.06em] text-destructive">
            Missing ROMs
          </span>
        </div>
      ) : null}

      {/* Checkbox — top-left, visible on hover or when selected */}
      <div
        className={cn(
          'absolute left-1.5 top-1.5 transition-opacity',
          isSelected ? 'opacity-100' : 'opacity-0 group-hover/tile:opacity-100',
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          className="accent-accent h-4 w-4 cursor-pointer rounded"
          aria-label={`Select ${displayName}`}
          checked={isSelected}
          onChange={(e) => onToggleSelect(checkboxKey, e.target.checked)}
        />
      </div>

      {/* Eye toggle — top-right, visible on hover */}
      <div
        className="absolute right-1 top-1 opacity-0 transition-opacity group-hover/tile:opacity-100"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 bg-surface/80 text-fg-muted hover:text-fg"
          disabled={!canMutate}
          title={canMutate ? (rom.hidden ? `Show ${displayName}` : `Hide ${displayName}`) : DISCONNECTED_TOOLTIP}
          aria-label={rom.hidden ? `Show ${displayName}` : `Hide ${displayName}`}
          onClick={onEyeToggle}
        >
          {rom.hidden ? <EyeOff className="size-3" strokeWidth={1.5} /> : <Eye className="size-3" strokeWidth={1.5} />}
        </Button>
      </div>
    </div>
  );
}

/**
 * CSS grid poster view. Same RomsViewProps contract as RomListView and
 * RomDetailedListView. Sort/filter/selection carry over from the adapter.
 *
 * No sort headers — the sorted `presentableRoms` order is inherited from
 * whatever sort state the user last applied in list/detailed mode.
 *
 * Performance note: each tile mounts a PosterArt component that fetches
 * box art via the main-process image cache. For large libraries (800+)
 * the memory footprint may be significant; virtualization is a follow-up.
 */
export function RomPosterView({
  loading,
  roms,
  presentableRoms,
  deferredFilter,
  onClearFilter,
  scrollContainerRef,
  selected,
  metadataByPath,
  canMutate,
  onToggleSelect,
  onSingleToggle,
  onRowActivate,
  setSubPath,
  setDetailDialogFor,
  arcadeContext,
  viewSize = 'M',
}: RomsViewProps): JSX.Element {
  const tileMinWidth = TILE_MIN_WIDTH[viewSize];
  const gridStyle = { gridTemplateColumns: `repeat(auto-fill, minmax(${tileMinWidth}px, 1fr))` };
  if (loading && !roms) {
    return (
      <div ref={scrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
        <div className="grid gap-4 p-4" style={gridStyle}>
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-1">
              <Skeleton className="aspect-[3/4] w-full rounded-md" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!presentableRoms || presentableRoms.length === 0) {
    return (
      <div ref={scrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
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
      </div>
    );
  }

  // Separate pinned (folder-container) from non-pinned rows.
  // Pinned rows appear at the top as smaller folder tiles.
  const pinned = presentableRoms.filter((r) => isPinnedRow(r));
  const unpinned = presentableRoms.filter((r) => !isPinnedRow(r));

  const renderTile = (rom: Rom): JSX.Element => {
    const isFolder = arcadeContext?.isFolderRow(rom) ?? rom.kind === 'folder-container';
    const classification = arcadeContext?.playabilityByPath.get(rom.filename) ?? null;
    const isMissing = classification === 'missing';
    const checkboxKey = arcadeContext?.checkboxKey(rom) ?? rom.filename;
    const isSelected = selected.has(checkboxKey);
    const isDimmed = rom.hidden;
    const metadataLookupPath =
      rom.kind === 'folder-atomic' && rom.containedRomPath !== undefined
        ? rom.containedRomPath : rom.path;
    const metadataState = metadataByPath[metadataLookupPath];
    const metadata = metadataState?.metadata;

    const openDetail = (): void => {
      if (arcadeContext) {
        arcadeContext.openDetail(rom, metadata ?? null);
      } else {
        setDetailDialogFor({ path: metadataLookupPath, displayName: metadata?.name ?? rom.displayName, filename: rom.filename });
      }
    };

    const handleRowActivate = (): void => {
      if (isFolder) {
        if (arcadeContext) {
          onRowActivate(rom);
        } else {
          setSubPath(rom.kind === 'folder-container' ? (rom.relativePath ?? rom.filename) : rom.filename);
          onRowActivate(rom);
        }
      } else {
        openDetail();
      }
    };

    return (
      <PosterTile
        key={rom.filename}
        rom={rom}
        metadata={metadata}
        isSelected={isSelected}
        isDimmed={isDimmed}
        isFolder={isFolder}
        isMissing={isMissing}
        checkboxKey={checkboxKey}
        canMutate={canMutate}
        onOpenDetail={handleRowActivate}
        onToggleSelect={onToggleSelect}
        onEyeToggle={() => {
          if (arcadeContext) arcadeContext.singleToggle(rom);
          else onSingleToggle(rom);
        }}
      />
    );
  };

  return (
    <div ref={scrollContainerRef} className="scroll-themed flex-1 overflow-auto pr-2.5">
      {pinned.length > 0 ? (
        <div className="border-b border-subtle px-4 py-3">
          <div className="grid gap-3" style={gridStyle}>
            {pinned.map(renderTile)}
          </div>
        </div>
      ) : null}
      <div className="grid gap-4 p-4" style={gridStyle}>
        {unpinned.map(renderTile)}
      </div>
    </div>
  );
}
