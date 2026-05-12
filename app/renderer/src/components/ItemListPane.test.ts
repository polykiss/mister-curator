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
