/**
 * The shell script and the parser for `IMisterClient.hashPaths`.
 *
 * Lives in `shared/` so the parser is unit-testable without an SSH
 * session (same pattern as `prime-parse.ts`).
 *
 * Output line shape (6 tab-separated fields):
 *   `<path>\t<md5hex>\t<sha1hex>\t<sizeBytes>\t<diskSizeBytes>\t<mtimeEpoch>\n`
 *
 * `sizeBytes` is the extracted ROM content size (zip-inner for
 * archives, raw bytes for direct files) — feeds ScreenScraper's
 * `romtaille`. `diskSizeBytes` is `stat -c %s` on the wrapper file —
 * what the OS says this file is. For non-archive paths the two are
 * identical; for `.zip` wrappers they differ. fix/scrape-and-count-
 * correctness commit 1 added the second field after the user
 * observed cache `size: 36MB` against on-disk `14MB` for a mame .zip
 * and assumed staleness. Investigation: `size` was always extracted-
 * content bytes, captured fresh per compute via `unzip -p | wc -c`.
 * Adding `diskSize` makes both numbers available so the discrepancy
 * is visible-by-design rather than a phantom bug.
 *
 * Paths that don't exist or aren't regular files don't emit a line —
 * `parseHashOutput` simply sees fewer rows than were sent in.
 *
 * Argv-limit note: busybox sh on the DE10-Nano happily handles ~100
 * paths joined with shell-quoting; the orchestrator (HashService)
 * chunks larger inputs.
 *
 * ─── Hash algorithms ──────────────────────────────────────────────
 *
 * **MD5 + SHA-1.** Both are present on every MiSTer build (busybox
 * `md5sum` / `sha1sum`). PR #16 round 2: ScreenScraper accepts any
 * subset of (md5, sha1, crc) and matches on the first one it
 * recognises, so passing both broadens variant-hash coverage.
 *
 * **CRC32 deliberately omitted.** Investigated and skipped:
 *   - busybox `cksum` computes the POSIX cksum, NOT CRC32.
 *   - busybox does not ship `crc32`, `xxhsum`, or coreutils
 *     `cksum -a crc32` on stock MiSTer firmware.
 *   - Computing CRC32 locally would require streaming the full file
 *     over SSH on every prefetch — multiplied across thousands of
 *     ROMs that's a non-starter.
 * Adding it would need either a python helper deployed to
 * `/tmp/mistercurator/` (per AGENTS.md, allowed but extra
 * complexity), OR an upstream busybox build flag we don't control.
 * MD5 + SHA-1 turns out to be sufficient for SS matching in
 * practice; revisit if a real-world miss surfaces an OpenVGDB row
 * that has CRC32 alone.
 *
 * ─── .zip wrappers ────────────────────────────────────────────────
 *
 * For paths whose extension is `.zip` (case-insensitive), we hash
 * the inner content via `unzip -p | md5sum` / `unzip -p | sha1sum`.
 * The `.zip` is read TWICE — once per algorithm — because busybox
 * doesn't ship `tee`-with-process-substitution or openssl
 * `dgst -md5 -sha1`. SD card I/O is the bottleneck, not CPU; one
 * extra read per zip is acceptable and avoids needing scratch space
 * in `/tmp`.
 *
 * mtime is captured against the wrapper in both branches. Cache
 * invalidation tracks the wrapper's mtime — the inner file's mtime
 * isn't accessible without extracting first.
 */

import type { HashRecord } from '@shared/mister-client';

export function buildHashScript(paths: readonly string[]): string {
  // For `.zip` wrappers we run THREE passes — md5, sha1, then
  // `wc -c` for the inner-content size. SS's `romtaille` expects
  // the size of the actual ROM, not the zip wrapper. A fourth
  // `stat -c %s` against `$f` records the WRAPPER size into the
  // `disk_size` field — that's the bytes-on-disk value the size
  // column displays. For non-archive paths the two coincide.
  // Three reads of a 50MB zip is ~1–2s on the Nano's SD card — fine
  // for a one-time prefetch. mtime stays on the wrapper since
  // that's what the user actually touches.
  const setLine = `set -- ${paths.map(shellQuote).join(' ')}`;
  return [
    setLine,
    'for f in "$@"; do',
    '  if [ -f "$f" ]; then',
    '    case "$f" in',
    '      *.zip|*.ZIP)',
    "        md5=$(unzip -p \"$f\" 2>/dev/null | md5sum 2>/dev/null | cut -d' ' -f1)",
    "        sha1=$(unzip -p \"$f\" 2>/dev/null | sha1sum 2>/dev/null | cut -d' ' -f1)",
    '        size=$(unzip -p "$f" 2>/dev/null | wc -c | tr -d \' \')',
    '        disk_size=$(stat -c %s "$f" 2>/dev/null)',
    '        ;;',
    '      *)',
    "        md5=$(md5sum \"$f\" 2>/dev/null | cut -d' ' -f1)",
    "        sha1=$(sha1sum \"$f\" 2>/dev/null | cut -d' ' -f1)",
    '        size=$(stat -c %s "$f" 2>/dev/null)',
    '        disk_size=$size',
    '        ;;',
    '    esac',
    '    mtime=$(stat -c %Y "$f" 2>/dev/null)',
    '    if [ -n "$md5" ] && [ -n "$sha1" ] && [ -n "$size" ] && [ -n "$disk_size" ] && [ -n "$mtime" ]; then',
    '      printf \'%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n\' "$f" "$md5" "$sha1" "$size" "$disk_size" "$mtime"',
    '    fi',
    '  fi',
    'done',
  ].join('\n');
}

export function parseHashOutput(stdout: string): readonly HashRecord[] {
  const out: HashRecord[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // Path may itself contain tabs (rare but legal POSIX). The five
    // trailing fields are fixed-width / numeric so we split from the
    // right with `lastIndexOf` five times.
    const t5 = line.lastIndexOf('\t');
    if (t5 < 0) continue;
    const t4 = line.lastIndexOf('\t', t5 - 1);
    if (t4 < 0) continue;
    const t3 = line.lastIndexOf('\t', t4 - 1);
    if (t3 < 0) continue;
    const t2 = line.lastIndexOf('\t', t3 - 1);
    if (t2 < 0) continue;
    const t1 = line.lastIndexOf('\t', t2 - 1);
    if (t1 < 0) continue;

    const path = line.slice(0, t1);
    const md5 = line.slice(t1 + 1, t2);
    const sha1 = line.slice(t2 + 1, t3);
    const sizeStr = line.slice(t3 + 1, t4);
    const diskSizeStr = line.slice(t4 + 1, t5);
    const mtimeStr = line.slice(t5 + 1);

    if (!isHexLength(md5, 32)) continue;
    if (!isHexLength(sha1, 40)) continue;
    const size = Number.parseInt(sizeStr, 10);
    if (!Number.isFinite(size) || size < 0) continue;
    const diskSize = Number.parseInt(diskSizeStr, 10);
    if (!Number.isFinite(diskSize) || diskSize < 0) continue;
    const mtime = Number.parseInt(mtimeStr, 10);
    if (!Number.isFinite(mtime) || mtime < 0) continue;

    out.push({ path, md5, sha1, size, diskSize, mtime });
  }
  return out;
}

function isHexLength(s: string, n: number): boolean {
  if (s.length !== n) return false;
  for (let i = 0; i < n; i += 1) {
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
