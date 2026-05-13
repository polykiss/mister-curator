import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RomMetadata } from '@shared/metadata-types';

import { buildMediaSlots } from '@app/renderer/src/components/RomDetailDialog';

/**
 * feat/metadata-detail-modal — structural contract for the
 * RomDetailDialog component.
 *
 * Source-string scan (same pattern as `RomSearchScreenScraperDialog`
 * and `RomsPane` tests) rather than a render test: the dialog is
 * built on shadcn/Radix `Dialog`, which portal-renders outside the
 * jsdom root and requires a full a11y tree to render correctly.
 * The structural rules below are small and stable, and a string
 * scan catches the regressions we care about (action-button drift,
 * sparse-data conditional drift, hand-off semantics).
 */

const SOURCE = readFileSync(
  resolve(__dirname, 'RomDetailDialog.tsx'),
  'utf8',
);

describe('RomDetailDialog — structural contract', () => {
  it('reuses useBoxArt for every gallery image (primary + thumbnails + lightbox)', () => {
    // Whole point of the cache architecture: don't add a new
    // image-fetching path. If anyone introduces a separate
    // <img src={metadata.boxArtUrl}> bypassing useBoxArt, the
    // SS-credential redaction + IPC byte-stream pipeline breaks.
    //
    // feat/detail-dialog-multi-media: the primary image is now the
    // gallery's currently-selected slot; thumbnails resolve each
    // slot's url via the same hook.
    expect(SOURCE).toContain("import { useBoxArt }");
    expect(SOURCE).toMatch(/useBoxArt\(primaryUrl\)/);
    expect(SOURCE).toMatch(/useBoxArt\(slot\.url\)/);
    // Lightbox resolves the current slot's URL through useBoxArt too;
    // post-PR the lookup goes through `slot?.url` (slots-array-based)
    // rather than a flat URL prop, so we accept either spelling.
    expect(SOURCE).toMatch(/useBoxArt\(slot\?\.url\s*\?\?\s*null\)/);
  });

  it('reuses metadata-display helpers (no raw metadata.name access)', () => {
    // The display-merge contract (PR-D2): userOverride layers on
    // top of source-resolved fields. The detail modal must honor
    // overrides the same way the row does.
    expect(SOURCE).toContain("import {");
    expect(SOURCE).toMatch(/displayName,\s+displayNote,\s+displayRating,\s+displayTags,\s+displayYear/s);
    expect(SOURCE).toContain('displayName(metadata)');
    expect(SOURCE).toContain('displayYear(metadata)');
    expect(SOURCE).toContain('displayGenre(metadata)');
    expect(SOURCE).toContain('displayRating(metadata)');
    expect(SOURCE).toContain('displayTags(metadata)');
    expect(SOURCE).toContain('displayNote(metadata)');
  });

  it('reads screenshots from metadata.screenshotUrls with empty-array fallback', () => {
    // v5 records won't have screenshotUrls (undefined). The modal
    // must treat undefined as empty so the strip just hides
    // rather than throwing.
    expect(SOURCE).toMatch(/metadata\.screenshotUrls \?\? \[\]/);
  });

  it('renders the synopsis section only when description is present and non-empty', () => {
    // Sparse-data state: rows from OpenVGDB or sentinels may have
    // no description. Pin the conditional so the heading doesn't
    // float over empty content.
    expect(SOURCE).toMatch(/description !== null && description\.length > 0/);
  });

  it('renders the gallery thumbnail strip only when multiple media URLs exist', () => {
    // feat/detail-dialog-multi-media: the single screenshot strip
    // folded into the gallery. Zero slots → grey placeholder; one
    // slot → primary only (no strip); 2+ slots → primary + strip.
    expect(SOURCE).toMatch(/slots\.length > 1/);
  });

  it('renders the tags section only when at least one tag exists', () => {
    expect(SOURCE).toMatch(/tags\.length > 0/);
  });

  it('renders the note section only when a non-empty note is set', () => {
    expect(SOURCE).toMatch(/note !== null && note\.length > 0/);
  });

  it('has a placeholder block for missing box art (no broken-image icon)', () => {
    // When boxArtUrl is null, render the fixed-aspect placeholder
    // block — never let `<img src={null}>` render and show the
    // browser's broken-image icon.
    expect(SOURCE).toMatch(/aspect-\[3\/4\] w-full rounded-sm border border-subtle bg-overlay\/40/);
  });

  it('footer has exactly three action buttons in order: Edit, Find, Close', () => {
    // Pin button order. Edit + Find are ghost (rest-action), Close
    // is the primary (close-self) action. If someone reorders or
    // adds a fourth, the regression is loud.
    //
    // feat/arcade-polish-context-menu added `flex-wrap` so the row
    // stays inside the dialog max-width on narrow viewports — the
    // regex tolerates any extra flex utilities between `flex` and
    // `justify-end`.
    const footerMatch = SOURCE.match(
      /<div className="flex [^"]*justify-end gap-2[\s\S]*?<\/div>/,
    );
    expect(footerMatch).not.toBeNull();
    const footer = footerMatch![0];
    const editIdx = footer.indexOf('Edit...');
    const findIdx = footer.indexOf('Find on ScreenScraper...');
    const closeIdx = footer.indexOf('Close');
    expect(editIdx).toBeGreaterThan(-1);
    expect(findIdx).toBeGreaterThan(editIdx);
    expect(closeIdx).toBeGreaterThan(findIdx);
  });

  it('Edit / Find handlers close self BEFORE handing off', () => {
    // Pattern: setState(false) → call onEdit/onSearch. Reversing
    // the order would leave both modals open at once.
    const handleEditMatch = SOURCE.match(
      /function handleEdit\(\)[\s\S]*?\n {2}\}/,
    );
    expect(handleEditMatch).not.toBeNull();
    const editBody = handleEditMatch![0];
    const closeIdx = editBody.indexOf('onOpenChange(false)');
    const handoffIdx = editBody.indexOf('onEdit()');
    expect(closeIdx).toBeGreaterThan(-1);
    expect(handoffIdx).toBeGreaterThan(closeIdx);

    const handleSearchMatch = SOURCE.match(
      /function handleSearch\(\)[\s\S]*?\n {2}\}/,
    );
    expect(handleSearchMatch).not.toBeNull();
    const searchBody = handleSearchMatch![0];
    const sCloseIdx = searchBody.indexOf('onOpenChange(false)');
    const sHandoffIdx = searchBody.indexOf('onSearch()');
    expect(sCloseIdx).toBeGreaterThan(-1);
    expect(sHandoffIdx).toBeGreaterThan(sCloseIdx);
  });

  it('lightbox: a nested Dialog instance keyed on a clicked slot index', () => {
    // feat/arcade-parse-tolerance-gallery-polish: the lightbox is
    // navigable, so its open state is now an INDEX into the gallery
    // slot list (was a URL pre-PR). Esc + click-outside close come
    // from Radix Dialog defaults — pin that we don't reinvent them.
    expect(SOURCE).toMatch(/const \[lightboxIndex, setLightboxIndex\] = useState/);
    expect(SOURCE).toMatch(/lightboxIndex !== null && mediaSlots\.length > 0/);
    expect(SOURCE).toMatch(/function Lightbox/);
  });

  it('lightbox has an a11y title (Radix Dialog requirement, sr-only ok)', () => {
    // Radix Dialog raises a console warning without a DialogTitle.
    // The lightbox's title is the image itself, so the title text
    // is visually hidden but present in the a11y tree.
    expect(SOURCE).toMatch(/DialogTitle className="sr-only"/);
  });

  it('uses viewport-relative max-w/max-h so the modal scales with window size (feat/detail-modal-nav-hide)', () => {
    // Pre-PR (max-w-3xl, no max-h): the modal was a fixed 768px
    // wide with no height cap, so on a 1024×600 window it filled
    // the screen with no negative space and on a 4K window it
    // looked lost in the middle. Post-PR `max-w-[85vw]` +
    // `max-h-[85vh]` cap both dimensions at 85% of viewport so the
    // modal scales with the window and always leaves breathing room
    // around the dialog edges.
    expect(SOURCE).toMatch(/max-w-\[85vw\]/);
    expect(SOURCE).toMatch(/max-h-\[85vh\]/);
  });

  it('provenance footer surfaces source + fetched-date for audit', () => {
    // Discreet caption-row below the box art. Useful for "why does
    // this row show X" debugging without dumping the whole record.
    expect(SOURCE).toContain('source:');
    expect(SOURCE).toContain('fetched:');
    expect(SOURCE).toMatch(/metadata\.fetchedAt\.slice\(0, 10\)/);
  });
});

describe('RomDetailDialog — empty state (no metadata yet)', () => {
  // The dialog accepts a nullable `metadata` prop and renders an
  // empty-state branch when null. Unmatched / source=none rows AND
  // rows whose prefetch hasn't landed both hit this path — the
  // modal becomes a single discovery point regardless of state.

  it('accepts a nullable metadata prop on the public component', () => {
    // The public RomDetailDialog forwards to either the populated
    // or empty variant based on `metadata`. Pin the prop type so a
    // future refactor doesn't tighten it back to non-null.
    expect(SOURCE).toMatch(
      /readonly metadata: RomMetadata \| null;/,
    );
  });

  it('requires a `filename` prop so the empty state has something to title', () => {
    // When metadata is null we have nothing else to call the row
    // by. Filename is the truth — always passed.
    expect(SOURCE).toMatch(/readonly filename: string;/);
  });

  it('routes to an EmptyDetailDialog branch when metadata is null', () => {
    expect(SOURCE).toMatch(/if \(metadata === null\)/);
    expect(SOURCE).toMatch(/function EmptyDetailDialog/);
  });

  it('empty state surfaces "No metadata yet" + Find on ScreenScraper CTA', () => {
    // The body is fixed copy; pin the affordance so a future text
    // tweak doesn't accidentally drop the primary action.
    expect(SOURCE).toMatch(/No metadata yet/);
    // Slice from the function declaration to end-of-file. The
    // empty-state component is intentionally placed last in the
    // file so a tail-slice captures the whole body.
    const idx = SOURCE.indexOf('function EmptyDetailDialog');
    expect(idx).toBeGreaterThan(-1);
    const empty = SOURCE.slice(idx);
    // Find button is variant="primary" in the empty state (Edit is
    // hidden — the edit modal requires a populated record).
    expect(empty).toMatch(
      /Button\s+variant="primary"[\s\S]*?Find on ScreenScraper/,
    );
    // No Edit button in the empty state at all.
    expect(empty).not.toMatch(/Edit\.\.\./);
  });

  it('empty state uses the same viewport-relative shell as the populated view', () => {
    // Modal sizing consistency — switching from no-metadata to
    // populated (e.g. after a successful Find + bind) shouldn't
    // visibly resize the dialog. Both variants use the same
    // max-w-[85vw] + max-h-[85vh] caps.
    const idx = SOURCE.indexOf('function EmptyDetailDialog');
    const empty = SOURCE.slice(idx);
    expect(empty).toMatch(/max-w-\[85vw\]/);
    expect(empty).toMatch(/max-h-\[85vh\]/);
  });
});

describe('RomDetailDialog — long-title overflow guard (feat/arcade-polish-context-menu)', () => {
  it('title elements use break-words instead of truncate so long unbreakable filenames wrap inside the dialog', () => {
    // Live bug: a 110-char zip filename made the dialog's max-w-3xl
    // cap fight against `white-space: nowrap` (inside `truncate`),
    // and the title's intrinsic width pushed the absolutely-
    // positioned Close button past the visible right edge. Switching
    // the title + filename-subhead to `break-words` keeps the
    // content inside the dialog width — content wraps to a second
    // line rather than overflowing horizontally.
    //
    // Both the populated DialogTitle and the EmptyDetailDialog title
    // get the same treatment.
    const titleOccurrences = SOURCE.match(
      /<DialogTitle\s+className="[^"]*"\s+title=\{/g,
    );
    expect(titleOccurrences).not.toBeNull();
    expect(titleOccurrences!.length).toBe(2);
    for (const occ of titleOccurrences!) {
      expect(occ).toContain('break-words');
      // The Tailwind `truncate` shortcut sets white-space:nowrap +
      // overflow-hidden + text-overflow:ellipsis — exactly the
      // single-line treatment we're moving away from. Make sure
      // it's gone from the title classes.
      expect(occ).not.toMatch(/\btruncate\b/);
    }
  });

  it('button rows use flex-wrap so a narrow viewport stacks them inside the dialog', () => {
    // Pin both the populated dialog footer AND the EmptyDetailDialog
    // footer. Without flex-wrap, a tight viewport would push the
    // rightmost button (or the whole row) past the dialog edge —
    // same overflow story as the title.
    const footerMatches =
      SOURCE.match(/<div className="flex flex-wrap justify-end gap-2[^"]*">/g) ??
      [];
    expect(footerMatches.length).toBe(2);
  });

  it('arcade empty-state copy reads "entry" (not the stale "manual search is coming in a follow-up")', () => {
    // PR #64 shipped manual search; the empty-state copy now reads
    // the same way for arcade + ROMs, with "entry" instead of "file"
    // so the wording generalises across both surfaces. The source
    // file uses backslash-escaped apostrophes inside the
    // single-quoted literal, so a regex matches either spelling.
    expect(SOURCE).toMatch(
      /ScreenScraper hasn['\\]+t matched this entry\. Click "Find on ScreenScraper" to search manually/,
    );
    expect(SOURCE).not.toContain('coming in a follow-up');
    // Pre-PR the live branch said "file" — pin the rename to
    // "entry" so a future regression surfaces.
    expect(SOURCE).not.toMatch(
      /ScreenScraper hasn['\\]+t matched this file/,
    );
  });
});

describe('buildMediaSlots (feat/detail-dialog-multi-media)', () => {
  // Pure helper — collects every non-null media URL from a cached
  // record into the gallery's ordered slot list. Box art first
  // (default primary), then title screen / screenshots / box3D /
  // marquee / clearLogo. Dedup by URL.

  function baseMeta(): RomMetadata {
    return {
      version: 7,
      hash: 'h',
      name: 'Sample',
      system: 'NEOGEO',
      year: 1996,
      publisher: null,
      developer: null,
      genre: null,
      description: null,
      players: null,
      rating: null,
      releaseDate: null,
      boxArtUrl: null,
      titleScreenUrl: null,
      screenshotUrl: null,
      screenshotUrls: [],
      box3DUrl: null,
      marqueeUrl: null,
      clearLogoUrl: null,
      source: 'screenscraper',
      fetchedAt: '2026-05-13T00:00:00.000Z',
    };
  }

  it('returns empty when the record has no media URLs at all', () => {
    expect(buildMediaSlots(baseMeta())).toEqual([]);
  });

  it('puts box art first so the gallery default primary is unchanged from pre-PR behaviour', () => {
    const slots = buildMediaSlots({
      ...baseMeta(),
      boxArtUrl: 'https://ss/box.png',
      titleScreenUrl: 'https://ss/title.png',
      screenshotUrl: 'https://ss/snap.png',
    });
    expect(slots.map((s) => s.url)).toEqual([
      'https://ss/box.png',
      'https://ss/title.png',
      'https://ss/snap.png',
    ]);
    expect(slots[0]!.label).toBe('Box art');
  });

  it('collects every cached media type (box3D / marquee / clearLogo) in the documented order', () => {
    const slots = buildMediaSlots({
      ...baseMeta(),
      boxArtUrl: 'https://ss/box.png',
      titleScreenUrl: 'https://ss/title.png',
      screenshotUrl: 'https://ss/snap.png',
      screenshotUrls: ['https://ss/snap2.png', 'https://ss/snap3.png'],
      box3DUrl: 'https://ss/box3d.png',
      marqueeUrl: 'https://ss/marquee.png',
      clearLogoUrl: 'https://ss/logo.png',
    });
    expect(slots.map((s) => s.label)).toEqual([
      'Box art',
      'Title screen',
      'Screenshot',
      'Screenshot',
      'Screenshot',
      '3D box',
      'Marquee',
      'Logo',
    ]);
  });

  it('dedups by URL when SS reuses a URL across media types (box2D == box3D)', () => {
    const slots = buildMediaSlots({
      ...baseMeta(),
      boxArtUrl: 'https://ss/shared.png',
      box3DUrl: 'https://ss/shared.png',
    });
    expect(slots.map((s) => s.url)).toEqual(['https://ss/shared.png']);
  });

  it('tolerates v4–v6 records that lack box3DUrl/marqueeUrl/clearLogoUrl (undefined → absent)', () => {
    // Legacy on-disk records won't have the new fields at all. The
    // helper must treat `undefined` the same as `null` — no crash,
    // no empty-slot pollution.
    const legacy = baseMeta();
    delete (legacy as { box3DUrl?: unknown }).box3DUrl;
    delete (legacy as { marqueeUrl?: unknown }).marqueeUrl;
    delete (legacy as { clearLogoUrl?: unknown }).clearLogoUrl;
    expect(() => buildMediaSlots(legacy)).not.toThrow();
    expect(
      buildMediaSlots({ ...legacy, boxArtUrl: 'https://ss/box.png' }),
    ).toEqual([{ url: 'https://ss/box.png', label: 'Box art' }]);
  });
});

describe('RomDetailDialog — gallery primary swap (feat/detail-dialog-multi-media)', () => {
  it('declares primaryUrl state initialised from the first media slot', () => {
    // Default primary = box art (when present), else the first
    // available media URL. State allows the user to click a
    // thumbnail and swap the displayed primary.
    expect(SOURCE).toMatch(
      /\[primaryUrl,\s*setPrimaryUrl\]\s*=\s*useState[\s\S]{0,200}mediaSlots\[0\]/,
    );
  });

  it('thumbnail click handler routes through setPrimaryUrl (gallery is interactive)', () => {
    expect(SOURCE).toMatch(/onSelect=\{setPrimaryUrl\}/);
  });
});

describe('RomDetailDialog — gallery primary sizing (feat/arcade-parse-tolerance-gallery-polish)', () => {
  // Pre-PR: the primary image lived in a 12rem-wide left column and
  // shared its height with whatever the right info column ran to,
  // which produced a postage-stamp-sized box art on most cores AND
  // a layout reflow every time the user swapped thumbnails (because
  // each source image had a different aspect ratio). The fix is a
  // fixed-height container with `object-contain` — any aspect fits,
  // nothing below moves.

  it('primary image button is a viewport-relative fixed-height container (h-[35vh]), no reflow on thumbnail swap', () => {
    // feat/detail-dialog-nav-layout-fix (A) — height drops from
    // 60vh (PR #76) to 35vh. Live screenshot showed the 60vh
    // image consuming ~60% of dialog height and the synopsis
    // getting clipped behind the scroll-button-row overlap. 35vh
    // leaves room for synopsis + key facts above the now-sticky
    // footer on a typical viewport. Still FIXED (not max-h-) so
    // switching thumbnails doesn't reflow.
    const primaryButton = SOURCE.match(
      /<button[\s\S]*?onClick=\{\(\) => primaryUrl !== null && onEnlarge[\s\S]*?className="([^"]+)"/,
    );
    expect(primaryButton).not.toBeNull();
    expect(primaryButton![1]).toContain('h-[35vh]');
    expect(primaryButton![1]).toContain('w-full');
    // Required so a tall image stays inside the container instead of
    // pushing the layout down.
    expect(primaryButton![1]).toContain('overflow-hidden');
  });

  it('zero-media placeholder matches the populated container height (no jump between states)', () => {
    // feat/detail-dialog-nav-layout-fix (A) — both placeholders
    // track each other at h-[35vh] (was 60vh in PR #76).
    expect(SOURCE).toMatch(/h-\[35vh\] w-full rounded-sm border border-subtle bg-overlay\/40/);
  });

  it('primary <img> fills the fixed container and uses object-contain to preserve aspect', () => {
    // feat/pre-beta-polish-batch — the IMG is `h-full w-full`
    // (not max-h-full / max-w-full). With max-*, an 800×600
    // screenshot rendered at its intrinsic 800×600 inside a much
    // larger container — switching to a portrait box-art changed
    // the visible size of the image. h-full w-full forces the IMG
    // element to fill the fixed h-[35vh] container; object-contain
    // then preserves the source aspect inside that fixed frame.
    expect(SOURCE).toMatch(
      /alt=\{`\$\{title\} primary image`\}[\s\S]{0,1200}className="h-full w-full object-contain"/,
    );
  });
});

describe('RomDetailDialog — sticky footer + scroll on content (feat/detail-dialog-nav-layout-fix A)', () => {
  // Pre-fix (PR #75 + #76): the action-button row was INSIDE the
  // scrolling content wrapper, so on a small viewport the buttons
  // scrolled out of view as the user dragged down the synopsis.
  // The screenshot showed the scrollbar overlapping the bottom of
  // the Close button.
  //
  // Post-fix: the button row is OUTSIDE the scrolling wrapper so
  // it stays pinned to the bottom of DialogContent. The scroll
  // applies to ONLY the media-gallery + info-stack area.

  it('action button row sits OUTSIDE the scrolling wrapper (sticky-footer effect)', () => {
    // Pin the structural shape: the `overflow-y-auto` wrapper
    // closes BEFORE the button row.
    const populatedIdx = SOURCE.indexOf('function PopulatedDetailDialog');
    const emptyIdx = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populatedIdx, emptyIdx);
    const overflowOpen = block.indexOf(
      'flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto',
    );
    const buttonRow = block.indexOf(
      'flex flex-wrap justify-end gap-2 border-t border-subtle pt-3',
    );
    expect(overflowOpen).toBeGreaterThan(-1);
    expect(buttonRow).toBeGreaterThan(overflowOpen);
    // And the closing </div> of the overflow wrapper comes BEFORE
    // the button row's opening. We approximate: count `</div>`
    // between overflowOpen and buttonRow and require ≥ 1.
    const between = block.slice(overflowOpen, buttonRow);
    expect(between.match(/<\/div>/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('footer row carries a top border so it visually separates from the scrolling content', () => {
    // The visual separation cue: without a top border, the footer
    // looks like it could be part of the scrolling region. Pin it
    // on both variants.
    const populatedIdx = SOURCE.indexOf('function PopulatedDetailDialog');
    const emptyIdx = SOURCE.indexOf('function EmptyDetailDialog');
    const populated = SOURCE.slice(populatedIdx, emptyIdx);
    const empty = SOURCE.slice(emptyIdx);
    expect(populated).toMatch(/border-t border-subtle pt-3/);
    expect(empty).toMatch(/border-t border-subtle pt-3/);
  });
});

describe('RomDetailDialog — lightbox navigation (feat/arcade-parse-tolerance-gallery-polish)', () => {
  // The pre-PR lightbox was a single static image with Esc-to-close.
  // This PR adds onscreen prev/next arrows, ArrowLeft/Right key
  // bindings, and wrap-around at both ends — so the user can flip
  // through every media slot without leaving fullscreen view.

  it('Lightbox takes slots / index / onIndexChange / onClose (index-keyed, not URL-keyed)', () => {
    // Switching from URL-keyed to index-keyed is what makes
    // "previous/next" expressible at all. Pin the signature so a
    // future refactor that drops one of the props is caught here
    // rather than at runtime.
    expect(SOURCE).toMatch(/function Lightbox\(props: \{/);
    expect(SOURCE).toMatch(/readonly slots: readonly MediaSlot\[\];/);
    expect(SOURCE).toMatch(/readonly index: number;/);
    expect(SOURCE).toMatch(/readonly onIndexChange: \(next: number\) => void;/);
    expect(SOURCE).toMatch(/readonly onClose: \(\) => void;/);
  });

  it('uses a wrap-around step formula so prev-from-0 lands on last (and next-from-last on 0)', () => {
    // Double-modulo `((i + d) % n + n) % n` handles the negative
    // delta without a branch. If someone simplifies to a plain
    // `(i + d) % n`, ArrowLeft from index 0 returns -1 and the
    // current-slot lookup blows up.
    expect(SOURCE).toMatch(
      /\(\(index \+ delta\) % count \+ count\) % count/,
    );
  });

  it('opens from the gallery primary at the slot index matching the currently-displayed URL', () => {
    // Clicking the primary should open the lightbox on the same
    // image, not on slot 0. Pin the `findIndex` lookup so a future
    // refactor doesn't reset to 0 every time.
    expect(SOURCE).toMatch(
      /const idx = mediaSlots\.findIndex\(\s*\(s\) => s\.url === \(primaryUrl \?\? boxArtUrl\),?\s*\);/,
    );
    expect(SOURCE).toMatch(/setLightboxIndex\(idx >= 0 \? idx : 0\)/);
  });

  it('renders Previous / Next arrow buttons with discoverable a11y labels', () => {
    // Visual arrows are required by the spec; aria-label is what
    // makes them screen-reader-discoverable since the icon is
    // aria-hidden. The buttons render only when there's more than
    // one slot.
    expect(SOURCE).toMatch(/aria-label="Previous image"/);
    expect(SOURCE).toMatch(/aria-label="Next image"/);
    // Icons come from lucide-react; pin the import so a future
    // icon-set swap surfaces here.
    // feat/pre-beta-polish-batch adds X to the lucide import for
    // the new large close button.
    expect(SOURCE).toMatch(
      /import \{ ChevronLeft, ChevronRight, X \} from 'lucide-react'/,
    );
  });

  it('elements that should NOT close the lightbox each stopPropagation against the backdrop-close handler', () => {
    // DialogContent's onClick={onClose} is the
    // feat/detail-modal-nav-hide click-backdrop-to-close handler.
    // Every element INSIDE DialogContent that doesn't represent a
    // backdrop click must stopPropagation so it doesn't bubble to
    // that handler. There are 5 such elements in the Lightbox:
    //   2 arrow buttons (prev / next)
    //   1 close button (calls onClose explicitly + stopPropagation
    //                   so it doesn't double-fire via backdrop)
    //   1 image (clicking the image keeps the lightbox open)
    //   1 loading placeholder (same — the user reads it as
    //                          "the image area" before bytes land)
    const lightboxIdx = SOURCE.indexOf('function Lightbox');
    expect(lightboxIdx).toBeGreaterThan(-1);
    const lightbox = SOURCE.slice(lightboxIdx);
    const stopPropCount = (lightbox.match(/e\.stopPropagation\(\)/g) ?? [])
      .length;
    expect(stopPropCount).toBe(5);
  });

  it('binds a document keydown listener for ArrowLeft / ArrowRight (cleans up on unmount)', () => {
    // The effect attaches on mount + every index change (closure
    // captures `index`); the cleanup removes the same listener.
    // Without the cleanup, navigating between slots stacks listeners
    // and the first key press fires N times.
    expect(SOURCE).toMatch(/document\.addEventListener\('keydown', onKey\)/);
    expect(SOURCE).toMatch(/document\.removeEventListener\('keydown', onKey\)/);
    expect(SOURCE).toMatch(/if \(e\.key === 'ArrowLeft'\)/);
    expect(SOURCE).toMatch(/else if \(e\.key === 'ArrowRight'\)/);
  });

  it('relies on Radix Dialog defaults for Esc + backdrop close (no custom handlers)', () => {
    // Esc + click-outside come for free from Radix — we just need to
    // route `onOpenChange(false)` to our onClose. Pin the inline
    // adapter so a future "let's intercept Esc" change is loud.
    expect(SOURCE).toMatch(
      /<Dialog open onOpenChange=\{\(open\) => \(open \? undefined : onClose\(\)\)\}>/,
    );
  });

  it('lightbox hides the default tiny X and renders a large, high-contrast close button (feat/pre-beta-polish-batch)', () => {
    // The default shadcn DialogContent renders a 16px muted-color X
    // at top-right — invisible against most box-art. The lightbox
    // suppresses that default via `hideDefaultClose` and renders
    // its own button with the same chrome as the prev/next arrows:
    // 48px rounded button, semi-opaque canvas backplate, large
    // 24px stroked icon. So all three affordances (prev, close,
    // next) read as a coherent set.
    expect(SOURCE).toMatch(/hideDefaultClose/);
    expect(SOURCE).toMatch(/aria-label="Close"/);
    // The close button shares the arrow buttons' chrome — same
    // size (h-12 w-12), same backplate (bg-canvas/80), same focus
    // ring. Pin it.
    expect(SOURCE).toMatch(
      /aria-label="Close"[\s\S]{0,400}h-12 w-12[\s\S]{0,200}rounded-full bg-canvas\/80/,
    );
    // The icon is the lucide X at 24px.
    expect(SOURCE).toMatch(
      /import \{ ChevronLeft, ChevronRight, X \} from 'lucide-react'/,
    );
    expect(SOURCE).toMatch(
      /<X className="size-6" strokeWidth=\{1\.5\} aria-hidden \/>/,
    );
  });

  it('shared DialogContent primitive accepts hideDefaultClose for the lightbox opt-out (feat/pre-beta-polish-batch)', () => {
    const dialog = readFileSync(
      resolve(__dirname, 'ui/dialog.tsx'),
      'utf8',
    );
    // Type contract.
    expect(dialog).toMatch(/readonly hideDefaultClose\?: boolean;/);
    // Implementation: gate the auto-injected close on the flag.
    expect(dialog).toMatch(
      /\{hideDefaultClose \? null : \(\s*<DialogPrimitive\.Close/,
    );
  });

  it('lightbox DialogContent closes on backdrop click (feat/detail-modal-nav-hide)', () => {
    // Live bug: PR #75 added hideDefaultClose + a large in-content
    // close button. That meant the dialog filled most of the
    // viewport and Radix's onPointerDownOutside (which fires for
    // clicks OUTSIDE DialogContent) covered only a thin ring.
    // Clicking the dark "backdrop" area INSIDE DialogContent
    // (between the image edge and the dialog edge) did nothing.
    // Fix: route DialogContent's onClick to onClose so anything
    // inside DialogContent that doesn't stopPropagation closes the
    // dialog. The image + arrows + close button each stopPropagation
    // for themselves.
    const lightboxIdx = SOURCE.indexOf('function Lightbox');
    const lightbox = SOURCE.slice(lightboxIdx);
    expect(lightbox).toMatch(
      /<DialogContent[\s\S]{0,1500}onClick=\{onClose\}/,
    );
  });

  it('image + loading placeholder stopPropagation so clicking them does not close the lightbox', () => {
    // The image area (loaded or loading) is conceptually NOT the
    // backdrop — clicking it should keep the lightbox open. Without
    // these stopPropagation calls, the new backdrop-close handler
    // would fire on every image click.
    const lightboxIdx = SOURCE.indexOf('function Lightbox');
    const lightbox = SOURCE.slice(lightboxIdx);
    // Find the img tag inside the lightbox; assert it has an
    // onClick that stops propagation.
    expect(lightbox).toMatch(
      /<img[\s\S]{0,800}onClick=\{\(e\) => e\.stopPropagation\(\)\}/,
    );
    // And the loading placeholder — same protection so a fast
    // click during the bytes-still-streaming window doesn't bail.
    expect(lightbox).toMatch(
      /<div[\s\S]{0,300}bg-overlay\/40"[\s\S]{0,800}onClick=\{\(e\) => e\.stopPropagation\(\)\}/,
    );
  });

  it('lightbox uses a fixed-size 90vh × 90vw stage; image fills it via h-full w-full + object-contain', () => {
    // feat/pre-beta-polish-batch — the 90vh/90vw lives on the
    // wrapping div, not the <img>. Result: every image renders into
    // the same visual frame regardless of intrinsic dimensions, so
    // portrait box-art and landscape screenshots no longer flip the
    // stage size mid-cycle. (Pre-fix the size lived on max-h/max-w
    // of the <img>, which gated the rendered size by the source's
    // intrinsic size — a 600×450 screenshot rendered at 600×450
    // even on a 4K screen.)
    expect(SOURCE).toMatch(
      /<div className="relative flex h-\[90vh\] w-\[90vw\] items-center justify-center">/,
    );
    expect(SOURCE).toMatch(
      /className="h-full w-full rounded-sm object-contain"/,
    );
  });
});

describe('RomDetailDialog — Prev/Next ROM navigation (feat/detail-dialog-nav-layout-fix B)', () => {
  // PR #76 placed the prev/next chevrons at the dialog's left/
  // right edges — visually indistinguishable from the lightbox's
  // image-cycling arrows AND visible behind the lightbox overlay
  // when it opened. The corrective fix moves the nav into a
  // header-area strip with text-labeled buttons + position
  // indicator, AND hides the strip while the lightbox is open.

  it('public RomDetailDialog accepts optional onPrev / onNext callbacks', () => {
    expect(SOURCE).toMatch(/readonly onPrev\?\: \(\) => void;/);
    expect(SOURCE).toMatch(/readonly onNext\?\: \(\) => void;/);
  });

  it('public RomDetailDialog accepts optional navPosition for the "X of Y" indicator', () => {
    expect(SOURCE).toMatch(
      /readonly navPosition\?\: \{\s*readonly current: number;\s*readonly total: number;\s*\};/,
    );
  });

  it('header-area DetailNavStrip replaces the old edge-positioned PrevNextArrows', () => {
    // Pre-fix: a PrevNextArrows component with absolute-positioned
    // chevron buttons at left-1 / right-1 of DialogContent. Post-
    // fix: DetailNavStrip — an in-flow strip with text labels.
    expect(SOURCE).toMatch(/function DetailNavStrip\(props: \{/);
    expect(SOURCE).not.toMatch(/function PrevNextArrows/);
    // No more "Previous entry" / "Next entry" generic chevron
    // aria-labels — replaced with explicit "ROM entry" wording
    // so screen readers can distinguish them from the lightbox's
    // image-cycling arrows (which use "Previous image" / "Next
    // image").
    expect(SOURCE).toMatch(/aria-label="Previous ROM entry"/);
    expect(SOURCE).toMatch(/aria-label="Next ROM entry"/);
    // Buttons are text-labeled in the visible UI too.
    expect(SOURCE).toMatch(/>\s*Previous\s*</);
    expect(SOURCE).toMatch(/>\s*Next\s*</);
  });

  it('DetailNavStrip renders a "<current> of <total>" indicator when navPosition is supplied', () => {
    expect(SOURCE).toMatch(
      /\{position\.current\} of \{position\.total\}/,
    );
  });

  it('DetailNavStrip returns null when hidden flag is set (covers it for the lightbox-open case)', () => {
    // feat/detail-dialog-nav-layout-fix D — the lightbox dialog
    // renders OVER the detail dialog. To prevent the prev/next
    // ROM strip from showing through, the PopulatedDetailDialog
    // passes `hidden={lightboxIndex !== null}` and DetailNavStrip
    // short-circuits to null. Pin the early return at the top of
    // the component.
    expect(SOURCE).toMatch(/if \(hidden === true\) return null;/);
  });

  it('DetailNavStrip returns null when neither prev nor next is supplied (no nav context → no strip)', () => {
    // The adapter passes undefined for both when the dialog is
    // opened on an entry that isn't in the visible row list (e.g.
    // an arcade `.mra` surfaced from a non-list code path).
    expect(SOURCE).toMatch(
      /if \(onPrev === undefined && onNext === undefined\) return null;/,
    );
  });

  it('Previous / Next buttons render disabled at list boundaries (button still present, click ignored)', () => {
    // Per the spec: at boundaries the button stays visible but
    // disabled, not absent. The adapter passes undefined only for
    // the missing direction; the button gets disabled={true}.
    expect(SOURCE).toMatch(/disabled=\{onPrev === undefined\}/);
    expect(SOURCE).toMatch(/disabled=\{onNext === undefined\}/);
  });

  it('PopulatedDetailDialog wires lightboxIndex into the strip\'s hidden flag (covers D)', () => {
    const populated = SOURCE.indexOf('function PopulatedDetailDialog');
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populated, empty);
    expect(block).toMatch(
      /<DetailNavStrip[\s\S]{0,200}hidden=\{lightboxIndex !== null\}/,
    );
  });

  it('EmptyDetailDialog gets the same DetailNavStrip (so users can advance even on no-metadata entries)', () => {
    // Users curating an unfamiliar core hit a string of no-metadata
    // entries. The dialog should let them advance without closing
    // — same affordance as populated entries. EmptyDetailDialog
    // has no lightbox of its own, so it doesn't pass `hidden`.
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const emptyBlock = SOURCE.slice(empty);
    expect(emptyBlock).toMatch(
      /<DetailNavStrip[\s\S]{0,200}onPrev=\{props\.onPrev\}[\s\S]{0,200}onNext=\{props\.onNext\}/,
    );
  });
});

describe('RomDetailDialog — primary-image state reset on entry change (feat/detail-dialog-nav-layout-fix C)', () => {
  // Live bug after PR #76: clicking Prev/Next updated the metadata
  // text (synopsis, year, etc.) but the primary image stayed on
  // the previous entry's image. The dialog's internal
  // `primaryUrl` state was set at mount and not refreshed when
  // `metadata` changed.

  it('a useEffect resets primaryUrl when metadata.hash changes', () => {
    // Pin the effect by its dependency array — `metadata.hash` is
    // the stable per-record signal. Pre-fix there was no such
    // effect; primaryUrl initialized once and lived forever.
    expect(SOURCE).toMatch(
      /useEffect\(\(\) => \{\s*setPrimaryUrl\(mediaSlots\[0\]\?\.url \?\? null\);[\s\S]{0,400}\}, \[metadata\.hash\]\);/,
    );
  });

  it('the same effect also closes the lightbox so a stale image does not survive a nav step', () => {
    // If the user opened the lightbox on entry X and then advanced
    // the dialog to entry Y, the lightbox would still be showing
    // X's image. Closing it on every entry change avoids the
    // mismatch.
    expect(SOURCE).toMatch(
      /useEffect\(\(\) => \{[\s\S]{0,300}setLightboxIndex\(null\);/,
    );
  });
});

describe('RomDetailDialog — Hide/Unhide button with auto-advance (feat/detail-modal-nav-hide)', () => {
  it('public RomDetailDialog accepts an optional hideAction with currentHidden + onToggle', () => {
    expect(SOURCE).toMatch(
      /readonly hideAction\?\: \{\s*readonly currentHidden: boolean;\s*readonly onToggle: \(\) => void;\s*\};/,
    );
  });

  it('PopulatedDetailDialog renders Hide/Unhide button only when hideAction is supplied', () => {
    const populated = SOURCE.indexOf('function PopulatedDetailDialog');
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populated, empty);
    expect(block).toMatch(
      /\{hideAction !== undefined \? \(\s*<Button variant="ghost" onClick=\{hideAction\.onToggle\}>\s*\{hideAction\.currentHidden \? 'Unhide' : 'Hide'\}/,
    );
  });

  it('EmptyDetailDialog also supports hideAction (no-metadata entries can still be hidden)', () => {
    // Pure-empty-state entries (source: 'none' sentinels, files
    // with no SS hit yet) are still real files on disk — the
    // user can hide them from the dialog without needing metadata
    // first.
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(empty);
    expect(block).toMatch(
      /\{props\.hideAction !== undefined \? \(\s*<Button variant="ghost" onClick=\{props\.hideAction\.onToggle\}>\s*\{props\.hideAction\.currentHidden \? 'Unhide' : 'Hide'\}/,
    );
  });

  it('Hide button reads "Hide" for visible entries and "Unhide" for hidden ones (label flips with state)', () => {
    // Pin both labels — a future "let's call it 'Show'" change
    // surfaces here. The exact word "Unhide" was specified by the
    // user in the brief.
    expect(SOURCE).toMatch(/'Unhide' : 'Hide'/);
  });
});

describe('roms-adapter / arcade-adapter — detail-dialog nav + hide wiring (feat/detail-modal-nav-hide)', () => {
  const ROMS = readFileSync(
    resolve(__dirname, 'roms-adapter.tsx'),
    'utf8',
  );
  const ARCADE = readFileSync(
    resolve(__dirname, 'arcade-adapter.tsx'),
    'utf8',
  );

  it('roms-adapter computes prev/next over `presentableRoms` (same filter + sort the user sees)', () => {
    // Pin the data source — the user spec is explicit that the
    // nav order must match the row view exactly. `presentableRoms`
    // is the post-filter post-sort list rendered in the table.
    expect(ROMS).toMatch(
      /presentableRoms\.findIndex\(\s*\(r\) => r\.filename === detailDialogFor\.filename,/,
    );
  });

  it('roms-adapter passes undefined for missing direction at boundaries (button disabled, not absent)', () => {
    // The dialog renders disabled buttons when the callback is
    // undefined. Adapter computes hasPrev / hasNext from the index
    // and forwards undefined for the missing direction.
    expect(ROMS).toMatch(/onPrev=\{hasPrev \? handlePrev : undefined\}/);
    expect(ROMS).toMatch(/onNext=\{hasNext \? handleNext : undefined\}/);
  });

  it('roms-adapter Hide flow advances on SSH success and toasts on failure (no advance on fail)', () => {
    // The Hide button calls setRomVisibility (CoresContext path,
    // which is already optimistic). On the promise's resolve we
    // advanceOrClose; on its reject we surface a toast.error and
    // stay put. Pin both branches.
    expect(ROMS).toMatch(/setRomVisibility\([\s\S]{0,200}\)\.then\(/);
    expect(ROMS).toMatch(/advanceOrClose\(\);/);
    expect(ROMS).toMatch(
      /toast\.error\(\s*`\$\{target \? 'Hide' : 'Show'\} failed: \$\{currentRom\.displayName\}`/,
    );
  });

  it('roms-adapter advanceOrClose closes the dialog at the end of the list (no wrap-around)', () => {
    expect(ROMS).toMatch(
      /const advanceOrClose = \(\): void => \{[\s\S]{0,800}setDetailDialogFor\(null\);/,
    );
  });

  it('arcade-adapter navigates over `sortedRows` filtered to mra rows only (subfolders skip)', () => {
    // sortedRows includes both mra and subfolder rows; only mras
    // can be opened in the detail dialog, so navigation only steps
    // through them. Pin the filter so future row-kind additions
    // don't accidentally include them in the nav order.
    expect(ARCADE).toMatch(
      /sortedRows\.filter\(\s*\(r\) => r\.kind === 'mra',\s*\)/,
    );
  });

  it('arcade-adapter Hide flow uses the new applyArcadeMraVisibility helper and advances on success', () => {
    expect(ARCADE).toMatch(/applyArcadeMraVisibility\([\s\S]{0,200}\)\.then\(/);
    expect(ARCADE).toMatch(/advanceOrClose\(\);/);
    // Toast on failure mirrors the row-toggle copy.
    expect(ARCADE).toMatch(
      /toast\.error\(\s*`\$\{next \? 'Hide' : 'Show'\} failed: \$\{currentEntry\.displayName\}`/,
    );
  });
});

describe('RomDetailDialog — two-column content layout (feat/detail-dialog-two-column-layout)', () => {
  // Pre-fix the scrolling content stacked vertically: image +
  // thumbnails first, then the synopsis / stats / tags / note stack
  // below. On wide windows this wasted right-side real estate.
  // Post-fix the content splits into two columns inside the same
  // scroll wrapper:
  //   • Left ~40%: image, thumbnail strip, source/fetched line.
  //   • Right ~60%: stats grid, synopsis (+ tags + note when
  //     present).
  // The grid collapses to a single column on narrow viewports.

  it('content wrapper holds a CSS grid with two columns at md+ that collapses to one column below', () => {
    // Pin both the responsive grid AND `items-start` so the
    // columns top-align rather than stretching to match each
    // other's height (a wide synopsis next to a short image
    // shouldn't make the image grow vertically).
    expect(SOURCE).toMatch(
      /<div className="grid grid-cols-1 gap-4 md:grid-cols-\[2fr_3fr\] md:items-start">/,
    );
  });

  it('LEFT column contains MediaGallery (image + thumbnails) then ProvenanceFooter', () => {
    // Pin the inner-column structure so a future "let me also put
    // the synopsis in the left" refactor is loud. The MediaGallery
    // component already owns the image button + thumbnail strip;
    // we just sandwich ProvenanceFooter under it.
    const populated = SOURCE.indexOf('function PopulatedDetailDialog');
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populated, empty);
    // Find the LEFT column wrapper (first child of the grid).
    const leftIdx = block.indexOf(
      '<div className="flex min-w-0 flex-col gap-2">',
    );
    expect(leftIdx).toBeGreaterThan(-1);
    // Grab the next ~2000 chars (the column's body) and assert the
    // two members are present in order.
    const leftBlock = block.slice(leftIdx, leftIdx + 2000);
    const galleryIdx = leftBlock.indexOf('<MediaGallery');
    const provenanceIdx = leftBlock.indexOf('<ProvenanceFooter');
    expect(galleryIdx).toBeGreaterThan(-1);
    expect(provenanceIdx).toBeGreaterThan(galleryIdx);
  });

  it('RIGHT column contains the stats grid first, then the synopsis', () => {
    // Pin the order — stats before synopsis is what the user
    // expects to see at the top of the right column.
    const populated = SOURCE.indexOf('function PopulatedDetailDialog');
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populated, empty);
    // The RIGHT column wrapper uses gap-4 (the stats / synopsis
    // / tags / note stack); the LEFT uses gap-2 (image + thumbs
    // + provenance). Distinct so a sloppy edit can't mix them.
    const rightIdx = block.indexOf(
      '<div className="flex min-w-0 flex-col gap-4">',
    );
    expect(rightIdx).toBeGreaterThan(-1);
    const rightBlock = block.slice(rightIdx, rightIdx + 3000);
    const statsIdx = rightBlock.indexOf('<KeyFact label="Players"');
    const synopsisIdx = rightBlock.indexOf('<SectionLabel>Synopsis</SectionLabel>');
    expect(statsIdx).toBeGreaterThan(-1);
    // Synopsis present (when description is non-empty — the JSX
    // path always contains the label string).
    expect(synopsisIdx).toBeGreaterThan(statsIdx);
  });

  it('stats grid keeps the 2x2 → 4-across responsive shape (per spec: fall back to 2x2 when cramped)', () => {
    // Inside the narrower right column the 4-across at sm:
    // (640px viewport ≈ 326px column width) is borderline, but
    // matches the spec's "fall back to 2x2 if 4-across is too
    // cramped" intent — the row falls back to 2x2 at viewport
    // below the sm: breakpoint.
    expect(SOURCE).toMatch(
      /<section className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">/,
    );
  });

  it('ProvenanceFooter renders a single inline row joined by a middle dot (not two stacked lines)', () => {
    // Pre-fix this rendered as a two-line flex-col under the
    // synopsis. In the two-column layout it lives in the left
    // column under thumbnails where vertical space is precious,
    // so it collapses to one line. flex-wrap lets it break onto
    // two lines naturally if the column ever gets too narrow.
    expect(SOURCE).toMatch(
      /<div className="flex flex-wrap gap-x-2 gap-y-0.5 text-caption text-fg-muted">/,
    );
    expect(SOURCE).toMatch(/<span aria-hidden>·<\/span>/);
    // Still source-first, fetched-second.
    expect(SOURCE).toMatch(
      /<span>source: \{metadata\.source\}<\/span>\s*<span aria-hidden>·<\/span>\s*<span>fetched: \{date\}<\/span>/,
    );
  });

  it('narrow-viewport breakpoint collapses both columns to a single vertical stack (grid-cols-1)', () => {
    // The grid's default is `grid-cols-1`; the `md:grid-cols-
    // [2fr_3fr]` override only kicks in at viewport >= 768px
    // (Tailwind's md: breakpoint, ≈ 653px modal at 85vw — close
    // enough to the user's "~720px modal width" guidance).
    expect(SOURCE).toMatch(/grid grid-cols-1 gap-4 md:grid-cols-/);
  });

  it('tags + note sections live in the right column under synopsis (not in a third spanning row)', () => {
    // The user spec listed only stats + synopsis in the right
    // column; tags + note continue the metadata stack there since
    // they're the same content class. Pinning their position
    // prevents a future "let me move tags below the columns"
    // refactor from quietly breaking the two-column rhythm.
    const populated = SOURCE.indexOf('function PopulatedDetailDialog');
    const empty = SOURCE.indexOf('function EmptyDetailDialog');
    const block = SOURCE.slice(populated, empty);
    const rightIdx = block.indexOf(
      '<div className="flex min-w-0 flex-col gap-4">',
    );
    const rightBlock = block.slice(rightIdx, rightIdx + 3500);
    expect(rightBlock).toMatch(/<SectionLabel>Tags<\/SectionLabel>/);
    expect(rightBlock).toMatch(/<SectionLabel>Note<\/SectionLabel>/);
  });
});
