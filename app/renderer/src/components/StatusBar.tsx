import { Loader2 } from 'lucide-react';
import type { JSX } from 'react';

import type { AutoScrapeProgressEvent } from '@shared/preload-api';
import type { ConnectionStatus } from '@shared/types';

import { useAutoScrapeProgress } from '@app/renderer/src/contexts/AutoScrapeContext';
import {
  useConnection,
  type AutoRetryProgress,
} from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
import { cn } from '@app/renderer/src/lib/cn';

/**
 * Bottom-of-window status bar. Two halves:
 *   - Left: the most recent in-flight operation message, or — when
 *     no operation is in flight — a transient-state idle string
 *     ("Connecting…", "Reconnecting (1 of 3)…", "Connection error").
 *     The steady-state connected case renders empty: the right-pill
 *     already communicates that, and the host address lives in the
 *     top header (PR-A item 7 dropped the redundant footer echo).
 *   - Right: a small colored dot reflecting the connection status,
 *     mirroring the four-state machine from ConnectionStatus —
 *     except an in-flight auto-retry overrides the dot to amber
 *     pulse so the user sees "we're working on it" even though the
 *     underlying status flipped to 'disconnected'.
 */
export function StatusBar(): JSX.Element {
  const { current, currentProgress } = useOperationStatus();
  const { status, lostConnection, autoRetry, autoRetryFailed } =
    useConnection();
  const autoScrape = useAutoScrapeProgress();

  // PR-C (PR #26): when no manual operation is in flight AND the
  // connection is steady-state connected, fall back to the
  // auto-scrape engine's progress (if any). The active-state
  // string is `<core display label> · <done>/<total>` per the
  // spec — no "ROMs" word, no percentage, no padding.
  const idleMessage = idleMessageFor(status, {
    lostConnection,
    autoRetry,
    autoRetryFailed,
  });
  const autoScrapeMessage = autoScrapeMessageFor(autoScrape, status);
  const baseMessage = current ?? autoScrapeMessage ?? idleMessage;
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
 * Idle-message picker. PR-A item 7 dropped the host string from
 * every branch — the top header (`HostHeader`) carries the address
 * and the right-pill carries the steady-state connection state, so
 * the footer-left only renders messages that add NEW information
 * (transient transitions + in-flight ops surfaced elsewhere).
 *
 * Branches:
 *   - reconnecting      → "Reconnecting (N of M)…" or "Connection lost,
 *                          retrying…" before the first auto-retry
 *                          attempt event arrives.
 *   - autoRetryFailed   → "Connection lost. Reconnect or disconnect."
 *   - connecting        → "Connecting…"
 *   - error             → "Connection error"
 *   - disconnected      → "Disconnected"
 *   - connected         → "" (steady state — pill suffices)
 */
export function idleMessageFor(
  status: ConnectionStatus,
  resilience: {
    readonly lostConnection: boolean;
    readonly autoRetry: AutoRetryProgress | null;
    readonly autoRetryFailed: boolean;
  } = { lostConnection: false, autoRetry: null, autoRetryFailed: false },
): string {
  if (resilience.autoRetry !== null) {
    const { attempt, totalAttempts } = resilience.autoRetry;
    return `Reconnecting (${String(attempt)} of ${String(totalAttempts)})…`;
  }
  if (resilience.lostConnection && !resilience.autoRetryFailed) {
    return 'Connection lost, retrying…';
  }
  if (resilience.autoRetryFailed) {
    return 'Connection lost. Reconnect or disconnect.';
  }
  switch (status) {
    case 'connected':
      return '';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Connection error';
    case 'disconnected':
      return 'Disconnected';
  }
}

/**
 * PR-C (PR #26): convert an auto-scrape progress event to the
 * footer-left string. Only renders when the engine is `active` AND
 * the connection is steady-state connected (the engine pauses on
 * disconnect, but a stale event could still be in the renderer's
 * state — gating on status keeps the footer honest if the
 * connection drops mid-scrape and the pause event hasn't propagated
 * yet). Returns null when there's nothing to surface, so the caller
 * can fall through to `idleMessageFor`.
 *
 * Format per the PR-C round 2 spec: `Scraping <core label> · <done>/<total>`.
 * Round 1 used just `<label> · <done>/<total>` — the "Scraping" verb
 * makes the state legible at a glance and matches the user's mental
 * model. No "ROMs" word, no `~`, no padding.
 */
export function autoScrapeMessageFor(
  event: AutoScrapeProgressEvent,
  status: ConnectionStatus,
): string | null {
  if (event.state !== 'active') return null;
  if (status !== 'connected') return null;
  // feat/auto-scrape-persistence: extend the footer with the
  // session completion counts so the user sees the FULL picture,
  // not just the current core. Tail segments drop when their
  // count is zero so the message stays short on the common case
  // (just connected, nothing done yet → "Scraping mame (12/680)").
  const base = `Scraping ${event.coreLabel} (${String(event.done)}/${String(event.total)})`;
  const doneCount = event.completedCoreIds.length;
  const queuedCount = event.remainingCount;
  const tail: string[] = [];
  if (doneCount > 0) tail.push(`${String(doneCount)} done`);
  if (queuedCount > 0) tail.push(`${String(queuedCount)} queued`);
  return tail.length > 0 ? `${base} · ${tail.join(' · ')}` : base;
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
