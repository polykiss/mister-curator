import { LogOut, RefreshCw } from 'lucide-react';
import type { JSX } from 'react';
import { toast } from 'sonner';

import { isArcadePlaceholder } from '@shared/core-matching';

import { Button } from '@app/renderer/src/components/ui/button';
import { CoresPane } from '@app/renderer/src/components/CoresPane';
import { RomsPane } from '@app/renderer/src/components/RomsPane';
import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useCores } from '@app/renderer/src/contexts/CoresContext';

export function BrowserScreen(): JSX.Element {
  const { currentProfile, disconnect } = useConnection();
  const { selectedCore, refresh, coresLoading } = useCores();

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
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">
            {currentProfile?.name ?? 'MiSTer'}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            {currentProfile
              ? `${currentProfile.username}@${currentProfile.host}:${currentProfile.port}`
              : 'connected'}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onRefresh()}
            disabled={coresLoading}
          >
            <RefreshCw className={coresLoading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={() => void onDisconnect()}>
            <LogOut />
            Disconnect
          </Button>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr]">
        <aside className="overflow-auto border-r bg-muted/30">
          <CoresPane />
        </aside>
        <main className="min-w-0">
          {selectedCore ? (
            isArcadePlaceholder(selectedCore) ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
                <h2 className="text-lg font-semibold">Arcade</h2>
                <p className="max-w-md text-sm text-muted-foreground">
                  Arcade core management is coming in a later release. For now, your
                  .mra files are visible to MiSTer as normal.
                </p>
              </div>
            ) : (
              <RomsPane core={selectedCore} />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a core on the left to browse its ROMs.
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
