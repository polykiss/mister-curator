/**
 * User-supplied per-folder classification overrides. Sibling concept to
 * the system-files marks file — auto-detection (here, the
 * `classifyFolder` heuristic) is the floor; this file lets the user
 * override it for the long tail.
 *
 * Storage: `/media/fat/.mistercurator/folder-classifications.json`.
 */

import type { FolderClassifications, FolderClassificationOverride } from '@shared/types';

export const FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER =
  'MISTERCURATOR_FOLDER_CLASSIFICATIONS_EOF';

export const EMPTY_FOLDER_CLASSIFICATIONS: FolderClassifications = {
  schemaVersion: 1,
  overrides: [],
};

/**
 * Lenient parser. Empty/malformed input → empty file. Unknown
 * schemaVersion throws to fail loudly on a forward-incompatible
 * upgrade — same policy as the ledger.
 */
export function parseFolderClassifications(raw: string): FolderClassifications {
  const trimmed = raw.trim();
  if (trimmed === '') return EMPTY_FOLDER_CLASSIFICATIONS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY_FOLDER_CLASSIFICATIONS;
  }

  if (!isClassificationsObject(parsed)) {
    return EMPTY_FOLDER_CLASSIFICATIONS;
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Folder classifications has an unsupported schemaVersion (${String(parsed.schemaVersion)}). ` +
        `This MiSTer was probably written by a newer version of MiSTerCurator — ` +
        `update before continuing.`,
    );
  }
  return parsed;
}

export function serializeFolderClassifications(
  marks: FolderClassifications,
): string {
  const json = `${JSON.stringify(marks, null, 2)}\n`;
  if (json.includes(FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER)) {
    throw new Error(
      `Refusing to write folder classifications: payload contains the heredoc ` +
        `delimiter '${FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER}'. Rename or remove ` +
        `the offending entry and try again.`,
    );
  }
  return json;
}

/**
 * Returns the user's per-folder override if any. coreId match is
 * case-insensitive (consistency with the ledger / system-files marks);
 * folderPath match is case-sensitive (filesystem semantics).
 *
 * `folderPath` is the path *within the core's games dir*, so a top-
 * level folder is `'<name>'`, a nested folder is `'<parent>/<child>'`.
 */
export function getFolderOverride(
  marks: FolderClassifications,
  coreId: string,
  folderPath: string,
): 'container' | 'atomic' | undefined {
  const lower = coreId.toLowerCase();
  for (const o of marks.overrides) {
    if (o.coreId.toLowerCase() === lower && o.folderPath === folderPath) {
      return o.classification;
    }
  }
  return undefined;
}

export function withFolderOverride(
  marks: FolderClassifications,
  override: FolderClassificationOverride,
): FolderClassifications {
  const lower = override.coreId.toLowerCase();
  const filtered = marks.overrides.filter(
    (o) =>
      !(o.coreId.toLowerCase() === lower && o.folderPath === override.folderPath),
  );
  return { ...marks, overrides: [...filtered, override] };
}

export function withoutFolderOverride(
  marks: FolderClassifications,
  coreId: string,
  folderPath: string,
): FolderClassifications {
  const lower = coreId.toLowerCase();
  const filtered = marks.overrides.filter(
    (o) => !(o.coreId.toLowerCase() === lower && o.folderPath === folderPath),
  );
  if (filtered.length === marks.overrides.length) return marks;
  return { ...marks, overrides: filtered };
}

export function folderClassificationsEqual(
  a: FolderClassifications,
  b: FolderClassifications,
): boolean {
  if (a === b) return true;
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.overrides.length !== b.overrides.length) return false;
  for (let i = 0; i < a.overrides.length; i += 1) {
    const ea = a.overrides[i]!;
    const eb = b.overrides[i]!;
    if (ea.coreId !== eb.coreId) return false;
    if (ea.folderPath !== eb.folderPath) return false;
    if (ea.classification !== eb.classification) return false;
    if (ea.setAt !== eb.setAt) return false;
  }
  return true;
}

function isClassificationsObject(v: unknown): v is FolderClassifications {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') return false;
  if (!Array.isArray(obj.overrides)) return false;
  return obj.overrides.every(isOverride);
}

function isOverride(v: unknown): v is FolderClassificationOverride {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.coreId === 'string' &&
    typeof obj.folderPath === 'string' &&
    (obj.classification === 'container' || obj.classification === 'atomic') &&
    typeof obj.setAt === 'string'
  );
}
