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

  it('returns the existing ArcadeMraPane chrome verbatim inside `content` (title h2 / count chip / bulk buttons / toggle row)', () => {
    expect(ARCADE_ADAPTER).toMatch(/<h2 className="text-heading text-fg">Arcade</);
    expect(ARCADE_ADAPTER).toMatch(/Hide all/);
    expect(ARCADE_ADAPTER).toMatch(/Show all/);
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

  it('renders RomDetailDialog with readOnly so Edit / Find buttons are hidden', () => {
    // Arcade detail view is read-only this round; manual SS search +
    // edit dialogs are v0.2. The dialog hides both buttons when
    // `readOnly` is set, leaving Close as the only action. The
    // onEdit / onSearch callbacks stay (the dialog's TypeScript
    // requires them) but are no-ops behind the gate.
    expect(ARCADE_ADAPTER).toMatch(/<RomDetailDialog[\s\S]{0,800}readOnly/);
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
    expect(ARCADE_ADAPTER).toMatch(/extras:\s*[\s\S]{0,200}<RomDetailDialog/);
  });

  it('RomDetailDialog accepts a readOnly prop (hides Edit + Find buttons)', () => {
    const detailDialogSrc = readFileSync(
      resolve(__dirname, 'RomDetailDialog.tsx'),
      'utf8',
    );
    expect(detailDialogSrc).toMatch(/readonly readOnly\?:\s*boolean/);
    // The button row guards both Edit and Find behind the readOnly
    // gate; assert both are inside the gate (not the trivial case
    // of guarding just one).
    expect(detailDialogSrc).toMatch(
      /readOnly\s*\?\s*null\s*:[\s\S]{0,400}Edit\.\.\.[\s\S]{0,400}Find on ScreenScraper/,
    );
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
