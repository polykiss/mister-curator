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

/**
 * Single source of truth for "what is the app doing right now?".
 *
 * Each long-running operation pushes a status entry; the StatusBar
 * displays the most recent one. `run` is the typical call pattern —
 * it pushes the entry, awaits the work, and pops on resolve OR reject
 * so we can never get stuck on a stale message.
 *
 * The context deliberately tracks a small *stack* of in-flight ops, not
 * a single value, so concurrent operations (e.g. background ROM fetch
 * during a connect) don't trample each other's messages.
 *
 * The optional `operationId` channel is for ops that emit per-step
 * progress (currently only bulk core hide/show). Progress events flow
 * in via `reportProgress` from a wire-listener subscription; the entry
 * picks them up by matching `operationId` and the StatusBar renders
 * a determinate progress bar. Ops without progress events render with
 * the indeterminate spinner.
 */
export interface OperationProgress {
  readonly done: number;
  readonly total: number;
}

interface OperationEntry {
  readonly id: number;
  readonly message: string;
  readonly operationId?: string;
  readonly progress?: OperationProgress;
}

interface OperationStatusContextValue {
  readonly current: string | null;
  readonly currentProgress: OperationProgress | null;
  readonly run: <T>(message: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Same as `run` but registers an `operationId` so external progress
   * events (forwarded via `reportProgress`) can update the entry's
   * progress field. The renderer typically generates the id, passes it
   * into the IPC call AND `runWithProgress`, then the same id flows
   * through bulk-progress events.
   */
  readonly runWithProgress: <T>(
    message: string,
    operationId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  /**
   * Bridge from the wire-side bulk-progress listener into the active
   * entry. No-op if no entry currently owns this `operationId`.
   */
  readonly reportProgress: (operationId: string, progress: OperationProgress) => void;
}

const OperationStatusContext = createContext<OperationStatusContextValue | null>(null);

export function OperationStatusProvider({ children }: { children: ReactNode }): JSX.Element {
  const [stack, setStack] = useState<readonly OperationEntry[]>([]);
  const nextIdRef = useRef(1);

  const run = useCallback(<T,>(message: string, fn: () => Promise<T>): Promise<T> => {
    const id = nextIdRef.current;
    nextIdRef.current += 1;
    setStack((prev) => [...prev, { id, message }]);
    return fn().finally(() => {
      setStack((prev) => prev.filter((e) => e.id !== id));
    });
  }, []);

  const runWithProgress = useCallback(
    <T,>(message: string, operationId: string, fn: () => Promise<T>): Promise<T> => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setStack((prev) => [...prev, { id, message, operationId }]);
      return fn().finally(() => {
        setStack((prev) => prev.filter((e) => e.id !== id));
      });
    },
    [],
  );

  const reportProgress = useCallback(
    (operationId: string, progress: OperationProgress): void => {
      setStack((prev) =>
        prev.map((e) =>
          e.operationId === operationId ? { ...e, progress } : e,
        ),
      );
    },
    [],
  );

  // Bridge bulk-core-progress events from the preload bridge into the
  // current operation. Defined here so consumers don't need to wire
  // their own listener — the StatusBar/CoresContext just see the
  // resulting `currentProgress` field.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.mister?.onBulkCoreProgress) {
      return;
    }
    const unsubscribe = window.mister.onBulkCoreProgress((event) => {
      reportProgress(event.operationId, {
        done: event.done,
        total: event.total,
      });
    });
    return unsubscribe;
  }, [reportProgress]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.mister?.onUpdateModeProgress) {
      return;
    }
    const unsubscribe = window.mister.onUpdateModeProgress((event) => {
      reportProgress(event.operationId, {
        done: event.done,
        total: event.total,
      });
    });
    return unsubscribe;
  }, [reportProgress]);

  const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
  const current = top?.message ?? null;
  const currentProgress = top?.progress ?? null;

  const value = useMemo<OperationStatusContextValue>(
    () => ({ current, currentProgress, run, runWithProgress, reportProgress }),
    [current, currentProgress, run, runWithProgress, reportProgress],
  );

  return (
    <OperationStatusContext.Provider value={value}>
      {children}
    </OperationStatusContext.Provider>
  );
}

export function useOperationStatus(): OperationStatusContextValue {
  const ctx = useContext(OperationStatusContext);
  if (!ctx) {
    throw new Error(
      'useOperationStatus must be used within an OperationStatusProvider.',
    );
  }
  return ctx;
}
