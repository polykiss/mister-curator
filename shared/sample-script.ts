/**
 * feat/sample-based-hashing — script + parser for
 * `IMisterClient.computeSampleMd5s`.
 *
 * The sample-md5 is a cheap fingerprint of one path:
 *   `md5(head 64KB ++ tail 64KB ++ size as 16-char hex string)`
 * Over the WRAPPER bytes (not the extracted .zip content). Used by
 * `HashService` to fast-validate cached entries whose mtimes drifted
 * past the ±2s tolerance window. A matching sample means "almost
 * certainly the same file" and lets the cache hold onto its
 * authoritative full md5 without a 10-40-minute re-hash.
 *
 * Output line shape (2 tab-separated fields):
 *   `<path>\t<md5hex>\n`
 *
 * Paths that can't be stat'd (vanished, permission denied, etc.)
 * don't emit a line — `parseSampleOutput` simply sees fewer rows
 * than were sent in. The caller treats absence as "couldn't
 * sample" and falls through to the full-rehash path.
 *
 * ─── BusyBox dd recipe ────────────────────────────────────────────
 *
 * Per path:
 *   sz = stat -c %s "$f"
 *   tskip = max(0, ceil(sz / 65536) - 1)
 *   sample = md5sum <(dd bs=65536 count=1; dd bs=65536 skip=$tskip count=1; printf '%016x' $sz)
 *
 * Verified on the user's MiSTer (busybox `dd` build) — `bs=`,
 * `skip=`, `count=` behave as standard. Last byte of file flips
 * the sample because the tail block always includes it (the
 * formula reads the LAST partial block when size doesn't divide
 * evenly into 64KB chunks).
 *
 * Known limitation: a file modified ONLY in its middle bytes
 * (between the head and tail windows) won't be caught by the
 * sample. Vanishingly rare for ROM files — the typical mtime-
 * drift case is a wholesale ROM redeploy where content is
 * byte-identical to the cached version. The full md5 is the
 * source of truth; sample is a fast revalidation gate.
 */

const SAMPLE_BLOCK_SIZE = 65536;
const SAMPLE_BLOCK_SIZE_STR = String(SAMPLE_BLOCK_SIZE);

export function buildSampleScript(paths: readonly string[]): string {
  // Same `set --` + `for f in "$@"` idiom as `buildHashScript`. The
  // body is small and the SD card I/O is bounded — at most 128KB
  // read per path — so a batch of 100 paths is ~12.5MB of reads
  // total, well under a single-second wall on the typical Nano
  // even with USB-attached storage.
  const setLine = `set -- ${paths.map(shellQuote).join(' ')}`;
  return [
    setLine,
    'for f in "$@"; do',
    '  if [ -f "$f" ]; then',
    '    sz=$(stat -c %s "$f" 2>/dev/null)',
    '    if [ -n "$sz" ]; then',
    `      tskip=$(( (sz + ${SAMPLE_BLOCK_SIZE_STR} - 1) / ${SAMPLE_BLOCK_SIZE_STR} - 1 ))`,
    '      [ "$tskip" -lt 0 ] && tskip=0',
    '      sample=$( {',
    `        dd if="$f" bs=${SAMPLE_BLOCK_SIZE_STR} count=1 2>/dev/null;`,
    `        dd if="$f" bs=${SAMPLE_BLOCK_SIZE_STR} skip=$tskip count=1 2>/dev/null;`,
    "        printf '%016x' \"$sz\";",
    "      } | md5sum 2>/dev/null | cut -d' ' -f1 )",
    '      if [ -n "$sample" ]; then',
    "        printf '%s\\t%s\\n' \"$f\" \"$sample\"",
    '      fi',
    '    fi',
    '  fi',
    'done',
  ].join('\n');
}

/**
 * Parse the TSV output into a `path → md5` map. Order is not
 * preserved (the device-side loop emits in argv order today, but
 * the caller shouldn't rely on it — Map iteration matches the
 * shell's emission order in any case).
 *
 * Rejects malformed rows defensively (wrong field count, non-hex
 * md5, empty path). Each rejection silently drops the row; the
 * caller treats absence as a sample miss.
 */
export function parseSampleOutput(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    // Paths can contain tabs (rare but legal POSIX). The single
    // trailing field is the 32-char hex md5; split from the right.
    const t = line.lastIndexOf('\t');
    if (t < 0) continue;
    const path = line.slice(0, t);
    const md5 = line.slice(t + 1);
    if (path === '') continue;
    if (!isMd5Hex(md5)) continue;
    out[path] = md5;
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

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Compute the sample-md5 for a buffer of raw bytes. Pure helper —
 * used by `FakeMisterClient` to mirror the on-device shell recipe
 * exactly, and by tests to construct expected fingerprints from
 * known content.
 *
 * `digester` is injected (typically `node:crypto`'s `createHash`)
 * to keep this module browser-bundle-compatible — `shared/` code
 * can't import Node built-ins.
 */
export function buildSampleInput(bytes: Buffer | Uint8Array): Buffer {
  // Node Buffer construction from a typed array shares storage —
  // safe because we only read from `bytes` below.
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const size = buf.length;
  const head = buf.subarray(0, Math.min(SAMPLE_BLOCK_SIZE, size));
  // Tail block start matches the device-side formula:
  //   tskip = max(0, ceil(size/65536) - 1)
  //   tail_offset = tskip * 65536
  // For size <= 65536 this is 0; tail block aliases head block.
  // For size = 200KB (3.125 blocks): tskip = 3, tail starts at
  // 196608, reads up to 204800 (8192 bytes). Matches dd behaviour.
  let tskip = Math.max(0, Math.ceil(size / SAMPLE_BLOCK_SIZE) - 1);
  if (size === 0) tskip = 0;
  const tailStart = tskip * SAMPLE_BLOCK_SIZE;
  const tailLen = Math.min(SAMPLE_BLOCK_SIZE, size - tailStart);
  const tail =
    tailLen > 0 ? buf.subarray(tailStart, tailStart + tailLen) : Buffer.alloc(0);
  const sizeHex = Buffer.from(size.toString(16).padStart(16, '0'), 'utf8');
  return Buffer.concat([head, tail, sizeHex]);
}
