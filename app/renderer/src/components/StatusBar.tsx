import { Loader2 } from 'lucide-react';
import type { JSX } from 'react';

import {
  formatConnectingMessage,
  type ConnectPhase,
} from '@shared/connection';
import type { AutoScrapeProgressEvent } from '@shared/preload-api';
import type { ConnectionStatus } from '@shared/types';

import {
  useActiveScrapeProgress,
  useAutoScrapeProgress,
} from '@app/renderer/src/contexts/AutoScrapeContext';
import {
  useConnection,
  type AutoRetryProgress,
} from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
import { StatusIndicator } from '@app/renderer/src/components/ui/status-indicator';
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
  const {
    status,
    lostConnection,
    autoRetry,
    autoRetryFailed,
    connectingElapsedMs,
    connectingPhase,
    currentProfile,
  } = useConnection();
  const autoScrape = useAutoScrapeProgress();
  const autoScrapeProgress = useActiveScrapeProgress();

  // PR-C (PR #26): when no manual operation is in flight AND the
  // connection is steady-state connected, fall back to the
  // auto-scrape engine's progress (if any). The active-state
  // string is `<core display label> · <done>/<total>` per the
  // spec — no "ROMs" word, no percentage, no padding.
  //
  // feat/connect-progress-ui — the connecting branch now consumes
  // the phase + elapsed pair the connection context already tracks
  // (used to power the per-row inline indicator on ProfileList) so
  // the footer surfaces "Reading device state… (4s)" / "Parsing
  // arcade metadata… (9s)" instead of a static "Connecting…".
  const idleMessage = idleMessageFor(status, {
    lostConnection,
    autoRetry,
    autoRetryFailed,
    connectingElapsedMs,
    connectingPhase,
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

  // D30: overall session progress for the ring; sub-task for the bar.
  const scrapeOverallProgress: number | null =
    (autoScrape.state === 'active' || autoScrape.state === 'discovering') &&
    autoScrape.totalCoreCount > 0
      ? Math.min(1, (autoScrape.processedCoreCount + 1) / autoScrape.totalCoreCount)
      : null;
  const scrapeSubTaskProgress: number | null =
    autoScrape.state === 'active' && autoScrape.total > 0
      ? Math.min(1, autoScrape.done / autoScrape.total)
      : null;

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
        {/* D30: session-level progress ring (overall cores done / total). */}
        {scrapeOverallProgress !== null ? (
          <ScrapeProgressRing
            progress={scrapeOverallProgress}
            ariaLabel={`Auto-scrape session progress ${String(Math.round(scrapeOverallProgress * 100))}%`}
          />
        ) : null}
        {/* fix/count-and-status-indicator commit 2 — live progress
            indicator next to the "Scraping <core> (n/total)" message.
            Brightens from cold-blue to signal-green-with-halo as the
            current core's done/total approaches 1. */}
        {autoScrapeProgress !== null ? (
          <StatusIndicator
            progress={autoScrapeProgress}
            sizePx={10}
            ariaLabel="Auto-scrape progress"
          />
        ) : null}
        <span className="truncate normal-case tracking-normal text-body-sm text-fg-body">
          {message}
        </span>
        {/* D30: sub-task bar — current core's done / total. */}
        {scrapeSubTaskProgress !== null ? (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={autoScrape.state === 'active' ? autoScrape.total : 0}
            aria-valuenow={autoScrape.state === 'active' ? autoScrape.done : 0}
            aria-label="Current core scrape progress"
            className="ml-1 h-1 w-20 shrink-0 overflow-hidden rounded-full bg-elevated"
          >
            <div
              className="h-full bg-accent transition-[width] duration-150 ease-out"
              style={{ width: `${String(Math.round(scrapeSubTaskProgress * 100))}%` }}
            />
          </div>
        ) : null}
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
      <div className="flex shrink-0 items-center gap-1.5">
        {currentProfile !== null ? (
          <>
            <span className="normal-case tracking-normal text-fg">
              {currentProfile.name}
            </span>
            <span className="text-fg-disabled" aria-hidden>·</span>
            <span className="font-mono normal-case tracking-normal text-fg-muted">
              {currentProfile.username}@{currentProfile.host}:{String(currentProfile.port)}
            </span>
            <span className="text-fg-disabled" aria-hidden>·</span>
          </>
        ) : null}
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
    readonly connectingElapsedMs?: number;
    readonly connectingPhase?: ConnectPhase | null;
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
    case 'connecting': {
      // feat/connect-progress-ui — surface the connect-phase label +
      // elapsed seconds when available. `formatConnectingMessage`
      // honours the reveal-delay (<3s returns null → fall back to
      // the generic copy so the footer still says something) and
      // the "still connecting" escalation past 8s.
      const elapsed = resilience.connectingElapsedMs ?? 0;
      const phase = resilience.connectingPhase ?? null;
      return formatConnectingMessage(elapsed, phase) ?? 'Connecting…';
    }
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
  if (status !== 'connected') return null;
  // feat/connect-progress-ui — `discovering` is the per-core SSH
  // walk window (the engine called listRomPaths and is waiting on
  // the device). Surface it as a "Probing ROM directories: X/Y"
  // line so the queue walk reads as visible progress instead of a
  // burst of silent SSH ops. X = current core's queue position,
  // Y = total cores in the original queue.
  if (event.state === 'discovering') {
    // feat/pre-beta-polish-batch — denominator is the engine's
    // session-stable totalCoreCount (set once at start()). Pre-fix
    // math derived total from `doneCount + 1 + remainingCount`, which
    // drifted DOWNWARD when shifted-but-not-completed cores (abort
    // path) drained the queue without growing completedCoreIds: live
    // trace showed the user "Probing ROM directories: 24/103 →
    // 24/99 → 24/57" as the engine walked the queue. The renderer
    // now trusts the engine's stable counter.
    //
    // feat/detail-modal-nav-hide — numerator now uses the engine's
    // `processedCoreCount` (incremented per loop iteration
    // regardless of scrapeCompleted) rather than
    // `completedCoreIds.length`. Pre-fix the numerator stalled when
    // cores aborted in sequence: live trace showed "9/114 · APPLE-I",
    // "9/114 · C64", "9/114 · Lynx48" — completedCoreIds stuck at 8
    // while the engine actually advanced through three cores. The
    // engine's new counter ticks on every iteration.
    const current = event.processedCoreCount + 1;
    return `Probing ROM directories: ${String(current)}/${String(event.totalCoreCount)} · ${event.coreLabel}`;
  }
  if (event.state !== 'active') return null;
  // fix/validation-not-scraping — when done=0 the engine is still in
  // the mtime-batch validation phase (or all paths were cache hits).
  // Show "Validating" instead of "Scraping 0/N" so the user sees an
  // accurate label: no ticking counter, no false impression of
  // 649 ROMs being re-scraped.
  if (event.done === 0) {
    const base = `Validating ${event.coreLabel}…`;
    const doneCount = event.completedCoreIds.length;
    const queuedCount = event.remainingCount;
    const tail: string[] = [];
    if (doneCount > 0) tail.push(`${String(doneCount)} done`);
    if (queuedCount > 0) tail.push(`${String(queuedCount)} queued`);
    return tail.length > 0 ? `${base} · ${tail.join(' · ')}` : base;
  }
  // feat/auto-scrape-persistence: extend the footer with the
  // session completion counts so the user sees the FULL picture,
  // not just the current core. Tail segments drop when their
  // count is zero so the message stays short on the common case.
  const base = `Scraping ${event.coreLabel} (${String(event.done)}/${String(event.total)})`;
  const doneCount = event.completedCoreIds.length;
  const queuedCount = event.remainingCount;
  const tail: string[] = [];
  if (doneCount > 0) tail.push(`${String(doneCount)} done`);
  if (queuedCount > 0) tail.push(`${String(queuedCount)} queued`);
  return tail.length > 0 ? `${base} · ${tail.join(' · ')}` : base;
}

/**
 * D30: SVG ring showing overall auto-scrape session progress.
 * Uses CSS custom property tokens (no raw hex). The ring fills
 * clockwise from the top via `-rotate-90` on the SVG element.
 *
 * Ring numerator: cores processed + in-flight ÷ totalCoreCount.
 * The data is available on `active` and `discovering` events.
 */
function ScrapeProgressRing({
  progress,
  size = 14,
  ariaLabel,
}: {
  readonly progress: number;
  readonly size?: number;
  readonly ariaLabel?: string;
}): JSX.Element {
  const r = (size - 2) / 2;
  const circ = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, progress)) * circ;
  return (
    <svg
      width={size}
      height={size}
      className="-rotate-90 shrink-0"
      role="img"
      aria-label={ariaLabel ?? `progress ${String(Math.round(progress * 100))}%`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="hsl(var(--border-default))"
        strokeWidth={1.5}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="hsl(var(--accent))"
        strokeWidth={1.5}
        strokeDasharray={`${filled} ${circ - filled}`}
        strokeLinecap="round"
      />
    </svg>
  );
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
