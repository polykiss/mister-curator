import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { JSX, ReactNode } from 'react';

import type { RomMetadata } from '@shared/metadata-types';

import { Button } from '@app/renderer/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@app/renderer/src/components/ui/dialog';
import { cn } from '@app/renderer/src/lib/cn';
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
   * requires a non-null record. Also hidden when `allowEdit=false`.
   */
  readonly onEdit: () => void;
  /**
   * Hand off to the Find on ScreenScraper modal (closes self first).
   * Hidden when `allowSearch=false`.
   */
  readonly onSearch: () => void;
  /**
   * feat/arcade-manual-ss-search — per-action toggles for surfaces
   * that wire only some of the hand-offs.
   *
   * Default to `true` so existing RomsPane callsites (which pass
   * neither flag) keep their full Edit + Find button row unchanged.
   * The arcade pane passes `allowEdit={false}` `allowSearch={true}`
   * — the metadata-edit dialog isn't wired for .mras yet, but the
   * Find-on-ScreenScraper bind path is, so arcade users can manually
   * fix mis-matched entries from the same surface RomsPane users
   * already know.
   */
  readonly allowEdit?: boolean;
  readonly allowSearch?: boolean;
  /**
   * Convenience shorthand: `readOnly={true}` defaults both
   * `allowEdit` and `allowSearch` to `false`. Explicit per-action
   * props (`allowEdit={false}`, `allowSearch={true}`, etc.) override
   * this default. Kept for callers that want to express "no
   * mutations from this surface" in a single flag.
   */
  readonly readOnly?: boolean;
  /**
   * feat/arcade-noromsneeded-overrides — override the empty-state
   * body copy. The default text picks between "click Find" / "auto-
   * scrape will retry" based on `allowSearch`; surfaces that need a
   * third state (the arcade pane's missing-zip wording, for example)
   * supply their own line.
   */
  readonly emptyStateBody?: string;
  /**
   * feat/detail-modal-nav-hide — power-curation flow: advance to
   * the previous / next entry in the pane's CURRENT FILTERED + SORTED
   * row list without closing the dialog. The adapter resolves the
   * neighbour and passes the callback; at list boundaries the
   * adapter passes `undefined` for the missing direction so the
   * button renders disabled.
   *
   * Both callbacks are independent: a list of two entries leaves
   * onPrev defined while on entry 2 and onNext undefined (etc.).
   * When BOTH are undefined the dialog skips the navigation
   * affordance entirely.
   */
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
  /**
   * feat/detail-modal-nav-hide — Hide/Unhide button in the dialog
   * footer. When `hideAction` is supplied the button renders with
   * the label derived from `currentHidden` and `onToggle` flips
   * the entry's hide state (optimistic in the adapter; the dialog
   * just invokes the callback). Adapters omit this prop for
   * entries that don't support hide (e.g. missing-zip arcade
   * rows). The adapter's `onToggle` is expected to:
   *   • apply the hide/unhide (same path as the row's eye toggle),
   *   • on SSH success advance to the next entry (or close),
   *   • on SSH failure surface a toast + stay on the current entry.
   */
  readonly hideAction?: {
    readonly currentHidden: boolean;
    readonly onToggle: () => void;
  };
}

export function RomDetailDialog(props: RomDetailDialogProps): JSX.Element {
  const {
    filename,
    metadata,
    open,
    onOpenChange,
    onEdit,
    onSearch,
    allowEdit,
    allowSearch,
    readOnly,
    emptyStateBody,
    onPrev,
    onNext,
    hideAction,
  } = props;
  const defaultAllow = readOnly === true ? false : true;
  const resolvedAllowEdit = allowEdit ?? defaultAllow;
  const resolvedAllowSearch = allowSearch ?? defaultAllow;
  if (metadata === null) {
    return (
      <EmptyDetailDialog
        filename={filename}
        open={open}
        onOpenChange={onOpenChange}
        onSearch={onSearch}
        allowSearch={resolvedAllowSearch}
        bodyOverride={emptyStateBody}
        onPrev={onPrev}
        onNext={onNext}
        hideAction={hideAction}
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
      allowEdit={resolvedAllowEdit}
      allowSearch={resolvedAllowSearch}
      onPrev={onPrev}
      onNext={onNext}
      hideAction={hideAction}
    />
  );
}

function PopulatedDetailDialog(props: {
  readonly metadata: RomMetadata;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onEdit: () => void;
  readonly onSearch: () => void;
  readonly allowEdit: boolean;
  readonly allowSearch: boolean;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
  readonly hideAction?: RomDetailDialogProps['hideAction'];
}): JSX.Element {
  const {
    metadata,
    open,
    onOpenChange,
    onEdit,
    onSearch,
    allowEdit,
    allowSearch,
    onPrev,
    onNext,
    hideAction,
  } = props;

  // feat/arcade-parse-tolerance-gallery-polish — lightbox state is
  // an INDEX into the gallery's media slots (was a URL pre-PR). The
  // index lets the arrow keys + onscreen prev/next buttons cycle
  // through the same slot order the thumbnail strip uses, with
  // wrap-around at both ends. `null` = lightbox closed.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // feat/detail-dialog-multi-media — the legacy top-level
  // `useBoxArt(boxArtUrl)` resolution moved into `MediaGallery`
  // (which now owns the primary-image rendering). `boxArtUrl` stays
  // available here as a fallback when the gallery starts with no
  // selection (zero-media metadata edge case).
  const boxArtUrl = metadata.boxArtUrl;

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

  // feat/detail-dialog-multi-media — collect every cached media URL
  // into a single gallery list. SS frequently returns some subset of
  // these per game (box art always, screenshots usually, box3D and
  // marquee less often, clear logo intermittently). Dedup so the same
  // URL doesn't render twice (boxArtUrl can occasionally equal
  // box3DUrl on cores where SS uses the same render). Box art leads
  // when present so the dialog's default look is unchanged.
  const mediaSlots = buildMediaSlots(metadata);
  // Initial primary: box-art (or the first available slot when no
  // box art exists; null when the game has no media at all).
  const [primaryUrl, setPrimaryUrl] = useState<string | null>(
    mediaSlots[0]?.url ?? null,
  );

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
      {/* feat/arcade-polish-context-menu — `max-w-3xl` already caps the
          dialog at 48rem, but long unbreakable strings (110-char zip
          filenames) make `truncate` (which sets `white-space: nowrap`)
          force the inner content to demand more width than the dialog
          allows, which on some Chromium builds visibly pushes the
          absolutely-positioned X button past the right edge and breaks
          the button row's positioning. Switching the title + subhead
          to `break-words` (overflow-wrap: break-word) lets the title
          wrap to two lines for the worst-case input while staying
          identical for the common case. */}
      {/* feat/detail-modal-nav-hide — modal scales to fit viewport.
          `max-w-[85vw]` caps width at 85% of viewport (was max-w-3xl
          = 768px fixed); `max-h-[85vh]` caps height. On a narrow
          window the dialog shrinks instead of overflowing; on a
          wide window there's negative space around it. The
          scrolling overflow lives on the inner wrapper (below) so
          the absolutely-positioned prev/next arrows stay anchored
          to the DialogContent bounds and don't scroll with content. */}
      <DialogContent className="flex max-h-[85vh] max-w-[85vw] flex-col p-5">
        <PrevNextArrows onPrev={onPrev} onNext={onNext} />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <DialogHeader className="min-w-0">
          <DialogTitle
            className="min-w-0 break-words pr-8"
            title={title}
          >
            {title}
          </DialogTitle>
          {subheadParts.length > 0 ? (
            <p className="text-body-sm text-fg-muted break-words">
              {subheadParts.join(' · ')}
            </p>
          ) : null}
        </DialogHeader>

        {/* feat/arcade-parse-tolerance-gallery-polish — gallery
            promotes to a full-width slot above the info stack. The
            primary container is now fixed-height (`h-[28rem]`) so
            switching thumbnails doesn't reflow the text below; the
            <img> uses object-contain to fit any aspect ratio inside
            the fixed bounds without distortion. */}
        <MediaGallery
          slots={mediaSlots}
          primaryUrl={primaryUrl ?? boxArtUrl}
          onSelect={setPrimaryUrl}
          onEnlarge={() => {
            const idx = mediaSlots.findIndex(
              (s) => s.url === (primaryUrl ?? boxArtUrl),
            );
            setLightboxIndex(idx >= 0 ? idx : 0);
          }}
          title={title}
        />

        <div className="flex flex-col gap-4 min-w-0">
          {description !== null && description.length > 0 ? (
            <section className="flex flex-col gap-1">
              <SectionLabel>Synopsis</SectionLabel>
              <p className="text-body-sm text-fg whitespace-pre-line">
                {description}
              </p>
            </section>
          ) : null}

          <section className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
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

          <ProvenanceFooter metadata={metadata} />
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {hideAction !== undefined ? (
            <Button variant="ghost" onClick={hideAction.onToggle}>
              {hideAction.currentHidden ? 'Unhide' : 'Hide'}
            </Button>
          ) : null}
          {allowEdit ? (
            <Button variant="ghost" onClick={handleEdit}>
              Edit...
            </Button>
          ) : null}
          {allowSearch ? (
            <Button variant="ghost" onClick={handleSearch}>
              Find on ScreenScraper...
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>
        </div>

        {lightboxIndex !== null && mediaSlots.length > 0 ? (
          <Lightbox
            slots={mediaSlots}
            index={lightboxIndex}
            onIndexChange={setLightboxIndex}
            onClose={() => setLightboxIndex(null)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * feat/detail-modal-nav-hide — Prev/Next arrow buttons anchored at
 * the left/right edges of the detail dialog. The adapter passes
 * `onPrev`/`onNext` resolved against the current pane's sorted +
 * filtered row list; either is `undefined` at list boundaries
 * (button renders disabled). When both are undefined the whole
 * affordance disappears (no navigation context — e.g. the detail
 * dialog was opened directly without a list backing it).
 *
 * Chrome mirrors the lightbox arrows from PR #74 / PR #75: 40px
 * rounded button, semi-opaque canvas backplate, focus ring. The
 * smaller size (vs. the lightbox's 48px) reflects that the
 * detail-dialog edge is less visually loaded than a fullscreen
 * image.
 */
function PrevNextArrows(props: {
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
}): JSX.Element | null {
  const { onPrev, onNext } = props;
  if (onPrev === undefined && onNext === undefined) return null;
  const baseClass =
    'absolute top-1/2 z-20 -translate-y-1/2 inline-flex h-10 w-10 items-center justify-center rounded-full bg-canvas/80 text-fg-body shadow-modal transition-colors hover:bg-canvas hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-canvas/80 disabled:hover:text-fg-body';
  return (
    <>
      <button
        type="button"
        onClick={onPrev}
        disabled={onPrev === undefined}
        aria-label="Previous entry"
        className={cn(baseClass, 'left-1')}
      >
        <ChevronLeft className="size-5" strokeWidth={1.5} aria-hidden />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={onNext === undefined}
        aria-label="Next entry"
        className={cn(baseClass, 'right-1')}
      >
        <ChevronRight className="size-5" strokeWidth={1.5} aria-hidden />
      </button>
    </>
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

/**
 * feat/detail-dialog-multi-media — media-type slot for the gallery.
 * Each slot carries the URL plus a short user-facing label used for
 * the alt text + screen-reader name on the thumbnail button.
 */
export interface MediaSlot {
  readonly url: string;
  readonly label: string;
}

/**
 * Build the ordered media-slot list from a cached RomMetadata
 * record. Order matters — the first slot is the gallery's default
 * primary image, so box art leads when present (preserves the
 * pre-PR look on the common case). Dedup by URL so the same image
 * doesn't render twice when SS happens to reuse a URL across media
 * types (the box-2D / box-3D pair is the usual collision).
 *
 * Exported for unit-testing without rendering React.
 */
export function buildMediaSlots(metadata: RomMetadata): MediaSlot[] {
  const out: MediaSlot[] = [];
  const seen = new Set<string>();
  const push = (url: string | null | undefined, label: string): void => {
    if (url === null || url === undefined || url === '') return;
    if (seen.has(url)) return;
    seen.add(url);
    out.push({ url, label });
  };
  push(metadata.boxArtUrl, 'Box art');
  push(metadata.titleScreenUrl, 'Title screen');
  push(metadata.screenshotUrl, 'Screenshot');
  for (const url of metadata.screenshotUrls ?? []) {
    push(url, 'Screenshot');
  }
  push(metadata.box3DUrl, '3D box');
  push(metadata.marqueeUrl, 'Marquee');
  push(metadata.clearLogoUrl, 'Logo');
  return out;
}

/**
 * feat/detail-dialog-multi-media — left-column gallery widget.
 * Primary image at the top (clickable → lightbox); thumbnail strip
 * below for switching the primary. Renders gracefully when only one
 * (or zero) media URLs exist:
 *   • zero  → grey aspect-3/4 placeholder, no thumbnail strip.
 *   • one   → primary only, no thumbnail strip.
 *   • 2+    → primary + horizontal thumbnail strip below.
 *
 * Thumbnails lazy-load via `useBoxArt` (the same hook the row cells
 * and the lightbox use) — no new HTTP path. Per the spec we don't
 * store image bytes locally beyond the existing main-process image
 * cache.
 */
function MediaGallery(props: {
  readonly slots: readonly MediaSlot[];
  readonly primaryUrl: string | null;
  readonly onSelect: (url: string) => void;
  readonly onEnlarge: (url: string) => void;
  readonly title: string;
}): JSX.Element {
  const { slots, primaryUrl, onSelect, onEnlarge, title } = props;
  const primaryLocal = useBoxArt(primaryUrl);
  if (slots.length === 0) {
    // No media at all — render a grey placeholder block sized like
    // the populated primary so the dialog's vertical layout doesn't
    // shift between empty and populated states.
    return (
      <div className="h-[60vh] w-full rounded-sm border border-subtle bg-overlay/40" />
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {/* feat/arcade-parse-tolerance-gallery-polish — fixed-height
          primary container. <img> uses object-contain inside so a
          portrait box-art and a 16:9 screenshot both fit without
          distorting the surrounding layout. Switching thumbnails
          replaces the src — the container's height never changes,
          so nothing below reflows.
          feat/detail-modal-nav-hide — height moves from a fixed
          448px (h-[28rem]) to a viewport-relative `h-[60vh]` so the
          gallery scales with the dialog: a 700px window shows a
          smaller image, a 1400px window shows a bigger one, always
          maintaining the breathing room the dialog's max-h-[85vh]
          enforces around its content. */}
      <button
        type="button"
        onClick={() => primaryUrl !== null && onEnlarge(primaryUrl)}
        className="flex h-[60vh] w-full items-center justify-center overflow-hidden rounded-sm border border-subtle bg-overlay/40 transition-colors hover:border-emphasis focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        aria-label={`${title} primary image — click to enlarge`}
      >
        {primaryLocal !== null ? (
          <img
            src={primaryLocal}
            alt={`${title} primary image`}
            // feat/pre-beta-polish-batch — the IMG fills the
            // fixed-size container; object-contain preserves the
            // source aspect ratio inside that box. Pre-fix the IMG
            // used max-h-full/max-w-full, so smaller-than-container
            // images rendered at their intrinsic size and the
            // primary slot effectively changed size when the user
            // swapped thumbnails between (say) a 800×600 screenshot
            // and a 400×500 box-art.
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="h-full w-full" />
        )}
      </button>
      {slots.length > 1 ? (
        <div className="flex flex-wrap gap-1">
          {slots.map((slot) => (
            <MediaThumb
              key={slot.url}
              slot={slot}
              selected={slot.url === primaryUrl}
              onClick={() => onSelect(slot.url)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Single thumbnail inside `MediaGallery`'s strip. Square-ish 3rem
 * tiles flex-wrap inside the 12rem left column (≈3 per row with the
 * 0.25rem gap). The selected slot gets the accent ring so the user
 * can see which thumb corresponds to the currently-displayed primary.
 */
function MediaThumb(props: {
  readonly slot: MediaSlot;
  readonly selected: boolean;
  readonly onClick: () => void;
}): JSX.Element {
  const { slot, selected, onClick } = props;
  const local = useBoxArt(slot.url);
  return (
    <button
      type="button"
      onClick={onClick}
      title={slot.label}
      aria-label={`Show ${slot.label}`}
      aria-pressed={selected}
      className={cn(
        'h-12 w-12 shrink-0 overflow-hidden rounded-sm border bg-overlay/40 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent',
        selected
          ? 'border-accent'
          : 'border-subtle hover:border-emphasis',
      )}
    >
      {local !== null ? (
        <img
          src={local}
          alt={slot.label}
          className="h-full w-full object-cover"
          loading="lazy"
        />
      ) : (
        <div className="h-full w-full" />
      )}
    </button>
  );
}

/**
 * feat/arcade-parse-tolerance-gallery-polish — navigable lightbox.
 *
 * Click-to-enlarge nested Dialog with prev/next navigation through
 * the same slot list the thumbnail strip uses. Bindings:
 *
 *   • Esc                          → close (Radix's default)
 *   • Click backdrop               → close (Radix's default)
 *   • Click arrow button           → navigate; click does NOT
 *                                    bubble to the backdrop
 *   • ArrowLeft / ArrowRight key   → navigate
 *   • Wrap-around at both ends: index 0 ← right→ last; last → 0
 *
 * The image bytes are already cached locally by the time the
 * thumbnail renders, so the lightbox <img> resolves instantly from
 * the same `useBoxArt` hook — no second network fetch.
 */
function Lightbox(props: {
  readonly slots: readonly MediaSlot[];
  readonly index: number;
  readonly onIndexChange: (next: number) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { slots, index, onIndexChange, onClose } = props;
  const slot = slots[index];
  const localUrl = useBoxArt(slot?.url ?? null);
  const count = slots.length;
  const hasMultiple = count > 1;

  // Wrap-around step: modulo math with the `+ count) % count`
  // double-mod handles negative deltas without a sign branch.
  const step = (delta: number): number =>
    count === 0 ? 0 : ((index + delta) % count + count) % count;

  useEffect(() => {
    if (!hasMultiple) return undefined;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onIndexChange(step(-1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        onIndexChange(step(1));
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // step's closure captures `index` + `count`; binding the effect
    // to those is what re-attaches with fresh state every nav step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, count, hasMultiple]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="h-[96vh] max-w-[96vw] border-none bg-transparent p-0 shadow-none"
        aria-label={`${slot?.label ?? 'Image'} at full size`}
        // feat/pre-beta-polish-batch — the default Dialog X is small
        // (16px icon, muted color, no backplate) and almost
        // invisible against arbitrary image content. Hide it and
        // render a larger, higher-contrast close button below.
        hideDefaultClose
        // feat/detail-modal-nav-hide — click anywhere on the
        // (transparent) DialogContent that ISN'T the image, arrows,
        // or close button closes the lightbox. This restores the
        // "click backdrop to dismiss" expectation users have from
        // every other image lightbox. Radix's overlay-click handler
        // already covers clicks OUTSIDE DialogContent (the small
        // ring of true backdrop visible past the 96vw/96vh dialog);
        // this handler covers the area INSIDE DialogContent that
        // reads as backdrop visually because the dialog is
        // transparent. The image + arrows + close button each
        // stopPropagation on their own onClick so they don't bubble
        // up here.
        onClick={onClose}
      >
        {/* Radix Dialog requires a title for a11y; visually hidden
            since the user-facing label is the image itself. */}
        <DialogTitle className="sr-only">
          {slot?.label ?? 'Image'}
        </DialogTitle>
        {/* feat/pre-beta-polish-batch — large, high-contrast close
            button at the top-right of the lightbox. Same size /
            chrome as the prev/next arrows so the affordances read
            as a set. Click bubbles to Radix's overlay handler via
            DialogClose semantics. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close"
          className="absolute right-4 top-4 z-20 inline-flex h-12 w-12 items-center justify-center rounded-full bg-canvas/80 text-fg-body shadow-modal transition-colors hover:bg-canvas hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="size-6" strokeWidth={1.5} aria-hidden />
        </button>
        {/* feat/pre-beta-polish-batch — fixed-size lightbox stage:
            90vh × 90vw, set on the wrapping div. Every image fills
            this same box via object-contain regardless of intrinsic
            dimensions, so cycling through a portrait box-art and a
            landscape screenshot doesn't shrink-grow the visible
            frame. (Pre-fix the SIZE lived on the <img> via
            max-h-[90vh]/max-w-[90vw], which let intrinsic dimensions
            drive the actual rendered size — smaller images rendered
            small.) The arrow buttons are absolutely positioned
            relative to this stage so they stay near the image edges
            instead of the DialogContent edges. */}
        <div className="relative flex h-[90vh] w-[90vw] items-center justify-center">
          {hasMultiple ? (
            <button
              type="button"
              onClick={(e) => {
                // Stop propagation so the click doesn't escape to the
                // Radix overlay (which would close the dialog).
                e.stopPropagation();
                onIndexChange(step(-1));
              }}
              aria-label="Previous image"
              className="absolute left-4 top-1/2 z-10 -translate-y-1/2 inline-flex h-12 w-12 items-center justify-center rounded-full bg-canvas/80 text-fg-body shadow-modal transition-colors hover:bg-canvas hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronLeft className="size-6" strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
          {localUrl !== null ? (
            <img
              src={localUrl}
              alt={slot?.label ?? 'Image'}
              className="h-full w-full rounded-sm object-contain"
              // feat/detail-modal-nav-hide — clicks on the image
              // do NOT close the lightbox. stopPropagation prevents
              // bubbling to DialogContent's backdrop-close handler.
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <div
              className="h-[60vh] w-[60vh] rounded-sm bg-overlay/40"
              // Same close-suppression for the loading placeholder
              // — the user visually identifies it as "the image
              // area", and clicking it shouldn't bail out of the
              // lightbox before the image even renders.
              onClick={(e) => e.stopPropagation()}
            />
          )}
          {hasMultiple ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onIndexChange(step(1));
              }}
              aria-label="Next image"
              className="absolute right-4 top-1/2 z-10 -translate-y-1/2 inline-flex h-12 w-12 items-center justify-center rounded-full bg-canvas/80 text-fg-body shadow-modal transition-colors hover:bg-canvas hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <ChevronRight className="size-6" strokeWidth={1.5} aria-hidden />
            </button>
          ) : null}
        </div>
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
  readonly allowSearch: boolean;
  readonly bodyOverride?: string;
  readonly onPrev?: () => void;
  readonly onNext?: () => void;
  readonly hideAction?: RomDetailDialogProps['hideAction'];
}): JSX.Element {
  function handleSearch(): void {
    props.onOpenChange(false);
    props.onSearch();
  }
  const bodyText =
    props.bodyOverride ??
    (props.allowSearch
      ? 'ScreenScraper hasn\'t matched this entry. Click "Find on ScreenScraper" to search manually, or wait for the prefetch to land.'
      : "ScreenScraper hasn't matched this entry. The auto-scrape pass will retry on the next connect.");
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-[85vw] flex-col p-5">
        <PrevNextArrows onPrev={props.onPrev} onNext={props.onNext} />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
        <DialogHeader className="min-w-0">
          <DialogTitle
            className="min-w-0 break-words pr-8"
            title={props.filename}
          >
            {props.filename}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[12rem_1fr] gap-5">
          <div className="aspect-[3/4] w-full rounded-sm border border-subtle bg-overlay/40" />
          <div className="flex min-w-0 flex-col gap-2">
            <SectionLabel>No metadata yet</SectionLabel>
            <p className="text-body-sm text-fg-body">{bodyText}</p>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {props.hideAction !== undefined ? (
            <Button variant="ghost" onClick={props.hideAction.onToggle}>
              {props.hideAction.currentHidden ? 'Unhide' : 'Hide'}
            </Button>
          ) : null}
          {props.allowSearch ? (
            <Button variant="primary" onClick={handleSearch}>
              Find on ScreenScraper...
            </Button>
          ) : null}
          <Button
            variant={props.allowSearch ? 'ghost' : 'primary'}
            onClick={() => props.onOpenChange(false)}
          >
            Close
          </Button>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
