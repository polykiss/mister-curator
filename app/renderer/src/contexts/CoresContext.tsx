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
import {
  ARCADE_VIRTUAL_CORE_ID,
  countArcadeMraEntries,
  type ArcadeMraEntry,
} from '@shared/arcade-mra';
import { arcadeMraVisiblePath } from '@shared/ledger';
import type { ArcadePlayabilityWire } from '@shared/preload-api';
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
  applyCoreVisibilityChange,
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

/**
 * feat/arcade-phase-1.5 — synthesize a CoreEntry for the
 * `__arcade__` row from the arcade .mra listing. The matcher
 * actively drops Arcade-category entries (see `core-matching.ts`
 * line ~494: "PR-A item 1 dropped the synthetic Arcade
 * placeholder"), so this is the only path that puts an Arcade
 * row in the sidebar — and now it's actionable, not the dead
 * "read-only" placeholder from earlier rounds.
 *
 * Counts come from `countArcadeMraEntries`: total `.mra` entries
 * = romCount, hidden `.mra` entries = hiddenCount. Subfolder /
 * cores-subfolder rows aren't counted (they're navigational
 * structure, not "ROMs").
 *
 * `gamesDirExists: true` is what makes the row navigable in
 * `BrowserScreen` — without it the right pane stays empty when
 * the user clicks. Returns `null` for an empty `_Arcade/` so the
 * sidebar doesn't show an Arcade row when the device has no
 * .mra content at all.
 */
function synthesizeArcadeCoreEntry(
  entries: readonly ArcadeMraEntry[],
  playability: ArcadePlayabilityWire | null,
): CoreEntry | null {
  // PR 2/2 scope is top-level mras only — match the pane listing
  // and the playability scan's universe so the sidebar count, the
  // pane header count, and the row badges all agree. Nested mras
  // (under `_alternatives/` etc.) are surfaced in a Phase 3
  // drillable view; they don't contribute to V1's counts.
  const topLevelEntries = entries.filter(
    (e) => e.kind !== 'mra' || !e.relativePath.includes('/'),
  );
  const counts = countArcadeMraEntries(topLevelEntries);
  if (counts.totalMras === 0 && counts.subfolders === 0) return null;
  return {
    id: ARCADE_VIRTUAL_CORE_ID,
    name: 'Arcade',
    romCount: counts.totalMras,
    hiddenCount: counts.hiddenMras,
    recursiveRomCount: counts.totalMras,
    recursiveHiddenCount: counts.hiddenMras,
    category: 'Arcade',
    rbfPaths: [],
    gamesDirExists: true,
    gamesDirHidden: false,
    // PR-2: when playability is loaded, render the count as
    // `playable (total)` via the new field. Undefined on cold
    // connect → CoreCountSummary falls back to the existing
    // `total (hidden)` shape so the sidebar doesn't flash a
    // stale 0.
    arcadePlayableCount:
      playability !== null
        ? countArcadePlayable(topLevelEntries, playability)
        : undefined,
  };
}

/**
 * feat/arcade-ux-and-ledger (PR 2/2) — compute the "playable"
 * count for the sidebar Arcade row:
 *
 *   |(playable ∪ no-roms-needed) − user-hidden|
 *
 * Auto-hidden mras are not subtracted: they're playable mras the
 * rule chose to dot-prefix because their ROMs are present, and
 * the count should reflect what the user could play if they
 * flipped auto-hide off. User-hidden mras (hidden but not in
 * `playability.autoHidden`) ARE subtracted — the user has
 * actively chosen to hide them.
 */
function countArcadePlayable(
  entries: readonly ArcadeMraEntry[],
  playability: ArcadePlayabilityWire,
): number {
  const playableSet = new Set<string>(playability.playable);
  const noRomsSet = new Set<string>(playability.noRomsNeeded);
  const autoHidden = new Set<string>(playability.autoHidden);
  let count = 0;
  for (const e of entries) {
    if (e.kind !== 'mra') continue;
    const inPlayable =
      playableSet.has(e.relativePath) || noRomsSet.has(e.relativePath);
    if (!inPlayable) continue;
    const visible = arcadeMraVisiblePath(e.relativePath);
    const isUserHidden = e.hidden && !autoHidden.has(visible);
    if (isUserHidden) continue;
    count += 1;
  }
  return count;
}

interface CoresContextValue {
  readonly cores: readonly CoreEntry[] | null;
  readonly coresLoading: boolean;
  readonly coresError: string | null;
  readonly selectedCoreId: string | null;
  readonly selectedCore: CoreEntry | null;
  readonly romsByCore: RomsByCore;
  readonly romsLoading: LoadingByCore;
  /**
   * Monotonically-increasing integer, incremented whenever the ROM
   * cache is fully cleared (Refresh, bulk-core ops, disconnect reset).
   * Adapters include this in their `ensureRoms` effect deps so the
   * effect re-fires after a cache wipe even when core.id and subPath
   * didn't change — which would otherwise leave the pane stuck in
   * "No ROMs in this core" until the user navigates away and back
   * (Bug C).
   */
  readonly romCacheVersion: number;
  /**
   * Cores with an in-flight hide / show operation. The cores list
   * uses this to render an inline "hiding…" / "showing…" indicator
   * in place of the eye icon while the rename is on the wire.
   */
  readonly pendingCoreIds: ReadonlySet<string>;
  /**
   * Core IDs the on-MiSTer hide ledger says we hid in past sessions.
   * Used exclusively to scope the "Unhide all" target list — the
   * renderer intersects this with currently-hidden cores to avoid
   * un-prefixing dot-folders the firmware itself placed there.
   */
  readonly ledgerCoreIds: ReadonlySet<string>;
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
  /**
   * feat/pre-beta-polish-batch — bump the synthetic Arcade row's
   * hidden count by `delta` (typically +1 / -1). The arcade adapter
   * calls this when optimistically toggling a single `.mra` so the
   * sidebar badge ("Arcade (5)") reflects the click before the SSH
   * rename round-trips. The adapter reverts with the inverse delta
   * if the rename rejects.
   *
   * No-op when there's no Arcade row in the cores list (cold load
   * not yet resolved, or device has no `.mra` content).
   */
  readonly adjustArcadeHiddenCount: (delta: number) => void;
}

const CoresContext = createContext<CoresContextValue | null>(null);

export function CoresProvider({ children }: { children: ReactNode }): JSX.Element {
  const { status, lostConnection, autoRetry, autoRetryFailed } = useConnection();
  const { run: runWithStatus, runWithProgress } = useOperationStatus();
  const [cores, setCores] = useState<readonly CoreEntry[] | null>(null);
  const [coresLoading, setCoresLoading] = useState(false);
  const [coresError, setCoresError] = useState<string | null>(null);
  const [selectedCoreId, setSelectedCoreId] = useState<string | null>(null);
  const [romsByCore, setRomsByCore] = useState<RomsByCore>({});
  const [romsLoading, setRomsLoading] = useState<LoadingByCore>({});
  const [romCacheVersion, setRomCacheVersion] = useState(0);
  const [systemFilesMarks, setSystemFilesMarks] = useState<SystemFilesMarks>(
    EMPTY_SYSTEM_FILES_MARKS,
  );
  const [pendingCoreIds, setPendingCoreIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [ledgerCoreIds, setLedgerCoreIds] = useState<ReadonlySet<string>>(
    () => new Set(),
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
   * Debug-logging wrapper around `setRomsByCore`. Every mutation to
   * the renderer ROM cache goes through here so future state-race
   * debugging has a clear audit trail without adding per-site noise.
   * `caller` identifies the function making the change; `key` is the
   * romsKey string (or `'*'` for a full-cache wipe).
   */
  const setRomsCache = useCallback(
    (
      caller: string,
      key: string,
      update: RomsByCore | ((prev: RomsByCore) => RomsByCore),
    ) => {
      console.debug('[cores] roms-cache', { caller, key });
      setRomsByCore(update);
    },
    [],
  );

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
      setRomsCache('refetchSelectedRoms', key, (prev) => ({ ...prev, [key]: fresh }));
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
        // refetchRoms is the post-mutation refresh path — always
        // bypass the cache here so we observe the fresh device state.
        // The lazy load path (`ensureRoms` below) leaves the cache
        // engaged so cold drills are fast.
        const fresh = await runWithStatus(`Loading ROMs in ${label}…`, () =>
          window.mister.listRoms(coreId, subPath, { forceRefresh: true }),
        );
        setRomsCache('refetchRoms', key, (prev) => ({ ...prev, [key]: fresh }));
      } finally {
        setRomsLoading((prev) => ({ ...prev, [key]: false }));
      }
    },
    [runWithStatus],
  );

  /**
   * Internal cores-list load. Two callers, two intents:
   *
   *   - `loadCores({ forceRefresh: false })` from the post-connect
   *     `useEffect` below. Allows the PR #12 disk cache to hit on
   *     warm reconnect — the manager validates witnesses and serves
   *     cached cores when they match, which is the whole point of
   *     the cache.
   *   - `loadCores({ forceRefresh: true })` from the public `refresh`
   *     wrapper used by the BrowserScreen Refresh button. The user
   *     clicked Refresh because they suspect the cache is stale;
   *     bypass it and walk the device.
   *
   * Round 1 of PR #12 hardcoded `forceRefresh: true` on the only
   * load path, which made every reconnect produce
   * cache.invalidate + cache.write instead of the expected
   * cache.hit. Round 2 splits the intent: the boolean now flows
   * from the caller.
   */
  const loadCores = useCallback(
    async ({ forceRefresh }: { readonly forceRefresh: boolean }) => {
      setCoresLoading(true);
      setCoresError(null);
      try {
        // Marks first — counts in the cores list depend on them.
        const marks = await window.mister.listSystemFileMarks();
        setSystemFilesMarks(marks);
        // Ledger snapshot — used by the "Unhide all" UI to scope its
        // target list. Single-core hide/show paths don't read this.
        try {
          const ids = await window.mister.listLedgerCoreIds();
          setLedgerCoreIds(new Set(ids));
        } catch {
          // Best-effort; the bulk-unhide button stays disabled if this
          // fails, which is the safe default.
          setLedgerCoreIds(new Set());
        }
        const next = await runWithStatus('Scanning cores…', () =>
          window.mister.listAllCoresWithFiles({ forceRefresh }),
        );
        // feat/arcade-phase-1.5 — fetch the .mra listing alongside
        // the cores walk so the synthetic Arcade row carries fresh
        // counts. Best-effort: if the call fails, the cores list
        // still renders without the Arcade row (Phase 1.5 is
        // additive — its absence doesn't break other functionality).
        //
        // PR 2/2 also fetches playability so the sidebar count can
        // render as `playable (total)`. Playability is allowed to
        // fail independently — the synthesizer falls back to the
        // `total (hidden)` format on a null playability.
        let arcadeEntry: CoreEntry | null = null;
        try {
          const [arcade, playability] = await Promise.all([
            window.mister.listArcadeMraEntries({ forceRefresh }),
            window.mister.getArcadePlayability().catch(() => null),
          ]);
          arcadeEntry = synthesizeArcadeCoreEntry(arcade, playability);
        } catch {
          arcadeEntry = null;
        }
        setCores(arcadeEntry ? [arcadeEntry, ...next] : next);
        setRomsCache('loadCores', '*', {});
        setRomCacheVersion((v) => v + 1);
        setRomsLoading({});
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Failed to load cores.';
        setCoresError(message);
      } finally {
        setCoresLoading(false);
      }
    },
    [runWithStatus],
  );

  /**
   * Public Refresh-button entry point. Exposed on the CoresContext
   * value so any UI control wired to "user wants fresh data" calls
   * this — the contract is "always cache-bypass". Currently only
   * BrowserScreen's Refresh button consumes it; new callers should
   * audit whether they actually want bypass or the lazy-load path.
   */
  const refresh = useCallback(
    () => loadCores({ forceRefresh: true }),
    [loadCores],
  );

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
        setRomsCache('ensureRoms', key, (prev) => ({ ...prev, [key]: roms }));
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

  // feat/pre-beta-polish-batch — see the public contract on
  // CoresContextValue.adjustArcadeHiddenCount above. Adjusts both
  // `hiddenCount` and `recursiveHiddenCount` since they're equal for
  // the synthetic Arcade row (it has no nested cores) AND
  // CoreCountSummary reads `recursiveHiddenCount ?? hiddenCount`.
  // The arcadePlayableCount is intentionally not touched here:
  // re-deriving it would require the playability set, which lives
  // outside CoresContext; it self-heals on the next refresh.
  const adjustArcadeHiddenCount = useCallback((delta: number) => {
    if (delta === 0) return;
    setCores((prev) => {
      if (!prev) return prev;
      return prev.map((core) =>
        core.id === ARCADE_VIRTUAL_CORE_ID
          ? {
              ...core,
              hiddenCount: core.hiddenCount + delta,
              recursiveHiddenCount:
                (core.recursiveHiddenCount ?? core.hiddenCount) + delta,
            }
          : core,
      );
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
      setRomsCache('setRomVisibility-optimistic', key, (prev) => ({ ...prev, [key]: optimistic }));
      // The cores-list romCount/hiddenCount only reflects top-level
      // entries — nested hides don't change the parent count.
      if (subPath === '') updateCoreCounts(coreId, optimistic);

      try {
        await window.mister.setRomVisibility(coreId, filename, hidden, subPath);
      } catch (err) {
        setRomsCache('setRomVisibility-revert', key, (prev) => ({ ...prev, [key]: previousRoms }));
        if (previousCores && subPath === '') setCores(previousCores);
        throw err;
      }
      // Post-success reconciliation: re-fetch from device to confirm
      // the optimistic state matches truth. forceRefresh bypasses the
      // witness check (the rename already bumped the games-dir mtime
      // and invalidated the main-process cache). Best-effort — the
      // optimistic state is already correct on SSH success; this just
      // catches any edge-case drift.
      try {
        const fresh = await window.mister.listRoms(coreId, subPath, {
          forceRefresh: true,
        });
        setRomsCache('setRomVisibility-reconcile', key, (prev) => ({ ...prev, [key]: fresh }));
        if (subPath === '') updateCoreCounts(coreId, fresh);
      } catch {
        /* best-effort — optimistic state is still correct on SSH success */
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
        setRomsCache('setBulkRomVisibility-optimistic', key, (prev) => ({ ...prev, [key]: optimistic }));
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
          setRomsCache('setBulkRomVisibility-revert', key, (prev) => ({ ...prev, [key]: previousRoms }));
          if (previousCores && subPath === '') setCores(previousCores);
        }
        throw err;
      }

      if (result.failed.length > 0 && previousRoms) {
        try {
          // forceRefresh bypasses the witness check — the renames that
          // succeeded already invalidated the cache, so without this
          // the witness may still match the pre-op snapshot and return
          // stale data that overwrites the correct optimistic state
          // (Bug B: ~0.5s flash-then-disappear on partial failure).
          const fresh = await window.mister.listRoms(coreId, subPath, {
            forceRefresh: true,
          });
          setRomsCache('setBulkRomVisibility-recovery', key, (prev) => ({ ...prev, [key]: fresh }));
          if (subPath === '') updateCoreCounts(coreId, fresh);
        } catch {
          /* best-effort */
        }
      }

      return result;
    },
    [updateCoreCounts, runWithStatus],
  );

  /**
   * Toggle a single core's visibility with an optimistic local update.
   *
   * Round 5: no global cores re-fetch on success — the matcher already
   * gave us all the information we need to flip the row in place. The
   * row's visual state changes the instant the user clicks; an inline
   * indicator (driven by `pendingCoreIds`) sits where the eye icon was
   * until the SSH rename returns. On failure we revert to the saved
   * snapshot so the row snaps back without the user having to refresh.
   */
  const setSingleCoreVisibility = useCallback(
    async (coreId: string, hidden: boolean): Promise<void> => {
      const previousCores = coresRef.current;
      // Optimistic flip: rewrite the row's rbfPaths + gamesDirHidden
      // so isCoreHidden flips in lockstep across both signals.
      setCores((prev) => {
        if (!prev) return prev;
        return prev.map((c) =>
          c.id === coreId ? applyCoreVisibilityChange(c, hidden) : c,
        );
      });
      // Ledger bookkeeping — set is mutated optimistically too so the
      // "Unhide all (N)" count reflects the change immediately.
      setLedgerCoreIds((prev) => {
        const lower = coreId.toLowerCase();
        const next = new Set(prev);
        if (hidden) next.add(lower);
        else next.delete(lower);
        // Also keep the original-cased id so lookups don't depend on
        // the renderer normalising every check.
        if (hidden) next.add(coreId);
        else next.delete(coreId);
        return next;
      });
      setPendingCoreIds((prev) => {
        const next = new Set(prev);
        next.add(coreId);
        return next;
      });
      try {
        if (hidden) {
          await window.mister.hideCore(coreId);
        } else {
          await window.mister.showCore(coreId);
        }
        // The hide/unhide changed the on-disk basename for this
        // core's ROM list — invalidate the cache so the next
        // `ensureRoms` re-fetches.
        setRomsCache('setSingleCoreVisibility-invalidate', coreId, (prev) => {
          if (!(coreId in prev)) return prev;
          const copy = { ...prev };
          delete copy[coreId];
          return copy;
        });
        if (selectedCoreIdRef.current === coreId) {
          await refetchSelectedRoms();
        }
      } catch (err) {
        // Roll back the optimistic flips.
        if (previousCores) setCores(previousCores);
        // Refresh ledger from the source of truth (the IPC call may
        // have partially succeeded — e.g. games-dir renamed but rbf
        // failed — and the ledger reflects the actual outcome).
        try {
          const ids = await window.mister.listLedgerCoreIds();
          setLedgerCoreIds(new Set(ids));
        } catch {
          /* best-effort */
        }
        throw err instanceof Error ? err : new Error(String(err));
      } finally {
        setPendingCoreIds((prev) => {
          if (!prev.has(coreId)) return prev;
          const next = new Set(prev);
          next.delete(coreId);
          return next;
        });
      }
    },
    [refetchSelectedRoms],
  );

  const hideCore = useCallback(
    (coreId: string) => setSingleCoreVisibility(coreId, true),
    [setSingleCoreVisibility],
  );

  const showCore = useCallback(
    (coreId: string) => setSingleCoreVisibility(coreId, false),
    [setSingleCoreVisibility],
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
      setRomsCache('setBulkCoreVisibility', '*', {});
      setRomCacheVersion((v) => v + 1);
      // Ledger snapshot may have shifted (entries added on hide / removed
      // on show). Refresh so "Unhide all (N)" stays accurate.
      try {
        const ids = await window.mister.listLedgerCoreIds();
        setLedgerCoreIds(new Set(ids));
      } catch {
        /* best-effort */
      }
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
        setRomsCache('addSystemFileMark', coreId, (prev) => ({ ...prev, [coreId]: freshRoms }));
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
        setRomsCache('removeSystemFileMark', coreId, (prev) => ({ ...prev, [coreId]: freshRoms }));
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
        setRomsCache('setFolderClassification', key, (prev) => ({ ...prev, [key]: fresh }));
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
        setRomsCache('setSystemFileMarks', coreId, (prev) => ({ ...prev, [coreId]: freshRoms }));
        setCores(freshCores);
      } catch {
        // Best-effort reconciliation.
      }
    },
    [systemFilesMarks, runWithStatus],
  );

  // Reset whenever we leave the connected state for a NON-transient
  // reason. PR #20 round 3: a mid-session SSH drop with auto-retry in
  // flight (`lostConnection || autoRetry`) keeps the cached cores +
  // selected core + ROM list alive so a successful auto-reconnect
  // returns the user to exactly where they were. Only wipe on a
  // user-initiated disconnect (back to profile picker) or after the
  // auto-retry budget is exhausted (`autoRetryFailed`) — either way
  // the cached state has lost its session anchor and the user has to
  // restart the connect flow.
  useEffect(() => {
    if (status === 'connected') return;
    if (lostConnection || autoRetry !== null) return;
    setCores(null);
    setSelectedCoreId(null);
    setRomsCache('disconnect-reset', '*', {});
    setRomCacheVersion((v) => v + 1);
    setRomsLoading({});
    setCoresError(null);
    setCoresLoading(false);
    setSystemFilesMarks(EMPTY_SYSTEM_FILES_MARKS);
    setPendingCoreIds(new Set());
    setLedgerCoreIds(new Set());
  }, [status, lostConnection, autoRetry, autoRetryFailed]);

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
      // PR #12 round 2: post-connect load is cache-friendly. The disk
      // cache validates against on-device witnesses; on a warm
      // reconnect after the user has been here before, the manager
      // serves the cached snapshot in <1s. Without this split, every
      // reconnect went through the Refresh-button branch and walked
      // the device unnecessarily.
      void loadCores({ forceRefresh: false });
    }
  }, [status, cores, coresLoading, coresError, loadCores]);

  const selectCore = useCallback((coreId: string | null) => {
    setSelectedCoreId(coreId);
    // PR-C (PR #26): pivot the auto-scrape engine to the user's
    // focus. setAutoScrapeFocus is idempotent (no-op if already
    // active), so re-clicking the same core doesn't disrupt the
    // in-flight scrape. `null` (deselect) doesn't dispatch — the
    // engine continues with whatever it was doing.
    if (coreId !== null) {
      void window.mister.setAutoScrapeFocus(coreId).catch(() => {
        // Silent failure — IPC errors here aren't user-actionable
        // (the engine just stays on its current core; scrape still
        // happens, just not in the user's preferred order).
      });
    }
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
      romCacheVersion,
      pendingCoreIds,
      ledgerCoreIds,
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
      adjustArcadeHiddenCount,
    }),
    [
      cores,
      coresLoading,
      coresError,
      selectedCoreId,
      selectedCore,
      romsByCore,
      romsLoading,
      romCacheVersion,
      pendingCoreIds,
      ledgerCoreIds,
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
      adjustArcadeHiddenCount,
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
