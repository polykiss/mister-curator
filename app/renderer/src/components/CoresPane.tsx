import { Check, Eye, EyeOff, Sparkles, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isArcadePlaceholder, isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
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
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b p-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setBulkOpen(true)}
            disabled={!canMutate || emptyHideableCores.length === 0}
            title={canMutate ? undefined : DISCONNECTED_TOOLTIP}
          >
            <Sparkles />
            Hide empty ({emptyHideableCores.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onShowAllHidden()}
            disabled={!canMutate || appHiddenCores.length === 0}
            title={
              canMutate
                ? 'Restore visibility for every core MiSTerCurator hid'
                : DISCONNECTED_TOOLTIP
            }
          >
            <Undo2 />
            Unhide all ({appHiddenCores.length})
          </Button>
        </div>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)}
          />
          Show hidden
        </label>
      </header>
      {externalHiddenCount > 0 ? (
        <div
          className="border-b bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
          title="These cores were already hidden when MiSTerCurator first connected. We won't modify them."
        >
          {String(externalHiddenCount)} cores hidden externally — managed by other
          tools, not by MiSTerCurator.
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
    return <div className="p-4 text-sm text-destructive">{args.coresError}</div>;
  }

  if (!args.visibleCores || args.visibleCores.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">No cores found.</div>;
  }

  return (
    <ul className="flex-1 overflow-auto divide-y" role="listbox" aria-label="MiSTer cores">
      {args.visibleCores.map((core) => {
        const isSelected = core.id === args.selectedCoreId;
        const isHiddenCore = isCoreHidden(core);
        const isArcade = core.category === 'Arcade';
        const isPlaceholder = isArcadePlaceholder(core);
        const askingHide = args.confirmHideId === core.id;
        const isPending = args.pendingId === core.id;

        return (
          <li key={core.id}>
            <div
              className={cn(
                'flex w-full items-center gap-1 px-3 py-2 text-sm transition-colors',
                isSelected && 'bg-accent',
                !isSelected && 'hover:bg-accent/50',
                // Hidden cores: half-opacity row + solid muted bg + italic
                // + a destructive HIDDEN badge to the LEFT of the name.
                // No strikethrough (it competed with the badge for the
                // user's eye and reduced legibility on long names).
                isHiddenCore && 'bg-muted text-muted-foreground italic opacity-50',
                // Arcade placeholder is read-only; render in a subtle
                // "coming soon" style so it doesn't compete visually
                // with active cores.
                isPlaceholder && 'italic text-muted-foreground/80',
              )}
            >
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => args.onSelect(core.id)}
                className="flex flex-1 min-w-0 items-center justify-between gap-2 text-left"
              >
                <span className="flex min-w-0 items-center gap-1.5 truncate font-medium">
                  {isHiddenCore ? (
                    <span
                      className="shrink-0 rounded bg-destructive px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide not-italic text-destructive-foreground"
                      title="This core is hidden from the MiSTer menu."
                    >
                      Hidden
                    </span>
                  ) : null}
                  <span className="truncate">{core.name}</span>
                </span>
                {isPlaceholder ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    coming later
                  </span>
                ) : !core.gamesDirExists && core.rbfPaths.length > 0 ? (
                  // Cores with an .rbf or .mgl but no games/ dir get a
                  // small badge instead of "0 ROMs" so users don't think
                  // their content vanished.
                  <span
                    className="shrink-0 text-xs italic text-muted-foreground"
                    title={`No games directory at /media/fat/games/${core.id}/`}
                  >
                    no games dir
                  </span>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {core.romCount}
                    {core.hiddenCount > 0 ? (
                      <span className="ml-1 italic">({core.hiddenCount} hidden)</span>
                    ) : null}
                  </span>
                )}
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
                    <Check />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={args.onCancelHide}
                    disabled={isPending}
                    title="Cancel"
                    aria-label="Cancel hide"
                  >
                    <X />
                  </Button>
                </div>
              ) : isArcade ? (
                // Arcade is read-only. No checkbox, no eye icon — it's
                // a label-only row. The tooltip on the row itself
                // surfaces the "coming later" message; a screen reader
                // gets the same message via aria-label on the row.
                <span
                  className="shrink-0 px-2 text-xs italic text-muted-foreground/70"
                  title={ARCADE_TOOLTIP}
                  aria-label={ARCADE_TOOLTIP}
                >
                  read-only
                </span>
              ) : isHiddenCore ? (
                // Round 4: rolled back the round-3 solid fills.
                // Outlined variants keep the slate-vs-primary
                // colour cue without 9 stacked rows shouting.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void args.onShow(core)}
                  disabled={isPending || !args.canMutate}
                  className="min-w-[5.5rem] border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
                  title={
                    args.canMutate
                      ? `Show ${core.name}`
                      : 'Reconnect to make changes.'
                  }
                  aria-label={`Show ${core.name}`}
                >
                  <EyeOff />
                  Show
                </Button>
              ) : (
                // Slate-outlined Hide. Triggers the confirm step
                // (askHide) — same flow, restrained affordance.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => args.onAskHide(core.id)}
                  disabled={isPending || !args.canMutate}
                  className="min-w-[5.5rem] border-slate-300 text-slate-700 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800/50 dark:hover:text-slate-100"
                  title={
                    args.canMutate
                      ? `Hide ${core.name}`
                      : 'Reconnect to make changes.'
                  }
                  aria-label={`Hide ${core.name}`}
                >
                  <Eye />
                  Hide
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
