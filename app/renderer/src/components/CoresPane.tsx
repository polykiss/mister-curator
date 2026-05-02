import { Eye, EyeOff, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isCoreHidden } from '@shared/core-matching';
import type { CoreEntry } from '@shared/types';

import { Button } from '@app/renderer/src/components/ui/button';
import { HideEmptyCoresDialog } from '@app/renderer/src/components/HideEmptyCoresDialog';
import { Skeleton } from '@app/renderer/src/components/ui/skeleton';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';

export function CoresPane(): JSX.Element {
  const {
    cores,
    coresLoading,
    coresError,
    selectedCoreId,
    selectCore,
    hideCore,
    showCore,
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

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b p-3 text-xs">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setBulkOpen(true)}
          disabled={emptyHideableCores.length === 0}
        >
          <Sparkles />
          Hide empty ({emptyHideableCores.length})
        </Button>
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
        const askingDelete = args.confirmHideId === core.id;

        return (
          <li key={core.id} className="group">
            <div
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-sm transition-colors',
                isSelected && 'bg-accent',
                !isSelected && 'hover:bg-accent/50',
              )}
            >
              <button
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => args.onSelect(core.id)}
                className={cn(
                  'flex flex-1 items-center justify-between gap-2 text-left',
                  isHiddenCore && 'italic text-muted-foreground',
                )}
              >
                <span className="truncate font-medium">{core.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {core.romCount}
                  {core.hiddenCount > 0 ? (
                    <span className="ml-1 italic">({core.hiddenCount} hidden)</span>
                  ) : null}
                </span>
              </button>

              {askingDelete ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => void args.onConfirmHide(core)}
                    disabled={args.pendingId === core.id}
                  >
                    Hide {core.name}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={args.onCancelHide}
                    disabled={args.pendingId === core.id}
                  >
                    Cancel
                  </Button>
                </div>
              ) : isHiddenCore ? (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Show ${core.name}`}
                  onClick={() => void args.onShow(core)}
                  disabled={args.pendingId === core.id}
                >
                  <Eye />
                </Button>
              ) : isArcade ? (
                <span
                  className="text-xs text-muted-foreground"
                  title="Arcade cores aren't supported yet — coming in a later release."
                >
                  Arcade
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Hide ${core.name}`}
                  onClick={() => args.onAskHide(core.id)}
                  disabled={args.pendingId === core.id}
                >
                  <EyeOff />
                </Button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
