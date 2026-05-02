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

import type { CoreEntry, Rom } from '@shared/types';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import {
  applyBulkVisibilityChange,
  applyVisibilityChange,
  recountCore,
  type VisibilityChange,
} from '@app/renderer/src/lib/optimistic';

type RomsByCore = Readonly<Record<string, readonly Rom[]>>;
type LoadingByCore = Readonly<Record<string, boolean>>;

interface CoresContextValue {
  readonly cores: readonly CoreEntry[] | null;
  readonly coresLoading: boolean;
  readonly coresError: string | null;
  readonly selectedCoreId: string | null;
  readonly selectedCore: CoreEntry | null;
  readonly romsByCore: RomsByCore;
  readonly romsLoading: LoadingByCore;
  readonly selectCore: (coreId: string | null) => void;
  readonly refresh: () => Promise<void>;
  readonly ensureRoms: (coreId: string) => Promise<void>;
  readonly setRomVisibility: (
    coreId: string,
    filename: string,
    hidden: boolean,
  ) => Promise<void>;
  readonly setBulkRomVisibility: (
    coreId: string,
    changes: readonly VisibilityChange[],
  ) => Promise<void>;
  readonly hideCore: (coreId: string) => Promise<void>;
  readonly showCore: (coreId: string) => Promise<void>;
  readonly setBulkCoreVisibility: (
    changes: readonly { readonly coreId: string; readonly hidden: boolean }[],
  ) => Promise<void>;
}

const CoresContext = createContext<CoresContextValue | null>(null);

export function CoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useConnection();
  const [cores, setCores] = useState<readonly CoreEntry[] | null>(null);
  const [coresLoading, setCoresLoading] = useState(false);
  const [coresError, setCoresError] = useState<string | null>(null);
  const [selectedCoreId, setSelectedCoreId] = useState<string | null>(null);
  const [romsByCore, setRomsByCore] = useState<RomsByCore>({});
  const [romsLoading, setRomsLoading] = useState<LoadingByCore>({});

  // Refs for stale-closure-safe reads inside async callbacks.
  const coresRef = useRef(cores);
  const romsByCoreRef = useRef(romsByCore);
  coresRef.current = cores;
  romsByCoreRef.current = romsByCore;

  const refresh = useCallback(async () => {
    setCoresLoading(true);
    setCoresError(null);
    try {
      const next = await window.mister.listAllCoresWithFiles();
      setCores(next);
      setRomsByCore({});
      setRomsLoading({});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load cores.';
      setCoresError(message);
    } finally {
      setCoresLoading(false);
    }
  }, []);

  const ensureRoms = useCallback(async (coreId: string) => {
    if (romsByCoreRef.current[coreId]) return;
    setRomsLoading((prev) => ({ ...prev, [coreId]: true }));
    try {
      const roms = await window.mister.listRoms(coreId);
      setRomsByCore((prev) => ({ ...prev, [coreId]: roms }));
    } finally {
      setRomsLoading((prev) => ({ ...prev, [coreId]: false }));
    }
  }, []);

  const updateCoreCounts = useCallback((coreId: string, nextRoms: readonly Rom[]) => {
    setCores((prev) => {
      if (!prev) return prev;
      return prev.map((core) => (core.id === coreId ? recountCore(core, nextRoms) : core));
    });
  }, []);

  const setRomVisibility = useCallback(
    async (coreId: string, filename: string, hidden: boolean) => {
      const previousRoms = romsByCoreRef.current[coreId];
      const previousCores = coresRef.current;
      if (!previousRoms) {
        // Nothing cached yet; just send through.
        await window.mister.setRomVisibility(coreId, filename, hidden);
        return;
      }

      const optimistic = applyVisibilityChange(previousRoms, { filename, hidden });
      setRomsByCore((prev) => ({ ...prev, [coreId]: optimistic }));
      updateCoreCounts(coreId, optimistic);

      try {
        await window.mister.setRomVisibility(coreId, filename, hidden);
      } catch (err) {
        setRomsByCore((prev) => ({ ...prev, [coreId]: previousRoms }));
        if (previousCores) setCores(previousCores);
        throw err;
      }
    },
    [updateCoreCounts],
  );

  const setBulkRomVisibility = useCallback(
    async (coreId: string, changes: readonly VisibilityChange[]) => {
      const previousRoms = romsByCoreRef.current[coreId];
      const previousCores = coresRef.current;
      if (!previousRoms) {
        await window.mister.setBulkRomVisibility(coreId, [...changes]);
        return;
      }

      const optimistic = applyBulkVisibilityChange(previousRoms, changes);
      setRomsByCore((prev) => ({ ...prev, [coreId]: optimistic }));
      updateCoreCounts(coreId, optimistic);

      try {
        await window.mister.setBulkRomVisibility(coreId, [...changes]);
      } catch (err) {
        setRomsByCore((prev) => ({ ...prev, [coreId]: previousRoms }));
        if (previousCores) setCores(previousCores);
        throw err;
      }
    },
    [updateCoreCounts],
  );

  const hideCore = useCallback(async (coreId: string) => {
    await window.mister.hideCore(coreId);
    // Invalidate the cores cache so the rebuilt list reflects the new state.
    const next = await window.mister.listAllCoresWithFiles();
    setCores(next);
    // Clear cached ROMs for this core — its games dir may have moved.
    setRomsByCore((prev) => {
      if (!(coreId in prev)) return prev;
      const copy = { ...prev };
      delete copy[coreId];
      return copy;
    });
  }, []);

  const showCore = useCallback(async (coreId: string) => {
    await window.mister.showCore(coreId);
    const next = await window.mister.listAllCoresWithFiles();
    setCores(next);
    setRomsByCore((prev) => {
      if (!(coreId in prev)) return prev;
      const copy = { ...prev };
      delete copy[coreId];
      return copy;
    });
  }, []);

  const setBulkCoreVisibility = useCallback(
    async (
      changes: readonly { readonly coreId: string; readonly hidden: boolean }[],
    ) => {
      if (changes.length === 0) return;
      await window.mister.setBulkCoreVisibility(changes);
      const next = await window.mister.listAllCoresWithFiles();
      setCores(next);
      setRomsByCore({});
    },
    [],
  );

  // Reset whenever we leave the connected state.
  useEffect(() => {
    if (status !== 'connected') {
      setCores(null);
      setSelectedCoreId(null);
      setRomsByCore({});
      setRomsLoading({});
      setCoresError(null);
      setCoresLoading(false);
    }
  }, [status]);

  // Load cores on entering the connected state.
  useEffect(() => {
    if (status === 'connected' && cores === null && !coresLoading) {
      void refresh();
    }
  }, [status, cores, coresLoading, refresh]);

  const selectCore = useCallback((coreId: string | null) => {
    setSelectedCoreId(coreId);
  }, []);

  const selectedCore = useMemo(
    () => cores?.find((c) => c.id === selectedCoreId) ?? null,
    [cores, selectedCoreId],
  );

  const value = useMemo<CoresContextValue>(
    () => ({
      cores,
      coresLoading,
      coresError,
      selectedCoreId,
      selectedCore,
      romsByCore,
      romsLoading,
      selectCore,
      refresh,
      ensureRoms,
      setRomVisibility,
      setBulkRomVisibility,
      hideCore,
      showCore,
      setBulkCoreVisibility,
    }),
    [
      cores,
      coresLoading,
      coresError,
      selectedCoreId,
      selectedCore,
      romsByCore,
      romsLoading,
      selectCore,
      refresh,
      ensureRoms,
      setRomVisibility,
      setBulkRomVisibility,
      hideCore,
      showCore,
      setBulkCoreVisibility,
    ],
  );

  return <CoresContext.Provider value={value}>{children}</CoresContext.Provider>;
}

export function useCores(): CoresContextValue {
  const ctx = useContext(CoresContext);
  if (!ctx) {
    throw new Error('useCores must be used within a CoresProvider.');
  }
  return ctx;
}
