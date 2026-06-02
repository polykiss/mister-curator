/**
 * Connection-state UX helpers — pure, testable. The renderer and main
 * process both consume these:
 *
 *   - Reveal-delay timing for the "Connecting…" indicator (no flicker
 *     on fast connects; soft escalation if the box is slow).
 *   - Backoff schedule for mid-session auto-reconnect attempts.
 *   - Error-message formatting keyed off `ConnectionError.code` so
 *     every UI surface speaks the same words (status bar, inline
 *     failure card, disconnect banner).
 */

import type { ConnectionErrorCode, DuplicatePair, MisterProfile } from '@shared/types';

/**
 * Don't show any "Connecting…" feedback for the first 3 seconds — most
 * connects complete inside that window and the spinner would flicker.
 * After this many milliseconds, the per-profile indicator appears.
 */
export const CONNECTING_REVEAL_MS = 3_000;

/**
 * After 8 seconds, soften the message ("Still connecting… your MiSTer
 * may be slow to respond."). The user knows something is up but
 * shouldn't think the app is broken.
 */
export const STILL_CONNECTING_MS = 8_000;

/**
 * Mid-session reconnect backoff. Three attempts, then surface the
 * disconnect banner. Tuned for real MiSTer reboots (1 min cold), the
 * common case being a brief network blip we can paper over with the
 * first attempt.
 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 3_000, 8_000];

/**
 * feat/connecting-screen-status — discrete phases the
 * ConnectionManager passes through during the initial connect.
 * Surfaces as a fine-grained label in the inline "Connecting…" UI
 * so a slow first-time connect (60-second cold cores+arcade walk
 * on a real device) tells the user which step is taking time.
 *
 * Distinct from `ConnectionStatus` (the four-state machine the
 * status bar tracks) — these are sub-phases inside the
 * `'connecting'` window. The phase is OPTIONAL on the rendering
 * side: a fast connect that never lingers in any one phase long
 * enough to exceed `CONNECTING_REVEAL_MS` shows nothing, exactly
 * as before.
 *
 *   - transport     → SSH socket + auth handshake
 *   - priming       → reading ledger / marks / classifications
 *   - cores-walk    → cold cores walk (cache miss only; warm reconnect skips)
 *   - arcade-parse  → mra parse + playability scan
 *   - auto-hide     → applying the missing-ROM hide rule (conditional)
 */
export type ConnectPhase =
  | 'transport'
  | 'priming'
  | 'cores-walk'
  | 'arcade-parse'
  | 'auto-hide';

const CONNECT_PHASE_LABELS: Readonly<Record<ConnectPhase, string>> = {
  transport: 'Opening SSH connection',
  priming: 'Reading device state',
  'cores-walk': 'Walking cores',
  'arcade-parse': 'Parsing arcade metadata',
  'auto-hide': 'Applying hidden cores',
};

/**
 * Returns the user-facing connecting-progress string for
 * `elapsedMs`, optionally scoped to a `phase`. `null` means
 * "render nothing" (we're inside the reveal delay).
 *
 * Precedence:
 *   1. Pre-reveal (< `CONNECTING_REVEAL_MS`) — null.
 *   2. Past `STILL_CONNECTING_MS` — escalation message wins; the
 *      phase label is suppressed so the user sees the "your
 *      MiSTer may be slow" framing even if the manager is still
 *      churning through a known-slow phase.
 *   3. Otherwise — `"<Phase Label>… (Ns)"` when phase is set,
 *      else the generic `"Connecting… (Ns)"`.
 */
export function formatConnectingMessage(
  elapsedMs: number,
  phase: ConnectPhase | null = null,
): string | null {
  if (elapsedMs < CONNECTING_REVEAL_MS) return null;
  if (elapsedMs >= STILL_CONNECTING_MS) {
    return 'Still connecting… your MiSTer may be slow to respond.';
  }
  const seconds = Math.floor(elapsedMs / 1000);
  const prefix = phase !== null ? CONNECT_PHASE_LABELS[phase] : 'Connecting';
  return `${prefix}… (${String(seconds)}s)`;
}

export interface ConnectionErrorContext {
  readonly profile: MisterProfile;
  /**
   * Original error message from the underlying SSH layer. Surfaced for
   * the `'unknown'` code only — for the named codes we have purpose-
   * built copy and don't expose internals.
   */
  readonly underlyingMessage?: string;
}

/**
 * Maps `(code, profile)` to a user-facing error string. Each branch
 * names the profile so a list of failures is unambiguous when the
 * user has more than one MiSTer registered.
 */
export function formatConnectionErrorMessage(
  code: ConnectionErrorCode,
  ctx: ConnectionErrorContext,
): string {
  const { profile, underlyingMessage } = ctx;
  switch (code) {
    case 'unreachable':
      return `Couldn't reach ${profile.name} at ${profile.host}. Is it powered on and on the same network?`;
    case 'auth_failed':
      return `Login failed. Check the username and password for ${profile.name}.`;
    case 'not_a_mister':
      return `Connected to ${profile.host}, but it doesn't look like a MiSTer (no /media/fat/games directory). Confirm the IP is correct.`;
    case 'unknown':
      return underlyingMessage !== undefined && underlyingMessage !== ''
        ? `Couldn't connect to ${profile.name}. ${underlyingMessage}`
        : `Couldn't connect to ${profile.name}.`;
  }
}

/**
 * Connection lifecycle events broadcast over the IPC bridge. Distinct
 * from the existing `ConnectionStatus` push so the renderer can act on
 * sub-states (mid-session disconnect, auto-retry progress) without us
 * overloading the four-state machine.
 */
export type ConnectionEvent =
  | {
      readonly type: 'connecting-elapsed';
      readonly profileId: string;
      readonly elapsedMs: number;
    }
  | {
      // feat/connecting-screen-status — fired by the manager at
      // each phase boundary inside `connect()` so the renderer's
      // inline "Connecting…" label can name the current step. The
      // event stream rides on the same `connectionEvent` IPC as
      // the elapsed ticker; the renderer threads both into
      // `formatConnectingMessage`.
      readonly type: 'connect-phase';
      readonly profileId: string;
      readonly phase: ConnectPhase;
    }
  | {
      readonly type: 'auto-retry-attempt';
      readonly profileId: string;
      /** 1-based attempt number (1, 2, 3 for the default schedule). */
      readonly attempt: number;
      readonly totalAttempts: number;
    }
  | {
      readonly type: 'auto-retry-failed';
      readonly profileId: string;
      readonly underlyingMessage: string;
    }
  | {
      readonly type: 'reconnected';
      readonly profileId: string;
    }
  | {
      readonly type: 'disconnected-unexpected';
      readonly profileId: string;
    }
  | {
      readonly type: 'duplicates-detected';
      readonly profileId: string;
      readonly duplicates: readonly DuplicatePair[];
    }
  | {
      /**
       * feat/launch — fired after the background Remote-availability
       * probe resolves. Parallel to 'background-validating': never
       * blocks connect, result cached per-host in RemoteService.
       */
      readonly type: 'remote-status';
      readonly available: boolean;
      readonly version: string | null;
    };

/**
 * Returns the "next attempt" delay for `attempt` (0-based — i.e. 0
 * means the first attempt's pre-delay). Out-of-range attempts return
 * `undefined`, signalling "stop retrying".
 */
export function backoffDelayMs(attempt: number): number | undefined {
  if (attempt < 0) return undefined;
  return RECONNECT_BACKOFF_MS[attempt];
}
