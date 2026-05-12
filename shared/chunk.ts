/**
 * feat/sample-based-hashing — generic sequential-chunked-reduce.
 *
 * Used by SSH client methods that build one shell script per call
 * and would otherwise blow past argv / packet-window limits on a
 * large input. Witness checks for a 666-path mame core produce a
 * ~177 KB script when un-chunked, well past ssh2's 32 KB default
 * exec-channel send window — the EPIPE-in-27ms loop documented in
 * the connect-cycle investigation. Splitting into 100-path chunks
 * brings each script under ~26 KB.
 *
 * Sequential, not parallel: the underlying SSH session is a single
 * channel; running chunks concurrently would stack writes on the
 * same socket without latency gain. `combine` reduces per-chunk
 * results into one aggregate; callers pick the merge shape that
 * fits their return type (Object.assign for path→value maps,
 * array spread for ordered records, etc.).
 *
 * Error semantics: the first throw propagates and stops the loop.
 * Subsequent chunks never run. This matches how the existing
 * unchunked callers behave today — a single SSH op either
 * succeeds wholesale or throws — so wrapping in this helper is a
 * drop-in replacement, not a contract change.
 *
 * Empty input short-circuits: zero `fn` invocations, returns
 * `empty` verbatim. Useful for callers that compute the
 * accumulator's identity (`{}`, `[]`) once and pass it through.
 */
export async function chunked<I, O>(
  items: readonly I[],
  chunkSize: number,
  fn: (chunk: readonly I[]) => Promise<O>,
  combine: (acc: O, next: O) => O,
  empty: O,
): Promise<O> {
  if (items.length === 0) return empty;
  let acc = empty;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const next = await fn(chunk);
    acc = combine(acc, next);
  }
  return acc;
}
