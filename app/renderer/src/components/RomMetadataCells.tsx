import { ImageOff } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import type { Rom } from '@shared/types';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { TableCell } from '@app/renderer/src/components/ui/table';
import { cn } from '@app/renderer/src/lib/cn';
import {
  formatRating,
  pickPrimaryGenre,
} from '@app/renderer/src/lib/rom-metadata-format';
import { useBoxArt } from '@app/renderer/src/lib/use-box-art';
import { useRomMetadata } from '@app/renderer/src/lib/use-rom-metadata';

/**
 * Per-row metadata-driven cells. Round 1 of the list-view enrichment
 * PR — collapsed-state only (no expand, no sort, no persistence).
 *
 * Three components, each fetching the same metadata via
 * `useRomMetadata`. The duplicate per-row IPC calls dedupe in the
 * main-process per-hash inflight gate, so the cost is one round-trip
 * per row on cold cache and zero on warm. Two extra renderer state
 * machines per row (vs lifting the fetch to a row-scoped context) is
 * a deliberate round-1 simplification — keeps the parent's row
 * structure intact and avoids a wider RomsPane refactor.
 *
 * Cell layout in the parent:
 *   [Checkbox] [Thumbnail] [Name+Year] [System] [Genre] [Rating]
 *   [More] [Density+Eye]
 */

export interface RomMetadataCellProps {
  readonly rom: Rom;
  /** True when the row is dimmed (hidden / system) — propagates the
   *  same opacity to the metadata cells so they don't pop out. */
  readonly dimmed: boolean;
}

/** Single thumbnail cell. Sits right of the checkbox, left of name. */
export function RomThumbnailCell(props: RomMetadataCellProps): JSX.Element {
  const { rom } = props;
  const { status, metadata } = useRomMetadata(rom);
  const boxArtObjectUrl = useBoxArt(metadata?.boxArtUrl ?? null);
  const loading = status === 'loading';

  return (
    <TableCell className="w-16 p-1">
      {loading ? (
        <Skeleton className="h-12 w-12 rounded-sm" />
      ) : boxArtObjectUrl !== null ? (
        <img
          src={boxArtObjectUrl}
          alt={metadata?.name ?? rom.displayName}
          className="h-12 w-auto max-w-16 rounded-sm object-contain"
          // Box art varies in aspect — `object-contain` keeps both
          // portrait (cartridge box) and landscape (jewel case)
          // sources undistorted.
          loading="lazy"
          decoding="async"
        />
      ) : (
        <div
          className="flex h-12 w-12 items-center justify-center rounded-sm bg-overlay/40 text-fg-disabled"
          aria-label="No box art available"
        >
          <ImageOff className="size-4" strokeWidth={1.5} aria-hidden />
        </div>
      )}
    </TableCell>
  );
}

/**
 * Inner content for the Name TableCell — the metadata-derived name
 * stacked over the year. The parent owns the surrounding `<TableCell>`
 * so the existing icons (system / folder), click handlers, and dim
 * styling stay where they were. Pass `leadingIcon` to render an icon
 * (Settings / FolderOpen / Folder) flush-left of the name.
 */
export function RomNameYearStack(
  props: RomMetadataCellProps & { readonly leadingIcon?: ReactNode },
): JSX.Element {
  const { rom, dimmed, leadingIcon } = props;
  const { status, metadata } = useRomMetadata(rom);
  const loading = status === 'loading';
  const displayName = metadata?.name ?? rom.displayName;
  const year = metadata?.year ?? null;

  return (
    <span className="flex min-w-0 items-center gap-2">
      {leadingIcon}
      <span className="flex min-w-0 flex-col leading-tight">
        <span
          className={cn(
            'truncate text-body-sm',
            !dimmed && 'text-fg',
          )}
        >
          {loading ? <DashSkeleton width="w-40" /> : displayName}
        </span>
        <span className="truncate font-mono text-body-xs text-fg-muted tabular">
          {loading ? (
            <DashSkeleton width="w-12" />
          ) : year !== null ? (
            String(year)
          ) : (
            ''
          )}
        </span>
      </span>
    </span>
  );
}

/** System / Genre / Rating cells. Sit right of the Name cell. */
export function RomMetadataInfoCells(
  props: RomMetadataCellProps,
): JSX.Element {
  const { rom, dimmed } = props;
  const { status, metadata } = useRomMetadata(rom);
  const loading = status === 'loading';
  const systemLabel =
    metadata?.system && metadata.system.length > 0
      ? metadata.system
      : rom.coreId;
  const primaryGenre = pickPrimaryGenre(metadata?.genre ?? null);
  const rating = formatRating(metadata?.rating ?? null);

  return (
    <>
      <TableCell className="w-28 truncate">
        <span className={cn('truncate text-body-sm', !dimmed && 'text-fg')}>
          {loading ? <DashSkeleton width="w-20" /> : systemLabel}
        </span>
      </TableCell>
      <TableCell className="w-28 truncate">
        <span
          className={cn('truncate text-body-sm', !dimmed && 'text-fg-muted')}
        >
          {loading ? (
            <DashSkeleton width="w-16" />
          ) : (
            primaryGenre ?? <span className="text-fg-disabled">—</span>
          )}
        </span>
      </TableCell>
      <TableCell className="w-14 text-right">
        <span
          className={cn(
            'font-mono text-body-sm tabular',
            !dimmed && 'text-fg-muted',
          )}
        >
          {loading ? (
            <DashSkeleton width="w-10" />
          ) : (
            rating ?? <span className="text-fg-disabled">—</span>
          )}
        </span>
      </TableCell>
    </>
  );
}

function DashSkeleton(props: { readonly width: string }): JSX.Element {
  return <Skeleton className={cn('inline-block h-3', props.width)} />;
}
