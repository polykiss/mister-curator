import { AlertCircle, ImageOff } from 'lucide-react';
import type { JSX, ReactNode } from 'react';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import { diagLog } from '@shared/diag-log';

import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { TableCell } from '@app/renderer/src/components/ui/table';
import { cn } from '@app/renderer/src/lib/cn';
import {
  formatRating,
  pickPrimaryGenre,
} from '@app/renderer/src/lib/rom-metadata-format';
import { useBoxArt } from '@app/renderer/src/lib/use-box-art';

/**
 * Per-row metadata-driven cells. Round 2 (PR #20): switched from a
 * per-row `useRomMetadata` hook to prop-driven rendering. The parent
 * `RomsPane` runs ONE batched `prefetchRomsMetadata` per pane mount
 * and streams per-path results back as they settle.
 *
 * Three states the parent can pass:
 *   - `undefined` → loading (skeletons in metadata fields; filename
 *     for the name)
 *   - `null` → unmatched (filename for name; em-dash everywhere else)
 *   - `RomMetadata` → loaded (real values)
 *
 * `error` is orthogonal — true means the upstream fetch failed
 * (e.g., SSH dropped). Renders an AlertCircle indicator in the
 * thumbnail slot; other fields fall back to em-dashes.
 *
 * PR-A item 8 column layout in the parent:
 *   [Checkbox] [Thumbnail] [Name] [Year] [Genre] [Rating]
 *   [More] [Density+Eye]
 *
 * (Year promoted out of the name stack into its own sortable
 * column.)
 */
export interface RomMetadataCellProps {
  readonly rom: Rom;
  /** Settled metadata: present, null (no match), or undefined (loading). */
  readonly metadata: RomMetadata | null | undefined;
  /** True if the upstream fetch failed (SSH dropped, etc.). */
  readonly error: boolean;
  /** True when the row is dimmed (hidden / system) — propagates the
   *  same opacity to the metadata cells so they don't pop out. */
  readonly dimmed: boolean;
}

/** Single thumbnail cell. Sits right of the checkbox, left of name. */
export function RomThumbnailCell(props: RomMetadataCellProps): JSX.Element {
  const { metadata, error } = props;
  const loading = metadata === undefined && !error;
  const boxArtObjectUrl = useBoxArt(metadata?.boxArtUrl ?? null);

  return (
    <TableCell className="w-16 p-1">
      {loading ? (
        <Skeleton className="h-12 w-12 rounded-sm" />
      ) : error ? (
        <div
          className="flex h-12 w-12 items-center justify-center rounded-sm bg-overlay/40 text-fg-disabled"
          title="Metadata fetch failed (connection dropped). Retry by reconnecting."
          aria-label="Metadata fetch failed"
        >
          <AlertCircle className="size-4" strokeWidth={1.5} aria-hidden />
        </div>
      ) : boxArtObjectUrl !== null ? (
        <img
          src={boxArtObjectUrl}
          alt={metadata?.name ?? props.rom.displayName}
          className="h-12 w-auto max-w-16 rounded-sm object-contain"
          loading="lazy"
          decoding="async"
          onError={(event) => {
            const img = event.currentTarget;
            diagLog('error', 'boxart', '✗', 'img-load-failed', {
              path: shortName(props.rom.path),
              naturalW: img.naturalWidth,
              naturalH: img.naturalHeight,
            });
          }}
          onLoad={(event) => {
            const img = event.currentTarget;
            diagLog('info', 'boxart', '←', 'img-loaded', {
              path: shortName(props.rom.path),
              w: img.naturalWidth,
              h: img.naturalHeight,
            });
          }}
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
 * Inner content for the Name TableCell — single-line, with optional
 * leading icon. PR-A item 8 promoted year out of this stack into a
 * dedicated `RomYearCell`. The parent owns the surrounding
 * `<TableCell>` so the existing icons (system / folder), click
 * handlers, and dim styling stay where they were.
 */
export function RomNameInner(
  props: RomMetadataCellProps & { readonly leadingIcon?: ReactNode },
): JSX.Element {
  const { rom, dimmed, leadingIcon, metadata } = props;
  const displayName = metadata?.name ?? rom.displayName;

  return (
    <span className="flex min-w-0 items-center gap-2">
      {leadingIcon}
      <span className={cn('truncate text-body-sm', !dimmed && 'text-fg')}>
        {displayName}
      </span>
    </span>
  );
}

/**
 * Year cell (PR-A item 8). Right-aligned, mono, `—` for missing
 * year. Skeletoned during the loading state. The width pairs with
 * the YEAR column header in the parent.
 */
export function RomYearCell(props: RomMetadataCellProps): JSX.Element {
  const { dimmed, metadata, error } = props;
  const loading = metadata === undefined && !error;
  const year = metadata?.year ?? null;

  return (
    <TableCell className="w-16 text-right">
      <span
        className={cn(
          'font-mono text-body-sm tabular',
          !dimmed && 'text-fg-muted',
        )}
      >
        {loading ? (
          <DashSkeleton width="w-10" />
        ) : year !== null ? (
          String(year)
        ) : (
          <span className="text-fg-disabled">—</span>
        )}
      </span>
    </TableCell>
  );
}

/** Genre / Rating cells. Sit right of the Year cell.
 *
 * Round 7 dropped the System cell. PR-A item 8 promoted Year into
 * its own cell (`RomYearCell`); this component now emits just
 * Genre + Rating.
 */
export function RomMetadataInfoCells(
  props: RomMetadataCellProps,
): JSX.Element {
  const { dimmed, metadata, error } = props;
  const loading = metadata === undefined && !error;
  const primaryGenre = pickPrimaryGenre(metadata?.genre ?? null);
  const rating = formatRating(metadata?.rating ?? null);

  return (
    <>
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

/** Last path segment, used in diag logs to keep lines readable. */
function shortName(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}
