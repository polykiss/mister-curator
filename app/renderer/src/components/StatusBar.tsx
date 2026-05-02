import { Loader2 } from 'lucide-react';
import type { JSX } from 'react';

import type { ConnectionStatus } from '@shared/types';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
import { cn } from '@app/renderer/src/lib/cn';

/**
 * Bottom-of-window status bar. Two halves:
 *   - Left: the most recent in-flight operation message, or an idle
 *     summary ("Connected to <host>" / "Disconnected").
 *   - Right: a small colored dot reflecting the connection status,
 *     mirroring the four-state machine from ConnectionStatus.
 *
 * Designed to be cheap to mount — both contexts are already in the
 * tree for everything else.
 */
export function StatusBar(): JSX.Element {
  const { current } = useOperationStatus();
  const { status, currentProfile } = useConnection();

  const idleMessage = idleMessageFor(status, currentProfile?.host);
  const message = current ?? idleMessage;
  const isBusy = current !== null;

  return (
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/40 px-4 py-1.5 text-xs">
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        {isBusy ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        ) : null}
        <span className="truncate">{message}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          aria-label={`Connection status: ${status}`}
          title={`Connection status: ${status}`}
          className={cn(
            'inline-block h-2 w-2 rounded-full',
            statusDotClass(status),
          )}
        />
        <span className="text-muted-foreground">{status}</span>
      </div>
    </footer>
  );
}

function idleMessageFor(status: ConnectionStatus, host: string | undefined): string {
  switch (status) {
    case 'connected':
      return host === undefined ? 'Connected' : `Connected to ${host}`;
    case 'connecting':
      return host === undefined ? 'Connecting…' : `Connecting to ${host}…`;
    case 'error':
      return 'Connection error';
    case 'disconnected':
      return 'Disconnected';
  }
}

function statusDotClass(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'bg-emerald-500';
    case 'connecting':
      return 'bg-amber-500 animate-pulse';
    case 'error':
      return 'bg-red-500';
    case 'disconnected':
      return 'bg-muted-foreground/40';
  }
}
