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

  it('uses max-w-3xl per the §6 layout spec', () => {
    // Wider than the form/list modals; narrower than full-screen.
    // Pin the size class so a future "let's make it bigger / sheet
    // it" change is intentional.
    expect(SOURCE).toMatch(/max-w-3xl/);
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

  it('empty state uses the same max-w-3xl shell as the populated view', () => {
    // Modal width consistency — switching from no-metadata to
    // populated (e.g. after a successful Find + bind) shouldn't
    // visibly resize the dialog.
    const idx = SOURCE.indexOf('function EmptyDetailDialog');
    const empty = SOURCE.slice(idx);
    expect(empty).toMatch(/max-w-3xl/);
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

  it('primary image button is a fixed-height container (h-[28rem]), no reflow on thumbnail swap', () => {
    // The button is the click target AND the visual container.
    // Pinning the height class catches a regression where someone
    // restores aspect-ratio-driven sizing (which reflows).
    const primaryButton = SOURCE.match(
      /<button[\s\S]*?onClick=\{\(\) => primaryUrl !== null && onEnlarge[\s\S]*?className="([^"]+)"/,
    );
    expect(primaryButton).not.toBeNull();
    expect(primaryButton![1]).toContain('h-[28rem]');
    expect(primaryButton![1]).toContain('w-full');
    // Required so a tall image stays inside the container instead of
    // pushing the layout down.
    expect(primaryButton![1]).toContain('overflow-hidden');
  });

  it('zero-media placeholder matches the populated container height (no jump between states)', () => {
    // If the placeholder block were a different height, an empty
    // record's modal would size differently than a populated one.
    // Pin both to h-[28rem] so they're visually identical.
    expect(SOURCE).toMatch(/h-\[28rem\] w-full rounded-sm border border-subtle bg-overlay\/40/);
  });

  it('primary <img> uses object-contain (preserves aspect, fits any source)', () => {
    // The whole point of the fixed container: any aspect ratio fits.
    // `object-cover` would crop tall box-art; `object-fill` would
    // stretch a wide screenshot. Both are wrong — pin object-contain.
    expect(SOURCE).toMatch(
      /alt=\{`\$\{title\} primary image`\}\s+className="max-h-full max-w-full object-contain"/,
    );
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
    expect(SOURCE).toMatch(/import \{ ChevronLeft, ChevronRight \} from 'lucide-react'/);
  });

  it('arrow buttons stopPropagation so a click on the arrow does not close the dialog via the backdrop', () => {
    // Radix Dialog closes on overlay click. If the arrow's onClick
    // bubbled, the very click that navigates would also close the
    // lightbox. e.stopPropagation() is load-bearing — pin it.
    const lightboxIdx = SOURCE.indexOf('function Lightbox');
    expect(lightboxIdx).toBeGreaterThan(-1);
    const lightbox = SOURCE.slice(lightboxIdx);
    const stopPropCount = (lightbox.match(/e\.stopPropagation\(\)/g) ?? [])
      .length;
    // Two arrows → two stopPropagation calls.
    expect(stopPropCount).toBe(2);
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

  it('lightbox image uses object-contain at max-h-[90vh] / max-w-[90vw] (full size, no distortion)', () => {
    // Spec: image at ~90vh/90vw with object-contain preserving
    // aspect. Smaller and the user can't see detail; larger and the
    // arrow buttons would overlap the image edges on narrow screens.
    expect(SOURCE).toMatch(
      /className="max-h-\[90vh\] max-w-\[90vw\] rounded-sm object-contain"/,
    );
  });
});
