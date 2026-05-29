import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * feat/arcade-refactor-1-adapter — structural assertions on the new
 * ItemListPane seam between RomsPane and ArcadeMraPane. The repo
 * runs vitest under the node environment (see vitest.config.ts;
 * `environment: 'node'`), so a literal React snapshot test would
 * require setting up jsdom — out of scope for this refactor. The
 * convention used here matches the existing `RomsPane.test.ts` and
 * `right-edge-stack.test.ts`: read each module as a source string
 * and assert on the structural invariants that drive pixel-identical
 * output.
 */

const ITEM_LIST_PANE = readFileSync(
  resolve(__dirname, 'ItemListPane.tsx'),
  'utf8',
);
const ITEM_LIST_ADAPTER = readFileSync(
  resolve(__dirname, 'item-list-adapter.ts'),
  'utf8',
);
const ROMS_ADAPTER = readFileSync(
  resolve(__dirname, 'roms-adapter.tsx'),
  'utf8',
);
const ARCADE_ADAPTER = readFileSync(
  resolve(__dirname, 'arcade-adapter.tsx'),
  'utf8',
);
const ROMS_PANE = readFileSync(
  resolve(__dirname, 'RomsPane.tsx'),
  'utf8',
);
const ARCADE_MRA_PANE = readFileSync(
  resolve(__dirname, 'ArcadeMraPane.tsx'),
  'utf8',
);

describe('ItemListPane shell', () => {
  it('composes the shared `flex h-full flex-col` with adapter.containerClassName', () => {
    // The two panes pre-refactor each spelled the outer container
    // with the same `'flex h-full flex-col'` prefix and different
    // surface tones (`bg-elevated` / `bg-canvas`). The shell pins
    // the shared prefix and lets each adapter contribute its accent
    // so the composed className matches each pane's pre-refactor
    // outer-div spelling.
    expect(ITEM_LIST_PANE).toMatch(/cn\(\s*'flex h-full flex-col'/);
    expect(ITEM_LIST_PANE).toMatch(/adapter\.containerClassName/);
  });

  it('renders `adapter.content` inside the outer container and `adapter.extras` outside it', () => {
    // Modal portals in RomsPane (detail / edit / search-SS) live
    // inside the JSX tree even though they portal to the document
    // body. The `extras` slot is the spec'd home for those — placed
    // as a sibling of the container, NOT inside it, so a future
    // pane that wants its modals truly outside the chrome can opt
    // into that placement without restructuring the shell.
    const idxContent = ITEM_LIST_PANE.indexOf('{adapter.content}');
    const idxClose = ITEM_LIST_PANE.indexOf('</div>');
    const idxExtras = ITEM_LIST_PANE.indexOf('{adapter.extras}');
    expect(idxContent).toBeGreaterThan(0);
    expect(idxClose).toBeGreaterThan(idxContent);
    expect(idxExtras).toBeGreaterThan(idxClose);
  });
});

describe('ItemListAdapter contract', () => {
  it('defines the four slots the shell consumes', () => {
    // Pin the field names — renaming any of them would silently
    // break one of the panes' wiring. The shape is the seam.
    expect(ITEM_LIST_ADAPTER).toMatch(/readonly kind:\s*'roms'\s*\|\s*'arcade'/);
    expect(ITEM_LIST_ADAPTER).toMatch(/readonly containerClassName:\s*string/);
    expect(ITEM_LIST_ADAPTER).toMatch(/readonly content:\s*ReactNode/);
    expect(ITEM_LIST_ADAPTER).toMatch(/readonly extras\?:\s*ReactNode/);
  });
});

describe('roms-adapter: useRomsAdapter', () => {
  it('exports a `useRomsAdapter` hook returning an ItemListAdapter', () => {
    expect(ROMS_ADAPTER).toMatch(
      /export function useRomsAdapter\(\{ core \}: RomsAdapterProps\): ItemListAdapter \{/,
    );
  });

  it("returns an adapter object with kind:'roms' and containerClassName:'bg-elevated' (preserves the pre-refactor pane-elevation surface tone)", () => {
    // The pre-refactor outer container was
    //   `<div className="flex h-full flex-col bg-elevated">`.
    // After the shell composes `'flex h-full flex-col'` itself, the
    // adapter must supply `'bg-elevated'` to recover the same final
    // className. Anything else would visibly change the surface
    // tone, violating the pixel-identical rule.
    expect(ROMS_ADAPTER).toMatch(/kind:\s*'roms'/);
    expect(ROMS_ADAPTER).toMatch(/containerClassName:\s*'bg-elevated'/);
  });

  it('returns the existing RomsPane chrome verbatim inside `content` (breadcrumb / count paragraph / toolbar / toggle row)', () => {
    // The four pre-refactor header rows are still present — the
    // refactor is structural (re-wraps the return) but does not
    // touch the inner chrome.
    expect(ROMS_ADAPTER).toMatch(/aria-label="Folder path"/); // breadcrumb nav
    expect(ROMS_ADAPTER).toMatch(/font-mono text-body-sm text-fg-muted tabular/); // count paragraph
    expect(ROMS_ADAPTER).toMatch(/Hide all/);
    expect(ROMS_ADAPTER).toMatch(/Unhide all/);
    expect(ROMS_ADAPTER).toMatch(/Show hidden/);
    expect(ROMS_ADAPTER).toMatch(/Show system files/);
  });

  it('keeps the same persistence keys for both toggles (no behavior change rule)', () => {
    // Renaming these keys would orphan users' saved preferences.
    // The refactor is structural only; persistence stays exactly
    // where it was.
    expect(ROMS_ADAPTER).toMatch(/'mistercurator\.showHiddenRoms',\s*true/);
    expect(ROMS_ADAPTER).toMatch(/'mistercurator\.showSystemFiles',\s*false/);
  });
});

describe('arcade-adapter: useArcadeAdapter', () => {
  it('exports a `useArcadeAdapter` hook returning an ItemListAdapter', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /export function useArcadeAdapter\(\): ItemListAdapter \{/,
    );
  });

  it("returns an adapter object with kind:'arcade' and containerClassName:'bg-canvas' (preserves the pre-refactor surface tone)", () => {
    expect(ARCADE_ADAPTER).toMatch(/kind:\s*'arcade'/);
    expect(ARCADE_ADAPTER).toMatch(/containerClassName:\s*'bg-canvas'/);
  });

  it('returns the existing ArcadeMraPane chrome verbatim inside `content` (breadcrumb nav / count line / bulk buttons / toggle row)', () => {
    // Title is now the breadcrumb nav (matches ROM pane), not an h2.
    expect(ARCADE_ADAPTER).toMatch(/computeBreadcrumb\('Arcade',\s*subPath\)/);
    expect(ARCADE_ADAPTER).not.toMatch(/<h2 className="text-heading text-fg">Arcade</);
    expect(ARCADE_ADAPTER).toMatch(/Hide all/);
    expect(ARCADE_ADAPTER).toMatch(/Unhide all/);
    expect(ARCADE_ADAPTER).toMatch(/Auto-hide missing ROMs/);
    expect(ARCADE_ADAPTER).toMatch(/Show hidden/);
  });

  it('keeps the pre-refactor `showHiddenArcadeMras` persistence key with default OFF', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /'mistercurator\.showHiddenArcadeMras',\s*false/,
    );
  });
});

describe('RomsPane.tsx wrapper', () => {
  it('is a thin wrapper: imports both useRomsAdapter and ItemListPane, returns ItemListPane', () => {
    // The whole point of this refactor is that the user-visible
    // entry points (`RomsPane`, `ArcadeMraPane`) become trivial
    // wrappers. If somebody adds logic here, it should have moved
    // to roms-adapter.tsx instead.
    expect(ROMS_PANE).toMatch(/from '@app\/renderer\/src\/components\/roms-adapter'/);
    expect(ROMS_PANE).toMatch(/from '@app\/renderer\/src\/components\/ItemListPane'/);
    expect(ROMS_PANE).toMatch(/<ItemListPane adapter=\{adapter\}/);
  });

  it('keeps the RomsPaneProps export so existing call sites compile', () => {
    expect(ROMS_PANE).toMatch(/export type RomsPaneProps = RomsAdapterProps/);
  });
});

describe('ArcadeMraPane.tsx wrapper', () => {
  it('is a thin wrapper: imports useArcadeAdapter and ItemListPane', () => {
    expect(ARCADE_MRA_PANE).toMatch(
      /from '@app\/renderer\/src\/components\/arcade-adapter'/,
    );
    expect(ARCADE_MRA_PANE).toMatch(
      /from '@app\/renderer\/src\/components\/ItemListPane'/,
    );
    expect(ARCADE_MRA_PANE).toMatch(/<ItemListPane adapter=\{adapter\}/);
  });
});

describe('arcade-adapter metadata wiring (feat/arcade-parity-2-metadata)', () => {
  it('imports `RomMetadata` for the entry-shape extension', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /import type \{ RomMetadata \} from '@shared\/metadata-types'/,
    );
  });

  it('calls `window.mister.getArcadeMetadataBatch()` during refresh', () => {
    // PR B exposes a cache-only IPC that returns relativePath →
    // RomMetadata. The adapter fires it inside the same refresh
    // call that loads entries / playability / auto-hide. Pinned
    // here so a future refactor doesn't drop the call silently.
    expect(ARCADE_ADAPTER).toMatch(
      /window\.mister[\s\S]{0,80}\.getArcadeMetadataBatch\(\)/,
    );
  });

  it('stores the metadata batch in a `metadataByMra` state map', () => {
    // The state name is part of the contract — PR C reads it from
    // the same handle. Renaming without updating PR C's cell
    // wiring would break the rendering with no compile error.
    expect(ARCADE_ADAPTER).toMatch(
      /\[metadataByMra,\s*setMetadataByMra\] = useState/,
    );
  });

  it('builds `enrichedPresentable` so each entry carries a `metadata` field', () => {
    // The renderer-side data shape extension: every visible row's
    // entry has `metadata: RomMetadata | null`. Cells in this PR
    // don't READ the field (per spec); PR C will display it.
    expect(ARCADE_ADAPTER).toMatch(/enrichedPresentable = useMemo/);
    expect(ARCADE_ADAPTER).toMatch(
      /metadata:\s*metadataByMra\[entry\.relativePath\]\s*\?\?\s*null/,
    );
  });

  it('iterates a metadata-enriched, sorted view in the table body (not raw `presentable`)', () => {
    // The table-body map MUST iterate a list that carries metadata so
    // each row's `entry.metadata` is accessible to the cells. PR C
    // wraps `enrichedPresentable` with a sort step (`sortedRows`)
    // before rendering; the sort preserves the enrichment, so each
    // row still has `metadata`. Pin both halves: enrichment exists,
    // and the body iterates the post-sort view.
    expect(ARCADE_ADAPTER).toMatch(
      /sortedRows\s*=\s*useMemo[\s\S]{0,400}enrichedPresentable/,
    );
    expect(ARCADE_ADAPTER).toMatch(/sortedRows\.map\(\(entry\)/);
  });
});

describe('preload-api: getArcadeMetadataBatch IPC surface', () => {
  it('declares the IPC channel constant', () => {
    const preloadApi = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'shared', 'preload-api.ts'),
      'utf8',
    );
    expect(preloadApi).toMatch(
      /getArcadeMetadataBatch:\s*'mister:getArcadeMetadataBatch'/,
    );
    // Return shape is `Record<string, RomMetadata | null>` — every
    // playable .mra's relativePath keys into a metadata record (or
    // null). The shape is what enriches the adapter entries.
    expect(preloadApi).toMatch(
      /getArcadeMetadataBatch\(\)[\s\S]{0,80}Record<string, RomMetadata \| null>/,
    );
  });
});

describe('arcade-adapter cell parity (feat/arcade-parity-3-ui G1-G4)', () => {
  it('reuses RomMetadataCells primitives for thumbnail / name / year / genre+rating / density+eye', () => {
    // The whole point of PR C is to reuse RomsPane's metadata-cell
    // primitives so arcade rows look identical to ROM rows. If a
    // future change inlines a custom name renderer (or stops
    // importing one of these), the visual parity drifts.
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/RomMetadataCells'/,
    );
    for (const sym of [
      'RomThumbnailCell',
      'RomNameInner',
      'RomYearCell',
      'RomMetadataInfoCells',
      'RomDensityEyeCell',
      'BackThumbnailCell',
    ]) {
      expect(ARCADE_ADAPTER).toContain(sym);
    }
  });

  it('synthesises a Rom shape per entry via makeArcadeRom from the shared lib', () => {
    // The Rom shape lets the row flow through sortRoms + the cell
    // primitives without renaming/reshaping. Lives in `arcade-row.ts`
    // (pure module) so the unit tests can import without dragging
    // React. The adapter imports from there.
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/lib\/arcade-row'/,
    );
    expect(ARCADE_ADAPTER).toMatch(/makeArcadeRom\(entry\)/);
  });

  it('preserves the "Missing ROMs" pill inside the name cell', () => {
    // The arcade pane's distinctive playability badge survives PR C
    // intact. The pill copy and the tooltip explaining it are part
    // of the contract.
    expect(ARCADE_ADAPTER).toContain('Missing ROMs');
    expect(ARCADE_ADAPTER).toContain(
      'At least one ROM zip referenced by this .mra is not present',
    );
  });
});

describe('arcade-adapter sortable headers (feat/arcade-parity-3-ui G8)', () => {
  it('imports the extracted SortableHeader + rom-sort APIs', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/SortableHeader'/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/lib\/rom-sort'/,
    );
    expect(ARCADE_ADAPTER).toMatch(/DEFAULT_SORT/);
    expect(ARCADE_ADAPTER).toMatch(/nextSortState/);
    expect(ARCADE_ADAPTER).toMatch(/sortRoms/);
  });

  it('wires SortableHeader for all four metadata columns (Name, Year, Genre, Rating) — full RomsPane parity', () => {
    // The earlier round shipped Genre as a plain <TableHead> on the
    // theory that sparse arcade metadata made the sort key noise.
    // Live use disagreed: with .mras that DO have a genre (most do
    // after a scrape pass) the sort is the natural way to group
    // shooters / fighters / puzzlers. Flipping it back to match
    // RomsPane keeps the user-mental-model identical across panes.
    expect(ARCADE_ADAPTER).toMatch(/<SortableHeader[\s\S]{0,200}sortKey="name"/);
    expect(ARCADE_ADAPTER).toMatch(/<SortableHeader[\s\S]{0,200}sortKey="year"/);
    expect(ARCADE_ADAPTER).toMatch(/<SortableHeader[\s\S]{0,200}sortKey="genre"/);
    expect(ARCADE_ADAPTER).toMatch(/<SortableHeader[\s\S]{0,200}sortKey="rating"/);
    // No leftover plain TableHead for Genre — would render two genre
    // headers if both were present.
    expect(ARCADE_ADAPTER).not.toMatch(
      /<TableHead className="w-28">Genre<\/TableHead>/,
    );
  });

  it('Genre header carries `normal-case` so the column label renders mixed-case instead of all-caps', () => {
    // Live regression: the inherited `uppercase` on the base TableHead
    // primitive made the arcade Genre column read "GENRE" in caps.
    // RomsPane shows it mixed-case; pinning the override keeps the
    // arcade column consistent with the live ROM-pane behavior.
    expect(ARCADE_ADAPTER).toMatch(
      /<SortableHeader[\s\S]{0,300}sortKey="genre"[\s\S]{0,300}className="w-28 normal-case"/,
    );
  });

  it('declares a per-pane sortState defaulting to DEFAULT_SORT (not persisted)', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /\[sortState,\s*setSortState\]\s*=\s*useState<SortState>\(DEFAULT_SORT\)/,
    );
    // The not-persisted assertion is structural: usePersistedBool
    // appears only twice — for `showHiddenArcadeMras`. Renaming
    // the sort state into a persisted slot would surface here.
    const persistMatches = ARCADE_ADAPTER.match(/usePersistedBool/g) ?? [];
    expect(persistMatches.length, 'sort state must not be persisted').toBeLessThan(3);
  });

  it('extracted SortableHeader lives in its own shared file (no inline copy in roms-adapter)', () => {
    const sortableHeaderSrc = readFileSync(
      resolve(__dirname, 'SortableHeader.tsx'),
      'utf8',
    );
    expect(sortableHeaderSrc).toMatch(/export function SortableHeader/);
    expect(ROMS_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/SortableHeader'/,
    );
    // The inline definition in roms-adapter is gone (would shadow
    // the extracted one and silently keep two implementations).
    expect(ROMS_ADAPTER).not.toMatch(/^function SortableHeader/m);
  });
});

describe('arcade-adapter subfolder drill (feat/arcade-parity-3-ui G15)', () => {
  it('imports the breadcrumb + back-row helpers used by RomsPane', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/lib\/breadcrumb'/,
    );
    expect(ARCADE_ADAPTER).toMatch(/computeBreadcrumb/);
    expect(ARCADE_ADAPTER).toMatch(/computeBackRow/);
    expect(ARCADE_ADAPTER).toMatch(/subPathAtDepth/);
  });

  it('declares subPath state initialised to "" (core root)', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /\[subPath,\s*setSubPath\]\s*=\s*useState<string>\(''\)/,
    );
  });

  it('renders a back row that resets subPath to the parent (mirrors RomsPane)', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /onClick=\{\(\)\s*=>\s*setSubPath\(backRow\.targetSubPath\)\}/,
    );
    expect(ARCADE_ADAPTER).toMatch(/<BackThumbnailCell\s*\/>/);
  });

  it('passes the arcade label "Arcade" as the breadcrumb root (matches the h2 title)', () => {
    expect(ARCADE_ADAPTER).toMatch(/computeBreadcrumb\('Arcade',\s*subPath\)/);
    expect(ARCADE_ADAPTER).toMatch(/computeBackRow\('Arcade',\s*subPath\)/);
  });
});

describe('arcade-adapter loading skeleton parity (feat/arcade-parity-3-ui G21)', () => {
  it('renders 8 skeleton rows during the cold load (matches RomsPane)', () => {
    // The skeleton block in RomsPane uses `Array.from({ length: 8 })`
    // and a `Skeleton className="h-10 w-full"`. Arcade must match
    // so the cold-load visual rhythm is consistent.
    expect(ARCADE_ADAPTER).toMatch(
      /Array\.from\(\{\s*length:\s*8\s*\}\)[\s\S]{0,400}Skeleton/,
    );
    expect(ARCADE_ADAPTER).toMatch(/Skeleton[\s\S]{0,40}className="h-10 w-full"/);
    // The pre-PR-C "Loading arcade entries…" centered spinner is gone.
    expect(ARCADE_ADAPTER).not.toContain('Loading arcade entries…');
  });
});

describe('CoresPane MAME/HBMame sidebar filter (feat/arcade-parity-3-ui G23)', () => {
  const CORES_PANE = readFileSync(
    resolve(__dirname, 'CoresPane.tsx'),
    'utf8',
  );

  it('persists the "Show MAME / HBMame as separate cores" toggle with default OFF', () => {
    expect(CORES_PANE).toMatch(
      /usePersistedBool\(\s*'mistercurator\.showMameAsCores',\s*false,?\s*\)/,
    );
  });

  it('filters coreId in {mame, hbmame} from visibleCores when the toggle is off', () => {
    // The filter predicate hides the two zip-management cores by
    // default so the sidebar reads as a single Arcade entry. Pin
    // both ids — dropping one would silently surface that core.
    expect(CORES_PANE).toMatch(/c\.id !== 'mame'/);
    expect(CORES_PANE).toMatch(/c\.id !== 'hbmame'/);
    expect(CORES_PANE).toMatch(/showMameAsCores/);
  });

  it('exposes the toggle in the sidebar header next to "Show hidden"', () => {
    expect(CORES_PANE).toContain('Show MAME / HBMame as separate cores');
    expect(CORES_PANE).toContain('Show hidden');
  });
});

describe('CoresPane Arcade sidebar row alignment (feat/arcade-sidebar-alignment)', () => {
  const CORES_PANE = readFileSync(
    resolve(__dirname, 'CoresPane.tsx'),
    'utf8',
  );

  it('Arcade row reserves the eye-icon slot as an empty `h-8 w-8` spacer (tagged data-arcade-eye-slot) instead of rendering null', () => {
    // The right-edge stack is `<DensityBar /> <EyeButton />` for
    // every regular core. Pre-fix, the Arcade branch returned null
    // where the eye button lives, so the density bar collapsed
    // rightward by ~32px (the icon button's width), visibly mis-
    // aligning the Arcade row's density strip with every other
    // core's. The spacer restores the grid without adding a real
    // eye toggle (Arcade hide is per-`.mra`, not per-core). The
    // `data-arcade-eye-slot` attribute lets the right-edge-stack
    // structural test recognise this as a gated mutually-exclusive
    // branch (never renders alongside the eye Button at runtime).
    const arcadeBranch = CORES_PANE.match(
      /isArcade \? \([\s\S]{0,2000}?\)\s*:\s*isPending/,
    );
    expect(arcadeBranch).not.toBeNull();
    const branch = arcadeBranch![0];
    expect(branch).toMatch(/data-arcade-eye-slot/);
    expect(branch).toMatch(/h-8 w-8/);
    // No live `null` return for the Arcade branch — that was the
    // regression. (Allow the literal word `null` to appear in a
    // comment, but not as the JSX expression itself.)
    expect(branch).not.toMatch(/\)\s*:\s*null\b/);
  });

  it('spacer width matches the loading-spinner placeholder and the eye-button footprint (column grid stays consistent)', () => {
    // Same `h-8 w-8 shrink-0` shape the pending-rename branch uses
    // for its loading spinner. If a future change moves to a
    // different icon size, both branches should move together so
    // the grid doesn't drift.
    const pendingBranch = CORES_PANE.match(
      /isPending \? \([\s\S]{0,1500}?\)\s*:\s*isHiddenCore/,
    );
    expect(pendingBranch).not.toBeNull();
    expect(pendingBranch![0]).toMatch(/h-8 w-8 shrink-0/);
  });
});

describe('arcade-adapter detail dialog (feat/arcade-parity-3-ui)', () => {
  it('imports the shared RomDetailDialog (not a new arcade-specific clone)', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/RomDetailDialog'/,
    );
  });

  it('declares detail-dialog state opened by a name-cell click', () => {
    // The click handler hangs off the name TableCell so clicking
    // the box-art / year / genre / rating cells doesn't trigger the
    // modal (those cells have their own non-click semantics).
    expect(ARCADE_ADAPTER).toMatch(
      /\[detailDialogFor,\s*setDetailDialogFor\]\s*=\s*useState/,
    );
    expect(ARCADE_ADAPTER).toMatch(/setDetailDialogFor\(\{/);
  });

  it('renders RomDetailDialog with per-entry allowEdit + allowSearch (both grey out for missing-zip entries)', () => {
    // feat/arcade-edit-detail-alignment: allowEdit is now bound to
    // the entry's playability at click time
    // (`detailDialogFor.canManageMetadata`), matching allowSearch.
    // Both flags greys out missing-zip rows (no zip to bind against);
    // playable + no-roms-needed entries get both buttons in the
    // detail dialog. Pre this PR, allowEdit was hard-coded false
    // and Edit Metadata lived only in the context menu.
    expect(ARCADE_ADAPTER).toMatch(
      /<RomDetailDialog[\s\S]{0,2000}allowEdit=\{detailDialogFor\.canManageMetadata\}/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /<RomDetailDialog[\s\S]{0,2000}allowSearch=\{detailDialogFor\.canManageMetadata\}/,
    );
  });

  it('wires onEdit to open RomEditMetadataDialog with the current row metadata', () => {
    // The detail-dialog's Edit handler reads metadataByMra by
    // relativePath, then opens the edit dialog with that record. The
    // dialog's existing onSave wiring routes through
    // setArcadeMetadataOverride (the IPC PR #67 + #68 already wired).
    expect(ARCADE_ADAPTER).toMatch(
      /onEdit=\{[\s\S]{0,800}metadataByMra\[detailDialogFor\.relativePath\][\s\S]{0,400}setEditMetadataFor\(\{/,
    );
  });

  it('wires onSearch to open RomSearchScreenScraperDialog with arcade context', () => {
    // Detail dialog's "Find on ScreenScraper..." button closes self +
    // calls onSearch, which opens the SS search modal pre-filled with
    // the .mra's display name. Pin the SS-modal callsite plus the
    // arcade-specific bind callback shape — bypassing the by-path
    // bind in favour of the new `bindArcadeMetadataFromSearch` IPC.
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/RomSearchScreenScraperDialog'/,
    );
    // The detail dialog hands off to the SS search modal by composing
    // its target object from `detailDialogFor` (no longer passes the
    // whole record verbatim — extra fields like canManageMetadata
    // shouldn't bleed into the search dialog's state).
    expect(ARCADE_ADAPTER).toMatch(
      /setSearchScreenScraperFor\(\{[\s\S]{0,200}relativePath:\s*detailDialogFor\.relativePath/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /onBind=\{[\s\S]{0,400}window\.mister\.bindArcadeMetadataFromSearch\(\s*searchScreenScraperFor\.relativePath,\s*game,?\s*\)/,
    );
    // The SS modal's coreId argument must be 'mame' so SS searches
    // systemId=75 — the same id the auto-scrape pass uses.
    expect(ARCADE_ADAPTER).toMatch(
      /<RomSearchScreenScraperDialog[\s\S]{0,400}coreId="mame"/,
    );
  });

  it('refreshes the arcade list after a successful manual-bind so siblings sharing the primary zip see the new metadata', () => {
    // The bind writes by primary-zip md5, so every .mra mapped to the
    // same zip surfaces the new record on the next batch read. The
    // adapter triggers that read by calling refresh() from onSaved.
    expect(ARCADE_ADAPTER).toMatch(
      /onSaved=\{[\s\S]{0,600}refresh\(false\)/,
    );
  });

  it('feeds metadata into the dialog via the existing metadataByMra map (no new IPC)', () => {
    // Reuses the by-hash cache PR B wired up — no new fetch path,
    // no new state slot. The dialog handles the null case for
    // entries the prefetch hasn't matched.
    expect(ARCADE_ADAPTER).toMatch(
      /metadata=\{metadataByMra\[detailDialogFor\.relativePath\]\s*\?\?\s*null\}/,
    );
  });

  it('returns the dialog via `extras` so it sits outside the pane container (modal-portal hygiene)', () => {
    // ItemListPane composes the pane chrome with `adapter.content`
    // inside the outer container and `adapter.extras` as a sibling.
    // Modal portals belong in `extras` so the pane shell can
    // restructure its container without dragging the modal tree
    // along (see ItemListPane.test.ts above).
    //
    // feat/detail-modal-nav-hide wraps the dialog instantiation in
    // an IIFE that computes the prev/next/hide callbacks against
    // the current sorted list, so the slack between `extras:` and
    // `<RomDetailDialog` is now several KB. Bump the regex window.
    expect(ARCADE_ADAPTER).toMatch(/extras:\s*[\s\S]{0,5000}<RomDetailDialog/);
  });

  it('RomDetailDialog exposes per-action allowEdit / allowSearch flags (plus readOnly convenience)', () => {
    const detailDialogSrc = readFileSync(
      resolve(__dirname, 'RomDetailDialog.tsx'),
      'utf8',
    );
    // Per-action flags drive the buttons. RomsPane callsites pass
    // neither and inherit the `true` default → both buttons appear.
    // Arcade passes allowEdit={false} and allowSearch={true}.
    expect(detailDialogSrc).toMatch(/readonly allowEdit\?:\s*boolean/);
    expect(detailDialogSrc).toMatch(/readonly allowSearch\?:\s*boolean/);
    // readOnly convenience stays (back-compat) but is layered as a
    // default for both flags rather than a direct gate.
    expect(detailDialogSrc).toMatch(/readonly readOnly\?:\s*boolean/);
    // The Edit + Find buttons are guarded by their own flags now —
    // pin that each is rendered conditionally on its own flag.
    expect(detailDialogSrc).toMatch(
      /\{allowEdit\s*\?[\s\S]{0,200}Edit\.\.\./,
    );
    expect(detailDialogSrc).toMatch(
      /\{allowSearch\s*\?[\s\S]{0,300}Find on ScreenScraper/,
    );
  });

  it('RomDetailDialog defaults both allow flags to true when readOnly is undefined (RomsPane preserves its full button row)', () => {
    const detailDialogSrc = readFileSync(
      resolve(__dirname, 'RomDetailDialog.tsx'),
      'utf8',
    );
    // The default-resolution helper: `readOnly === true ? false : true`
    // means an absent readOnly → default true → both buttons visible.
    // Explicit per-action props override.
    expect(detailDialogSrc).toMatch(
      /defaultAllow\s*=\s*readOnly\s*===\s*true\s*\?\s*false\s*:\s*true/,
    );
    expect(detailDialogSrc).toMatch(/allowEdit\s*\?\?\s*defaultAllow/);
    expect(detailDialogSrc).toMatch(/allowSearch\s*\?\?\s*defaultAllow/);
  });
});

describe('arcade-adapter scrollbar gap parity (feat/arcade-scrollbar-gap-parity)', () => {
  it('arcade pane scroll container uses the same scroll-themed + pr-2.5 treatment as RomsPane', () => {
    // PR #23 rounds 5/6 added `scroll-themed` (stable scrollbar gutter
    // + themed bar) and `pr-2.5` (10px right padding so the eye column
    // clears the scrollbar) to RomsPane + CoresPane. Arcade was
    // shipped without either, so its right edge sat at a different
    // pixel than ROM panes under macOS overlay scrollbars. Pin both
    // bits of the treatment in BOTH adapters so a future regression
    // would surface here.
    const SCROLL_CONTAINER_RE = /scroll-themed flex-1 overflow-auto pr-2\.5/;
    expect(ROMS_ADAPTER).toMatch(SCROLL_CONTAINER_RE);
    expect(ARCADE_ADAPTER).toMatch(SCROLL_CONTAINER_RE);
  });
});

describe('arcade-adapter row context menu (feat/arcade-polish-context-menu)', () => {
  it('imports RomRowMenu and declares a menuFor anchor state', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/RomRowMenu'/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /\[menuFor,\s*setMenuFor\]\s*=\s*useState/,
    );
  });

  it('renders a MoreHorizontal trigger inside each mra row', () => {
    expect(ARCADE_ADAPTER).toMatch(/<MoreHorizontal strokeWidth=\{1\.5\}/);
    expect(ARCADE_ADAPTER).toMatch(/title="More actions"/);
  });

  it('menu carries exactly two items: Find on ScreenScraper... + Edit Metadata...', () => {
    // feat/arcade-bind-density-edit: Edit Metadata joins Find on
    // ScreenScraper now that the arcade bind path can write user
    // overrides keyed on the primary-zip md5. Both items disable
    // when the row's primary zip is missing (no md5 to bind / edit
    // against); Edit further disables when no metadata record exists
    // yet (composer needs an existing record to override).
    const itemsBlock = ARCADE_ADAPTER.match(
      /const items: readonly RomRowMenuItem\[\] = \[[\s\S]{0,1600}\];/,
    );
    expect(itemsBlock).not.toBeNull();
    const body = itemsBlock![0];
    expect(body).toContain("label: 'Find on ScreenScraper...'");
    expect(body).toContain("label: 'Edit Metadata...'");
    expect(body).toContain('setSearchScreenScraperFor(target)');
    expect(body).toContain('setEditMetadataFor({');
    const labelCount = (body.match(/label:\s*'/g) ?? []).length;
    expect(labelCount).toBe(2);
  });

  it('menu items grey out for missing-zip entries and (for Edit) for entries without metadata', () => {
    // Find: disabled when canManageMetadata is false. Edit: disabled
    // when EITHER canManageMetadata is false OR hasMetadata is false.
    // Tooltips differentiate the two reasons so a user understands
    // why the option is greyed. The tooltip strings live in const
    // bindings just above the items array, so scan the wider menu
    // IIFE body.
    const iifeBlock = ARCADE_ADAPTER.match(
      /menuFor !== null[\s\S]{0,3000}<RomRowMenu/,
    );
    expect(iifeBlock).not.toBeNull();
    const body = iifeBlock![0];
    expect(body).toMatch(/disabled:\s*!canSearch/);
    expect(body).toMatch(/disabled:\s*!canEdit/);
    expect(body).toContain('Install the ROM to enable metadata search.');
    expect(body).toContain(
      'No metadata yet — use Find on ScreenScraper first.',
    );
  });

  it('renders RomRowMenu in extras when an anchor is open', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /<RomRowMenu[\s\S]{0,400}onClose=\{\(\)\s*=>\s*setMenuFor\(null\)\}/,
    );
  });
});

describe('arcade density driven by primary-zip size (feat/arcade-polish-context-menu)', () => {
  it('makeArcadeRom uses entry.primaryZipSizeBytes for rom.sizeBytes on mra entries', () => {
    const arcadeRowSrc = readFileSync(
      resolve(__dirname, '..', 'lib', 'arcade-row.ts'),
      'utf8',
    );
    expect(arcadeRowSrc).toMatch(
      /sizeBytes:\s*isMra\s*\?\s*\(entry\.primaryZipSizeBytes\s*\?\?\s*0\)\s*:\s*0/,
    );
  });

  it('arcade-adapter computes maxSizeBytes across visible rows and passes it to RomDensityEyeCell', () => {
    expect(ARCADE_ADAPTER).toMatch(/const maxSizeBytes = useMemo/);
    expect(ARCADE_ADAPTER).toMatch(
      /<RomDensityEyeCell[\s\S]{0,400}maxSizeBytes=\{maxSizeBytes\}/,
    );
  });

  it('ArcadeMraEntryWire carries an optional primaryZipSizeBytes field', () => {
    const preloadApi = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'shared', 'preload-api.ts'),
      'utf8',
    );
    expect(preloadApi).toMatch(/readonly primaryZipSizeBytes\?:\s*number/);
  });

  it('ArcadeMraMetaCacheEntry persists per-mra primary-zip sizes (optional field for legacy-cache tolerance)', () => {
    const cacheTypesSrc = readFileSync(
      resolve(__dirname, '..', '..', '..', '..', 'app', 'main', 'cache', 'cache-types.ts'),
      'utf8',
    );
    expect(cacheTypesSrc).toMatch(
      /primaryZipSizeByMra\?:\s*Readonly<Record<string, number>>/,
    );
  });
});

describe('arcade Edit Metadata wiring (feat/arcade-bind-density-edit)', () => {
  const preloadApi = readFileSync(
    resolve(__dirname, '..', '..', '..', '..', 'shared', 'preload-api.ts'),
    'utf8',
  );

  it('imports RomEditMetadataDialog into arcade-adapter', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /from '@app\/renderer\/src\/components\/RomEditMetadataDialog'/,
    );
  });

  it('renders RomEditMetadataDialog with arcade-shaped onSave wired to setArcadeMetadataOverride', () => {
    // The same callback-driven shape that the SS search dialog uses
    // — RomsPane wires `onSave` to setRomMetadataOverride, arcade
    // wires it to setArcadeMetadataOverride. Pin the arcade callsite.
    expect(ARCADE_ADAPTER).toMatch(
      /<RomEditMetadataDialog[\s\S]{0,800}onSave=\{[\s\S]{0,200}window\.mister\.setArcadeMetadataOverride\(/,
    );
  });

  it('Edit menu item opens RomEditMetadataDialog with the row metadata pre-filled', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /setEditMetadataFor\(\{[\s\S]{0,400}metadata:\s*meta,?/,
    );
  });

  it('declares the setArcadeMetadataOverride IPC channel + preload bridge', () => {
    expect(preloadApi).toMatch(
      /setArcadeMetadataOverride:\s*'mister:setArcadeMetadataOverride'/,
    );
    expect(preloadApi).toMatch(
      /setArcadeMetadataOverride\([\s\S]{0,200}mraRelativePath: string,[\s\S]{0,200}override: UserMetadataOverride \| undefined,?\s*\)/,
    );
  });

  it('RomEditMetadataDialog accepts onSave callback (no longer hard-codes the IPC)', () => {
    const editDialogSrc = readFileSync(
      resolve(__dirname, 'RomEditMetadataDialog.tsx'),
      'utf8',
    );
    expect(editDialogSrc).toMatch(
      /readonly onSave:\s*\(\s*override: UserMetadataOverride \| undefined,?\s*\)\s*=>\s*Promise<RomMetadata \| null>/,
    );
    // Pin handler bodies — both save + reset go through onSave now.
    // (Top-of-file comments may still mention setRomMetadataOverride
    // in the historical context section; those are fine.)
    for (const fn of ['handleSave', 'handleReset'] as const) {
      const match = editDialogSrc.match(
        new RegExp(`async function ${fn}\\([^)]*\\)[^{]*\\{[\\s\\S]*?\\n {2}\\}`),
      );
      expect(match, `${fn} body must exist`).not.toBeNull();
      expect(match![0]).toContain('await onSave(');
      expect(match![0]).not.toMatch(/window\.mister\.setRomMetadataOverride\(/);
    }
  });

  it('RomsPane still wires Edit via window.mister.setRomMetadataOverride (no regression)', () => {
    expect(ROMS_ADAPTER).toMatch(
      /<RomEditMetadataDialog[\s\S]{0,800}onSave=\{[\s\S]{0,200}window\.mister\.setRomMetadataOverride\(/,
    );
  });
});

describe('arcade manual SS bind: on-demand hash + grey-out for missing zip (feat/arcade-bind-density-edit)', () => {
  const orchestratorSrc = readFileSync(
    resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'app',
      'main',
      'metadata',
      'metadata-orchestrator.ts',
    ),
    'utf8',
  );

  it('hashes the primary zip on-demand when the hash cache misses (Devil Zone case)', () => {
    // Pre-fix: bindArcadeManualMetadataOverride returned null when
    // the primary zip wasn't in the hash cache (auto-scrape hadn't
    // reached it yet). The renderer surfaced "no metadata record"
    // and the user was stuck. The fix calls computeHash directly
    // on the candidate zip paths when the cache lookup fails.
    expect(orchestratorSrc).toMatch(
      /resolveOrComputeArcadePrimaryZipMd5/,
    );
    expect(orchestratorSrc).toMatch(
      /this\.hashService\.computeHash\(\s*session\.client,\s*session\.host,\s*path,?\s*\)/,
    );
  });

  it('detail-dialog allowSearch follows canManageMetadata so missing-zip entries grey out the Find button', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /canManageMetadata\s*=\s*classification === 'playable'/,
    );
    expect(ARCADE_ADAPTER).toMatch(/allowSearch=\{detailDialogFor\.canManageMetadata\}/);
  });
});

describe('RomSearchScreenScraperDialog long-title overflow (feat/arcade-bind-density-edit)', () => {
  const searchDialogSrc = readFileSync(
    resolve(__dirname, 'RomSearchScreenScraperDialog.tsx'),
    'utf8',
  );

  it('title + description use break-words instead of truncate', () => {
    // Same fix RomDetailDialog got in PR #66. `truncate` set
    // white-space:nowrap; long unbreakable zip filenames forced the
    // dialog past max-w-xl and the Close button slid past the right
    // edge.
    expect(searchDialogSrc).toMatch(
      /<DialogDescription\s+className="break-words"/,
    );
    expect(searchDialogSrc).not.toMatch(
      /<DialogDescription className="truncate"/,
    );
  });

  it('the search form is flex-wrap so the Search button stays inside the dialog', () => {
    expect(searchDialogSrc).toMatch(
      /<form\s+className="flex flex-wrap items-center gap-2"/,
    );
  });
});

describe('arcade noRomsNeeded overrides (feat/arcade-noromsneeded-overrides)', () => {
  it('canManageMetadata accepts playable AND no-roms-needed (only missing is greyed)', () => {
    // Pre-this-PR the gate was strictly classification === playable.
    // TTL / discrete-logic games (no-roms-needed) had no path to
    // bind metadata; this PR adds a parallel mra-keyed store so they
    // become actionable from the same UI.
    expect(ARCADE_ADAPTER).toMatch(
      /classification === 'playable'\s*\|\|\s*classification === 'no-roms-needed'/,
    );
  });

  it('detail-dialog state captures playability so the empty-state copy can branch', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /readonly playability:\s*[\s\S]{0,200}'no-roms-needed'/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /setDetailDialogFor\(\{[\s\S]{0,400}playability:\s*classification/,
    );
  });

  it('arcadeEmptyStateBody returns the three-tier copy by playability', () => {
    const helperMatch = ARCADE_ADAPTER.match(
      /function arcadeEmptyStateBody[\s\S]{0,1200}\n\}/,
    );
    expect(helperMatch).not.toBeNull();
    const body = helperMatch![0];
    expect(body).toContain('Install the ROM zip to enable metadata search.');
    // noRomsNeeded → returned text ends at "search manually." with
    // no "or wait for the prefetch" tail. Pin the exact returned
    // string so a future copy change can't reintroduce the tail.
    expect(body).toContain(
      'Click "Find on ScreenScraper" to search manually.',
    );
    // The literal `return 'X';` for the no-roms-needed branch must
    // NOT include the "or wait..." tail; checking against the
    // RETURN statement specifically (not the surrounding comments).
    const noRomsNeededReturn = body.match(
      /playability === 'no-roms-needed'\)\s*\{[\s\S]*?return\s+['"`]([^'"`]+)['"`]/,
    );
    expect(noRomsNeededReturn).not.toBeNull();
    expect(noRomsNeededReturn![1]).not.toContain('wait for the prefetch');
    // Playable → return undefined (use the dialog's default copy).
    expect(body).toMatch(/return undefined/);
  });

  it('detail dialog receives emptyStateBody from the helper', () => {
    expect(ARCADE_ADAPTER).toMatch(
      /emptyStateBody=\{arcadeEmptyStateBody\(\s*detailDialogFor\.playability,?\s*\)\}/,
    );
  });
});

describe('arcade-mra-overrides storage + routing (feat/arcade-noromsneeded-overrides)', () => {
  const orchestratorSrc = readFileSync(
    resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'app',
      'main',
      'metadata',
      'metadata-orchestrator.ts',
    ),
    'utf8',
  );
  const metadataServiceSrc = readFileSync(
    resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      'app',
      'main',
      'metadata',
      'metadata-service.ts',
    ),
    'utf8',
  );

  it('MetadataService exposes the three new arcade-mra entry points', () => {
    expect(metadataServiceSrc).toMatch(/async bindArcadeMraOverride\(/);
    expect(metadataServiceSrc).toMatch(/async writeArcadeMraUserOverride\(/);
    expect(metadataServiceSrc).toMatch(/async readCachedArcadeMraMetadata\(/);
  });

  it('storage path lives under arcade-mra-overrides/ (parallel to by-hash)', () => {
    expect(metadataServiceSrc).toMatch(
      /join\(\s*this\.rootDir,\s*'arcade-mra-overrides'/,
    );
  });

  it('bindArcadeManualMetadataOverride branches on no-roms-needed and routes to bindArcadeMraOverride', () => {
    expect(orchestratorSrc).toMatch(
      /snapshot\.byPath\.get\(mraRelativePath\) === 'no-roms-needed'[\s\S]{0,400}bindArcadeMraOverride\(/,
    );
  });

  it('setArcadeManualMetadataOverride branches on no-roms-needed and routes to writeArcadeMraUserOverride', () => {
    expect(orchestratorSrc).toMatch(
      /snapshot\.byPath\.get\(mraRelativePath\) === 'no-roms-needed'[\s\S]{0,400}writeArcadeMraUserOverride\(/,
    );
  });

  it('getCachedArcadeMetadataBatch reads no-roms-needed entries from the parallel store', () => {
    expect(orchestratorSrc).toMatch(/readCachedArcadeMraMetadata\(/);
  });
});

describe('arcade row alignment with RomsPane (feat/arcade-edit-detail-alignment)', () => {
  it('arcade table header starts with the same w-10 pl-4 leading slot RomsPane uses for the checkbox column', () => {
    // Both panes now carry a "select all" checkbox in the w-10 pl-4
    // TableHead slot so the header row is pixel-identical across panes.
    expect(ROMS_ADAPTER).toMatch(
      /<TableHead className="w-10 pl-4">[\s\S]{0,400}type="checkbox"/,
    );
    expect(ARCADE_ADAPTER).toMatch(
      /<TableHead className="w-10 pl-4">[\s\S]{0,400}type="checkbox"/,
    );
  });

  it('arcade back-row and folder rows carry the w-10 pl-4 leading TableCell spacer', () => {
    // MRA rows now carry a checkbox in their leading cell; back-row
    // and folder rows still use an empty spacer to keep column rhythm.
    const cells = ARCADE_ADAPTER.match(
      /<TableCell className="w-10 pl-4"\s*\/>/g,
    );
    expect(cells, 'arcade-adapter should have ≥2 leading spacers (back-row + folder-row branch)').not.toBeNull();
    expect(cells!.length).toBeGreaterThanOrEqual(2);
  });

  it('empty-folder placeholder colSpan covers the full 8-column grid', () => {
    // 7 → 8 after the leading spacer landed. Off-by-one here would
    // make the "This folder is empty." cell stop short of the right
    // edge.
    expect(ARCADE_ADAPTER).toMatch(/colSpan=\{8\}/);
    expect(ARCADE_ADAPTER).not.toMatch(/colSpan=\{7\}/);
  });
});

describe('no inter-adapter state leakage', () => {
  it('neither adapter file declares module-level mutable state (each hook owns its state in React)', () => {
    // The "switching adapters at runtime doesn't leak state" guarantee
    // (per spec) holds as long as each adapter's state is scoped to
    // its React hook instance — i.e. inside the function body, NOT
    // at module scope. A module-level `let entries = [...]` would
    // leak between mounts. Source scan: assert each adapter file has
    // no top-level `let` declarations outside the hook body.
    //
    // The hook function definition lines are the anchor; we check
    // that no `let` appears BEFORE them at the module scope.
    for (const [name, src] of [
      ['roms-adapter.tsx', ROMS_ADAPTER],
      ['arcade-adapter.tsx', ARCADE_ADAPTER],
    ] as const) {
      const lines = src.split('\n');
      const firstHookLine = lines.findIndex((l) =>
        /^export function use\w+Adapter/.test(l),
      );
      expect(firstHookLine, `${name} should export a use*Adapter hook`).toBeGreaterThan(0);
      const preamble = lines.slice(0, firstHookLine);
      // Allow `let` only inside function declarations (heuristic:
      // any `let` line in the preamble that isn't preceded by an
      // unbalanced `{` from a function/const declaration counts as
      // module scope). The strict check: no top-level `let` token
      // at column 0 of the preamble.
      const moduleLevelLet = preamble.find((l) => /^let /.test(l));
      expect(
        moduleLevelLet,
        `${name} has a module-level \`let\` — would leak across adapter mounts`,
      ).toBeUndefined();
    }
  });
});
