import { Loader2 } from 'lucide-react';
import type { JSX } from 'react';

import type { ConnectionStatus } from '@shared/types';

import {
  useConnection,
  type AutoRetryProgress,
} from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
import { cn } from '@app/renderer/src/lib/cn';

/**
 * Bottom-of-window status bar. Two halves:
 *   - Left: the most recent in-flight operation message, or an idle
 *     summary ("Connected to <host>" / "Reconnecting (1 of 3)…" /
 *     "Disconnected").
 *   - Right: a small colored dot reflecting the connection status,
 *     mirroring the four-state machine from ConnectionStatus —
 *     except an in-flight auto-retry overrides the dot to amber
 *     pulse so the user sees "we're working on it" even though the
 *     underlying status flipped to 'disconnected'.
 *
 * PR #20 round 3: surfaces a visible reconnecting state during
 * transient drops. Round 1/2 left the user staring at "Disconnected"
 * with no signal that auto-retry was happening.
 */
export function StatusBar(): JSX.Element {
  const { current, currentProgress } = useOperationStatus();
  const {
    status,
    currentProfile,
    lostConnection,
    autoRetry,
    autoRetryFailed,
  } = useConnection();

  const idleMessage = idleMessageFor(status, currentProfile?.host, {
    lostConnection,
    autoRetry,
    autoRetryFailed,
  });
  const baseMessage = current ?? idleMessage;
  const isBusy = current !== null;
  // Reconnecting overrides the underlying disconnected dot so the
  // user sees the progress signal instead of a "we gave up" gray.
  const dotState: ConnectionStatus | 'reconnecting' =
    autoRetry !== null || (lostConnection && !autoRetryFailed)
      ? 'reconnecting'
      : status;

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
    <footer className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-subtle bg-chrome px-4 text-caption uppercase tracking-[0.08em] text-fg-muted">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {isBusy && !hasProgress ? (
          <Loader2
            className="size-3 shrink-0 animate-spin text-fg-body"
            strokeWidth={1.5}
            aria-hidden
          />
        ) : null}
        <span className="truncate normal-case tracking-normal text-body-sm text-fg-body">
          {message}
        </span>
        {isBusy && hasProgress ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={currentProgress.total}
            aria-valuenow={currentProgress.done}
            className="ml-1 h-1 w-32 shrink-0 overflow-hidden rounded-full bg-elevated"
          >
            <div
              className="h-full bg-accent transition-[width] duration-150 ease-out"
              style={{ width: `${String(percent)}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span
          aria-hidden
          className={cn(
            'inline-block size-1.5 shrink-0 rounded-full',
            statusDotClass(dotState),
          )}
        />
        <span aria-label={`Connection status: ${dotState}`}>{dotState}</span>
      </div>
    </footer>
  );
}

/**
 * Idle-message picker. Splits cleanly:
 *   - reconnecting      → "Reconnecting (N of M)…" or "Connection lost,
 *                          retrying…" before the first auto-retry
 *                          attempt event arrives.
 *   - autoRetryFailed   → "Connection lost. Reconnect or disconnect."
 *   - default           → the four-state ConnectionStatus copy.
 */
export function idleMessageFor(
  status: ConnectionStatus,
  host: string | undefined,
  resilience: {
    readonly lostConnection: boolean;
    readonly autoRetry: AutoRetryProgress | null;
    readonly autoRetryFailed: boolean;
  } = { lostConnection: false, autoRetry: null, autoRetryFailed: false },
): string {
  if (resilience.autoRetry !== null) {
    const { attempt, totalAttempts } = resilience.autoRetry;
    return host === undefined
      ? `Reconnecting (${String(attempt)} of ${String(totalAttempts)})…`
      : `Reconnecting to ${host} (${String(attempt)} of ${String(totalAttempts)})…`;
  }
  if (resilience.lostConnection && !resilience.autoRetryFailed) {
    return host === undefined
      ? 'Connection lost, retrying…'
      : `Connection lost, retrying ${host}…`;
  }
  if (resilience.autoRetryFailed) {
    return host === undefined
      ? 'Connection lost. Reconnect or disconnect.'
      : `Connection lost to ${host}. Reconnect or disconnect.`;
  }
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

function statusDotClass(state: ConnectionStatus | 'reconnecting'): string {
  switch (state) {
    case 'connected':
      return 'bg-success';
    case 'connecting':
    case 'reconnecting':
      return 'bg-warning animate-status-pulse';
    case 'error':
      return 'bg-destructive';
    case 'disconnected':
      return 'bg-fg-disabled';
  }
}
