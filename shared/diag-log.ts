/**
 * Runtime diagnostic logger — PR #20 round 4. Adds visibility into
 * the SSH / IPC / prefetch / connection layers so we can identify
 * what hangs during the cold-cache prefetch cascade. Distinct from
 * `shared/diag.ts` (matcher diagnostic records, recorded
 * structurally for offline analysis).
 *
 * Format:
 *   [<subsystem>] <glyph> <message>  key=value key=value …
 *
 * Glyphs (consistent across subsystems so a grep `→` shows every
 * outbound call, `←` every inbound result, `✗` every failure):
 *   →   inbound start / outbound call begin
 *   ←   call returned / event in
 *   ✗   error / timeout / disconnect
 *   ·   neutral lifecycle event (subscribe, tick, etc.)
 *
 * The logger sends to `console.log` / `console.warn` / `console.error`
 * in both the Electron main process and the renderer — no flag gating
 * for now, this round wants visibility on by default. If the noise
 * becomes a problem post-debug, gate behind `MISTERCURATOR_DIAG_LOG`.
 */

export type DiagLogLevel = 'info' | 'warn' | 'error';
export type DiagSubsystem =
  | 'ssh'
  | 'ipc'
  | 'prefetch'
  | 'roms-pane'
  | 'conn'
  // Round 6 (PR #20) — per-path decision tree across the orchestrator,
  // HashService, and MetadataService. Tells us why a particular ROM
  // resolved to source=none with no SSH hash command (cache hit on a
  // sentinel? mtime-validated cache hit? skipped for some other
  // reason?). Distinct subsystem so a single grep `[meta]` isolates
  // the whole decision chain for one prefetch.
  | 'meta'
  // Round 7 (PR #20) — box-art fetch + render trace. Spans the
  // ImageCache fetch, the orchestrator's bytes wrapper, the IPC
  // hop, and the renderer's useBoxArt → <img> render path. Grep
  // `[boxart]` to follow one URL from request to display.
  | 'boxart'
  // feat/arcade-playability-data (PR 1/2) — playability scan
  // tracer. One `[arcade]` line per scan emit on connect or
  // forceRefresh, carrying the cold/warm timing, the cache flag,
  // and the bucket counts.
  | 'arcade';
export type DiagGlyph = '→' | '←' | '✗' | '·';

/**
 * Pure formatter — exported so tests can assert on the line shape
 * without spying on `console`. Fields with `undefined` values are
 * omitted (caller can pass a wide bag without conditional spreading).
 * String values containing whitespace are double-quoted so the
 * `key=value` pairs stay parseable when the user pipes the log
 * through grep / awk.
 */
export function diagLine(
  subsystem: DiagSubsystem,
  glyph: DiagGlyph,
  message: string,
  fields: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const pairs: string[] = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    const value =
      typeof raw === 'string' && /\s/.test(raw) ? `"${raw}"` : String(raw);
    pairs.push(`${key}=${value}`);
  }
  const tail = pairs.length > 0 ? `  ${pairs.join(' ')}` : '';
  return `[${subsystem}] ${glyph} ${message}${tail}`;
}

/** Emit a diagnostic log line at the given level. */
export function diagLog(
  level: DiagLogLevel,
  subsystem: DiagSubsystem,
  glyph: DiagGlyph,
  message: string,
  fields?: Readonly<Record<string, string | number | undefined>>,
): void {
  const line = diagLine(subsystem, glyph, message, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * Truncate long command strings for log lines. SSH `find` commands
 * routinely run 500+ chars; cap at 200 so a busy prefetch doesn't
 * bury the structured fields under a wall of `-printf` flags.
 */
export function truncateForLog(text: string, max = 200): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * Monotonic id generator scoped to a subsystem. Each subsystem gets
 * its own counter so opIds / callIds don't collide cross-system.
 * Module-level state is fine here — both main and renderer get their
 * own module instance under Electron's process model.
 */
export function makeIdGen(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${String(n)}`;
  };
}
