import { useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { RomMetadata } from '@shared/metadata-types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { useBoxArt } from '@app/renderer/src/lib/use-box-art';
import {
  displayGenre,
  displayName,
  displayNote,
  displayRating,
  displayTags,
  displayYear,
} from '@app/renderer/src/lib/metadata-display';

/**
 * feat/metadata-detail-modal — rich detail view for a ROM row.
 *
 * Opens on single-click for `file` / `folder-atomic` rows. Holds the
 * cached metadata snapshot; never fetches anything itself except via
 * `useBoxArt` (the same hook the rows + search modal use), which
 * goes through the existing main-process image cache.
 *
 * Layout (max-w-3xl):
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ Title                                                [×] │
 *   │ Developer · Year · Genre · System                         │
 *   ├──────────────┬───────────────────────────────────────────┤
 *   │ Box art      │ Synopsis (if present)                     │
 *   │              │ Key facts (Players / Rating / Released)   │
 *   │ Provenance   │ Tags / Note                               │
 *   ├──────────────┴───────────────────────────────────────────┤
 *   │ Screenshots strip (if present)                            │
 *   ├──────────────────────────────────────────────────────────┤
 *   │     [ Edit... ] [ Find on ScreenScraper... ] [ Close ]    │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Action buttons hand off to the existing edit + search modals via
 * `onEdit` / `onSearch` callbacks — RomsPane owns those modals'
 * state and the detail modal just closes itself and signals which to
 * open next.
 */
export interface RomDetailDialogProps {
  /** The ROM's on-device path — used by hand-off callbacks. */
  readonly path: string;
  /**
   * On-disk filename. Used as the title fallback when `metadata` is
   * null (the no-record case). Always passed regardless of metadata
   * state so the modal can render an empty-state view.
   */
  readonly filename: string;
  /**
   * Current cache record, or null when the row has no metadata yet
   * (prefetch hasn't landed OR `source: 'none'` sentinel). Modal
   * renders an empty state in the null case with "Find on
   * ScreenScraper" as the primary action.
   */
  readonly metadata: RomMetadata | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /**
   * Hand off to the edit-metadata modal (closes self first). The
   * Edit button is hidden in the empty state — `RomEditMetadataDialog`
   * requires a non-null record. Also hidden when `readOnly=true`.
   */
  readonly onEdit: () => void;
  /**
   * Hand off to the Find on ScreenScraper modal (closes self first).
   * Hidden when `readOnly=true` (arcade detail view is read-only;
   * a manual ScreenScraper search dialog tailored to .mras is v0.2).
   */
  readonly onSearch: () => void;
  /**
   * feat/arcade-parity-3-ui — read-only mode for surfaces where the
   * Edit / Find-on-ScreenScraper hand-offs aren't wired yet (e.g.
   * the arcade pane). Hides both buttons; the only action left is
   * Close. Additive — defaults to `false`, existing RomsPane wiring
   * keeps its full button row.
   */
  readonly readOnly?: boolean;
}

export function RomDetailDialog(props: RomDetailDialogProps): JSX.Element {
  const { filename, metadata, open, onOpenChange, onEdit, onSearch, readOnly } =
    props;
  if (metadata === null) {
    return (
      <EmptyDetailDialog
        filename={filename}
        open={open}
        onOpenChange={onOpenChange}
        onSearch={onSearch}
        readOnly={readOnly === true}
      />
    );
  }
  return (
    <PopulatedDetailDialog
      metadata={metadata}
      open={open}
      onOpenChange={onOpenChange}
      onEdit={onEdit}
      onSearch={onSearch}
      readOnly={readOnly === true}
    />
  );
}

function PopulatedDetailDialog(props: {
  readonly metadata: RomMetadata;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly onSearch: () => void;
  readonly readOnly: boolean;
}): JSX.Element {
  const { metadata, open, onOpenChange, onEdit, onSearch, readOnly } = props;

  // Lightbox state, scoped to this dialog instance. A non-null URL
  // mounts the nested Dialog; null hides it. Radix handles Esc +
  // click-outside-overlay to close.
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const boxArtUrl = metadata.boxArtUrl;
  const boxArt = useBoxArt(boxArtUrl);

  const title = displayName(metadata);
  const year = displayYear(metadata);
  const genre = displayGenre(metadata);
  const rating = displayRating(metadata);
  const tags = displayTags(metadata);
  const note = displayNote(metadata);

  // Subhead: developer · year · genre · system. Drop empties so we
  // don't render trailing separators.
  const subheadParts = [
    metadata.developer,
    year !== null ? String(year) : null,
    genre,
    metadata.system === '' ? null : metadata.system,
  ].filter((p): p is string => p !== null && p !== '');

  const description = metadata.description;
  const players = metadata.players;
  const releaseDate = metadata.releaseDate;
  const publisher = metadata.publisher;

  const screenshots = metadata.screenshotUrls ?? [];

  function handleEdit(): void {
    onOpenChange(false);
    onEdit();
  }
  function handleSearch(): void {
    onOpenChange(false);
    onSearch();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl gap-3 p-5">
        <DialogHeader>
          <DialogTitle className="pr-8 truncate" title={title}>
            {title}
          </DialogTitle>
          {subheadParts.length > 0 ? (
            <p className="text-body-sm text-fg-muted truncate">
              {subheadParts.join(' · ')}
            </p>
          ) : null}
        </DialogHeader>

        <div className="grid grid-cols-[12rem_1fr] gap-5">
          {/* Left column: box art + provenance footer. Fixed width
              keeps the right column's text reflow predictable across
              boxes of varying aspect ratios. */}
          <div className="flex flex-col gap-2">
            {boxArt !== null ? (
              <img
                src={boxArt}
                alt={`${title} box art`}
                className="w-full rounded-sm border border-subtle bg-overlay/40 object-contain"
              />
            ) : (
              <div className="aspect-[3/4] w-full rounded-sm border border-subtle bg-overlay/40" />
            )}
            <ProvenanceFooter metadata={metadata} />
          </div>

          {/* Right column: synopsis + key facts + tags + note. Each
              section omits itself when its data is absent. */}
          <div className="flex flex-col gap-4 min-w-0">
            {description !== null && description.length > 0 ? (
              <section className="flex flex-col gap-1">
                <SectionLabel>Synopsis</SectionLabel>
                <p className="text-body-sm text-fg whitespace-pre-line">
                  {description}
                </p>
              </section>
            ) : null}

            <section className="grid grid-cols-2 gap-x-4 gap-y-2">
              <KeyFact label="Players" value={players} />
              <KeyFact
                label="Rating"
                value={rating !== null ? formatRating(rating) : null}
              />
              <KeyFact label="Released" value={releaseDate} />
              <KeyFact label="Publisher" value={publisher} />
            </section>

            {tags.length > 0 ? (
              <section className="flex flex-col gap-1">
                <SectionLabel>Tags</SectionLabel>
                <div className="flex flex-wrap gap-1">
                  {tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-sm bg-elevated px-2 py-0.5 text-caption text-fg"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            ) : null}

            {note !== null && note.length > 0 ? (
              <section className="flex flex-col gap-1">
                <SectionLabel>Note</SectionLabel>
                <p className="text-body-sm text-fg-body whitespace-pre-line">
                  {note}
                </p>
              </section>
            ) : null}
          </div>
        </div>

        {screenshots.length > 0 ? (
          <section className="flex flex-col gap-2">
            <SectionLabel>Screenshots</SectionLabel>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {screenshots.map((url) => (
                <ScreenshotThumb
                  key={url}
                  url={url}
                  onClick={() => setLightboxUrl(url)}
                />
              ))}
            </div>
          </section>
        ) : null}

        <div className="flex justify-end gap-2 pt-1">
          {readOnly ? null : (
            <>
              <Button variant="ghost" onClick={handleEdit}>
                Edit...
              </Button>
              <Button variant="ghost" onClick={handleSearch}>
                Find on ScreenScraper...
              </Button>
            </>
          )}
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>

        {lightboxUrl !== null ? (
          <Lightbox
            url={lightboxUrl}
            onClose={() => setLightboxUrl(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SectionLabel(props: { readonly children: ReactNode }): JSX.Element {
  return (
    <span className="text-caption uppercase tracking-[0.08em] text-fg-muted">
      {props.children}
    </span>
  );
}

function KeyFact(props: {
  readonly label: string;
  readonly value: string | null;
}): JSX.Element | null {
  if (props.value === null || props.value === '') return null;
  return (
    <div className="flex flex-col gap-0.5">
      <SectionLabel>{props.label}</SectionLabel>
      <span className="text-body-sm text-fg">{props.value}</span>
    </div>
  );
}

function ProvenanceFooter(props: {
  readonly metadata: RomMetadata;
}): JSX.Element {
  const { metadata } = props;
  const date = metadata.fetchedAt.slice(0, 10);
  return (
    <div className="flex flex-col gap-0.5 text-caption text-fg-muted">
      <span>source: {metadata.source}</span>
      <span>fetched: {date}</span>
    </div>
  );
}

function ScreenshotThumb(props: {
  readonly url: string;
  readonly onClick: () => void;
}): JSX.Element {
  const { url, onClick } = props;
  const localUrl = useBoxArt(url);
  return (
    <button
      type="button"
      onClick={onClick}
      className="shrink-0 rounded-sm border border-subtle bg-overlay/40 transition-colors hover:border-emphasis focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
      aria-label="Open screenshot at full size"
    >
      {localUrl !== null ? (
        <img
          src={localUrl}
          alt="Screenshot"
          className="h-24 rounded-sm object-contain"
        />
      ) : (
        <div className="h-24 w-32 rounded-sm" />
      )}
    </button>
  );
}

/**
 * Click-to-enlarge nested Dialog. Single fullscreen <img> centered;
 * Esc and click-on-overlay close (Radix defaults). The image bytes
 * are already cached locally by the time the thumbnail renders, so
 * the lightbox <img> resolves instantly from the same `useBoxArt`
 * hook — no second network fetch.
 */
function Lightbox(props: {
  readonly url: string;
  readonly onClose: () => void;
}): JSX.Element {
  const localUrl = useBoxArt(props.url);
  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : props.onClose())}>
      <DialogContent
        className="max-w-[min(96vw,1600px)] border-none bg-transparent p-0 shadow-none"
        aria-label="Screenshot at full size"
      >
        {/* Radix Dialog requires a title for a11y; visually hidden
            since the user-facing label is the image itself. */}
        <DialogTitle className="sr-only">Screenshot</DialogTitle>
        {localUrl !== null ? (
          <img
            src={localUrl}
            alt="Screenshot at full size"
            className="max-h-[90vh] w-full rounded-sm object-contain"
          />
        ) : (
          <div className="h-[60vh] w-full rounded-sm bg-overlay/40" />
        )}
      </DialogContent>
    </Dialog>
  );
}

function formatRating(rating: number): string {
  return `${rating.toFixed(1)} / 10`;
}

/**
 * No-metadata variant of the detail dialog. Same shell, but with the
 * filename as the title, a placeholder body explaining the state,
 * and "Find on ScreenScraper" elevated to the primary action (Edit
 * is hidden — the edit modal requires a non-null record).
 *
 * The modal-as-discovery-point story: every file / folder-atomic row
 * is clickable; the modal contextualizes the state and offers the
 * right next action, regardless of whether metadata has landed.
 */
function EmptyDetailDialog(props: {
  readonly filename: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSearch: () => void;
  readonly readOnly: boolean;
}): JSX.Element {
  function handleSearch(): void {
    props.onOpenChange(false);
    props.onSearch();
  }
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-3xl gap-3 p-5">
        <DialogHeader>
          <DialogTitle className="pr-8 truncate" title={props.filename}>
            {props.filename}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[12rem_1fr] gap-5">
          <div className="aspect-[3/4] w-full rounded-sm border border-subtle bg-overlay/40" />
          <div className="flex min-w-0 flex-col gap-2">
            <SectionLabel>No metadata yet</SectionLabel>
            <p className="text-body-sm text-fg-body">
              {props.readOnly
                ? "ScreenScraper hasn't matched this entry. The auto-scrape pass will retry on the next connect; manual search is coming in a follow-up."
                : 'ScreenScraper hasn\'t matched this file. Click "Find on ScreenScraper" to search manually, or wait for the prefetch to land.'}
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          {props.readOnly ? null : (
            <Button variant="primary" onClick={handleSearch}>
              Find on ScreenScraper...
            </Button>
          )}
          <Button
            variant={props.readOnly ? 'primary' : 'ghost'}
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
