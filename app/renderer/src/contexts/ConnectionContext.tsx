import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';
import { toast } from 'sonner';

import type { ConnectPhase } from '@shared/connection';
import type { MisterSecret } from '@shared/mister-client';
import { MisterConnectionError } from '@shared/types';
import type {
  ConnectionErrorCode,
  ConnectionStatus,
  DuplicatePair,
  MisterProfile,
} from '@shared/types';

import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';

/**
 * Per-profile failure info for the inline sticky card on the
 * connection screen. Survives across re-renders and lives until the
 * user retries, edits, or dismisses.
 */
export interface ConnectionFailureInfo {
  readonly code: ConnectionErrorCode;
  readonly underlyingMessage: string;
}

/**
 * Active auto-reconnect attempt — the manager fires
 * `auto-retry-attempt` per attempt and we expose the latest count for
 * the banner copy ("Reconnecting (1 of 3)…").
 */
export interface AutoRetryProgress {
  readonly attempt: number;
  readonly totalAttempts: number;
}

interface ConnectionContextValue {
  readonly status: ConnectionStatus;
  readonly profiles: readonly MisterProfile[];
  readonly currentProfile: MisterProfile | null;
  readonly profilesLoading: boolean;
  readonly refreshProfiles: () => Promise<void>;
  readonly connect: (
    profileId: string,
  ) => Promise<{
    readonly reappliedCount: number;
    readonly firstConnectArcadeAutoHidden: number | null;
  }>;
  readonly disconnect: () => Promise<void>;
  readonly saveProfile: (profile: MisterProfile, secret: MisterSecret) => Promise<void>;
  readonly deleteProfile: (profileId: string) => Promise<void>;

  /**
   * Failures keyed by profileId. Populated when `connect()` rejects;
   * cleared by `dismissFailure()`, by a successful retry, or by an
   * edit (which the dialog calls via `dismissFailure`).
   */
  readonly failureByProfileId: ReadonlyMap<string, ConnectionFailureInfo>;
  readonly dismissFailure: (profileId: string) => void;

  /**
   * Profile currently being connected to (null if no connect is in
   * flight). Drives the per-row "Connecting…" indicator.
   */
  readonly connectingProfileId: string | null;
  /**
   * Milliseconds since the current connect attempt started. Updated
   * from the main process's connecting-elapsed events. Renderers feed
   * this into `formatConnectingMessage` to decide what to display.
   */
  readonly connectingElapsedMs: number;
  /**
   * feat/connecting-screen-status — current sub-phase inside the
   * `'connecting'` window, or `null` when no phase has been signalled
   * yet (or after the connect resolves). Threaded into
   * `formatConnectingMessage` alongside `connectingElapsedMs` so the
   * inline indicator can name the current step.
   */
  readonly connectingPhase: ConnectPhase | null;

  /**
   * feat/optimistic-connect — true while background arcade validation
   * is running after a connect. The status bar shows "Validating
   * library…" while this is set.
   */
  readonly backgroundValidating: boolean;

  /**
   * True iff the SSH transport dropped mid-session and the user has
   * not yet dismissed the resulting banner. The browser screen stays
   * mounted while this is true (read-only mode) so the user can still
   * see their cached cores / ROMs.
   */
  readonly lostConnection: boolean;
  /**
   * Latest auto-retry attempt info, if any. Null between cycles.
   */
  readonly autoRetry: AutoRetryProgress | null;
  /**
   * Set after all three auto-retry attempts have failed. The banner
   * uses this to escalate the copy from "Reconnecting…" to
   * "Connection lost. [Reconnect] [Disconnect]".
   */
  readonly autoRetryFailed: boolean;
  /**
   * Manual reconnect — same as `connect(currentProfile.id)` but
   * clears the lost-connection / auto-retry state up front so the
   * banner doesn't flicker. Errors propagate to the caller; if the
   * call rejects the failure card will pick it up via the normal
   * failure-recording path.
   */
  readonly reconnect: () => Promise<void>;
  /**
   * feat/duplicate-detect-and-restore (#40) — pairs emitted by the
   * manager on connect when both dotted and undotted forms coexist.
   * `null` means no duplicates were detected on the last connect.
   * Resets to `null` on disconnect; the banner uses this to decide
   * whether to render.
   */
  readonly detectedDuplicates: readonly DuplicatePair[] | null;
  /**
   * Dismiss the banner for this session (per-connect, not persisted).
   * Reappears on the next connect if duplicates are still present.
   */
  readonly dismissDuplicates: () => void;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

function errToFailureInfo(err: unknown): ConnectionFailureInfo {
  if (err instanceof MisterConnectionError) {
    return { code: err.code, underlyingMessage: err.message };
  }
  if (err instanceof Error) {
    return { code: 'unknown', underlyingMessage: err.message };
  }
  return { code: 'unknown', underlyingMessage: String(err) };
}

export function ConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const { run: runWithStatus } = useOperationStatus();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [profiles, setProfiles] = useState<readonly MisterProfile[]>([]);
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(true);

  const [failureByProfileId, setFailureByProfileId] = useState<
    ReadonlyMap<string, ConnectionFailureInfo>
  >(() => new Map());
  const [connectingProfileId, setConnectingProfileId] = useState<string | null>(
    null,
  );
  const [connectingElapsedMs, setConnectingElapsedMs] = useState<number>(0);
  // feat/connecting-screen-status — last `connect-phase` event from
  // the manager, scoped to the active connecting profile. Threaded
  // into `formatConnectingMessage` to name the current step.
  const [connectingPhase, setConnectingPhase] = useState<ConnectPhase | null>(
    null,
  );
  const [lostConnection, setLostConnection] = useState(false);
  const [autoRetry, setAutoRetry] = useState<AutoRetryProgress | null>(null);
  const [autoRetryFailed, setAutoRetryFailed] = useState(false);
  const [detectedDuplicates, setDetectedDuplicates] = useState<readonly DuplicatePair[] | null>(null);
  // feat/optimistic-connect
  const [backgroundValidating, setBackgroundValidating] = useState(false);

  // Refs so async callbacks can read the latest "current profile"
  // without re-binding subscriptions on every state change.
  const connectingProfileIdRef = useRef<string | null>(null);
  connectingProfileIdRef.current = connectingProfileId;

  useEffect(() => {
    const unsubscribeStatus = window.mister.onConnectionStatusChanged((next) => {
      setStatus(next);
    });

    const unsubscribeEvents = window.mister.onConnectionEvent((event) => {
      switch (event.type) {
        case 'connecting-elapsed':
          // Only update if this event matches the profile we're
          // showing the indicator for. Stale events from a cancelled
          // connect (e.g. the user clicked another profile mid-flight)
          // would otherwise repaint the wrong row.
          if (event.profileId === connectingProfileIdRef.current) {
            setConnectingElapsedMs(event.elapsedMs);
          }
          break;

        case 'connect-phase':
          // feat/connecting-screen-status — same stale-event guard
          // as the elapsed ticker. Phase events from a cancelled
          // connect must not repaint a different row's label.
          if (event.profileId === connectingProfileIdRef.current) {
            setConnectingPhase(event.phase);
          }
          break;

        case 'disconnected-unexpected':
          setLostConnection(true);
          setAutoRetryFailed(false);
          setAutoRetry(null);
          break;

        case 'auto-retry-attempt':
          setAutoRetry({
            attempt: event.attempt,
            totalAttempts: event.totalAttempts,
          });
          break;

        case 'auto-retry-failed':
          setAutoRetry(null);
          setAutoRetryFailed(true);
          break;

        case 'reconnected':
          setLostConnection(false);
          setAutoRetry(null);
          setAutoRetryFailed(false);
          toast.success('Reconnected.');
          break;

        case 'duplicates-detected':
          setDetectedDuplicates(event.duplicates);
          break;

        case 'background-validating':
          setBackgroundValidating(event.isValidating);
          break;

        case 'arcade-auto-hide-applied': {
          const n = event.count;
          const noun = n === 1 ? 'arcade game' : 'arcade games';
          toast.info(`Auto-hid ${String(n)} ${noun} with missing ROMs.`, {
            description: 'Toggle "Auto-hide missing ROMs" off in Settings to restore them.',
          });
          break;
        }

        case 'arcade-refreshed':
          // No UI action needed — CoresContext reloads arcade data via
          // the existing onStatusChange / romCacheVersion mechanism when
          // the arcade pane is next focused. The event is consumed here
          // to prevent the switch from falling to the default.
          break;
      }
    });

    void (async () => {
      try {
        const [initialStatus, initialProfiles, initialBgValidating] = await Promise.all([
          window.mister.getConnectionStatus(),
          window.mister.listProfiles(),
          window.mister.getBackgroundValidating(),
        ]);
        setStatus(initialStatus);
        setProfiles(initialProfiles);
        setBackgroundValidating(initialBgValidating);
      } finally {
        setProfilesLoading(false);
      }
    })();

    return () => {
      unsubscribeStatus();
      unsubscribeEvents();
    };
  }, []);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await window.mister.listProfiles());
  }, []);

  const dismissFailure = useCallback((profileId: string) => {
    setFailureByProfileId((prev) => {
      if (!prev.has(profileId)) return prev;
      const next = new Map(prev);
      next.delete(profileId);
      return next;
    });
  }, []);

  const connect = useCallback(
    async (profileId: string) => {
      setCurrentProfileId(profileId);
      setConnectingProfileId(profileId);
      setConnectingElapsedMs(0);
      setConnectingPhase(null);
      // Clear stale state for this profile — fresh connect resets
      // the failure card and any lost-connection banner that might be
      // hanging on from a previous session.
      setFailureByProfileId((prev) => {
        if (!prev.has(profileId)) return prev;
        const next = new Map(prev);
        next.delete(profileId);
        return next;
      });
      setLostConnection(false);
      setAutoRetry(null);
      setAutoRetryFailed(false);
      setDetectedDuplicates(null);

      const profile = profiles.find((p) => p.id === profileId);
      const message = profile
        ? `Connecting to ${profile.host}…`
        : 'Connecting…';
      try {
        const result = await runWithStatus(message, () =>
          window.mister.connect(profileId),
        );
        setConnectingProfileId(null);
        setConnectingElapsedMs(0);
        setConnectingPhase(null);
        return result;
      } catch (err) {
        setCurrentProfileId(null);
        setConnectingProfileId(null);
        setConnectingElapsedMs(0);
        setConnectingPhase(null);
        const info = errToFailureInfo(err);
        setFailureByProfileId((prev) => {
          const next = new Map(prev);
          next.set(profileId, info);
          return next;
        });
        throw err;
      }
    },
    [profiles, runWithStatus],
  );

  const dismissDuplicates = useCallback(() => {
    setDetectedDuplicates(null);
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await runWithStatus('Disconnecting…', () => window.mister.disconnect());
    } finally {
      setCurrentProfileId(null);
      setLostConnection(false);
      setAutoRetry(null);
      setAutoRetryFailed(false);
      setDetectedDuplicates(null);
    }
  }, [runWithStatus]);

  const reconnect = useCallback(async () => {
    if (currentProfileId === null) return;
    await connect(currentProfileId);
  }, [connect, currentProfileId]);

  const saveProfile = useCallback(
    async (profile: MisterProfile, secret: MisterSecret) => {
      await window.mister.saveProfile(profile, secret);
      await refreshProfiles();
      // Editing a profile clears any stale failure card for it — the
      // next Connect attempt is a fresh start.
      dismissFailure(profile.id);
    },
    [refreshProfiles, dismissFailure],
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      await window.mister.deleteProfile(profileId);
      setCurrentProfileId((prev) => (prev === profileId ? null : prev));
      dismissFailure(profileId);
      await refreshProfiles();
    },
    [refreshProfiles, dismissFailure],
  );

  const currentProfile = useMemo(
    () => profiles.find((p) => p.id === currentProfileId) ?? null,
    [profiles, currentProfileId],
  );

  const value = useMemo<ConnectionContextValue>(
    () => ({
      status,
      profiles,
      currentProfile,
      profilesLoading,
      refreshProfiles,
      connect,
      disconnect,
      saveProfile,
      deleteProfile,
      failureByProfileId,
      dismissFailure,
      connectingProfileId,
      connectingElapsedMs,
      connectingPhase,
      backgroundValidating,
      lostConnection,
      autoRetry,
      autoRetryFailed,
      reconnect,
      detectedDuplicates,
      dismissDuplicates,
    }),
    [
      status,
      profiles,
      currentProfile,
      profilesLoading,
      refreshProfiles,
      connect,
      disconnect,
      saveProfile,
      deleteProfile,
      failureByProfileId,
      dismissFailure,
      connectingProfileId,
      connectingElapsedMs,
      connectingPhase,
      backgroundValidating,
      lostConnection,
      autoRetry,
      autoRetryFailed,
      reconnect,
      detectedDuplicates,
      dismissDuplicates,
    ],
  );

  return <ConnectionContext.Provider value={value}>{children}</ConnectionContext.Provider>;
}

export function useConnection(): ConnectionContextValue {
  const ctx = useContext(ConnectionContext);
  if (!ctx) {
    throw new Error('useConnection must be used within a ConnectionProvider.');
  }
  return ctx;
}
