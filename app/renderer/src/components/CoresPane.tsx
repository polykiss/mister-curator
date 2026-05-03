import { Check, Eye, EyeOff, Sparkles, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isArcadePlaceholder, isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Badge } from '@app/renderer/src/components/ui/badge';
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
        (c) => c.romCount === 0 && c.category !== 'Arcade' && !isCoreHidden(c),
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

  // Density-bar denominator: max ROM count across the visible cores.
  // Cores with romCount === 0 render no bar (per SYSTEM.md §10).
  const maxRomCount = args.visibleCores.reduce(
    (acc, c) => (c.romCount > acc ? c.romCount : acc),
    0,
  );

  return (
    <ul
      className="flex-1 overflow-auto"
      role="listbox"
      aria-label="MiSTer cores"
    >
      {args.visibleCores.map((core) => {
        const isSelected = core.id === args.selectedCoreId;
        const isHiddenCore = isCoreHidden(core);
        const isArcade = core.category === 'Arcade';
        const isPlaceholder = isArcadePlaceholder(core);
        const askingHide = args.confirmHideId === core.id;
        const isPending = args.pendingId === core.id;

        return (
          <li
            key={core.id}
            className={cn(
              'group/row relative flex h-10 items-center gap-2 border-b border-subtle pl-4 pr-2 text-body transition-colors',
              !isSelected && 'hover:bg-elevated',
              isSelected && 'bg-overlay',
              // Hidden cores keep the row clickable but visually
              // recede via foreground color only — no opacity, no
              // italic, no fill. The HIDDEN badge does the signalling.
              isHiddenCore && 'text-fg-muted',
              isPlaceholder && 'text-fg-disabled',
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
                {isHiddenCore ? (
                  <Badge
                    variant="muted"
                    title="This core is hidden from the MiSTer menu."
                  >
                    Hidden
                  </Badge>
                ) : null}
                <span
                  className={cn(
                    'truncate',
                    isSelected ? 'font-medium text-fg' : '',
                  )}
                >
                  {core.name}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2 font-mono text-body-sm text-fg-muted tabular">
                {isPlaceholder ? (
                  <span className="text-fg-disabled">coming later</span>
                ) : !core.gamesDirExists && core.rbfPaths.length > 0 ? (
                  <span
                    className="text-fg-disabled"
                    title={`No games directory at /media/fat/games/${core.id}/`}
                  >
                    no games dir
                  </span>
                ) : (
                  <>
                    <DensityBar
                      value={core.romCount}
                      max={maxRomCount}
                      ariaLabel={`${String(core.romCount)} of ${String(maxRomCount)} ROMs (peer max)`}
                    />
                    <span className="min-w-[2.5rem] text-right">
                      {core.romCount}
                    </span>
                    {core.hiddenCount > 0 ? (
                      <span className="text-fg-disabled">
                        ({core.hiddenCount} hidden)
                      </span>
                    ) : null}
                  </>
                )}
              </span>
            </button>

            {askingHide ? (
              // Two icon-sized buttons replace the eye button — same width
              // budget, fits inside any reasonable cores-pane width.
              <div className="flex shrink-0 items-center gap-0.5">
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
            ) : isArcade ? (
              <span
                className="shrink-0 px-2 font-mono text-body-sm text-fg-disabled"
                title={ARCADE_TOOLTIP}
                aria-label={ARCADE_TOOLTIP}
              >
                read-only
              </span>
            ) : isHiddenCore ? (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void args.onShow(core)}
                disabled={isPending || !args.canMutate}
                title={
                  args.canMutate ? `Show ${core.name}` : DISCONNECTED_TOOLTIP
                }
                aria-label={`Show ${core.name}`}
                className="opacity-100 group-hover/row:opacity-100"
              >
                <EyeOff strokeWidth={1.5} />
              </Button>
            ) : (
              // Hide button reveals on row hover so the rest state stays
              // visually quiet — a long list of permanent eye icons reads
              // as noise. Selected and hidden rows always show their
              // primary action. The mutating action gates on canMutate
              // so a lost-connection session can't trigger a rename.
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
                  !isSelected && 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                )}
              >
                <Eye strokeWidth={1.5} />
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
