import { LogOut, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isArcadePlaceholder } from '@shared/core-matching';

import { Button } from '@app/renderer/src/components/ui/button';
import { CoresPane } from '@app/renderer/src/components/CoresPane';
import { DisconnectBanner } from '@app/renderer/src/components/DisconnectBanner';
import { RomsPane } from '@app/renderer/src/components/RomsPane';
import { StatusBar } from '@app/renderer/src/components/StatusBar';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';
import { cn } from '@app/renderer/src/lib/cn';
import { useResizablePaneWidth } from '@app/renderer/src/lib/use-resizable-pane';

const CORES_PANE_DEFAULT_WIDTH = 280;
const CORES_PANE_MIN_WIDTH = 200;
const ROMS_PANE_MIN_WIDTH = 300;

export function BrowserScreen(): JSX.Element {
  const { currentProfile, disconnect, lostConnection } = useConnection();
  const { selectedCore, refresh, coresLoading } = useCores();

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
            isArcadePlaceholder(selectedCore) ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
                <h2 className="text-heading text-fg">Arcade</h2>
                <p className="max-w-md text-body-lg text-fg-muted">
                  Arcade core management is coming in a later release. For now, your
                  .mra files are visible to MiSTer as normal.
                </p>
              </div>
            ) : !selectedCore.gamesDirExists ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-12 text-center">
                <h2 className="text-heading text-fg">{selectedCore.name}</h2>
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
    </div>
  );
}
