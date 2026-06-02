import type { RefObject } from 'react';

import type { Playability } from '@shared/arcade-mra-parse';
import type { RomMetadata } from '@shared/metadata-types';
import type { Rom } from '@shared/types';

import type { SortKey, SortState } from '@app/renderer/src/lib/rom-sort';

/**
 * View-mode identifier. The ROM and arcade panes persist this per-host
 * in localStorage so each connected MiSTer remembers its own preference.
 *
 * Introduced in PR I-1; the 'detailed' and 'poster' variants are wired
 * up in PR I-2.
 */
export type ViewMode = 'list' | 'detailed' | 'poster';

/**
 * Size preset for Detailed and Poster views. Controls thumbnail height
 * in Detailed mode and tile min-width in Poster mode. Persisted per-host
 * + per-pane in localStorage; defaults to 'M'.
 */
export type ViewSize = 'S' | 'M' | 'L' | 'XL';

/**
 * Arcade-specific row context, bundled into one optional prop so the
 * view component stays self-contained. When arcadeContext is defined
 * the component uses arcade-specific behavior; when absent (ROM pane)
 * all standard ROM behavior applies — the ROM pane is untouched.
 *
 * The six fields correspond to the six arcade/ROM behavioral
 * differences identified in PR I-2a:
 *   1. Folder-row detection (subfolder entries skip checkbox/menu/density)
 *   2. Playability map for the "Missing ROMs" badge
 *   3. Checkbox key function (arcadeMraVisiblePath instead of rom.filename)
 *   4. Detail-dialog open handler (arcade state shape differs from ROM)
 *   5. Menu open handler (arcade state shape differs from ROM)
 *   6. Single-toggle handler (wraps ArcadeMraEntry instead of Rom)
 */
export interface ArcadeRowContext {
  /**
   * Returns true when the row represents an organisational subfolder
   * (not a .mra launcher). Folder rows skip the checkbox, kebab menu,
   * and density+eye cells; the row itself is the drill-in affordance.
   */
  readonly isFolderRow: (rom: Rom) => boolean;
  /**
   * Per-.mra playability status. Used to:
   *   - Drive the "Missing ROMs" badge in the name cell.
   *   - Compute `canManageMetadata` for the detail dialog and menu.
   */
  readonly playabilityByPath: ReadonlyMap<string, Playability>;
  /**
   * Stable checkbox selection key.
   * ROM pane: `rom.filename` (unchanged across hide/show).
   * Arcade:   `arcadeMraVisiblePath(rom.filename)` (normalises the
   *           leading-dot rename so the selection survives hide/show).
   */
  readonly checkboxKey: (rom: Rom) => string;
  /**
   * Open the arcade detail dialog. Receives the standard Rom + metadata
   * so the view component stays generic; the handler reconstructs the
   * arcade-specific dialog state internally.
   */
  readonly openDetail: (rom: Rom, metadata: RomMetadata | null) => void;
  /**
   * Open the arcade context/kebab menu. Same generic signature; the
   * handler captures the arcade-specific fields from its closure.
   */
  readonly openMenu: (
    rom: Rom,
    metadata: RomMetadata | null,
    x: number,
    y: number,
  ) => void;
  /**
   * Eye-toggle for a single .mra row. The handler wraps the Rom
   * back into the ArcadeMraEntry shape that onToggleSingle expects.
   */
  readonly singleToggle: (rom: Rom) => void;
}

/**
 * Shared props contract for ROM list view components (RomListView,
 * RomDetailedListView, RomPosterView). Every view receives the same
 * data + handler surface; each decides which subset to display.
 *
 * The adapter (roms-adapter / arcade-adapter) owns all state and passes
 * it down here so view components stay stateless and swappable.
 */
export interface RomsViewProps {
  // ── Loading / empty state ────────────────────────────────────────────
  /** True while the ROM list is being fetched from the device. */
  readonly loading: boolean;
  /** Raw ROM array from the cache (null/undefined = not yet loaded). */
  readonly roms: readonly Rom[] | null | undefined;
  /** Sorted + filtered ROM array — the rows to render. */
  readonly presentableRoms: readonly Rom[];
  /** The active text filter (deferred value). */
  readonly deferredFilter: string;
  /** Clear the filter text (called by the "Clear filter" button). */
  readonly onClearFilter: () => void;
  // ── Scroll position ──────────────────────────────────────────────────
  /** Ref forwarded from the adapter's scroll-restoration logic. */
  readonly scrollContainerRef: RefObject<HTMLDivElement | null>;
  // ── Sort ─────────────────────────────────────────────────────────────
  readonly sortState: SortState;
  /** Called when a sortable column header is clicked. */
  readonly onSortChange: (key: SortKey) => void;
  // ── Selection ────────────────────────────────────────────────────────
  readonly selected: ReadonlySet<string>;
  readonly onToggleAll: (checked: boolean) => void;
  readonly onToggleSelect: (filename: string, checked: boolean) => void;
  // ── Metadata ─────────────────────────────────────────────────────────
  readonly metadataByPath: Record<
    string,
    { readonly metadata: RomMetadata | null; readonly error: boolean }
  >;
  // ── Density bar ──────────────────────────────────────────────────────
  /** Max sizeBytes across visible file rows — the density bar denominator. */
  readonly maxSizeBytes: number;
  // ── System files ─────────────────────────────────────────────────────
  readonly systemFlags: ReadonlyMap<string, boolean>;
  // ── Mutation gate ────────────────────────────────────────────────────
  /** False when the SSH session is lost — disables mutating actions. */
  readonly canMutate: boolean;
  // ── Navigation ───────────────────────────────────────────────────────
  /** Synthetic back-row for drill navigation; null at the root level. */
  readonly backRow: {
    readonly targetSubPath: string;
    readonly parentLabel: string;
  } | null;
  readonly setSubPath: (subPath: string) => void;
  // ── Row interactions ─────────────────────────────────────────────────
  /** Eye-toggle hide/show for a single ROM. */
  readonly onSingleToggle: (rom: Rom) => void;
  /** Drill into a container folder or navigate back. */
  readonly onRowActivate: (rom: Rom) => void;
  /** Open the context / kebab menu at the given coordinates. */
  readonly setMenuFor: (
    m: { readonly rom: Rom; readonly x: number; readonly y: number } | null,
  ) => void;
  /** Open the ROM detail dialog. */
  readonly setDetailDialogFor: (
    d: {
      readonly path: string;
      readonly displayName: string;
      readonly filename: string;
    } | null,
  ) => void;
  // ── Arcade-specific (optional) ───────────────────────────────────────
  /**
   * Arcade row context. When provided, the view uses arcade-specific
   * rendering (Missing ROMs badge, folder-row empty cells, arcade-
   * shaped dialog/menu callbacks). When absent the ROM-pane behavior
   * applies unchanged.
   */
  readonly arcadeContext?: ArcadeRowContext;
  /**
   * Size preset for Detailed and Poster views. Ignored by RomListView.
   * Controls thumbnail height (Detailed) and tile min-width (Poster).
   * Defaults to 'M' when absent.
   */
  readonly viewSize?: ViewSize;
}
