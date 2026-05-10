import type { ReactElement } from 'react';

import { describe, expect, it } from 'vitest';

import type { Rom } from '@shared/types';

import {
  DENSITY_EYE_CELL_CLASSNAMES,
  RomDensityEyeCell,
  RomNameInner,
  shouldShowFilenameSubline,
} from '@app/renderer/src/components/RomMetadataCells';

/**
 * PR #23 round 4 — regression coverage for the density+eye cell. The
 * bar disappeared TWICE before round 4 (round 1's `h-full` resolved
 * to 0 in the table-cell context, round 3's `h-full` on the `<td>`
 * didn't propagate as Chromium's table-cell percentage-height behavior
 * is more brittle than that approach assumed). Round 4 stops fighting
 * table-cell heights and uses absolute positioning.
 *
 * The static-className constants are exported precisely so this test
 * doesn't need a DOM. If the absolute-positioning class strings ever
 * change without an explicit fix, these assertions fail.
 */

// eslint complains about `() => {}` as the callback prop. A named noop
// reads cleaner than `// eslint-disable` and is the same intent.
function noop(): void {
  return undefined;
}

function rom(overrides: Partial<Rom> = {}): Rom {
  return {
    coreId: 'SNES',
    filename: 'sonic.smc',
    displayName: 'Sonic',
    sizeBytes: 1024 * 1024,
    hidden: false,
    path: '/media/fat/games/SNES/sonic.smc',
    kind: 'file',
    relativePath: 'sonic.smc',
    ...overrides,
  };
}

describe('DENSITY_EYE_CELL_CLASSNAMES — pinned absolute-positioning contract', () => {
  it('cell is `relative p-0` so the absolute child anchors to the <td>', () => {
    // `relative` MUST be present — drops it and the absolute child
    // anchors to the nearest positioned ancestor (the table or the
    // viewport), which would render the bar at the wrong size and
    // position. `p-0` keeps the bar flush to the cell edges.
    expect(DENSITY_EYE_CELL_CLASSNAMES.cell).toContain('relative');
    expect(DENSITY_EYE_CELL_CLASSNAMES.cell).toContain('p-0');
    // Pin against accidental re-introduction of the round-3 `h-full`
    // approach — that's what we just learned doesn't work on a `<td>`.
    expect(DENSITY_EYE_CELL_CLASSNAMES.cell).not.toMatch(/\bh-full\b/);
  });

  it('wrapper is `absolute inset-0 flex shrink-0 items-stretch`', () => {
    // `absolute inset-0` is THE fix that survives where percentage
    // heights on `<td>` don't propagate. `items-stretch` makes the
    // DensityBar fill the wrapper's full height via its default
    // `h-full`. `flex` + `shrink-0` keep the bar adjacent to the
    // eye button without compressing it.
    const cls = DENSITY_EYE_CELL_CLASSNAMES.wrapper;
    expect(cls).toContain('absolute');
    expect(cls).toContain('inset-0');
    expect(cls).toContain('flex');
    expect(cls).toContain('items-stretch');
    expect(cls).toContain('shrink-0');
  });
});

describe('RomDensityEyeCell — render shape', () => {
  // Component is plain enough to call as a function. The result is a
  // <TableCell> wrapping a single <div> wrapping the bar + button. We
  // walk the tree to confirm both layers carry the pinned classNames.

  function callCell(
    isSystem: boolean,
  ): ReactElement<{
    readonly className: string;
    readonly children: ReactElement<{ readonly className: string }>;
  }> {
    return RomDensityEyeCell({
      rom: rom(),
      isSystem,
      maxSizeBytes: 100 * 1024 * 1024,
      canMutate: true,
      disconnectedTooltip: 'Reconnect to make changes.',
      onSingleToggle: noop,
    }) as ReactElement<{
      readonly className: string;
      readonly children: ReactElement<{ readonly className: string }>;
    }>;
  }

  it('outer <td> className matches the exported constant (JSX <-> constant agreement)', () => {
    // The JSX literal and the exported constant are kept in sync by
    // hand — JSX uses a literal string so source-string scanners can
    // see the class names, the constant is exported so other tests
    // can pin them. This assertion is the bridge: if the literal
    // ever drifts from the constant, the regression-coverage we wrote
    // against the constant goes silently stale. Pin them together.
    const cell = callCell(false);
    expect(cell.props.className).toBe(DENSITY_EYE_CELL_CLASSNAMES.cell);
  });

  it('inner wrapper className matches the exported constant', () => {
    const cell = callCell(false);
    expect(cell.props.children.props.className).toBe(
      DENSITY_EYE_CELL_CLASSNAMES.wrapper,
    );
  });

  it('system rows use the same wrapper — read-only span swaps in for the eye button', () => {
    // The wrapper className should not branch on `isSystem`. Pin that
    // so a future "give system rows different layout" change doesn't
    // accidentally drop the absolute-positioning fix.
    const sysCell = callCell(true);
    expect(sysCell.props.className).toBe(DENSITY_EYE_CELL_CLASSNAMES.cell);
    expect(sysCell.props.children.props.className).toBe(
      DENSITY_EYE_CELL_CLASSNAMES.wrapper,
    );
  });
});

describe('RomNameInner — PR #25 truncation + title-attribute tooltip', () => {
  // The name cell's <td> uses `max-w-0 truncate` and the parent
  // `<table>` is `table-fixed` (Table primitive), so per-cell width
  // constraints actually apply and long titles ellipsis instead of
  // pushing right-side columns off the visible area. The inner span
  // carries a `title=` attribute so the browser-native hover tooltip
  // surfaces the full title when it's truncated. Three contracts to
  // pin: classes still include `truncate`, the title attribute is
  // present, and it equals the visible display name (so the tooltip
  // is never out-of-sync with the row).

  function rom(overrides: Partial<Rom> = {}): Rom {
    return {
      coreId: 'NES',
      filename: 'long.nes',
      displayName:
        "The Adventures of Some Game with a Really Long Subtitle (USA, Europe) (Beta) [Extended Demo]",
      sizeBytes: 1024,
      hidden: false,
      path: '/media/fat/games/NES/long.nes',
      kind: 'file',
      relativePath: 'long.nes',
      ...overrides,
    };
  }

  // RomNameInner returns a wrapping <span> with [leadingIcon, innerSpan].
  // PR-D2 (PR #29): RomNameInner renders the inner-span alongside
  // RomTagPills + (feat/filename-in-listings) an optional filename
  // subline inside a flex-col wrapper. We walk the tree to find the
  // FIRST `truncate` span — that's the title-text span the test
  // pins. The filename subline (if present) also has `truncate` but
  // is keyed under the filename text instead.
  function findFirstTruncateSpan(
    node: ReactElement<{
      readonly children?: unknown;
    }> | null,
  ): {
    readonly className: string;
    readonly title: string;
    readonly children: string;
  } | null {
    if (node === null || typeof node !== 'object') return null;
    const props = node.props as {
      readonly className?: string;
      readonly title?: string;
      readonly children?: unknown;
    };
    if (
      typeof props.className === 'string' &&
      props.className.includes('truncate')
    ) {
      return {
        className: props.className,
        title: props.title ?? '',
        children: typeof props.children === 'string' ? props.children : '',
      };
    }
    const childArr = Array.isArray(props.children)
      ? (props.children as unknown[])
      : props.children !== undefined
        ? [props.children]
        : [];
    for (const c of childArr) {
      if (c === null || typeof c !== 'object') continue;
      const found = findFirstTruncateSpan(
        c as ReactElement<{ readonly children?: unknown }>,
      );
      if (found !== null) return found;
    }
    return null;
  }

  function callInner(displayName?: string): {
    readonly className: string;
    readonly title: string;
    readonly children: string;
  } {
    const r = rom(displayName ? { displayName } : {});
    const result = RomNameInner({
      rom: r,
      dimmed: false,
      metadata: undefined,
      error: false,
    }) as ReactElement<{ readonly children?: unknown }>;
    const found = findFirstTruncateSpan(result);
    if (found === null) {
      throw new Error('truncate inner span not found in RomNameInner output');
    }
    return found;
  }

  it('inner span has the `truncate` class so long titles ellipsis', () => {
    const inner = callInner();
    expect(inner.className).toContain('truncate');
  });

  it('inner span carries a title= attribute equal to the visible display name', () => {
    // For short titles the tooltip duplicates what's visible — fine,
    // browsers show it on hover with no harm. For long truncated
    // titles, this is what surfaces the full text. The two MUST agree
    // (same source, no parallel state) so the tooltip can't show a
    // different name than the row.
    const inner = callInner('Mike Tyson Punch Out');
    expect(inner.title).toBe('Mike Tyson Punch Out');
    expect(inner.children).toBe('Mike Tyson Punch Out');
  });

  it('uses metadata.name when present, on-disk displayName otherwise', () => {
    // Pin the resolution path: metadata.name wins when set; the title
    // attribute follows the same fallback chain as the visible text.
    const r = rom({ displayName: 'on-disk-name.nes' });
    const result = RomNameInner({
      rom: r,
      dimmed: false,
      metadata: {
        version: 4,
        hash: 'a'.repeat(32),
        name: 'Canonical Game Title',
        system: 'Nintendo Entertainment System',
        year: null,
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
        source: 'screenscraper',
        fetchedAt: '2026-05-09T00:00:00.000Z',
      },
      error: false,
    }) as ReactElement<{ readonly children?: unknown }>;
    // feat/filename-in-listings: walk the new flex-col wrapper to
    // find the FIRST truncate span — that's the title.
    const found = findFirstTruncateSpan(result);
    expect(found?.title).toBe('Canonical Game Title');
    expect(found?.children).toBe('Canonical Game Title');
  });
});

describe('shouldShowFilenameSubline (feat/filename-in-listings)', () => {
  // The filename subline disambiguates rows that share a metadata-
  // resolved title but have different region/version tags. It's
  // NOT shown when redundant (title == filename) or for folder rows
  // (the folder name IS the displayed name).

  it('shows for a file row when title differs from filename', () => {
    expect(
      shouldShowFilenameSubline(
        { kind: 'file', filename: 'mslug.zip' },
        'Metal Slug',
      ),
    ).toBe(true);
  });

  it('hidden ROM (dot-prefix filename) shows the filename subline too', () => {
    // The hide convention dot-prefixes the filename; users may want
    // to see the on-disk name to confirm what's hidden vs visible.
    expect(
      shouldShowFilenameSubline(
        { kind: 'file', filename: '.mslug.zip' },
        'Metal Slug',
      ),
    ).toBe(true);
  });

  it('hides when title equals filename (no metadata yet → fallback)', () => {
    expect(
      shouldShowFilenameSubline(
        { kind: 'file', filename: 'Foo.zip' },
        'Foo.zip',
      ),
    ).toBe(false);
  });

  it('hides for folder-atomic rows (folder name IS the title)', () => {
    expect(
      shouldShowFilenameSubline(
        { kind: 'folder-atomic', filename: 'Carrot Party Disk Magazine' },
        'Carrot Party Disk Magazine',
      ),
    ).toBe(false);
  });

  it('hides for folder-container rows (drillable, no meaningful filename)', () => {
    expect(
      shouldShowFilenameSubline(
        { kind: 'folder-container', filename: '1 World A-Z' },
        '1 World A-Z',
      ),
    ).toBe(false);
  });

  it('hides for folder-atomic even if title differs from filename (defensive)', () => {
    // Folders never show the filename subline regardless of the
    // displayName/filename relationship.
    expect(
      shouldShowFilenameSubline(
        { kind: 'folder-atomic', filename: 'old-name' },
        'New Display Name',
      ),
    ).toBe(false);
  });
});

describe('RomNameInner — filename subline rendering (feat/filename-in-listings)', () => {
  function makeRom(overrides: Partial<Rom> = {}): Rom {
    return {
      coreId: 'NES',
      filename: 'mslug.zip',
      displayName: 'mslug',
      sizeBytes: 1024,
      hidden: false,
      path: '/media/fat/games/NES/mslug.zip',
      kind: 'file',
      relativePath: 'mslug.zip',
      ...overrides,
    };
  }

  function findAllTruncateSpans(
    node: ReactElement<{ readonly children?: unknown }> | null,
  ): { className: string; title: string; children: string }[] {
    const out: { className: string; title: string; children: string }[] = [];
    function walk(n: unknown): void {
      if (n === null || typeof n !== 'object') return;
      const props = (n as ReactElement<{ readonly children?: unknown }>).props as {
        readonly className?: string;
        readonly title?: string;
        readonly children?: unknown;
      };
      if (
        typeof props.className === 'string' &&
        props.className.includes('truncate')
      ) {
        out.push({
          className: props.className,
          title: props.title ?? '',
          children: typeof props.children === 'string' ? props.children : '',
        });
      }
      const childArr = Array.isArray(props.children)
        ? (props.children as unknown[])
        : props.children !== undefined
          ? [props.children]
          : [];
      for (const c of childArr) walk(c);
    }
    walk(node);
    return out;
  }

  it('renders BOTH title + filename when metadata gives a real name', () => {
    const result = RomNameInner({
      rom: makeRom({ filename: 'mslug.zip' }),
      dimmed: false,
      metadata: {
        version: 4,
        hash: 'a'.repeat(32),
        name: 'Metal Slug',
        system: 'NEOGEO',
        year: null,
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
        source: 'screenscraper',
        fetchedAt: '2026-05-10T00:00:00.000Z',
      },
      error: false,
    }) as ReactElement<{ readonly children?: unknown }>;
    const truncates = findAllTruncateSpans(result);
    // Two truncate spans: the title + the filename subline.
    expect(truncates).toHaveLength(2);
    expect(truncates[0]?.children).toBe('Metal Slug');
    expect(truncates[1]?.children).toBe('mslug.zip');
    // Filename subline is the most subtle text token in the
    // design system — fix/auto-scrape-correctness-suite bumped
    // from text-fg-muted to text-fg-disabled so it recedes from
    // a glance scan of the row table.
    expect(truncates[1]?.className).toContain('text-fg-disabled');
    expect(truncates[1]?.className).toContain('text-caption');
    // Native title= for hover when truncated.
    expect(truncates[1]?.title).toBe('mslug.zip');
  });

  it('omits the filename subline when no metadata (title == filename fallback)', () => {
    const result = RomNameInner({
      rom: makeRom({ filename: 'Foo.zip', displayName: 'Foo.zip' }),
      dimmed: false,
      metadata: undefined,
      error: false,
    }) as ReactElement<{ readonly children?: unknown }>;
    const truncates = findAllTruncateSpans(result);
    // Only the title — no filename subline (would be redundant).
    expect(truncates).toHaveLength(1);
    expect(truncates[0]?.children).toBe('Foo.zip');
  });

  it('omits the filename subline for atomic folders', () => {
    const result = RomNameInner({
      rom: makeRom({
        kind: 'folder-atomic',
        filename: 'Carrot Party Disk Magazine',
        displayName: 'Carrot Party Disk Magazine',
      }),
      dimmed: false,
      metadata: undefined,
      error: false,
    }) as ReactElement<{ readonly children?: unknown }>;
    const truncates = findAllTruncateSpans(result);
    expect(truncates).toHaveLength(1);
    expect(truncates[0]?.children).toBe('Carrot Party Disk Magazine');
  });
});
