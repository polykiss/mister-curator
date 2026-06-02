import type { RefObject } from 'react';

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
}
