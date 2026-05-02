import { Check, Eye, EyeOff, Sparkles, Undo2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isArcadePlaceholder, isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import { HideEmptyCoresDialog } from '@app/renderer/src/components/HideEmptyCoresDialog';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { summarizeBulkResult } from '@app/renderer/src/lib/format';

const ARCADE_TOOLTIP = "Arcade cores aren't supported yet — coming in a later release.";

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

  const [showHidden, setShowHidden] = useState(false);
  const [confirmHideId, setConfirmHideId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const visibleCores = useMemo(() => {
    if (!cores) return null;
    return showHidden ? cores : cores.filter((c) => !isCoreHidden(c));
  }, [cores, showHidden]);

  const emptyHideableCores = useMemo(
    () =>
      (cores ?? []).filter(
        (c) => c.romCount === 0 && c.category !== 'Arcade' && !isCoreHidden(c),
      ),
    [cores],
  );

  const allHiddenCores = useMemo(
    () => (cores ?? []).filter((c) => isCoreHidden(c) && c.category !== 'Arcade'),
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
    if (allHiddenCores.length === 0) return;
    const changes = allHiddenCores.map((c) => ({ coreId: c.id, hidden: false }));
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
      toast.error('Could not show all hidden cores', {
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
            disabled={emptyHideableCores.length === 0}
          >
            <Sparkles />
            Hide empty ({emptyHideableCores.length})
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onShowAllHidden()}
            disabled={allHiddenCores.length === 0}
            title="Restore visibility for every hidden core in one batch"
          >
            <Undo2 />
            Show all hidden ({allHiddenCores.length})
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

      {renderCoreList({
        cores,
        coresLoading,
        coresError,
        visibleCores,
        selectedCoreId,
        confirmHideId,
        pendingId,
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
                // Hidden cores get a strong, unambiguous visual treatment.
                isHiddenCore && 'bg-muted/60 text-muted-foreground italic',
              )}
            >
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => args.onSelect(core.id)}
                className="flex flex-1 min-w-0 items-center justify-between gap-2 text-left"
              >
                <span
                  className={cn(
                    'truncate font-medium',
                    isHiddenCore && 'line-through',
                  )}
                >
                  {core.name}
                </span>
                {isPlaceholder ? (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    coming later
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
                <Button
                  variant="ghost"
                  size="icon"
                  disabled
                  title={ARCADE_TOOLTIP}
                  aria-label={ARCADE_TOOLTIP}
                >
                  <EyeOff />
                </Button>
              ) : isHiddenCore ? (
                // State icon: crossed-out eye = currently hidden. Click to show.
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void args.onShow(core)}
                  disabled={isPending}
                  title={`Show ${core.name}`}
                  aria-label={`Show ${core.name}`}
                >
                  <EyeOff />
                </Button>
              ) : (
                // State icon: open eye = currently visible. Click to hide.
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => args.onAskHide(core.id)}
                  disabled={isPending}
                  title={`Hide ${core.name}`}
                  aria-label={`Hide ${core.name}`}
                >
                  <Eye />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
