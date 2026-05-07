import type { ConnectionStatus, CoreEntry } from '@shared/types';

/**
 * Gate used by the cores-load `useEffect` in CoresContext. Returns
 * true iff the renderer should fire a fresh `listAllCoresWithFiles`
 * IPC call.
 *
 * Pure and synchronous so the contract is testable without rendering
 * React. The four parameters mirror the React state slots that drive
 * the effect:
 *
 *   - `status`: connection lifecycle. We only fetch in the
 *     `'connected'` state. While reconnecting / disconnected the
 *     effect must stay quiet so the renderer doesn't hammer the IPC
 *     bridge with calls that would only throw "not connected".
 *   - `cores`: presence flag for an existing snapshot. Non-null means
 *     we already have data; don't refetch unless explicitly asked.
 *   - `coresLoading`: in-flight guard. Prevents duplicate fetches
 *     during the natural setLoading-true → setLoading-false
 *     re-render pair (React 18 StrictMode etc.).
 *   - `coresError`: latch that prevents the post-failure retry loop
 *     fixed in PR #10 round 4. A failed refresh leaves this
 *     non-null; the gate refuses to re-fire until the
 *     disconnect-reset effect (or a manual retry) clears it.
 *
 * The fourth latch is the one that matters for the bug. Without it,
 * the effect spammed hundreds of failing IPC calls in the
 * milliseconds between an IPC rejection (renderer-side) and the
 * status-change event arriving on the renderer side: the rejection
 * flipped `coresLoading` from true to false, the effect re-evaluated
 * with status still appearing as `'connected'`, the gate re-opened,
 * a fresh IPC fired, and so on until the status event finally
 * arrived and `useConnection` re-rendered with `'disconnected'`.
 */
export function shouldFetchCoresOnEffect(
  status: ConnectionStatus,
  cores: readonly CoreEntry[] | null,
  coresLoading: boolean,
  coresError: string | null,
): boolean {
  return (
    status === 'connected' &&
    cores === null &&
    !coresLoading &&
    coresError === null
  );
}
