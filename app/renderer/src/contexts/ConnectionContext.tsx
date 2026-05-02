import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';

import type { MisterSecret } from '@shared/mister-client';
import type { ConnectionStatus, MisterProfile } from '@shared/types';

import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';

interface ConnectionContextValue {
  readonly status: ConnectionStatus;
  readonly profiles: readonly MisterProfile[];
  readonly currentProfile: MisterProfile | null;
  readonly profilesLoading: boolean;
  readonly refreshProfiles: () => Promise<void>;
  readonly connect: (profileId: string) => Promise<{ reappliedCount: number }>;
  readonly disconnect: () => Promise<void>;
  readonly saveProfile: (profile: MisterProfile, secret: MisterSecret) => Promise<void>;
  readonly deleteProfile: (profileId: string) => Promise<void>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function ConnectionProvider({ children }: { children: ReactNode }): JSX.Element {
  const { run: runWithStatus } = useOperationStatus();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [profiles, setProfiles] = useState<readonly MisterProfile[]>([]);
  const [currentProfileId, setCurrentProfileId] = useState<string | null>(null);
  const [profilesLoading, setProfilesLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = window.mister.onConnectionStatusChanged((next) => {
      setStatus(next);
      if (next === 'disconnected' || next === 'error') {
        setCurrentProfileId(null);
      }
    });

    void (async () => {
      try {
        const [initialStatus, initialProfiles] = await Promise.all([
          window.mister.getConnectionStatus(),
          window.mister.listProfiles(),
        ]);
        setStatus(initialStatus);
        setProfiles(initialProfiles);
      } finally {
        setProfilesLoading(false);
      }
    })();

    return unsubscribe;
  }, []);

  const refreshProfiles = useCallback(async () => {
    setProfiles(await window.mister.listProfiles());
  }, []);

  const connect = useCallback(
    async (profileId: string) => {
      setCurrentProfileId(profileId);
      const profile = profiles.find((p) => p.id === profileId);
      const message = profile
        ? `Connecting to ${profile.host}…`
        : 'Connecting…';
      try {
        return await runWithStatus(message, () => window.mister.connect(profileId));
      } catch (err) {
        setCurrentProfileId(null);
        throw err;
      }
    },
    [profiles, runWithStatus],
  );

  const disconnect = useCallback(async () => {
    try {
      await runWithStatus('Disconnecting…', () => window.mister.disconnect());
    } finally {
      setCurrentProfileId(null);
    }
  }, [runWithStatus]);

  const saveProfile = useCallback(
    async (profile: MisterProfile, secret: MisterSecret) => {
      await window.mister.saveProfile(profile, secret);
      await refreshProfiles();
    },
    [refreshProfiles],
  );

  const deleteProfile = useCallback(
    async (profileId: string) => {
      await window.mister.deleteProfile(profileId);
      setCurrentProfileId((prev) => (prev === profileId ? null : prev));
      await refreshProfiles();
    },
    [refreshProfiles],
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
