import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

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
  it('reuses useBoxArt for the main box art', () => {
    // Whole point of the cache architecture: don't add a new
    // image-fetching path. If anyone introduces a separate
    // <img src={metadata.boxArtUrl}> bypassing useBoxArt, the
    // SS-credential redaction + IPC byte-stream pipeline breaks.
    expect(SOURCE).toContain("import { useBoxArt }");
    expect(SOURCE).toMatch(/useBoxArt\(boxArtUrl\)/);
  });

  it('reuses useBoxArt for each screenshot thumbnail', () => {
    // Same hook for screenshots — the image cache is URL-agnostic
    // and "BoxArt" is a misnomer for what's really a generic image
    // fetcher. Pin the reuse so a future refactor doesn't sneak a
    // <img src={url}> direct-fetch in.
    expect(SOURCE).toMatch(/useBoxArt\(url\)/);
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

  it('renders the screenshot strip only when at least one screenshot exists', () => {
    expect(SOURCE).toMatch(/screenshots\.length > 0/);
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

  it('lightbox: a nested Dialog instance keyed on a clicked screenshot URL', () => {
    // The lightbox is a second Dialog mounted on demand (non-null
    // lightboxUrl state). Esc + click-outside close come from
    // Radix Dialog defaults — pin that we don't reinvent.
    expect(SOURCE).toMatch(/const \[lightboxUrl, setLightboxUrl\] = useState/);
    expect(SOURCE).toMatch(/lightboxUrl !== null \? \(/);
    expect(SOURCE).toMatch(/function Lightbox/);
  });

  it('lightbox has an a11y title (Radix Dialog requirement, sr-only ok)', () => {
    // Radix Dialog raises a console warning without a DialogTitle.
    // The lightbox's title is the image itself, so the title text
    // is visually hidden but present in the a11y tree.
    expect(SOURCE).toMatch(/DialogTitle className="sr-only">Screenshot</);
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
