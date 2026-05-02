/**
 * POSIX-safe single-quote shell escaping.
 *
 * Wraps the input in single quotes and rewrites any embedded single quote as
 * `'\''` (close, escaped quote, reopen). The result is safe to interpolate
 * into any POSIX shell command, including BusyBox sh on the MiSTer.
 *
 * Use this anywhere a user-controlled string (filename, core id, path) is
 * spliced into a shell command sent over SSH.
 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
