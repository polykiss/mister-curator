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
  const { current, currentProgress } = useOperationStatus();
  const { status, currentProfile } = useConnection();

  const idleMessage = idleMessageFor(status, currentProfile?.host);
  const baseMessage = current ?? idleMessage;
  const isBusy = current !== null;

  // Determinate progress when the active op is reporting ticks; falls
  // back to the indeterminate spinner otherwise.
  const hasProgress =
    currentProgress !== null &&
    currentProgress.total > 0 &&
    currentProgress.done >= 0;
  const percent = hasProgress
    ? Math.min(
        100,
        Math.round((currentProgress.done / currentProgress.total) * 100),
      )
    : 0;
  const message =
    isBusy && hasProgress
      ? `${baseMessage.replace(/[…\s]+$/u, '')} ${String(currentProgress.done)} / ${String(
          currentProgress.total,
        )} (${String(percent)}%)`
      : baseMessage;

  return (
    <footer className="flex shrink-0 items-center justify-between gap-3 border-t bg-muted/40 px-4 py-1.5 text-xs">
      <div className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground">
        {isBusy && !hasProgress ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
        ) : null}
        <span className="truncate">{message}</span>
        {isBusy && hasProgress ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={currentProgress.total}
            aria-valuenow={currentProgress.done}
            className="ml-1 h-1.5 w-32 shrink-0 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary transition-[width] duration-150 ease-out"
              style={{ width: `${String(percent)}%` }}
            />
          </div>
        ) : null}
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
