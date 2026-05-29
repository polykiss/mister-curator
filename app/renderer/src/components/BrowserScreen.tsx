import { LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { ARCADE_VIRTUAL_CORE_ID } from '@shared/arcade-mra';
import { coreDisplayName } from '@shared/core-matching';

import { ArcadeMraPane } from '@app/renderer/src/components/ArcadeMraPane';
import { Button } from '@app/renderer/src/components/ui/button';
import { CoresPane } from '@app/renderer/src/components/CoresPane';
import { DisconnectBanner } from '@app/renderer/src/components/DisconnectBanner';
import { RomsPane } from '@app/renderer/src/components/RomsPane';
import { StatusBar } from '@app/renderer/src/components/StatusBar';
import { UpdateModeBanner } from '@app/renderer/src/components/UpdateModeBanner';
import { UpdateModeDialog } from '@app/renderer/src/components/UpdateModeDialog';
import { UpdateModeProgressModal } from '@app/renderer/src/components/UpdateModeProgressModal';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { useResizablePaneWidth } from '@app/renderer/src/lib/use-resizable-pane';

// Round 5: cores pane min bumped from 200 → 320. Below 320px the
// "9 folders · ~300 ROMs" breakdown cell wraps and the right-edge
// density+eye stack starts crowding the row name; the live
// screenshot caught it. Default initial width stays at 280, but the
// resizable divider clamps to 320 so a user can't drag past where
// the layout breaks.
const CORES_PANE_DEFAULT_WIDTH = 320;
const CORES_PANE_MIN_WIDTH = 320;
const ROMS_PANE_MIN_WIDTH = 300;

export function BrowserScreen(): JSX.Element {
  const { currentProfile, disconnect, lostConnection } = useConnection();
  const { selectedCore, refresh, coresLoading, updateModeActive, updateModeOperationPhase, updateModeOperationKey } = useCores();
  const [updateModeDialogOpen, setUpdateModeDialogOpen] = useState(false);
  const [progressCurrent, setProgressCurrent] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.mister?.onUpdateModeProgress) return;
    const unsubscribe = window.mister.onUpdateModeProgress((event) => {
      setProgressCurrent(event.done);
      setProgressTotal(event.total);
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (updateModeOperationPhase !== null) {
      setProgressCurrent(0);
      setProgressTotal(0);
    }
  }, [updateModeOperationPhase]);

  const {
    width: coresWidth,
    onDragStart,
    isDragging,
  } = useResizablePaneWidth({
    storageKey: 'mistercurator.coresPaneWidth',
    defaultWidth: CORES_PANE_DEFAULT_WIDTH,
    minLeft: CORES_PANE_MIN_WIDTH,
    minRight: ROMS_PANE_MIN_WIDTH,
  });

  const onDisconnect = async (): Promise<void> => {
    try {
      await disconnect();
    } catch (err) {
      toast.error('Could not disconnect cleanly', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  const onRefresh = async (): Promise<void> => {
    try {
      await refresh();
    } catch (err) {
      toast.error('Refresh failed', {
        description: err instanceof Error ? err.message : 'Unexpected error.',
      });
    }
  };

  return (
    <div
      className={cn(
        'flex h-screen flex-col bg-canvas text-fg',
        // Disable text selection while dragging the divider so the
        // user doesn't accidentally highlight chunks of the cores list.
        isDragging && 'select-none',
      )}
    >
      <DisconnectBanner />
      <UpdateModeBanner />
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-subtle bg-chrome px-4">
        <div className="min-w-0">
          <div className="truncate text-body font-medium text-fg">
            {currentProfile?.name ?? 'MiSTer'}
          </div>
          <div className="truncate font-mono text-body-sm text-fg-muted">
            {currentProfile
              ? `${currentProfile.username}@${currentProfile.host}:${currentProfile.port}`
              : 'connected'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={coresLoading}
          >
            <RefreshCw
              className={coresLoading ? 'animate-spin' : undefined}
              strokeWidth={1.5}
            />
            Refresh
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setUpdateModeDialogOpen(true)}
            disabled={updateModeActive || coresLoading}
            title={updateModeActive ? 'Update mode already active — restore first' : undefined}
          >
            <ShieldCheck strokeWidth={1.5} />
            Update mode
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void onDisconnect()}>
            <LogOut strokeWidth={1.5} />
            Disconnect
          </Button>
        </div>
      </header>

      {/* While the SSH session is lost we keep the panes mounted so
          the user can still browse cached state — but dim them so the
          stale-vs-live difference is visible at a glance. The banner
          above is the primary signal; this is the secondary one. */}
      <div
        className={cn(
          'flex min-h-0 flex-1',
          lostConnection && 'opacity-70 transition-opacity',
        )}
      >
        <aside
          style={{ width: `${String(coresWidth)}px` }}
          className="shrink-0 overflow-auto border-r border-subtle bg-surface"
        >
          <CoresPane />
        </aside>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize cores pane"
          onPointerDown={onDragStart}
          className={cn(
            'group relative w-px shrink-0 cursor-col-resize bg-overlay transition-colors hover:bg-accent',
            isDragging && 'bg-accent',
          )}
        >
          {/* Slightly wider invisible hit-target so the divider is easy
              to grab without making the visible bar fat. */}
          <span className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
        <main className="min-w-0 flex-1 bg-elevated">
          {selectedCore ? (
            // feat/arcade-phase-1.5 — the synthetic Arcade row
            // routes to ArcadeMraPane (which fetches its own
            // entries via the new IPC). RomsPane stays
            // exclusively for real cores with a games dir.
            selectedCore.id === ARCADE_VIRTUAL_CORE_ID ? (
              <ArcadeMraPane />
            ) : !selectedCore.gamesDirExists ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
                <h2 className="text-heading text-fg">
                  {coreDisplayName(selectedCore.id)}
                </h2>
                <p className="max-w-md text-body-lg text-fg-muted">
                  This core has no games directory. ROMs go in{' '}
                  <code className="rounded border border-default bg-overlay px-1.5 py-0.5 font-mono text-body-sm text-fg-body">
                    /media/fat/games/{selectedCore.id}/
                  </code>
                  .
                </p>
                <p className="max-w-md text-body-sm text-fg-disabled">
                  MiSTerCurator does not create directories on the device — copy your
                  ROMs over and refresh.
                </p>
              </div>
            ) : (
              <RomsPane core={selectedCore} />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-body-sm text-fg-muted">
              Select a core on the left to browse its ROMs.
            </div>
          )}
        </main>
      </div>

      <StatusBar />
      <UpdateModeDialog
        open={updateModeDialogOpen}
        onOpenChange={setUpdateModeDialogOpen}
      />
      <UpdateModeProgressModal
        key={updateModeOperationKey}
        open={updateModeOperationPhase !== null}
        phase={updateModeOperationPhase ?? 'entering'}
        current={progressCurrent}
        total={progressTotal}
      />
    </div>
  );
}
