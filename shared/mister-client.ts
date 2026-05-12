import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';
import type { SizeAndMtime, WitnessMtimes } from '@shared/prime-parse';
import type {
  CoreEntry,
  FolderClassifications,
  FolderClassificationOverride,
  HideLedger,
  MisterProfile,
  Rom,
  SystemFilesMarks,
} from '@shared/types';

/**
 * Output of `primeConnect` — the data the ConnectionManager needs in
 * one round trip on a fresh session. Mirrors what the pre-PR-#12 code
 * fetched in three sequential SSH calls.
 */
export interface PrimeConnectResult {
  readonly ledger: HideLedger;
  readonly marks: SystemFilesMarks;
  readonly classifications: FolderClassifications;
  /**
   * Mtime epoch per cores-cache witness path. The caller compares
   * these against `cores.json`'s recorded witnesses to decide hit /
   * stale. Missing-on-device paths report mtime 0 — `witnessesMatch`
   * already treats 0 as a mismatch.
   */
  readonly witnesses: WitnessMtimes;
}

export type MisterSecret =
  | { readonly type: 'key'; readonly privateKey: string }
  | { readonly type: 'password'; readonly password: string };

export interface RomVisibilityChange {
  readonly filename: string;
  readonly hidden: boolean;
}

/**
 * A single core-visibility change in a batched operation. The full
 * CoreEntry is passed (not just an id) so the implementation can
 * short-circuit no-ops without a lookup round-trip.
 */
export interface CoreVisibilityChange {
  readonly core: CoreEntry;
  readonly hidden: boolean;
}

/**
 * Per-rom result of a batched ROM visibility operation. Bulk ROM
 * operations do NOT abort on first failure: each rename runs
 * independently, and a partial failure produces a partial result rather
 * than throwing. The caller surfaces whichever toast variant matches.
 */
export interface BulkRomResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly filename: string; readonly reason: string }[];
}

/**
 * Per-core result of a batched core-visibility operation. A core is
 * considered "succeeded" only if every rename it owned (games dir +
 * each matching .rbf / .mgl) committed. Any rename failure within a
 * core marks that core as failed (and leaves the ledger entry for it
 * untouched in ConnectionManager).
 */
export interface BulkCoreResult {
  readonly succeeded: readonly string[];
  readonly failed: readonly { readonly coreId: string; readonly reason: string }[];
}

/**
 * One progress tick during a bulk core-visibility operation. The real
 * client emits these from the SSH stream as each per-core subshell
 * completes; the fake client synthesises them per plan. Renderer-side
 * the events drive the StatusBar progress bar.
 *
 * `done` is 1-based and includes the just-completed core. `total` is
 * the number of plans the client actually attempted (no-ops are
 * filtered upstream).
 */
export interface BulkCoreProgress {
  readonly done: number;
  readonly total: number;
  readonly coreId: string;
  readonly result: 'ok' | 'fail';
  /** Single-line failure reason — present iff `result === 'fail'`. */
  readonly reason?: string;
}

export interface BulkCoreOptions {
  /**
   * Per-core progress callback. Invoked from inside the client as soon
   * as a line is parsed from the SSH stream — there's no buffering, so
   * the renderer sees ticks roughly in real time. Throws are swallowed
   * (the bulk op continues regardless of UI state).
   */
  readonly onProgress?: (event: BulkCoreProgress) => void;
}

export interface IMisterClient {
  connect(profile: MisterProfile, secret: MisterSecret): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;

  /**
   * Subscribe to mid-session "unexpected disconnect" events. Fires when
   * the underlying SSH transport drops on its own — host rebooted,
   * network blip, etc. — *not* during initial connect, and *not*
   * during a clean `disconnect()`. The listener fires at most once per
   * `connect()` call. Returns an unsubscribe function.
   */
  onUnexpectedDisconnect(listener: () => void): () => void;

  /**
   * Lists every core the device knows about — joined across `_Console`,
   * `_Computer`, `_Other`, `_Utility`, `_Arcade` and `games/`. Replaces
   * the older `listCores()` which only saw `games/` subdirectories.
   *
   * `systemFilesMarks` is an optional layer over the auto-detector
   * heuristic. When supplied, files and folders the user has marked as
   * system for a given core are excluded from each `CoreEntry`'s
   * `romCount` / `hiddenCount` exactly like auto-detected BIOSes. The
   * caller (ConnectionManager) typically caches the marks once per
   * connection and passes them on every list call.
   */
  listAllCoresWithFiles(
    systemFilesMarks?: SystemFilesMarks,
  ): Promise<CoreEntry[]>;

  /**
   * List the ROM-shaped entries at `<coreDir>/<subPath>`. With no
   * `subPath` (or `''`) returns top-level entries. With a subPath like
   * `'1 World A-Z'` returns the contents of that container folder.
   * Folder entries get classified via the auto-detector heuristic +
   * the user-supplied overrides; the resulting `kind` field tells the
   * renderer whether it's drillable.
   */
  listRoms(
    coreId: string,
    subPath?: string,
    folderClassifications?: FolderClassifications,
  ): Promise<Rom[]>;

  /**
   * PR-C round 2 (PR #26): list every ROM file in a core's games dir
   * recursively, filtered by the SAME predicate the sidebar count
   * uses (`shouldCountAsRom` + `isLaunchableRomExtension` from
   * `shared/folder-rom.ts`). Used by the auto-scrape engine to
   * queue every path that contributes to the sidebar's integer
   * count — pre-round-2 the engine queued only top-level files
   * from `listRoms`, so subfolder ROMs were never scraped and the
   * footer total never matched the sidebar.
   *
   * Returns full on-device paths (`/media/fat/games/<dir>/<rel>`)
   * so the engine can pass them straight to
   * `MetadataOrchestrator.getRomsMetadata`. Folder rows themselves
   * (folder-atomic / folder-container) don't appear here — the
   * engine sees only individual ROM files. Atomic-folder routing
   * (treat the folder's contained ROM as the folder's metadata
   * source) is deferred to PR-D1.
   */
  listRecursiveRomFiles(args: {
    readonly coreId: string;
    /**
     * On-disk basename of the games dir (with leading dot for
     * hidden cores). Resolved by ConnectionManager from the cores
     * cache so the client doesn't need its own coreId → games-dir
     * lookup.
     */
    readonly gamesDirBasename: string;
    readonly marks?: SystemFilesMarks;
  }): Promise<readonly string[]>;

  /**
   * feat/arcade-mra-management Phase 1: walk `_Arcade/` and emit
   * one raw `{type, relPath}` row per filesystem entry under it
   * (recursive, bounded depth). Called by the renderer-facing
   * arcade listing IPC; the shared `parseArcadeMraEntries` filter
   * turns the raw rows into typed entries (`.mra` files,
   * subfolders, with hidden state).
   *
   * Returns an empty list when `_Arcade/` doesn't exist on the
   * device — same shape as `listRecursiveRomFiles` for missing
   * games dirs.
   */
  listArcadeRawListing(): Promise<
    readonly { readonly type: 'f' | 'd'; readonly relPath: string }[]
  >;

  /**
   * feat/arcade-playability-data (PR 1/2) — extract the load-bearing
   * slice (relativePath, zip-attr blocks, rbf, setname) of every
   * top-level `.mra` under `_Arcade/` in one SSH round-trip.
   *
   * Top-level only — entries under `_alternatives/` and other
   * subfolders are deferred to a follow-up; this PR's scope is the
   * 1000-ish .mras the firmware actually surfaces in the arcade menu.
   *
   * Server-side parsing keeps the wire payload tiny (~200KB vs
   * ~7-9MB if we shipped each .mra head over the wire). The Real
   * client implementation drops a one-shot awk script in
   * `MISTER_AGENT_DIR` and removes it before returning.
   *
   * Returns an empty list when `_Arcade/` doesn't exist on the
   * device — same shape as `listArcadeRawListing` for that case.
   */
  parseArcadeMras(): Promise<readonly ArcadeMraMeta[]>;

  /**
   * feat/arcade-playability-data (PR 1/2) — list every `.zip` basename
   * under both `games/mame/` and `games/hbmame/` in a single SSH
   * round-trip. Used to decide which .mra entries reference a zip
   * that actually exists on disk.
   *
   * MAME-side and HBMAME-side namespaces are flat (no subdirs the
   * MiSTer loader looks at) so a `-maxdepth 1` walk is sufficient.
   * Duplicates across the two dirs are deduped by the caller.
   *
   * Returns an empty list when neither dir exists.
   */
  listArcadeZipBasenames(): Promise<readonly string[]>;

  /**
   * Toggle the visibility of one ROM at `<coreDir>/<subPath>/<filename>`.
   * `subPath` defaults to the empty string (top-level); pass it when
   * the user is operating inside a drilled-in container.
   */
  setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath?: string,
  ): Promise<void>;

  /**
   * Apply many ROM visibility changes in a single batched SSH call.
   * Per-rename results are aggregated and returned — a single failed
   * `mv` does NOT abort the batch (defensive against races, perms,
   * etc). The caller decides how to react.
   */
  setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
    subPath?: string,
  ): Promise<BulkRomResult>;

  /**
   * feat/arcade-phase-1.5 — toggle a single `.mra` file's
   * visibility under `MISTER_ARCADE_DIR`. `relativePath` is the
   * path relative to `_Arcade/` (e.g. `_Konami/TMNT.mra` for
   * subfolder entries, `Metal Slug.mra` for top-level). Same
   * dot-prefix hide convention as ROM files.
   *
   * Distinct from `setRomVisibility` because the base directory is
   * different — `setRomVisibility` always targets
   * `MISTER_GAMES_DIR/<coreId>` and a synthetic 'arcade' coreId
   * would route to `/media/fat/games/arcade/` (wrong).
   */
  setArcadeMraVisibility(
    relativePath: string,
    hidden: boolean,
  ): Promise<void>;

  /**
   * feat/arcade-phase-1.5 — bulk variant. Same chunking as
   * `setBulkRomVisibility` (PR #30): the batch is split into
   * groups of 100 paths per SSH `execCommand` to stay under
   * dropbear's exec channel buffer.
   */
  setBulkArcadeMraVisibility(
    changes: readonly { readonly relativePath: string; readonly hidden: boolean }[],
  ): Promise<BulkRomResult>;

  /**
   * Hide a single core: rename its games dir AND every matching rbf
   * (file or folder) to dot-prefixed form, atomically in one SSH call.
   * No-op (zero SSH calls) when the core is already fully hidden.
   * Refuses to operate on arcade cores.
   */
  hideCore(core: CoreEntry): Promise<void>;
  showCore(core: CoreEntry): Promise<void>;

  /**
   * Apply many core-visibility changes in a single batched SSH call.
   * Each core's renames run inside a `set -e` subshell so the core
   * itself is atomic, but a failure in one core does NOT abort the
   * other cores in the batch. Per-core results are returned.
   *
   * No-op changes (already in desired state) are skipped silently. If
   * every change is a no-op, zero SSH calls are issued and the result
   * is `{ succeeded: [], failed: [] }`.
   */
  setBulkCoreVisibility(
    changes: readonly CoreVisibilityChange[],
    options?: BulkCoreOptions,
  ): Promise<BulkCoreResult>;

  /**
   * Read and parse the on-MiSTer hide ledger
   * (`/media/fat/.mistercurator/state.json`). Returns the empty ledger
   * if the file is missing or empty.
   */
  readHideLedger(): Promise<HideLedger>;

  /**
   * Atomically (re)write the ledger via a temp file + rename.
   */
  writeHideLedger(ledger: HideLedger): Promise<void>;

  /**
   * Read and parse the on-MiSTer user-marked system-files list
   * (`/media/fat/.mistercurator/system-files.json`). Returns the empty
   * marks object if the file is missing or empty. The marks file
   * extends the auto-detector heuristic — files appearing here are
   * treated as system content for that specific core.
   */
  readSystemFilesMarks(): Promise<SystemFilesMarks>;

  /**
   * Mark a single `(coreId, filename)` pair as a user-defined system
   * file. Idempotent at the persistence layer — re-marking is a
   * silent no-op. The implementation reads-modifies-writes the marks
   * file in one logical operation; concurrent writers are not expected
   * (the renderer is single-threaded against one MiSTer).
   */
  addSystemFileMark(coreId: string, filename: string): Promise<void>;

  /**
   * Remove a user-defined system-file mark. Idempotent — removing a
   * non-existent mark is a silent no-op. Auto-detected system files
   * are not affected (they're heuristic, not stored).
   */
  removeSystemFileMark(coreId: string, filename: string): Promise<void>;

  /**
   * Apply many mark / unmark changes to one core in a single
   * read-modify-write of the marks file. Used by the multi-select
   * "Mark selected as system" / "Unmark selected" actions so a 50-row
   * batch is one SSH round-trip, not 50.
   *
   * Idempotent per change — already-marked / already-unmarked entries
   * pass through with no further work. If every change is a no-op the
   * implementation may skip the write entirely.
   */
  setSystemFileMarks(
    coreId: string,
    changes: readonly SystemFileMarkChange[],
  ): Promise<void>;

  /**
   * Read and parse the on-MiSTer folder-classifications file
   * (`/media/fat/.mistercurator/folder-classifications.json`). Returns
   * the empty marks object if the file is missing or empty. Used by
   * `listRoms` to apply user overrides on top of the auto-detector.
   */
  readFolderClassifications(): Promise<FolderClassifications>;

  /**
   * Set or remove a per-folder classification override. `classification`
   * of `undefined` removes any existing override. Idempotent at the
   * persistence layer.
   */
  setFolderClassification(
    override: FolderClassificationOverride | { coreId: string; folderPath: string; classification: undefined },
  ): Promise<void>;

  /**
   * PR #12 connect-time prime. One SSH round trip that returns the
   * three small JSON files (ledger / marks / classifications) AND a
   * batch of cores-cache witness mtimes. Replaces three sequential
   * `cat`s + a stat call with a single command — load-bearing for the
   * <1s warm-connect performance contract.
   */
  primeConnect(coresWitnessPaths: readonly string[]): Promise<PrimeConnectResult>;

  /**
   * Stat the supplied absolute paths and return mtime epochs in one
   * shell round trip. Used by the listRoms cache (one path per call:
   * `/media/fat/games/<coreId>` or a sub-path) and by write-through
   * post-mutation refreshes.
   *
   * Paths that don't exist on the device map to mtime 0; the caller
   * treats that as a mismatch via `witnessesMatch`.
   */
  statWitnesses(paths: readonly string[]): Promise<WitnessMtimes>;

  /**
   * fix/count-and-status-indicator commit 4 — stat (size + mtime)
   * for a batch of absolute file paths in one SSH round-trip. Used
   * by the hash-cache v3→v4 lazy migration to populate the new
   * `diskSizeBytes` field WITHOUT re-running `unzip -p | md5sum`
   * across thousands of cached entries.
   *
   * Paths that don't exist or aren't regular files come back with
   * `{ size: 0, mtime: 0 }` so the caller can spot the miss.
   */
  statPathsWithSize(
    paths: readonly string[],
  ): Promise<Record<string, SizeAndMtime>>;

  /**
   * Compute md5 + sha1 + size for a batch of absolute file paths in
   * one SSH round-trip. PR #16 round 2 expanded this from md5-only
   * to multi-hash so ScreenScraper can match on either algorithm.
   *
   * Implementations should cap their internal batch size at ~100 paths
   * to stay safely under argv limits across busybox shells; the caller
   * (HashService) chunks larger inputs accordingly. The return order is
   * NOT guaranteed to match the input order — match by `path`.
   *
   * Paths that don't exist or aren't regular files are silently
   * dropped from the result (no entry returned). The caller decides
   * whether a missing path is a problem.
   *
   * `.zip`-wrapped paths get the inner content hashed (via `unzip -p`
   * on-device) — the zip wrapper bytes never reach a hash. mtime is
   * captured against the wrapper, not the inner file.
   */
  hashPaths(paths: readonly string[]): Promise<readonly HashRecord[]>;

  /**
   * feat/sample-based-hashing — compute the sample-md5 fingerprint
   * for each path. The fingerprint is
   *   `md5(head 64KB ++ tail 64KB ++ size as 16-char hex)`
   * over the wrapper bytes (NOT the extracted .zip content). Used
   * by `HashService` to fast-validate cached entries whose mtimes
   * drifted: if the sample matches the cached sample, the file is
   * almost certainly unchanged and the cached full md5 still holds.
   *
   * Implementations cap their internal batch at ~100 paths to stay
   * under busybox argv limits; the caller chunks larger inputs.
   * Paths that vanish or can't be stat'd mid-batch are silently
   * dropped from the result map — the caller treats absence as a
   * sample miss.
   *
   * Returns a `path → 32-char-hex-md5` map. Order is not preserved.
   */
  computeSampleMd5s(
    paths: readonly string[],
  ): Promise<Record<string, string>>;
}

/**
 * One per-file result from `hashPaths`.
 *   - md5: 32-char lowercase hex
 *   - sha1: 40-char lowercase hex
 *   - size: bytes of the (extracted) ROM content; for .zip wrappers
 *     this is the inner-file size, for direct files the wrapper size.
 *     This is what ScreenScraper's `romtaille` expects.
 *   - diskSize: bytes of the wrapper file on disk (`stat -c %s`). For
 *     non-archive paths this equals `size`; for .zip wrappers this is
 *     the compressed wrapper size, distinct from the extracted `size`.
 *     Surfaces the user-visible "what does the file system say this
 *     is?" answer alongside the SS-matching extracted size.
 *   - mtime: epoch seconds of the wrapper file (cache invalidation
 *     key — what the user actually touches)
 */
export interface HashRecord {
  readonly path: string;
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
  readonly diskSize: number;
  readonly mtime: number;
}

/**
 * One element of a bulk mark/unmark batch. `marked: true` adds the
 * mark; `false` removes it. Filenames are matched against the marks
 * file exactly (the filesystem is case-sensitive).
 */
export interface SystemFileMarkChange {
  readonly filename: string;
  readonly marked: boolean;
}
