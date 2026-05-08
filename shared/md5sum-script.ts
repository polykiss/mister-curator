import type { Md5SumResult } from '@shared/mister-client';

/**
 * The shell script and the parser for `IMisterClient.md5sumPaths`.
 *
 * Lives in `shared/` so the parser is unit-testable without an SSH
 * session (same pattern as `prime-parse.ts`).
 *
 * Output line shape: `<path>\t<md5hex>\t<mtimeEpoch>\n`. Paths that
 * don't exist or aren't regular files don't emit a line at all — the
 * `parseMd5sumOutput` helper just sees fewer rows than were sent in.
 *
 * Argv-limit note: busybox sh on the DE10-Nano happily handles ~100
 * paths joined with shell-quoting; the orchestrator (HashService)
 * chunks larger inputs.
 *
 * Round 6 — `.zip` extraction:
 *
 * OpenVGDB indexes ROMs by the hash of the EXTRACTED file (`.sfc`,
 * `.md`, `.nes`, `.gba`, …), never by the hash of a `.zip` wrapper.
 * For paths with a `.zip` (case-insensitive) extension, we pipe the
 * archive through `unzip -p` before `md5sum` so the cache stores the
 * inner-file hash. `mtime` is still recorded against the wrapper —
 * that's what cache invalidation keys on, since the wrapper is what
 * the user touches.
 *
 * Limitation: `unzip -p` writes every entry concatenated. For a
 * multi-file zip (variant collections, X68000 multi-disk) the
 * resulting hash won't match anything in OpenVGDB. The metadata
 * service then returns null cleanly — same outcome as a ROM that
 * genuinely isn't indexed. Not incorrect, just unmatched. A future
 * round can detect multi-file zips and hash each entry separately
 * once we see how often it actually matters.
 *
 * Limitation 2: `.zip` is the only archive format handled. `.7z`,
 * `.gz`, `.rar` and friends fall through to direct `md5sum`, which
 * won't match OpenVGDB but won't error either.
 */
export function buildMd5sumScript(paths: readonly string[]): string {
  // The body is platform-portable: busybox `md5sum`, `unzip`, `stat
  // -c %Y`, `printf`, and POSIX `case ... esac` all exist on every
  // MiSTer build we care about. The `[ -f $f ]` guard ensures a
  // directory path silently drops rather than producing a confusing
  // md5 of the dir's contents string.
  //
  // The input paths are passed as positional args via `set --`; we
  // shell-quote each so spaces and apostrophes survive untouched.
  const setLine = `set -- ${paths.map(shellQuote).join(' ')}`;
  return [
    setLine,
    'for f in "$@"; do',
    '  if [ -f "$f" ]; then',
    '    case "$f" in',
    '      *.zip|*.ZIP)',
    "        h=$(unzip -p \"$f\" 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1)",
    '        ;;',
    '      *)',
    "        h=$(md5sum \"$f\" 2>/dev/null | cut -d' ' -f1)",
    '        ;;',
    '    esac',
    '    m=$(stat -c %Y "$f" 2>/dev/null)',
    '    if [ -n "$h" ] && [ -n "$m" ]; then',
    '      printf \'%s\\t%s\\t%s\\n\' "$f" "$h" "$m"',
    '    fi',
    '  fi',
    'done',
  ].join('\n');
}

export function parseMd5sumOutput(stdout: string): readonly Md5SumResult[] {
  const out: Md5SumResult[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // Path may itself contain tabs (rare but legal on POSIX). md5 is
    // a fixed 32 hex chars and mtime is an integer, so split on the
    // last two tabs — `lastIndexOf` twice.
    const lastTab = line.lastIndexOf('\t');
    if (lastTab < 0) continue;
    const prevTab = line.lastIndexOf('\t', lastTab - 1);
    if (prevTab < 0) continue;
    const path = line.slice(0, prevTab);
    const hash = line.slice(prevTab + 1, lastTab);
    const mtimeStr = line.slice(lastTab + 1);
    if (!isMd5Hex(hash)) continue;
    const mtime = Number.parseInt(mtimeStr, 10);
    if (!Number.isFinite(mtime) || mtime < 0) continue;
    out.push({ path, hash, mtime });
  }
  return out;
}

function isMd5Hex(s: string): boolean {
  if (s.length !== 32) return false;
  for (let i = 0; i < 32; i += 1) {
    const c = s.charCodeAt(i);
    const isDigit = c >= 48 && c <= 57;
    const isLowerHex = c >= 97 && c <= 102;
    if (!isDigit && !isLowerHex) return false;
  }
  return true;
}

/**
 * POSIX-safe single-quote shell escaping. Duplicated here (rather than
 * imported from `app/main/clients/shell.ts`) so this module stays
 * dependency-free for the renderer/test bundle.
 */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
