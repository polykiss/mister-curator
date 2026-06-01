import { useCallback, useState } from 'react';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';

const STORAGE_KEY = 'mistercurator.coreCustomNames';

export type CoreCustomNamesMap = Record<string, Record<string, string>>;

export function readPersistedCustomNames(): CoreCustomNamesMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as CoreCustomNamesMap;
  } catch {
    return {};
  }
}

export function writePersistedCustomNames(value: CoreCustomNamesMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage full / disabled — nothing to do.
  }
}

export interface CoreCustomNames {
  customName: (coreId: string) => string | null;
  setCustomName: (coreId: string, name: string) => void;
  clearCustomName: (coreId: string) => void;
}

export function useCoreCustomNames(): CoreCustomNames {
  const { currentProfile } = useConnection();
  const profileId = currentProfile?.id ?? null;
  const [data, setData] = useState<CoreCustomNamesMap>(() => readPersistedCustomNames());

  const customName = useCallback(
    (coreId: string): string | null => {
      if (profileId === null) return null;
      return data[profileId]?.[coreId] ?? null;
    },
    [profileId, data],
  );

  const clearCustomName = useCallback(
    (coreId: string): void => {
      if (profileId === null) return;
      setData((prev) => {
        const profileMap = { ...(prev[profileId] ?? {}) };
        delete profileMap[coreId];
        const next: CoreCustomNamesMap = { ...prev };
        if (Object.keys(profileMap).length === 0) {
          delete next[profileId];
        } else {
          next[profileId] = profileMap;
        }
        writePersistedCustomNames(next);
        return next;
      });
    },
    [profileId],
  );

  const setCustomName = useCallback(
    (coreId: string, name: string): void => {
      if (profileId === null) return;
      const trimmed = name.trim();
      if (trimmed.length === 0) {
        clearCustomName(coreId);
        return;
      }
      setData((prev) => {
        const next: CoreCustomNamesMap = {
          ...prev,
          [profileId]: { ...(prev[profileId] ?? {}), [coreId]: trimmed },
        };
        writePersistedCustomNames(next);
        return next;
      });
    },
    [profileId, clearCustomName],
  );

  return { customName, setCustomName, clearCustomName };
}
