import type { SystemFileMark, SystemFilesMarks } from '@shared/types';

/**
 * Heredoc delimiter used by the real client when writing the marks file
 * over SSH. Mirrors the ledger's pattern — exported so the serializer can
 * hard-fail before producing a payload that would prematurely terminate
 * the heredoc on the MiSTer.
 */
export const SYSTEM_FILES_HEREDOC_DELIMITER =
  'MISTERCURATOR_SYSTEM_FILES_EOF';

export const EMPTY_SYSTEM_FILES_MARKS: SystemFilesMarks = {
  schemaVersion: 1,
  marked: [],
};

/**
 * Lenient parser: empty input or malformed JSON yields an empty marks
 * file, because that's how a freshly-installed MiSTer presents itself.
 * Strict about *recognized-but-incompatible* shapes — an unknown schema
 * version throws so future-incompatible upgrades fail loudly instead of
 * silently dropping data.
 */
export function parseSystemFilesMarks(raw: string): SystemFilesMarks {
  const trimmed = raw.trim();
  if (trimmed === '') return EMPTY_SYSTEM_FILES_MARKS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY_SYSTEM_FILES_MARKS;
  }

  if (!isMarksObject(parsed)) {
    return EMPTY_SYSTEM_FILES_MARKS;
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `System-files marks have an unsupported schemaVersion (${String(parsed.schemaVersion)}). ` +
        `This MiSTer was probably written by a newer version of MiSTerCurator — ` +
        `update before continuing.`,
    );
  }
  return parsed;
}

/**
 * Serializes the marks file to pretty JSON. Hard-fails if the payload
 * would collide with the SSH heredoc delimiter — same defense the
 * ledger uses.
 */
export function serializeSystemFilesMarks(marks: SystemFilesMarks): string {
  const json = `${JSON.stringify(marks, null, 2)}\n`;
  if (json.includes(SYSTEM_FILES_HEREDOC_DELIMITER)) {
    throw new Error(
      `Refusing to write the system-files marks: payload contains the heredoc ` +
        `delimiter '${SYSTEM_FILES_HEREDOC_DELIMITER}'. Rename or remove the offending ` +
        `entry and try again.`,
    );
  }
  return json;
}

/**
 * Returns true iff `(coreId, filename)` is in the marks list. coreId is
 * matched case-insensitively to mirror the ledger's case-tolerance for
 * a renamed core; filename is matched exactly because filesystems are
 * case-sensitive on the MiSTer.
 */
export function isMarked(
  marks: SystemFilesMarks,
  coreId: string,
  filename: string,
): boolean {
  const lowerCore = coreId.toLowerCase();
  return marks.marked.some(
    (m) => m.coreId.toLowerCase() === lowerCore && m.filename === filename,
  );
}

/**
 * Adds a mark. Idempotent — re-marking an already-marked file leaves
 * the list unchanged (the original `markedAt` wins).
 */
export function withMark(
  marks: SystemFilesMarks,
  entry: SystemFileMark,
): SystemFilesMarks {
  if (isMarked(marks, entry.coreId, entry.filename)) return marks;
  return { ...marks, marked: [...marks.marked, entry] };
}

/**
 * Removes a mark identified by `(coreId, filename)`. Idempotent —
 * removing a non-existent mark is a no-op. coreId is compared
 * case-insensitively (consistency with `isMarked`); filename exactly.
 */
export function withoutMark(
  marks: SystemFilesMarks,
  coreId: string,
  filename: string,
): SystemFilesMarks {
  const lowerCore = coreId.toLowerCase();
  const filtered = marks.marked.filter(
    (m) => !(m.coreId.toLowerCase() === lowerCore && m.filename === filename),
  );
  if (filtered.length === marks.marked.length) return marks;
  return { ...marks, marked: filtered };
}

/**
 * Structural equality for two marks files. Lets callers skip a rewrite
 * when an update was a no-op. Order-sensitive because we don't promise
 * a particular sort.
 */
export function marksEqual(a: SystemFilesMarks, b: SystemFilesMarks): boolean {
  if (a === b) return true;
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.marked.length !== b.marked.length) return false;
  for (let i = 0; i < a.marked.length; i += 1) {
    const ea = a.marked[i]!;
    const eb = b.marked[i]!;
    if (ea.coreId !== eb.coreId) return false;
    if (ea.filename !== eb.filename) return false;
    if (ea.markedAt !== eb.markedAt) return false;
  }
  return true;
}

function isMarksObject(v: unknown): v is SystemFilesMarks {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') return false;
  if (!Array.isArray(obj.marked)) return false;
  return obj.marked.every(isMark);
}

function isMark(v: unknown): v is SystemFileMark {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.coreId === 'string' &&
    typeof obj.filename === 'string' &&
    typeof obj.markedAt === 'string'
  );
}
