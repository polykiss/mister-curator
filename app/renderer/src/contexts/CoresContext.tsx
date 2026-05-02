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

import type { BulkCoreResult, BulkRomResult } from '@shared/mister-client';
import { EMPTY_SYSTEM_FILES_MARKS, isMarked } from '@shared/system-files-marks';
import type { CoreEntry, Rom, SystemFilesMarks } from '@shared/types';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
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
  ) => Promise<BulkRomResult>;
  readonly hideCore: (coreId: string) => Promise<void>;
  readonly showCore: (coreId: string) => Promise<void>;
  readonly setBulkCoreVisibility: (
    changes: readonly { readonly coreId: string; readonly hidden: boolean }[],
  ) => Promise<BulkCoreResult>;
  /** User-marked system-files list for the current connection. */
  readonly systemFilesMarks: SystemFilesMarks;
  /**
   * True iff the user has explicitly marked `(coreId, filename)` as a
   * system file. Distinct from the auto-detector — RomsPane uses this
   * to gate the right-click "Unmark" action (auto-detected files
   * cannot be unmarked).
   */
  readonly isUserMarked: (coreId: string, filename: string) => boolean;
  /**
   * Adds a user mark and refetches the affected slice (ROM list and
   * cores list — the latter so per-core counts pick up the change).
   * Optimistic: the marks cache flips immediately; on IPC failure the
   * cache rolls back and the error propagates.
   */
  readonly addSystemFileMark: (coreId: string, filename: string) => Promise<void>;
  readonly removeSystemFileMark: (coreId: string, filename: string) => Promise<void>;
}

const CoresContext = createContext<CoresContextValue | null>(null);

export function CoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useConnection();
  const { run: runWithStatus } = useOperationStatus();
  const [cores, setCores] = useState<readonly CoreEntry[] | null>(null);
  const [coresLoading, setCoresLoading] = useState(false);
  const [coresError, setCoresError] = useState<string | null>(null);
  const [selectedCoreId, setSelectedCoreId] = useState<string | null>(null);
  const [romsByCore, setRomsByCore] = useState<RomsByCore>({});
  const [romsLoading, setRomsLoading] = useState<LoadingByCore>({});
  const [systemFilesMarks, setSystemFilesMarks] = useState<SystemFilesMarks>(
    EMPTY_SYSTEM_FILES_MARKS,
  );

  // Refs for stale-closure-safe reads inside async callbacks.
  const coresRef = useRef(cores);
  const romsByCoreRef = useRef(romsByCore);
  const selectedCoreIdRef = useRef(selectedCoreId);
  coresRef.current = cores;
  romsByCoreRef.current = romsByCore;
  selectedCoreIdRef.current = selectedCoreId;

  /**
   * After a bulk op invalidates the rom cache, the RomsPane's `useEffect`
   * doesn't re-fire (its dep array is stable), so the right pane goes
   * blank until the user clicks away and back. Force a re-fetch for the
   * currently-selected core so the user sees the post-op state.
   */
  const refetchSelectedRoms = useCallback(async (): Promise<void> => {
    const sel = selectedCoreIdRef.current;
    if (!sel) return;
    setRomsLoading((prev) => ({ ...prev, [sel]: true }));
    try {
      const fresh = await runWithStatus(`Loading ROMs in ${sel}…`, () =>
        window.mister.listRoms(sel),
      );
      setRomsByCore((prev) => ({ ...prev, [sel]: fresh }));
    } catch {
      // Best-effort — leave the cache empty and let the next render
      // trigger ensureRoms via the normal effect path.
    } finally {
      setRomsLoading((prev) => ({ ...prev, [sel]: false }));
    }
  }, [runWithStatus]);

  const refresh = useCallback(async () => {
    setCoresLoading(true);
    setCoresError(null);
    try {
      // Marks first — counts in the cores list depend on them.
      const marks = await window.mister.listSystemFileMarks();
      setSystemFilesMarks(marks);
      const next = await runWithStatus('Scanning cores…', () =>
        window.mister.listAllCoresWithFiles(),
      );
      setCores(next);
      setRomsByCore({});
      setRomsLoading({});
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load cores.';
      setCoresError(message);
    } finally {
      setCoresLoading(false);
    }
  }, [runWithStatus]);

  const ensureRoms = useCallback(
    async (coreId: string) => {
      if (romsByCoreRef.current[coreId]) return;
      setRomsLoading((prev) => ({ ...prev, [coreId]: true }));
      try {
        const roms = await runWithStatus(`Loading ROMs in ${coreId}…`, () =>
          window.mister.listRoms(coreId),
        );
        setRomsByCore((prev) => ({ ...prev, [coreId]: roms }));
      } finally {
        setRomsLoading((prev) => ({ ...prev, [coreId]: false }));
      }
    },
    [runWithStatus],
  );

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
    async (
      coreId: string,
      changes: readonly VisibilityChange[],
    ): Promise<BulkRomResult> => {
      const previousRoms = romsByCoreRef.current[coreId];
      const previousCores = coresRef.current;

      // Optimistic apply when we have the rom list cached. On any error
      // (network, throw), roll the cache back. On a partial success we
      // re-fetch from the server to reconcile.
      if (previousRoms) {
        const optimistic = applyBulkVisibilityChange(previousRoms, changes);
        setRomsByCore((prev) => ({ ...prev, [coreId]: optimistic }));
        updateCoreCounts(coreId, optimistic);
      }

      let result: BulkRomResult;
      const hidingCount = changes.filter((c) => c.hidden).length;
      const verb = hidingCount > 0 ? 'Hiding' : 'Restoring';
      const statusMessage = `${verb} ${String(changes.length)} ROMs in ${coreId}…`;
      try {
        result = await runWithStatus(statusMessage, () =>
          window.mister.setBulkRomVisibility(coreId, [...changes]),
        );
      } catch (err) {
        if (previousRoms) {
          setRomsByCore((prev) => ({ ...prev, [coreId]: previousRoms }));
          if (previousCores) setCores(previousCores);
        }
        throw err;
      }

      if (result.failed.length > 0 && previousRoms) {
        // Partial failure — refetch from the server so the UI reflects
        // truth, not the optimistic application.
        try {
          const fresh = await window.mister.listRoms(coreId);
          setRomsByCore((prev) => ({ ...prev, [coreId]: fresh }));
          updateCoreCounts(coreId, fresh);
        } catch {
          // Best-effort reconciliation; leave optimistic state if refetch fails.
        }
      }

      return result;
    },
    [updateCoreCounts, runWithStatus],
  );

  const hideCore = useCallback(
    async (coreId: string) => {
      await runWithStatus(`Hiding ${coreId}…`, () =>
        window.mister.hideCore(coreId),
      );
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
      // If the user is currently looking at this core, refetch so the
      // right pane doesn't go blank.
      if (selectedCoreIdRef.current === coreId) {
        await refetchSelectedRoms();
      }
    },
    [refetchSelectedRoms, runWithStatus],
  );

  const showCore = useCallback(
    async (coreId: string) => {
      await runWithStatus(`Restoring ${coreId}…`, () =>
        window.mister.showCore(coreId),
      );
      const next = await window.mister.listAllCoresWithFiles();
      setCores(next);
      setRomsByCore((prev) => {
        if (!(coreId in prev)) return prev;
        const copy = { ...prev };
        delete copy[coreId];
        return copy;
      });
      if (selectedCoreIdRef.current === coreId) {
        await refetchSelectedRoms();
      }
    },
    [refetchSelectedRoms, runWithStatus],
  );

  const setBulkCoreVisibility = useCallback(
    async (
      changes: readonly { readonly coreId: string; readonly hidden: boolean }[],
    ): Promise<BulkCoreResult> => {
      if (changes.length === 0) return { succeeded: [], failed: [] };
      const hidingCount = changes.filter((c) => c.hidden).length;
      const verb = hidingCount > 0 ? 'Hiding' : 'Restoring';
      const message = `${verb} ${String(changes.length)} cores…`;
      const result = await runWithStatus(message, () =>
        window.mister.setBulkCoreVisibility(changes),
      );
      // Always refetch after a bulk core op — partial failures mean the
      // optimistic mental model isn't reliable.
      const next = await window.mister.listAllCoresWithFiles();
      setCores(next);
      setRomsByCore({});
      // The bulk op may have renamed the games dir for the currently-
      // selected core (or one of its case-duplicate siblings). Refetch
      // its ROMs so the right pane doesn't go blank.
      await refetchSelectedRoms();
      return result;
    },
    [refetchSelectedRoms, runWithStatus],
  );

  const isUserMarked = useCallback(
    (coreId: string, filename: string): boolean =>
      isMarked(systemFilesMarks, coreId, filename),
    [systemFilesMarks],
  );

  const addSystemFileMark = useCallback(
    async (coreId: string, filename: string): Promise<void> => {
      const previous = systemFilesMarks;
      // Optimistic: assume the call succeeds and reflect it immediately.
      // The marks cache only sees the truth-from-server on the next call,
      // so we synthesise a placeholder entry until then.
      if (!isMarked(previous, coreId, filename)) {
        setSystemFilesMarks({
          ...previous,
          marked: [
            ...previous.marked,
            { coreId, filename, markedAt: new Date().toISOString() },
          ],
        });
      }
      try {
        const refreshed = await window.mister.addSystemFileMark(coreId, filename);
        setSystemFilesMarks(refreshed);
      } catch (err) {
        setSystemFilesMarks(previous);
        throw err;
      }
      // Re-fetch the affected ROMs (filter changed) and cores list (counts).
      try {
        const [freshRoms, freshCores] = await Promise.all([
          window.mister.listRoms(coreId),
          window.mister.listAllCoresWithFiles(),
        ]);
        setRomsByCore((prev) => ({ ...prev, [coreId]: freshRoms }));
        setCores(freshCores);
      } catch {
        // Best-effort reconciliation — the next normal refresh fixes it.
      }
    },
    [systemFilesMarks],
  );

  const removeSystemFileMark = useCallback(
    async (coreId: string, filename: string): Promise<void> => {
      const previous = systemFilesMarks;
      const next: SystemFilesMarks = {
        ...previous,
        marked: previous.marked.filter(
          (m) =>
            !(m.coreId.toLowerCase() === coreId.toLowerCase() &&
              m.filename === filename),
        ),
      };
      setSystemFilesMarks(next);
      try {
        const refreshed = await window.mister.removeSystemFileMark(coreId, filename);
        setSystemFilesMarks(refreshed);
      } catch (err) {
        setSystemFilesMarks(previous);
        throw err;
      }
      try {
        const [freshRoms, freshCores] = await Promise.all([
          window.mister.listRoms(coreId),
          window.mister.listAllCoresWithFiles(),
        ]);
        setRomsByCore((prev) => ({ ...prev, [coreId]: freshRoms }));
        setCores(freshCores);
      } catch {
        // Best-effort reconciliation — the next normal refresh fixes it.
      }
    },
    [systemFilesMarks],
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
      setSystemFilesMarks(EMPTY_SYSTEM_FILES_MARKS);
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
      systemFilesMarks,
      isUserMarked,
      addSystemFileMark,
      removeSystemFileMark,
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
      systemFilesMarks,
      isUserMarked,
      addSystemFileMark,
      removeSystemFileMark,
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
