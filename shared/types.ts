export interface MisterProfile {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: 'key' | 'password';
  readonly keyPath?: string;
  /**
   * When true, on each successful connect the app reads the on-MiSTer hide
   * ledger and re-applies any cores that have been un-hidden externally
   * (typically by a MiSTer update that re-deployed the .rbf or games dir).
   *
   * Treated as `false` when undefined — older profiles persisted before
   * this field existed remain opt-out without a migration step.
   */
  readonly autoReapplyHides?: boolean;
}

export type CoreCategory = 'Console' | 'Computer' | 'Other' | 'Utility' | 'Arcade' | 'Unknown';

/**
 * Everything the renderer needs to know about a core. Replaces the older
 * games-dir-only `Core` type — `CoreEntry` now also covers cores that have
 * a .rbf but no games directory, folder-shaped cores under `_Computer/`,
 * arcade cores (read-only), and the orphan-games-dir edge case
 * (`category: 'Unknown'`).
 *
 * Counts (`romCount`, `hiddenCount`) are zero when `gamesDirExists` is
 * false. `rbfPaths` lists every matching .rbf / .mgl file or folder-shaped
 * core directory; multiple versions of the same core map to multiple
 * entries in this list.
 */
export interface CoreEntry {
  readonly id: string;
  readonly name: string;
  readonly romCount: number;
  readonly hiddenCount: number;
  /**
   * Approximate total ROM count across the games dir, walking into
   * container folders (NEOGEO's `1 World A-Z`, MegaDrive's `EUR`, ...)
   * and treating atomic disc folders (Saturn, MegaCD) as a single ROM.
   * The cores-list density indicator and the "9 folders · ~300 ROMs"
   * breadcrumb both consume this. May be 0 (empty core, externally
   * hidden) or undefined (legacy data, computed-on-demand surfaces).
   *
   * Approximate by design — recursive walks can over- or under-count
   * depending on non-standard ROM extensions or unusual nesting. The
   * UI prefixes the value with `~` when displaying it.
   */
  readonly recursiveRomCount?: number;
  /** Hidden subset of `recursiveRomCount`. Same approximation rules. */
  readonly recursiveHiddenCount?: number;
  readonly category: CoreCategory;
  readonly rbfPaths: readonly string[];
  readonly gamesDirExists: boolean;
  readonly gamesDirHidden: boolean;
  /**
   * On-disk basename of the games directory in its undotted (visible) form,
   * preserved exactly as it appears on the device. Set whenever
   * `gamesDirExists` is true. Distinct from `id` to handle case mismatches
   * between the .rbf prefix and the games dir name (e.g. `.Apogee*.rbf`
   * paired with `games/.APOGEE`).
   */
  readonly gamesDirName?: string;
}

export interface Rom {
  readonly coreId: string;
  readonly filename: string;
  readonly displayName: string;
  readonly sizeBytes: number;
  readonly hidden: boolean;
  readonly path: string;
  /**
   * 'file'             — single-file ROM (typical NES/SNES cartridge dump).
   * 'folder-atomic'    — multi-file disc dump where the directory IS one
   *                      game (Saturn / MegaCD / X68000). Hide/show
   *                      operates on the directory itself.
   * 'folder-container' — organisational subfolder that groups many
   *                      playable games (NEOGEO's `1 World A-Z`,
   *                      MegaDrive's `EUR`, etc). Drillable in the UI;
   *                      hide/show on the container moves the whole tree.
   * Folder ROMs of either flavour are renamed with a leading dot just
   * like file ROMs when hidden.
   */
  readonly kind: 'file' | 'folder-atomic' | 'folder-container';
  /**
   * Path within the core's games dir. Empty for top-level entries
   * (`/media/fat/games/<coreId>/<filename>`); slash-joined for nested
   * entries when listing inside a container folder. The renderer uses
   * this for breadcrumb display and to thread back into IPC calls.
   */
  readonly relativePath?: string;
  /**
   * PR-D1 (PR #27): for `kind === 'folder-atomic'` rows ONLY — the
   * full on-device path of the alphabetical-first launchable ROM
   * file inside the folder. Lets the renderer look up metadata
   * keyed by the contained file's hash so the folder row displays
   * the contained game's box art (with a folder badge overlay).
   *
   * Undefined for `'file'` rows (the rom IS the file) and for
   * `'folder-container'` rows (multi-game folders need drill-in,
   * not direct binding). Undefined for atomic folders that don't
   * contain a launchable file (defensive — renderer falls back to
   * the ImageOff + badge presentation in that case).
   *
   * "Alphabetical-first" is the picker for atomic folders with
   * multiple launchable files (rare). Documented; PR-D2's manual
   * override surfaces the wrong-pick correction path.
   */
  readonly containedRomPath?: string;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type ConnectionErrorCode = 'unreachable' | 'auth_failed' | 'not_a_mister' | 'unknown';

export interface ConnectionError {
  readonly code: ConnectionErrorCode;
  readonly message: string;
}

export class MisterConnectionError extends Error implements ConnectionError {
  readonly code: ConnectionErrorCode;

  constructor(code: ConnectionErrorCode, message: string) {
    super(message);
    this.name = 'MisterConnectionError';
    this.code = code;
  }
}

/**
 * One entry in the on-MiSTer hide ledger.
 *
 * `rbfPaths` snapshots the .rbf files / folder-shaped core directories that
 * were hidden alongside the games dir. We re-record them rather than
 * recompute on auto-reapply so a core that picked up a fresh .rbf after a
 * MiSTer update is still re-hidden using the *current* matching rbfs at
 * apply time, not stale ones from when it was first hidden.
 */
export interface HiddenCoreEntry {
  readonly coreId: string;
  readonly gamesDirHidden: boolean;
  /**
   * On-disk basename (undotted form) of the games dir at the time of hide.
   * Lets us un-hide a case-mismatched dir later (e.g. games/.APOGEE while
   * the canonical id is `Apogee`). Defaults to coreId when absent.
   */
  readonly gamesDirName?: string;
  readonly rbfPaths: readonly string[];
  readonly hiddenAt: string;
}

export interface HideLedger {
  readonly schemaVersion: 1;
  readonly hiddenCores: readonly HiddenCoreEntry[];
}

/**
 * One entry in the user-marked system files list. Mirrors the shape of
 * `HiddenCoreEntry`: identified by `(coreId, filename)`, timestamped at
 * mark time. The auto-detector heuristic (`isSystemFile`) is the floor;
 * this list lets the user *expand* what's treated as system-content to
 * cover the long tail (`pal.act`, `Empty.d64`, `DolphinDOS_2.0.rom`,
 * etc) that the heuristic refuses to chase.
 */
export interface SystemFileMark {
  readonly coreId: string;
  readonly filename: string;
  readonly markedAt: string;
}

export interface SystemFilesMarks {
  readonly schemaVersion: 1;
  readonly marked: readonly SystemFileMark[];
}

/**
 * One user override of a folder ROM's auto-classification. The
 * heuristic in `shared/folder-rom.ts` decides every connection from
 * folder contents; this list lets the user pin a specific
 * `(coreId, folderPath)` to `'container'` or `'atomic'`.
 */
export interface FolderClassificationOverride {
  readonly coreId: string;
  /**
   * Slash-joined path relative to the core's games dir. A top-level
   * folder is `'<name>'`; a nested folder is `'<parent>/<child>'`.
   */
  readonly folderPath: string;
  readonly classification: 'container' | 'atomic';
  readonly setAt: string;
}

export interface FolderClassifications {
  readonly schemaVersion: 1;
  readonly overrides: readonly FolderClassificationOverride[];
}
