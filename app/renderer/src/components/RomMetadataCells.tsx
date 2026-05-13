import {
  AlertCircle,
  CornerUpLeft,
  Eye,
  EyeOff,
  // feat/pre-beta-polish-batch (H): the folder marker used to be a
  // thumbnail overlay (lost against busy box-art). It moves into
  // the name-cell subtitle below — same icon, new home.
  Folder as FolderIcon,
  FolderOpen,
  ImageOff,
} from 'lucide-react';
import type {
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react';

import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import { diagLog } from '@shared/diag-log';

import { Button } from '@app/renderer/src/components/ui/button';
import { DensityBar } from '@app/renderer/src/components/ui/density-bar';
import { StatusIndicator } from '@app/renderer/src/components/ui/status-indicator';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { TableCell } from '@app/renderer/src/components/ui/table';
import { cn } from '@app/renderer/src/lib/cn';
import { formatBytes } from '@app/renderer/src/lib/format';
import { formatGenreList } from '@app/renderer/src/lib/genre-format';
import {
  displayGenre as displayGenreOf,
  displayName as displayNameOf,
  displayRating as displayRatingOf,
  displayTags as displayTagsOf,
  displayYear as displayYearOf,
} from '@app/renderer/src/lib/metadata-display';
import { RomTagPills } from '@app/renderer/src/components/RomTagPills';
import {
  formatRating,
  pickPrimaryGenre,
} from '@app/renderer/src/lib/rom-metadata-format';
import type { RowType } from '@app/renderer/src/lib/row-type';
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

/**
 * Single thumbnail cell. Sits right of the checkbox, left of name.
 *
 * PR #23 round 3 part 2: branches on visual `rowType` so every row
 * presents a 40px tile of SOMETHING, not the previous mix of "box-art
 * tile for games" / "ImageOff fallback for folders" / "no tile at all
 * for back row":
 *
 *   • `'game'`              — box art (or skeleton / error / ImageOff
 *                             fallback in that priority order).
 *   • `'single-game-folder'`— the same box-art-tile chain plus a small
 *                             folder badge overlay in the bottom-right
 *                             corner. The contained game's box art
 *                             will appear once metadata fetching for
 *                             folder-atomic ROMs is wired (separate
 *                             scope — see RomsPane prefetch). For
 *                             now the badge sits on the ImageOff
 *                             fallback so the row still reads as "this
 *                             is a folder containing a game".
 *   • `'explorable-folder'` — 40px tile with a centered FolderOpen
 *                             icon. No metadata, no chains.
 *   • `'back'`              — handled by `BackThumbnailCell` (the back
 *                             row has no `Rom`).
 */
export function RomThumbnailCell(
  props: RomMetadataCellProps & {
    readonly rowType: RowType;
    /**
     * feat/pre-beta-polish-batch — optional onClick wires the
     * thumbnail to the same activation the title cell exposes (open
     * detail dialog for files / atomic folders, drill for container
     * folders). When supplied, the cell renders with `cursor-pointer`
     * and the call-through `aria-label` / `title` from `clickLabel`.
     * Pre-fix only the title was clickable; the user reported the
     * art tile felt like it should be too — it's the strongest
     * affordance on the row.
     */
    readonly onClick?: () => void;
    readonly clickLabel?: string;
  },
): JSX.Element {
  const { metadata, error, rowType, onClick, clickLabel } = props;
  const loading = metadata === undefined && !error;
  // Hooks must run unconditionally — call useBoxArt regardless of
  // rowType. Folder-container rows hand it `null` (no metadata =
  // no box art URL) so it's a no-op.
  const boxArtObjectUrl = useBoxArt(metadata?.boxArtUrl ?? null);
  // Shared className contract for the wrapping cell. `relative` is
  // only needed for the `single-game-folder` badge overlay, but
  // keeping it everywhere lets the parent class string stay one
  // line. Cursor + hover-emphasis surface only when there's an
  // onClick — a non-interactive cell shouldn't hint clickability.
  const cellClassName = cn(
    'w-16 p-1',
    onClick !== undefined && 'cursor-pointer',
  );
  const cellInteractiveProps =
    onClick !== undefined
      ? {
          onClick: (e: ReactMouseEvent) => {
            e.stopPropagation();
            onClick();
          },
          role: 'button' as const,
          tabIndex: 0,
          title: clickLabel,
          'aria-label': clickLabel,
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onClick();
            }
          },
        }
      : {};

  if (rowType === 'explorable-folder') {
    return (
      <TableCell className={cellClassName} {...cellInteractiveProps}>
        <FolderTile icon="open" ariaLabel={`Folder: ${props.rom.displayName}`} />
      </TableCell>
    );
  }

  // Shared base for `'game'` and `'single-game-folder'`: render the
  // existing tile chain, then optionally composite the folder badge
  // on top for single-game-folder.
  const baseTile = loading ? (
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
  );

  if (rowType === 'single-game-folder') {
    // feat/pre-beta-polish-batch (H): the folder-marker badge that
    // used to live overlaid on the thumbnail moved into the
    // name-cell subtitle (next to the folder-name subline) where it
    // reads against the canvas instead of arbitrary box-art. The
    // thumbnail itself is now the same shape as a regular game
    // tile, with no overlay glyph.
    return (
      <TableCell className={cellClassName} {...cellInteractiveProps}>
        {baseTile}
      </TableCell>
    );
  }

  // 'game'
  return (
    <TableCell className={cellClassName} {...cellInteractiveProps}>
      {baseTile}
    </TableCell>
  );
}

/**
 * Thumbnail cell for the synthetic back-row. Same 40px footprint as
 * the game tiles so the column has consistent visual rhythm; centers
 * a CornerUpLeft icon to read as "navigate up". Picked over
 * `ArrowLeft` because the cornered glyph reads as "back / out" rather
 * than "previous in a list" — the row IS the action of leaving the
 * current folder, not stepping through items.
 */
export function BackThumbnailCell(): JSX.Element {
  return (
    <TableCell className="w-16 p-1">
      <FolderTile icon="back" ariaLabel="Back to parent folder" />
    </TableCell>
  );
}

/**
 * Shared 40px tile chrome for non-art rows. Same dimensions as the
 * box-art tile (`h-12 w-12 rounded-sm`) and the ImageOff fallback so
 * the column has a single visual rhythm regardless of row type.
 */
function FolderTile(props: {
  readonly icon: 'open' | 'back';
  readonly ariaLabel: string;
}): JSX.Element {
  const Icon = props.icon === 'open' ? FolderOpen : CornerUpLeft;
  return (
    <div
      className="flex h-12 w-12 items-center justify-center rounded-sm bg-overlay/40 text-fg-muted"
      aria-label={props.ariaLabel}
    >
      <Icon className="size-5" strokeWidth={1.5} aria-hidden />
    </div>
  );
}

/**
 * Inner content for the Name TableCell — title + (optional) filename
 * subline. PR-A item 8 promoted year out of this stack into a
 * dedicated `RomYearCell`. The parent owns the surrounding
 * `<TableCell>` so the existing icons (system / folder), click
 * handlers, and dim styling stay where they were.
 *
 * PR #25: the inner span carries `title={displayName}` so the full
 * title surfaces in the browser-native hover tooltip when the visible
 * text is truncated. Set unconditionally — for short titles the
 * tooltip duplicates what's already visible (harmless), and skipping
 * the conditional avoids needing JS scrollWidth detection or a
 * dedicated Tooltip primitive (the codebase doesn't ship one and the
 * existing tooltips throughout the app use the same `title=` pattern).
 *
 * feat/filename-in-listings: when the resolved title differs from
 * the on-disk filename (i.e. metadata gave us a real name), surface
 * the filename below in muted/smaller style. Disambiguates rows that
 * share a title but have different region/version tags
 * (`Sonic the Hedgehog (USA).bin` vs `Sonic the Hedgehog (Japan).bin`)
 * and confirms the underlying file even when metadata is rich.
 *
 * Skipped when:
 *   • the row is an atomic folder — the folder name IS the
 *     displayed name; surfacing it again is redundant.
 *   • the row is a container folder — drill-in is the action; no
 *     meaningful filename to disambiguate.
 *   • title === filename (no metadata yet → displayName falls back
 *     to filename → showing both is duplicated noise).
 */
export function RomNameInner(
  props: RomMetadataCellProps & { readonly leadingIcon?: ReactNode },
): JSX.Element {
  const { rom, dimmed, leadingIcon, metadata } = props;
  // PR-D2 (PR #29): route through `displayNameOf` so the user-set
  // `userOverride.name` wins over the source-resolved name. Falls
  // back to the on-disk filename when no metadata record exists
  // yet (loading / unmatched).
  const displayName =
    metadata !== null && metadata !== undefined
      ? displayNameOf(metadata)
      : rom.displayName;
  // PR-D2 (PR #29): user-set tags render as colored pills next to
  // the title. `RomTagPills` returns null when no tags so the
  // markup degrades cleanly for the common case.
  const tags =
    metadata !== null && metadata !== undefined ? displayTagsOf(metadata) : [];
  const showFilename = shouldShowFilenameSubline(rom, displayName);
  // fix/count-and-status-indicator commit 2 — binary per-row
  // scrape state. Cold blue while metadata is loading or when SS /
  // OpenVGDB returned no match; full signal-green halo once we
  // have data we can show. The dot sits before the title, so its
  // column position stays consistent across rows of varying lengths.
  const rowProgress = metadata !== null && metadata !== undefined ? 1 : 0;

  return (
    <span className="flex min-w-0 items-center gap-2">
      {leadingIcon}
      <StatusIndicator
        progress={rowProgress}
        sizePx={8}
        ariaLabel={
          rowProgress === 1
            ? `${displayName} metadata ready`
            : `${displayName} metadata pending`
        }
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn('truncate text-body-sm', !dimmed && 'text-fg')}
          title={displayName}
        >
          {displayName}
        </span>
        {showFilename ? (
          <span className="flex min-w-0 items-center gap-1">
            {/* feat/pre-beta-polish-batch (H): the folder-marker
                used to live as an overlay on the thumbnail
                (lost against busy box-art). It moves inline with
                the folder-name subline where it sits against the
                row background and reads clearly. Same icon,
                smaller footprint. Skipped for plain file rows. */}
            {rom.kind === 'folder-atomic' ? (
              <FolderIcon
                className="size-3 shrink-0 text-fg-muted"
                strokeWidth={1.75}
                aria-label="folder"
              />
            ) : null}
            <span
              className="truncate text-caption text-fg-muted"
              title={rom.filename}
            >
              {rom.filename}
            </span>
          </span>
        ) : null}
      </span>
      <RomTagPills tags={tags} />
    </span>
  );
}

/**
 * feat/filename-in-listings: filename-subline gate. Exported so the
 * test file can pin the contract directly without rendering JSX.
 *
 * feat/pre-beta-polish-batch (G): atomic folders now ALSO show the
 * folder basename as a subline when their displayName differs from
 * the basename (i.e. metadata gave us a real game name distinct
 * from `_SomeFolder`). Container folders still skip — they're
 * drillable, the folder name IS the heading. The subline is gated
 * by the same display-vs-filename diff used for file rows: when
 * the title degenerates to the basename (no metadata yet), the
 * subline would duplicate the title and is suppressed.
 */
export function shouldShowFilenameSubline(
  rom: { readonly kind: Rom['kind']; readonly filename: string },
  displayName: string,
): boolean {
  // Container folders skip — drill-in is the action; the folder
  // name IS the heading.
  if (rom.kind === 'folder-container') return false;
  // Skip when the title is identical to the filename — happens when
  // there's no metadata yet and `displayName` falls back to the
  // on-disk name. Surfacing both would be duplicate noise.
  if (displayName === rom.filename) return false;
  return true;
}

/**
 * Year cell (PR-A item 8). Right-aligned, mono, `—` for missing
 * year. Skeletoned during the loading state. The width pairs with
 * the YEAR column header in the parent.
 */
export function RomYearCell(props: RomMetadataCellProps): JSX.Element {
  const { dimmed, metadata, error } = props;
  const loading = metadata === undefined && !error;
  // PR-D2 (PR #29): user-override wins via `displayYearOf`.
  const year = metadata ? displayYearOf(metadata) : null;

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
  // PR-D2 (PR #29): user-override wins via `displayGenreOf` /
  // `displayRatingOf`. chore/search-and-filter-cleanup commit 3:
  // run the cached value through `formatGenreList` first so multi-
  // language and slash-duplicated forms ("Action / Action",
  // "RPG / Role-Playing Game") collapse before the primary-pick.
  // `formatGenreList` also applies the abbreviation map per slash-
  // token, so the cell's abbreviation no longer needs a separate
  // call.
  const cleanedGenre = formatGenreList(
    metadata ? displayGenreOf(metadata) : null,
  );
  const primaryGenre = pickPrimaryGenre(cleanedGenre);
  const displayGenre = primaryGenre ?? '';
  const rating = formatRating(
    metadata ? displayRatingOf(metadata) : null,
  );

  return (
    <>
      <TableCell className="w-28 truncate">
        <span
          className={cn('truncate text-body-sm', !dimmed && 'text-fg-muted')}
          title={cleanedGenre !== '' ? cleanedGenre : undefined}
        >
          {loading ? (
            <DashSkeleton width="w-16" />
          ) : displayGenre !== '' ? (
            displayGenre
          ) : (
            <span className="text-fg-disabled">—</span>
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

/**
 * Stable className contract for the density+eye cell. Exported so the
 * regression test can pin them without reaching into a render tree —
 * the combination `relative` on the `<td>` + `absolute inset-0` on the
 * inner wrapper is THE fix that makes the density bar fill the row
 * height. See the long comment on `RomDensityEyeCell` below.
 */
export const DENSITY_EYE_CELL_CLASSNAMES = {
  cell: 'relative p-0',
  wrapper: 'absolute inset-0 flex shrink-0 items-stretch',
} as const;

/**
 * Combined density-rectangle + Eye-toggle cell — the right-edge slot on
 * every ROM row. PR #23 round 4 extracted this from RomsPane so the
 * absolute-positioning workaround has a stable contract a unit test
 * can pin.
 *
 * Why absolute positioning:
 *
 *   • Round 1 hardcoded the bar to `h-10` (40px) — visible but with a
 *     ~16px gap above + below because the row's actual height is ~56px
 *     (the 48px thumbnail in `w-16 p-1` drives it past the design-token
 *     40px on `<tr>`).
 *   • Round 2 reverted to `h-10` after `h-full` rendered as 0 in some
 *     row configurations. Round 3 part 1 added `h-full` to the `<td>`
 *     hoping percentage-height would chain through the cell. Live test
 *     said no — the chain doesn't propagate reliably in Chromium when
 *     the parent `<tr>` height is content-driven.
 *   • Round 4 stops fighting table-cell percentage heights entirely.
 *     `position: relative` on the `<td>` + `position: absolute; inset: 0`
 *     on the inner wrapper makes the wrapper fill the cell's actual
 *     rendered bounds REGARDLESS of how the height resolves. The
 *     DensityBar then fills the wrapper via its default `h-full`,
 *     which is now resolving against an absolutely-positioned parent
 *     with a defined size.
 *
 * Width: the column header (`<TableHead className="w-[3.25rem] p-0"/>`)
 * sets the column to ~52px; the body cell inherits that width from the
 * table layout, so absolute-only content doesn't collapse the column.
 *
 * Adjacent-cell behavior: the absolutely-positioned wrapper doesn't
 * leak — its `inset-0` is bounded by `<td position: relative>`. The
 * Eye button stays vertically centered via `self-center` inside the
 * stretched flex container.
 */
export function RomDensityEyeCell(props: {
  readonly rom: Rom;
  readonly isSystem: boolean;
  readonly maxSizeBytes: number;
  readonly canMutate: boolean;
  readonly disconnectedTooltip: string;
  readonly onSingleToggle: (rom: Rom) => void;
}): JSX.Element {
  const {
    rom,
    isSystem,
    maxSizeBytes,
    canMutate,
    disconnectedTooltip,
    onSingleToggle,
  } = props;
  // Class strings inlined as literals (rather than referencing
  // `DENSITY_EYE_CELL_CLASSNAMES`) so source-string scanners like
  // `right-edge-stack.test.ts` can find them without resolving a
  // const reference. The exported constants must agree with the
  // strings here — `RomMetadataCells.test.ts` pins both ends.
  return (
    <TableCell className="relative p-0">
      <div className="absolute inset-0 flex shrink-0 items-stretch">
        {!isSystem ? (
          <DensityBar
            floor="bg-elevated"
            value={rom.sizeBytes}
            max={maxSizeBytes}
            ariaLabel={`${formatBytes(rom.sizeBytes)} of peer max ${formatBytes(maxSizeBytes)}`}
          />
        ) : null}
        {isSystem ? (
          <span
            className="flex items-center px-2 font-mono text-body-sm text-fg-disabled"
            aria-label="read-only"
          >
            read-only
          </span>
        ) : (
          // Eye / EyeOff toggle — always visible at rest; row-hover
          // lifts opacity (matches the cores pane via `group-hover/row`
          // on the TableRow primitive). `canMutate` gates against a
          // lost-connection session.
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void onSingleToggle(rom)}
            disabled={!canMutate}
            title={
              canMutate
                ? rom.hidden
                  ? `Show ${rom.displayName}`
                  : `Hide ${rom.displayName}`
                : disconnectedTooltip
            }
            aria-label={
              rom.hidden
                ? `Show ${rom.displayName}`
                : `Hide ${rom.displayName}`
            }
            className="self-center opacity-70 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
          >
            {rom.hidden ? (
              <EyeOff strokeWidth={1.5} />
            ) : (
              <Eye strokeWidth={1.5} />
            )}
          </Button>
        )}
      </div>
    </TableCell>
  );
}
