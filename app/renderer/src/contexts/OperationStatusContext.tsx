import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { JSX, ReactNode } from 'react';

/**
 * Single source of truth for "what is the app doing right now?".
 *
 * Each long-running operation pushes a status entry; the StatusBar
 * displays the most recent one. `withOperationStatus` is the typical
 * call pattern — it pushes the entry, awaits the work, and pops on
 * resolve OR reject so we can never get stuck on a stale message.
 *
 * The context deliberately tracks a small *stack* of in-flight ops, not
 * a single value, so concurrent operations (e.g. background ROM fetch
 * during a connect) don't trample each other's messages.
 */
interface OperationEntry {
  readonly id: number;
  readonly message: string;
}

interface OperationStatusContextValue {
  readonly current: string | null;
  readonly run: <T>(message: string, fn: () => Promise<T>) => Promise<T>;
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

  const current = stack.length > 0 ? (stack[stack.length - 1]?.message ?? null) : null;

  const value = useMemo<OperationStatusContextValue>(
    () => ({ current, run }),
    [current, run],
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
