import { Eye, EyeOff, Loader2, Sparkles, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { coreDisplayName, isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import { DensityBar } from '@app/renderer/src/components/ui/density-bar';
import { HideEmptyCoresDialog } from '@app/renderer/src/components/HideEmptyCoresDialog';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';
import { usePersistedBool } from '@app/renderer/src/lib/use-persisted-bool';

const ARCADE_TOOLTIP = "Arcade cores aren't supported yet — coming in a later release.";
const DISCONNECTED_TOOLTIP = 'Reconnect to make changes.';

export function CoresPane(): JSX.Element {
  const {
    cores,
    coresLoading,
    coresError,
    selectedCoreId,
    selectCore,
    hideCore,
    showCore,
    setBulkCoreVisibility,
    pendingCoreIds,
    ledgerCoreIds,
  } = useCores();
  const { status } = useConnection();
  const canMutate = status === 'connected';

  // Hidden cores stay off the default cores list — they're permanent
  // decisions and the user opts in to seeing them.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenCores',
    false,
  );
  const [bulkOpen, setBulkOpen] = useState(false);

  const visibleCores = useMemo(() => {
    if (!cores) return null;
    return showHidden
      ? cores
      : cores.filter((c) => c.category === 'Arcade' || !isCoreHidden(c));
  }, [cores, showHidden]);

  const emptyHideableCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) =>
          c.romCount === 0 &&
          c.category !== 'Arcade' &&
          !isCoreHidden(c),
      ),
    [cores],
  );

  // "Unhide all (N)" only targets cores in the on-MiSTer ledger — the
  // ones we hid ourselves. Other dot-prefixed cores (firmware system
  // folders, externally-hidden cases) stay alone unless the user
  // unhides them one at a time via the eye icon.
  const appHiddenCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) =>
          isCoreHidden(c) &&
          c.category !== 'Arcade' &&
          ledgerCoreIds.has(c.id),
      ),
    [cores, ledgerCoreIds],
  );

  const onHide = async (core: CoreEntry): Promise<void> => {
    try {
      await hideCore(core.id);
      toast.success(`Hid ${coreDisplayName(core.id)}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await showCore(core.id);
                toast.success(`Restored ${coreDisplayName(core.id)}`);
              } catch (err) {
                toast.error('Could not restore core', {
                  description: err instanceof Error ? err.message : 'Unexpected error.',
                });
              }
            })();
          },
        },
        duration: 10000,
      });
    } catch (err) {
      toast.error(`Could not hide ${coreDisplayName(core.id)}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onShow = async (core: CoreEntry): Promise<void> => {
    try {
      await showCore(core.id);
      toast.success(`Restored ${coreDisplayName(core.id)}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await hideCore(core.id);
              } catch {
                /* swallow — primary toast was the success */
              }
            })();
          },
        },
        duration: 10000,
      });
    } catch (err) {
      toast.error(`Could not show ${coreDisplayName(core.id)}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onShowAllHidden = async (): Promise<void> => {
    if (appHiddenCores.length === 0) return;
    const changes = appHiddenCores.map((c) => ({ coreId: c.id, hidden: false }));
    try {
      const result = await setBulkCoreVisibility(changes);
      const summary = summarizeBulkResult({
        action: 'Restored',
        itemNoun: 'core',
        succeeded: result.succeeded,
        failed: result.failed,
        failedNames: result.failed.map((f) => f.coreId),
      });
      const surface =
        summary.kind === 'success'
          ? toast.success
          : summary.kind === 'partial'
            ? toast.warning
            : toast.error;
      surface(summary.title, {
        description: summary.description,
        action:
          summary.kind === 'success' && result.succeeded.length > 0
            ? {
                label: 'Undo',
                onClick: () => {
                  void (async () => {
                    try {
                      await setBulkCoreVisibility(
                        result.succeeded.map((id) => ({ coreId: id, hidden: true })),
                      );
                    } catch {
                      /* swallow */
                    }
                  })();
                },
              }
            : undefined,
        duration: 10000,
      });
    } catch (err) {
      toast.error('Could not unhide all cores', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  return (
    <div className="flex h-full flex-col bg-surface">
      <header className="flex flex-col gap-3 border-b border-subtle px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setBulkOpen(true)}
            disabled={!canMutate || emptyHideableCores.length === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            <Sparkles strokeWidth={1.5} />
            Hide empty ({emptyHideableCores.length})
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onShowAllHidden()}
            disabled={!canMutate || appHiddenCores.length === 0}
            title={
              canMutate
                ? 'Restore visibility for every core MiSTerCurator hid'
                : DISCONNECTED_TOOLTIP
            }
          >
            <Undo2 strokeWidth={1.5} />
            Unhide all ({appHiddenCores.length})
          </Button>
        </div>
        <label className="flex items-center gap-2 text-body-sm text-fg-body">
          <input
            type="checkbox"
            className="accent-accent"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
      </header>

      {renderCoreList({
        cores,
        coresLoading,
        coresError,
        visibleCores,
        selectedCoreId,
        pendingCoreIds,
        canMutate,
        onSelect: selectCore,
        onHide,
        onShow,
      })}

      <HideEmptyCoresDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        candidates={emptyHideableCores}
      />
    </div>
  );
}

interface RenderArgs {
  readonly cores: readonly CoreEntry[] | null;
  readonly coresLoading: boolean;
  readonly coresError: string | null;
  readonly visibleCores: readonly CoreEntry[] | null;
  readonly selectedCoreId: string | null;
  readonly pendingCoreIds: ReadonlySet<string>;
  readonly canMutate: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onHide: (core: CoreEntry) => Promise<void>;
  readonly onShow: (core: CoreEntry) => Promise<void>;
}

function renderCoreList(args: RenderArgs): JSX.Element {
  if (args.coresLoading && args.cores === null) {
    return (
      <div className="space-y-1 p-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (args.coresError !== null) {
    return (
      <div className="border-l-2 border-destructive bg-surface p-4 text-body-sm text-fg-body">
        {args.coresError}
      </div>
    );
  }

  if (!args.visibleCores || args.visibleCores.length === 0) {
    return (
      <div className="p-6 text-body-sm text-fg-muted">No cores found.</div>
    );
  }

  // Density-bar denominator: max recursive ROM count across the
  // visible cores. Recursive values let NEOGEO's ~300 stand against
  // mame's 633 instead of NEOGEO's top-level "9" collapsing into the
  // floor. Falls back to top-level `romCount` when the matcher
  // didn't supply a recursive value (legacy fixtures, partial test
  // data).
  const maxRomCount = args.visibleCores.reduce((acc, c) => {
    const v = densityValueFor(c);
    return v > acc ? v : acc;
  }, 0);

  return (
    <ul
      // PR #23 round 5 commit 1: `scroll-themed` reserves a stable
      // scrollbar gutter and paints a permanent themed bar so native
      // overlay scrollbars on macOS can't fade in over the eye column.
      className="scroll-themed flex-1 overflow-auto"
      role="listbox"
      aria-label="MiSTer cores"
    >
      {args.visibleCores.map((core) => {
        const isSelected = core.id === args.selectedCoreId;
        const isHiddenCore = isCoreHidden(core);
        const isArcade = core.category === 'Arcade';
        const isPending = args.pendingCoreIds.has(core.id);
        const displayName = coreDisplayName(core.id);

        return (
          <li
            key={core.id}
            className={cn(
              'group/row relative flex h-10 items-center gap-2 border-b border-subtle pl-4 text-body transition-colors',
              !isSelected && 'hover:bg-elevated',
              isSelected && 'bg-overlay',
              // Hidden rows lean entirely on dimming: opacity +
              // italic + a darker text color.
              isHiddenCore && 'opacity-50 italic text-fg-disabled',
            )}
          >
            {/* Active row: 2px accent edge per SYSTEM.md §5. Renders
                inside the row container so it doesn't shift content. */}
            {isSelected ? (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 w-[2px] bg-accent"
              />
            ) : null}

            <button
              type="button"
              role="option"
              aria-selected={isSelected}
              onClick={() => args.onSelect(core.id)}
              className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-none"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'truncate',
                    isSelected && !isHiddenCore && 'font-medium text-fg',
                  )}
                >
                  {displayName}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2 font-mono text-body-sm text-fg-muted tabular">
                <CoreCountSummary core={core} />
              </span>
            </button>

            {/* Right-edge stack: density rectangle flush against the
                eye icon on the far right. Wrapping them in a
                gap-0 flex lets the density's right edge meet the
                button's left edge with no breathing room — matches
                the ROMs pane's identical right-edge stack. The
                surrounding `<li>` keeps `gap-2` for the spacing
                between the name area and this stack. */}
            <div className="flex h-full shrink-0 items-stretch">
              <DensityBar
                floor="bg-surface"
                value={densityValueFor(core)}
                max={maxRomCount}
                ariaLabel={`${String(densityValueFor(core))} ROMs of peer max ${String(maxRomCount)}`}
              />
              {isArcade ? (
                <span
                  className="flex shrink-0 items-center px-2 font-mono text-body-sm text-fg-disabled"
                  title={ARCADE_TOOLTIP}
                  aria-label={ARCADE_TOOLTIP}
                >
                  read-only
                </span>
              ) : isPending ? (
                // Inline indicator while the SSH rename is on the
                // wire (Round 5 Issue 4). Replaces the eye icon at
                // the same screen position so the row's
                // optimistic state-flip is paired with a clear
                // "we're working on it" signal.
                <span
                  role="status"
                  aria-label={
                    isHiddenCore ? `Showing ${coreDisplayName(core.id)}…` : `Hiding ${coreDisplayName(core.id)}…`
                  }
                  className="flex h-8 w-8 shrink-0 items-center justify-center self-center text-fg-muted"
                >
                  <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
                </span>
              ) : isHiddenCore ? (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void args.onShow(core)}
                  disabled={!args.canMutate}
                  title={
                    args.canMutate ? `Show ${coreDisplayName(core.id)}` : DISCONNECTED_TOOLTIP
                  }
                  aria-label={`Show ${coreDisplayName(core.id)}`}
                  className="self-center opacity-70 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                >
                  <EyeOff strokeWidth={1.5} />
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void args.onHide(core)}
                  disabled={!args.canMutate}
                  title={
                    args.canMutate ? `Hide ${coreDisplayName(core.id)}` : DISCONNECTED_TOOLTIP
                  }
                  aria-label={`Hide ${coreDisplayName(core.id)}`}
                  className={cn(
                    'self-center transition-opacity',
                    !isSelected &&
                      'opacity-70 group-hover/row:opacity-100 focus-visible:opacity-100',
                  )}
                >
                  <Eye strokeWidth={1.5} />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Value the cores-list density indicator uses for `value`. Prefers
 * the recursive ROM count when the matcher computed it (the cores
 * with containers — NEOGEO, MegaCD, Saturn, ...). Falls back to the
 * top-level `romCount` when the matcher input lacked sub-folder data.
 */
function densityValueFor(core: CoreEntry): number {
  return core.recursiveRomCount ?? core.romCount;
}

/**
 * Cores-list count summary. When the recursive ROM count exceeds the
 * top-level item count (i.e. the core has at least one container
 * folder that the matcher walked into), we surface BOTH numbers:
 *
 *   "9 folders · ~300 ROMs"
 *
 * The folder count is `romCount` (top-level entries after the system-
 * file filter); the ROM total is the recursive-walk approximation.
 * The `~` is intentional — recursive counts can over- or under-count
 * (non-standard ROM extensions, atomic folders nested inside
 * containers, etc.). Single-number form is used when the two agree.
 *
 * Round 5 simplified the model: every non-arcade core renders this
 * summary, even cores without a games dir (they show `0`). No special
 * "no games dir" label, no "hidden externally" label.
 */
function CoreCountSummary({ core }: { readonly core: CoreEntry }): JSX.Element {
  const recursive = core.recursiveRomCount;
  const hasBreakdown =
    recursive !== undefined && recursive !== core.romCount && core.romCount > 0;
  if (hasBreakdown) {
    return (
      <>
        <span className="min-w-[2.5rem] text-right">{core.romCount}</span>
        <span className="font-sans text-fg-disabled">folders ·</span>
        <span>~{recursive}</span>
        <span className="font-sans text-fg-disabled">ROMs</span>
        {core.hiddenCount > 0 ? (
          <span className="text-fg-disabled">({core.hiddenCount} hidden)</span>
        ) : null}
      </>
    );
  }
  const single = recursive ?? core.romCount;
  return (
    <>
      <span className="min-w-[2.5rem] text-right">{single}</span>
      {core.hiddenCount > 0 ? (
        <span className="text-fg-disabled">({core.hiddenCount} hidden)</span>
      ) : null}
    </>
  );
}
