import { Check, Eye, EyeOff, Sparkles, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import {
  isArcadePlaceholder,
  isCoreExternallyHidden,
  isCoreHidden,
} from '@shared/core-matching';
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
const EXTERNALLY_HIDDEN_TOOLTIP =
  'Hidden by an external tool. MiSTerCurator will not modify it; folder browsing is disabled.';

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
  } = useCores();
  const { status } = useConnection();
  const canMutate = status === 'connected';

  // Hidden cores are intentionally permanent decisions — keep them
  // off the default cores list. The user's last choice persists.
  const [showHidden, setShowHidden] = usePersistedBool(
    'mistercurator.showHiddenCores',
    false,
  );
  const [confirmHideId, setConfirmHideId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  // Cores list excludes externally-hidden entries. They're cores whose
  // hidden state pre-dates our ledger (MiSTer's stock layout, other
  // tools). The user can still see they exist via the header count.
  // Arcade placeholder is always shown — it's a synthetic UI row that
  // would otherwise get dropped because it has no rbfs and no games dir,
  // which `isCoreHidden` treats as "hidden".
  const presentableCores = useMemo(() => {
    if (!cores) return null;
    return cores.filter(
      (c) =>
        c.category === 'Arcade' || !isCoreHidden(c) || c.managedByApp === true,
    );
  }, [cores]);

  const visibleCores = useMemo(() => {
    if (!presentableCores) return null;
    return showHidden
      ? presentableCores
      : presentableCores.filter((c) => c.category === 'Arcade' || !isCoreHidden(c));
  }, [presentableCores, showHidden]);

  const emptyHideableCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) =>
          c.romCount === 0 &&
          c.category !== 'Arcade' &&
          !isCoreHidden(c) &&
          // Externally-hidden cores are already not in the user's
          // browsable library (their games dir is hidden by some other
          // tool). The "Hide empty cores" sweep would re-rename them,
          // which is exactly the kind of cross-tool interference
          // AGENTS.md tells us to avoid — leave them alone.
          !isCoreExternallyHidden(c),
      ),
    [cores],
  );

  // "Unhide all (N)" only counts cores we hid ourselves. Pre-existing
  // dot-prefixed dirs from MiSTer's stock state stay alone.
  const appHiddenCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) => isCoreHidden(c) && c.managedByApp === true && c.category !== 'Arcade',
      ),
    [cores],
  );

  const externalHiddenCount = useMemo(
    () =>
      (cores ?? []).filter(
        (c) =>
          isCoreHidden(c) && c.managedByApp !== true && c.category !== 'Arcade',
      ).length,
    [cores],
  );

  const onHide = async (core: CoreEntry): Promise<void> => {
    setPendingId(core.id);
    try {
      await hideCore(core.id);
      toast.success(`Hid ${core.name}`, {
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await showCore(core.id);
                toast.success(`Restored ${core.name}`);
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
      toast.error(`Could not hide ${core.name}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setPendingId(null);
      setConfirmHideId(null);
    }
  };

  const onShow = async (core: CoreEntry): Promise<void> => {
    setPendingId(core.id);
    try {
      await showCore(core.id);
      toast.success(`Restored ${core.name}`, {
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
      toast.error(`Could not show ${core.name}`, {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    } finally {
      setPendingId(null);
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
      {externalHiddenCount > 0 ? (
        <div
          className="border-b border-subtle border-l-2 border-l-info bg-surface px-4 py-3 text-body-sm text-fg-muted"
          title="These cores were already hidden when MiSTerCurator first connected. We won't modify them."
        >
          <span className="font-mono text-fg-body">
            {String(externalHiddenCount)}
          </span>{' '}
          cores hidden externally — managed by other tools, not by MiSTerCurator.
        </div>
      ) : null}

      {renderCoreList({
        cores,
        coresLoading,
        coresError,
        visibleCores,
        selectedCoreId,
        confirmHideId,
        pendingId,
        canMutate,
        onSelect: selectCore,
        onAskHide: setConfirmHideId,
        onConfirmHide: onHide,
        onCancelHide: () => setConfirmHideId(null),
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
  readonly confirmHideId: string | null;
  readonly pendingId: string | null;
  /** Disables every per-row hide/show button when not connected. */
  readonly canMutate: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onAskHide: (id: string) => void;
  readonly onConfirmHide: (core: CoreEntry) => Promise<void>;
  readonly onCancelHide: () => void;
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
  // visible cores (Round 3 / Issue 5). Recursive values let NEOGEO's
  // ~300 stand against mame's 633 instead of NEOGEO's top-level "9"
  // collapsing into the floor. Falls back to top-level `romCount`
  // when the matcher didn't supply a recursive value (legacy
  // fixtures, partial test data).
  const maxRomCount = args.visibleCores.reduce((acc, c) => {
    const v = densityValueFor(c);
    return v > acc ? v : acc;
  }, 0);

  return (
    <ul
      className="flex-1 overflow-auto"
      role="listbox"
      aria-label="MiSTer cores"
    >
      {args.visibleCores.map((core) => {
        const isSelected = core.id === args.selectedCoreId;
        const isHiddenCore = isCoreHidden(core);
        const externallyHidden = isCoreExternallyHidden(core);
        const isArcade = core.category === 'Arcade';
        const isPlaceholder = isArcadePlaceholder(core);
        const askingHide = args.confirmHideId === core.id;
        const isPending = args.pendingId === core.id;

        return (
          <li
            key={core.id}
            className={cn(
              'group/row relative flex h-10 items-center gap-2 border-b border-subtle pl-4 text-body transition-colors',
              !isSelected && !externallyHidden && 'hover:bg-elevated',
              isSelected && 'bg-overlay',
              // Hidden + arcade-placeholder + externally-hidden rows
              // lean entirely on dimming: opacity + italic + a darker
              // text color. The HIDDEN/SYSTEM badges that used to sit
              // on the left were removed in Round 2 — the dimming is
              // the whole signal. Externally-hidden cores get the
              // same treatment because the user can't act on them
              // through this app.
              isHiddenCore && 'opacity-50 italic text-fg-disabled',
              externallyHidden && 'opacity-50 italic text-fg-disabled',
              isPlaceholder && 'italic text-fg-disabled',
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
              onClick={() => {
                if (externallyHidden) return;
                args.onSelect(core.id);
              }}
              disabled={externallyHidden}
              title={externallyHidden ? EXTERNALLY_HIDDEN_TOOLTIP : undefined}
              className={cn(
                'flex min-w-0 flex-1 items-center justify-between gap-3 text-left focus-visible:outline-none',
                externallyHidden && 'cursor-not-allowed',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'truncate',
                    isSelected && !isHiddenCore && 'font-medium text-fg',
                  )}
                >
                  {core.name}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2 font-mono text-body-sm text-fg-muted tabular">
                {isPlaceholder ? (
                  <span className="text-fg-disabled">coming later</span>
                ) : externallyHidden ? (
                  <span
                    className="text-fg-disabled"
                    title={EXTERNALLY_HIDDEN_TOOLTIP}
                  >
                    hidden externally
                  </span>
                ) : !core.gamesDirExists && core.rbfPaths.length > 0 ? (
                  <span
                    className="text-fg-disabled"
                    title={`No games directory at /media/fat/games/${core.id}/`}
                  >
                    no games dir
                  </span>
                ) : (
                  <CoreCountSummary core={core} />
                )}
              </span>
            </button>

            {/* Right-edge stack (Round 3): density rectangle inside,
                eye icon on the far right. Eye is always visible and
                paired to the row's current state — open Eye for
                visible cores, EyeOff for hidden. */}
            {askingHide ? (
              // Two icon-sized buttons replace the eye button — same width
              // budget, fits inside any reasonable cores-pane width.
              <div className="flex shrink-0 items-center gap-0.5 pr-1">
                <Button
                  variant="destructive"
                  size="icon"
                  onClick={() => void args.onConfirmHide(core)}
                  disabled={isPending}
                  title={`Confirm: hide ${core.name}`}
                  aria-label={`Confirm hide ${core.name}`}
                >
                  <Check strokeWidth={1.5} />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={args.onCancelHide}
                  disabled={isPending}
                  title="Cancel"
                  aria-label="Cancel hide"
                >
                  <X strokeWidth={1.5} />
                </Button>
              </div>
            ) : (
              <>
                {!isPlaceholder ? (
                  <DensityBar
                    floor="bg-surface"
                    value={densityValueFor(core)}
                    max={maxRomCount}
                    ariaLabel={`${String(densityValueFor(core))} ROMs of peer max ${String(maxRomCount)}`}
                  />
                ) : null}
                {isArcade ? (
                  <span
                    className="shrink-0 px-2 font-mono text-body-sm text-fg-disabled"
                    title={ARCADE_TOOLTIP}
                    aria-label={ARCADE_TOOLTIP}
                  >
                    read-only
                  </span>
                ) : isHiddenCore ? (
                  // Eye-off icon is always visible on hidden rows. The
                  // hover lift is a subtle brightness boost so the user
                  // gets affordance feedback without the icon disappearing
                  // at rest. canMutate gates the rename during disconnects.
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => void args.onShow(core)}
                    disabled={isPending || !args.canMutate}
                    title={
                      args.canMutate ? `Show ${core.name}` : DISCONNECTED_TOOLTIP
                    }
                    aria-label={`Show ${core.name}`}
                    className="opacity-70 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100"
                  >
                    <EyeOff strokeWidth={1.5} />
                  </Button>
                ) : (
                  // Eye (open) icon on visible rows — symmetric with the
                  // hidden state. Always rendered; hover lifts the
                  // brightness slightly. The mutating action gates on
                  // canMutate so a lost-connection session can't trigger
                  // a rename.
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => args.onAskHide(core.id)}
                    disabled={isPending || !args.canMutate}
                    title={
                      args.canMutate ? `Hide ${core.name}` : DISCONNECTED_TOOLTIP
                    }
                    aria-label={`Hide ${core.name}`}
                    className={cn(
                      'transition-opacity',
                      !isSelected &&
                        'opacity-70 group-hover/row:opacity-100 focus-visible:opacity-100',
                    )}
                  >
                    <Eye strokeWidth={1.5} />
                  </Button>
                )}
              </>
            )}
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
