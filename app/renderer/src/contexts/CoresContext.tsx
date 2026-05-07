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

import type {
  BulkCoreResult,
  BulkRomResult,
  SystemFileMarkChange,
} from '@shared/mister-client';
import { EMPTY_SYSTEM_FILES_MARKS, isMarked } from '@shared/system-files-marks';
import type {
  CoreEntry,
  Rom,
  SystemFilesMarks,
} from '@shared/types';

import { useConnection } from '@app/renderer/src/contexts/ConnectionContext';
import { useOperationStatus } from '@app/renderer/src/contexts/OperationStatusContext';
import { shouldFetchCoresOnEffect } from '@app/renderer/src/lib/cores-fetch-gate';
import {
  applyBulkVisibilityChange,
  applyVisibilityChange,
  recountCore,
  type VisibilityChange,
} from '@app/renderer/src/lib/optimistic';

type RomsByCore = Readonly<Record<string, readonly Rom[]>>;
type LoadingByCore = Readonly<Record<string, boolean>>;

/**
 * Composite key for the ROM cache. Top-level entries are keyed by
 * `coreId`; drilled-into container folders by `coreId::subPath`.
 * Keeping it a single map (rather than a nested record) means every
 * existing optimistic-update / refetch helper still works with one
 * lookup.
 */
export function romsKey(coreId: string, subPath = ''): string {
  return subPath === '' ? coreId : `${coreId}::${subPath}`;
}

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
  readonly ensureRoms: (coreId: string, subPath?: string) => Promise<void>;
  readonly refetchRoms: (coreId: string, subPath?: string) => Promise<void>;
  readonly setRomVisibility: (
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath?: string,
  ) => Promise<void>;
  readonly setBulkRomVisibility: (
    coreId: string,
    changes: readonly VisibilityChange[],
    subPath?: string,
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
  /**
   * Apply a batch of mark/unmark changes for one core in a single SSH
   * round-trip. Used by the multi-select toolbar actions.
   */
  readonly setSystemFileMarks: (
    coreId: string,
    changes: readonly SystemFileMarkChange[],
  ) => Promise<void>;
  /**
   * Override (or remove an override of) a folder ROM's classification.
   * `'container'` makes it drillable, `'atomic'` makes it a leaf,
   * `null` clears any user override and lets the auto-detector decide.
   * After the call the affected ROM list is refetched so the UI picks
   * up the new `kind`.
   */
  readonly setFolderClassification: (
    coreId: string,
    folderPath: string,
    classification: 'container' | 'atomic' | null,
    refreshAt?: { coreId: string; subPath: string },
  ) => Promise<void>;
}

const CoresContext = createContext<CoresContextValue | null>(null);

export function CoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status } = useConnection();
  const { run: runWithStatus, runWithProgress } = useOperationStatus();
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
  // In-flight ROM fetches keyed by (coreId::subPath). Lets concurrent
  // `ensureRoms` calls for the same key share a single promise instead
  // of firing duplicate IPC round-trips. Two reasons we see duplicates:
  //   1. React 18 StrictMode double-invokes mount effects in dev.
  //   2. RomsPane's effect re-fires every time `core.id` or `subPath`
  //      flips, and a refresh-then-still-on-page sequence wipes the
  //      cache out from under the resolved promise.
  // Without dedup, both fires hit IPC; the second can race a state
  // change and surface as "Unknown core: <coreId>" in the main log.
  const pendingRomsRef = useRef<Map<string, Promise<readonly Rom[]>>>(
    new Map(),
  );
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
    const key = romsKey(sel);
    setRomsLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const fresh = await runWithStatus(`Loading ROMs in ${sel}…`, () =>
        window.mister.listRoms(sel),
      );
      setRomsByCore((prev) => ({ ...prev, [key]: fresh }));
    } catch {
      // Best-effort — leave the cache empty and let the next render
      // trigger ensureRoms via the normal effect path.
    } finally {
      setRomsLoading((prev) => ({ ...prev, [key]: false }));
    }
  }, [runWithStatus]);

  /**
   * Public refetch — used by the RomsPane drill UI when the user
   * navigates into a sub-path. Distinct from `refetchSelectedRoms`
   * because this one targets a specific (coreId, subPath) and doesn't
   * read from the selected-core ref.
   */
  const refetchRoms = useCallback(
    async (coreId: string, subPath = ''): Promise<void> => {
      const key = romsKey(coreId, subPath);
      setRomsLoading((prev) => ({ ...prev, [key]: true }));
      try {
        const label = subPath === '' ? coreId : `${coreId}/${subPath}`;
        const fresh = await runWithStatus(`Loading ROMs in ${label}…`, () =>
          window.mister.listRoms(coreId, subPath),
        );
        setRomsByCore((prev) => ({ ...prev, [key]: fresh }));
      } finally {
        setRomsLoading((prev) => ({ ...prev, [key]: false }));
      }
    },
    [runWithStatus],
  );

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
    async (coreId: string, subPath = '') => {
      const key = romsKey(coreId, subPath);
      // Already cached? Nothing to do.
      if (romsByCoreRef.current[key]) return;
      // Already in flight from a prior call? Wait on the same promise
      // instead of firing a second IPC round-trip. Errors from the
      // shared promise are swallowed here — the original initiator
      // already logged the failure.
      const inflight = pendingRomsRef.current.get(key);
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* original caller handled / logged */
        }
        return;
      }

      setRomsLoading((prev) => ({ ...prev, [key]: true }));
      const label = subPath === '' ? coreId : `${coreId}/${subPath}`;
      const fetchPromise = runWithStatus(`Loading ROMs in ${label}…`, () =>
        window.mister.listRoms(coreId, subPath),
      );
      pendingRomsRef.current.set(key, fetchPromise);
      try {
        const roms = await fetchPromise;
        setRomsByCore((prev) => ({ ...prev, [key]: roms }));
      } catch (err) {
        // The IPC layer already logs main-side; on the renderer we
        // surface a one-line warning so the user can spot it without
        // turning a transient failure into an unhandled rejection.
        console.warn(
          `Failed to load ROMs for ${label}:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        pendingRomsRef.current.delete(key);
        setRomsLoading((prev) => ({ ...prev, [key]: false }));
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
    async (
      coreId: string,
      filename: string,
      hidden: boolean,
      subPath = '',
    ) => {
      const key = romsKey(coreId, subPath);
      const previousRoms = romsByCoreRef.current[key];
      const previousCores = coresRef.current;
      if (!previousRoms) {
        await window.mister.setRomVisibility(coreId, filename, hidden, subPath);
        return;
      }

      const optimistic = applyVisibilityChange(previousRoms, { filename, hidden });
      setRomsByCore((prev) => ({ ...prev, [key]: optimistic }));
      // The cores-list romCount/hiddenCount only reflects top-level
      // entries — nested hides don't change the parent count.
      if (subPath === '') updateCoreCounts(coreId, optimistic);

      try {
        await window.mister.setRomVisibility(coreId, filename, hidden, subPath);
      } catch (err) {
        setRomsByCore((prev) => ({ ...prev, [key]: previousRoms }));
        if (previousCores && subPath === '') setCores(previousCores);
        throw err;
      }
    },
    [updateCoreCounts],
  );

  const setBulkRomVisibility = useCallback(
    async (
      coreId: string,
      changes: readonly VisibilityChange[],
      subPath = '',
    ): Promise<BulkRomResult> => {
      const key = romsKey(coreId, subPath);
      const previousRoms = romsByCoreRef.current[key];
      const previousCores = coresRef.current;

      if (previousRoms) {
        const optimistic = applyBulkVisibilityChange(previousRoms, changes);
        setRomsByCore((prev) => ({ ...prev, [key]: optimistic }));
        if (subPath === '') updateCoreCounts(coreId, optimistic);
      }

      let result: BulkRomResult;
      const hidingCount = changes.filter((c) => c.hidden).length;
      const verb = hidingCount > 0 ? 'Hiding' : 'Restoring';
      const label = subPath === '' ? coreId : `${coreId}/${subPath}`;
      const statusMessage = `${verb} ${String(changes.length)} ROMs in ${label}…`;
      try {
        result = await runWithStatus(statusMessage, () =>
          window.mister.setBulkRomVisibility(coreId, [...changes], subPath),
        );
      } catch (err) {
        if (previousRoms) {
          setRomsByCore((prev) => ({ ...prev, [key]: previousRoms }));
          if (previousCores && subPath === '') setCores(previousCores);
        }
        throw err;
      }

      if (result.failed.length > 0 && previousRoms) {
        try {
          const fresh = await window.mister.listRoms(coreId, subPath);
          setRomsByCore((prev) => ({ ...prev, [key]: fresh }));
          if (subPath === '') updateCoreCounts(coreId, fresh);
        } catch {
          /* best-effort */
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
      const verb = hidingCount > 0 ? 'Hiding' : 'Unhiding';
      const message = `${verb} ${String(changes.length)} cores…`;
      // Generate the operationId here so the progress wire can match it
      // on the events forwarded by the main process. The main process
      // also generates one if we don't supply, but we need the renderer-
      // side progress entry to know about it BEFORE the first event.
      const operationId = `bulk-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      const result = await runWithProgress(message, operationId, () =>
        window.mister.setBulkCoreVisibility(changes, { operationId }),
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
    [refetchSelectedRoms, runWithProgress],
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

  const setFolderClassification = useCallback(
    async (
      coreId: string,
      folderPath: string,
      classification: 'container' | 'atomic' | null,
      refreshAt?: { coreId: string; subPath: string },
    ): Promise<void> => {
      try {
        await window.mister.setFolderClassification(
          coreId,
          folderPath,
          classification,
        );
      } catch (err) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      // Refetch the affected ROM list so the user sees the new kind.
      // Default: refresh top-level of `coreId` (which contains the
      // folder whose classification just changed).
      const target = refreshAt ?? { coreId, subPath: '' };
      try {
        const fresh = await window.mister.listRoms(target.coreId, target.subPath);
        const key = romsKey(target.coreId, target.subPath);
        setRomsByCore((prev) => ({ ...prev, [key]: fresh }));
      } catch {
        /* best-effort */
      }
    },
    [],
  );

  const setSystemFileMarks = useCallback(
    async (
      coreId: string,
      changes: readonly SystemFileMarkChange[],
    ): Promise<void> => {
      if (changes.length === 0) return;
      const previous = systemFilesMarks;
      // Optimistic: synthesise the post-batch marks list. The truth-
      // from-server replaces it after the IPC call completes.
      const markedAt = new Date().toISOString();
      let optimistic = previous;
      for (const c of changes) {
        if (c.marked) {
          if (!isMarked(optimistic, coreId, c.filename)) {
            optimistic = {
              ...optimistic,
              marked: [...optimistic.marked, { coreId, filename: c.filename, markedAt }],
            };
          }
        } else {
          const lower = coreId.toLowerCase();
          optimistic = {
            ...optimistic,
            marked: optimistic.marked.filter(
              (m) =>
                !(m.coreId.toLowerCase() === lower && m.filename === c.filename),
            ),
          };
        }
      }
      setSystemFilesMarks(optimistic);
      try {
        const refreshed = await runWithStatus(
          `${changes[0]?.marked ? 'Marking' : 'Unmarking'} ${String(changes.length)} files…`,
          () => window.mister.setSystemFileMarks(coreId, [...changes]),
        );
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
        // Best-effort reconciliation.
      }
    },
    [systemFilesMarks, runWithStatus],
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
  //
  // Round 4 hotfix: the `!coresError` guard prevents a tight retry
  // loop that surfaced when the first `listAllCoresWithFiles` call
  // fails. Without it, the sequence was:
  //   1. status flips to 'connected' → effect fires refresh
  //   2. refresh: setCoresLoading(true) → re-render, guard skips
  //   3. IPC call fails (real-MiSTer perf timeout — see Round 4
  //      shell hotfix)
  //   4. catch sets coresError, finally sets coresLoading(false)
  //   5. coresLoading dep flips → effect re-evaluates. Status hasn't
  //      yet flipped to 'disconnected' on the renderer side (the
  //      IPC status event lags the rejected promise by a tick), so
  //      the effect SAW status='connected' + cores=null +
  //      !coresLoading and re-fired refresh — hundreds of times
  //      until the status event finally arrived.
  //
  // With `!coresError`, a failed refresh latches the gate. The
  // disconnect-reset effect clears coresError when status leaves
  // 'connected', so the next 'connected' transition (e.g. after
  // auto-retry success) un-latches the gate and a single refresh
  // fires.
  useEffect(() => {
    if (shouldFetchCoresOnEffect(status, cores, coresLoading, coresError)) {
      void refresh();
    }
  }, [status, cores, coresLoading, coresError, refresh]);

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
      refetchRoms,
      setRomVisibility,
      setBulkRomVisibility,
      hideCore,
      showCore,
      setBulkCoreVisibility,
      systemFilesMarks,
      isUserMarked,
      addSystemFileMark,
      removeSystemFileMark,
      setSystemFileMarks,
      setFolderClassification,
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
      refetchRoms,
      setRomVisibility,
      setBulkRomVisibility,
      hideCore,
      showCore,
      setBulkCoreVisibility,
      systemFilesMarks,
      isUserMarked,
      addSystemFileMark,
      removeSystemFileMark,
      setSystemFileMarks,
      setFolderClassification,
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
