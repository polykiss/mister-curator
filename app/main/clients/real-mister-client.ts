import { NodeSSH } from 'node-ssh';

import { shellQuote } from '@app/main/clients/shell';
import {
  HIDEABLE_CATEGORIES,
  MISTER_AGENT_DIR,
  MISTER_ARCADE_DIR,
  MISTER_ARCADE_ZIP_DIRS,
  MISTER_CATEGORY_DIRS,
  MISTER_FOLDER_CLASSIFICATIONS_PATH,
  MISTER_GAMES_DIR,
  MISTER_LEDGER_DIR,
  MISTER_LEDGER_PATH,
  MISTER_SYSTEM_FILES_PATH,
  MISTER_UPDATE_SNAPSHOT_PATH,
} from '@shared/constants';
import {
  decodeArcadeMraTsv,
  type ArcadeMraMeta,
} from '@shared/arcade-mra-parse';
import {
  computeCoreRenames,
  extractCorePrefix,
  isCoreFile,
  isRealCore,
  matchRbfsToGamesDirs,
  type CoreRename,
  type RawGamesDirInput,
  type RawRbfInput,
  type RawSubFolderInput,
} from '@shared/core-matching';
import {
  diagLog,
  makeIdGen,
  truncateForLog,
} from '@shared/diag-log';
import {
  countRomGroups,
  isLaunchableRomExtension,
} from '@shared/folder-rom';
import { isOsMetadataDir, isOsMetadataFile } from '@shared/library-filter';
import { shouldCountAsRom } from '@shared/system-files';
import {
  InMemoryDiagnosticsCollector,
  type DiagRecord,
  type DiagReport,
} from '@shared/diag';
import { displayRomName } from '@shared/display';
import {
  EMPTY_FOLDER_CLASSIFICATIONS,
  getFolderOverride,
  parseFolderClassifications,
  serializeFolderClassifications,
  withFolderOverride,
  withoutFolderOverride,
} from '@shared/folder-classifications';
import { classifyFolder, resolveClassification } from '@shared/folder-rom';
import {
  healLedger,
  ledgerEqual,
  parseLedger,
  serializeLedger,
} from '@shared/ledger';
import {
  parseSystemFilesMarks,
  serializeSystemFilesMarks,
  withMark,
  withoutMark,
} from '@shared/system-files-marks';
import {
  buildHashScript,
  parseHashOutput,
} from '@shared/hash-script';
import { chunked } from '@shared/chunk';
import {
  buildSampleScript,
  parseSampleOutput,
} from '@shared/sample-script';
import {
  buildContentHashScript,
  buildPrimeScript,
  buildSizeAndMtimeScript,
  buildWitnessScript,
  parseContentHashOutput,
  parseSizeAndMtimeOutput,
  parsePrimeOutput,
  parseWitnessOutput,
  type SizeAndMtime,
} from '@shared/prime-parse';
import { DestinationAlreadyExistsError, MisterConnectionError } from '@shared/types';
import type {
  CoreCategory,
  CoreEntry,
  FolderClassificationOverride,
  FolderClassifications,
  HideLedger,
  MisterProfile,
  Rom,
  SystemFilesMarks,
} from '@shared/types';
import type {
  BulkCoreOptions,
  BulkCoreResult,
  BulkRomResult,
  CoreVisibilityChange,
  HashRecord,
  IMisterClient,
  MisterSecret,
  PrimeConnectResult,
  RomVisibilityChange,
  SystemFileMarkChange,
} from '@shared/mister-client';

const CONNECT_TIMEOUT_MS = 8000;

/**
 * Per-operation SSH timeout. PR #20 round 3 raised this 10s → 60s
 * after WiFi-attached MiSTers with larger libraries (~8k files)
 * tipped the original 10s ceiling on legitimate first-call work
 * (the connection-prime path stats every games dir, which on a slow
 * SD card + busybox + USB WiFi adapter genuinely takes longer than
 * 10s sometimes even when the underlying ssh / find calls each take
 * <2s). 60s catches a truly stuck transport without false-firing
 * on a busy-but-progressing MiSTer.
 *
 * Hash commands get a separate higher cap — see
 * `SSH_HASH_OP_TIMEOUT_MS` below.
 */
const SSH_OP_TIMEOUT_MS = 60_000;

/**
 * Hash-command timeout, raised separately from the default. Each
 * `hashPaths(N)` call streams every byte of N ROM files through
 * `unzip -p | md5sum/sha1sum/wc -c`. A single 32MB SNES ROM on a
 * slow SD card can take ~5s; a batch of 100 paths can run minutes
 * legitimately. 120s covers the realistic batch sizes the renderer
 * sends today (one prefetch per pane, capped at the visible ROM
 * count) without false-firing.
 */
const SSH_HASH_OP_TIMEOUT_MS = 120_000;

/**
 * Max number of rename ops per single SSH `execCommand` script in
 * `setBulkRomVisibility`. See the comment inside that method for the
 * dropbear-buffer-truncation incident this guards against. Exported
 * for the regression test that asserts the chunking math.
 */
export const BULK_ROM_RENAME_CHUNK_SIZE = 100;

/**
 * feat/sample-based-hashing — chunk size for `statWitnesses` and
 * `computeSampleMd5s`. Each method builds a single shell script
 * per chunk, and both grow ~linearly with path count. 100 paths
 * keeps the script under ~26 KB (vs ssh2's 32 KB default
 * exec-channel send window) and matches the existing
 * `BULK_ROM_RENAME_CHUNK_SIZE` precedent. Exported for the
 * regression tests that pin the chunking math.
 */
export const WITNESS_CHUNK_SIZE = 100;

/**
 * SSH-level keepalive cadence. ssh2 sends an empty keepalive packet
 * every `keepaliveInterval` ms; after `keepaliveCountMax` missed
 * responses the socket fires its own `'close'` / `'error'` event and
 * `RealMisterClient.handleUnexpectedDisconnect` kicks in.
 *
 * PR #20 round 3 widened this from 5s × 2 (10s detection) to
 * 15s × 4 (60s detection). The aggressive 10s cadence false-fired
 * on idle WiFi where intermittent latency spikes (6ms baseline →
 * 194ms transient per the live-test ping data) caused the keepalive
 * to miss two responses in a row even though the link was fine.
 * 60s before declaring the transport dead matches the per-op
 * timeout cap and lets normal WiFi jitter pass through.
 */
const SSH_KEEPALIVE_INTERVAL_MS = 15_000;
const SSH_KEEPALIVE_COUNT_MAX = 4;

/**
 * Marker error thrown by the per-op timeout race. Internal-only —
 * caught by `runSshOp` and converted to a typed
 * `MisterConnectionError` before it leaves the client. Carries the
 * actual timeout in ms so the user-facing error message reports the
 * right number for the call shape that fired.
 */
/**
 * Module-level SSH op-id generator (round 4). Each `runSshOp` /
 * `runSshStreamOp` invocation gets a unique id so the start / exit /
 * timeout log lines correlate. Counter is process-lifetime.
 */
const nextSshOpId = makeIdGen('ssh-');

class SshOpTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`SSH operation timed out after ${String(timeoutMs)}ms`);
    this.name = 'SshOpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export class RealMisterClient implements IMisterClient {
  private ssh: NodeSSH;
  /**
   * Listeners registered via `onUnexpectedDisconnect`. Fired at most
   * once per `connect()` call when the underlying SSH transport drops.
   */
  private readonly unexpectedDisconnectListeners = new Set<() => void>();
  /** Set inside `disconnect()` to suppress the "unexpected" path. */
  private isCleanShutdown = false;
  /** Reset on `connect()`. Prevents double-firing from close+error. */
  private unexpectedFired = false;

  constructor() {
    this.ssh = new NodeSSH();
  }

  async connect(profile: MisterProfile, secret: MisterSecret): Promise<void> {
    if (profile.authMethod !== secret.type) {
      throw new MisterConnectionError(
        'auth_failed',
        `Auth method '${profile.authMethod}' does not match supplied secret of type '${secret.type}'.`,
      );
    }

    // Recreate the ssh instance so each connect attempt starts with a
    // clean NodeSSH. A disposed instance cannot reconnect; without this
    // reset the retry button silently fails after any connection error.
    try { this.ssh.dispose(); } catch { /* already disposed or never connected */ }
    this.ssh = new NodeSSH();

    const baseConfig = {
      host: profile.host,
      port: profile.port,
      username: profile.username,
      readyTimeout: CONNECT_TIMEOUT_MS,
      // SSH-level keepalive lets ssh2 detect a dead transport within
      // ~30 s even when nothing is being sent on the wire. Without
      // these the socket can sit silently for tens of seconds before
      // TCP RST surfaces.
      keepaliveInterval: SSH_KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: SSH_KEEPALIVE_COUNT_MAX,
    };
    const config =
      secret.type === 'password'
        ? { ...baseConfig, password: secret.password }
        : { ...baseConfig, privateKey: secret.privateKey };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.ssh.connect(config),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`Connection timed out after ${CONNECT_TIMEOUT_MS}ms`),
              ),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      this.safelyDispose();
      throw mapConnectError(err);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const dirCheckCmd = `[ -d ${shellQuote(MISTER_GAMES_DIR)} ]`;
    const dirCheck = await this.runSshOp(dirCheckCmd, () =>
      this.ssh.execCommand(dirCheckCmd),
    );
    if (dirCheck.code !== 0) {
      this.safelyDispose();
      throw new MisterConnectionError(
        'not_a_mister',
        `Could not find ${MISTER_GAMES_DIR} on this host — is it a MiSTer?`,
      );
    }

    // Connect succeeded. Reset the unexpected-disconnect bookkeeping
    // and attach listeners to the underlying ssh2 Client. We don't
    // attach earlier (during the connect race) because the timeout
    // path may dispose without ever opening the socket — listening
    // there just creates dead handlers.
    this.isCleanShutdown = false;
    this.unexpectedFired = false;
    const conn = this.ssh.connection;
    if (conn) {
      const handler = (): void => this.handleUnexpectedDisconnect();
      conn.once('close', handler);
      conn.once('error', handler);
    }
  }

  async disconnect(): Promise<void> {
    this.isCleanShutdown = true;
    if (!this.ssh.isConnected()) {
      return;
    }
    this.safelyDispose();
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.ssh.isConnected();
  }

  onUnexpectedDisconnect(listener: () => void): () => void {
    this.unexpectedDisconnectListeners.add(listener);
    return () => {
      this.unexpectedDisconnectListeners.delete(listener);
    };
  }

  private handleUnexpectedDisconnect(): void {
    // Suppress when the renderer asked us to disconnect. Also dedup
    // close-vs-error: ssh2 can fire both for the same drop.
    if (this.isCleanShutdown || this.unexpectedFired) return;
    this.unexpectedFired = true;
    for (const listener of this.unexpectedDisconnectListeners) {
      try {
        listener();
      } catch {
        /* never let a UI throw kill the disconnect path */
      }
    }
  }

  async listAllCoresWithFiles(
    systemFilesMarks?: SystemFilesMarks,
  ): Promise<CoreEntry[]> {
    this.assertConnected();

    // One batched shell script that emits TAB-separated lines:
    //   R\t<category>\t<file|dir>\t<filename>      one per rbf or folder-core
    //   G\t<rawname>                                one per games dir
    //   GF\t<rawname>\t<filename>                  one per top-level file
    //   GD\t<rawname>\t<dirname>                   one per top-level dir
    //   A                                           if /media/fat/_Arcade exists
    // The JS side joins them via matchRbfsToGamesDirs, which applies the
    // `isSystemFile` heuristic to derive romCount/hiddenCount.
    const script = buildListAllCoresScript();
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to list cores: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }

    const rbfs: RawRbfInput[] = [];
    // Tracks folder-shaped core dirs we've already emitted an rbf
    // record for — deduplicates the case where multiple rbf/mgl
    // versions sit inside the same folder-shaped core (e.g.
    // `_Computer/AO486/AO486_20240115.rbf` and
    // `_Computer/AO486/AO486_20231215.rbf` both surface
    // `_Computer/AO486` as the core dir).
    const folderCoreDirs = new Set<string>();
    // Aggregate per-games-dir entries from the GF / GD lines so the
    // matcher can apply the system-file filter to derive romCount.
    interface DirBuilder {
      files: string[];
      dirs: string[];
      // One bucket per top-level subfolder (Round 3 / Issue 5). Built
      // from S* lines emitted by the shell script: SF for the folder
      // header, SE for each immediate file/dir, SR for the recursive
      // file totals.
      subFolders: Map<string, MutableSubFolder>;
    }
    interface MutableSubFolder {
      name: string;
      files: string[];
      dirs: string[];
      /**
       * fix/scrape-and-count-correctness commit 2: leaf basenames
       * bucketed by their immediate parent dir. The `recursive*Count`
       * fields are derived from these at conversion time by running
       * `countRomGroups` per bucket and summing — so a `Game.cue`
       * plus 30 sibling `.bin` tracks contributes 1 to the count
       * instead of 31.
       */
      filesByParent: Map<string, string[]>;
      hiddenFilesByParent: Map<string, string[]>;
    }
    const gamesDirsBuilder = new Map<string, DirBuilder>();
    const ensureDirBuilder = (rawName: string): DirBuilder => {
      let bucket = gamesDirsBuilder.get(rawName);
      if (!bucket) {
        bucket = { files: [], dirs: [], subFolders: new Map() };
        gamesDirsBuilder.set(rawName, bucket);
      }
      return bucket;
    };
    const ensureSubFolder = (
      bucket: DirBuilder,
      subName: string,
    ): MutableSubFolder => {
      let sub = bucket.subFolders.get(subName);
      if (!sub) {
        sub = {
          name: subName,
          files: [],
          dirs: [],
          filesByParent: new Map(),
          hiddenFilesByParent: new Map(),
        };
        bucket.subFolders.set(subName, sub);
      }
      return sub;
    };
    let arcadeDirExists = false;
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const parts = line.split('\t');
      const tag = parts[0];
      if (tag === 'A') {
        // Sentinel emitted by the script when /media/fat/_Arcade/ exists
        // on the device. Triggers the synthetic Arcade placeholder row
        // regardless of the directory's contents.
        arcadeDirExists = true;
      } else if (tag === 'P' && parts.length >= 3) {
        // P-line: rbf/mgl found by the per-category find. Format:
        //   P\t<category>\t<fullPath>
        // fullPath starts with one of the configured category dirs.
        // Top-level files (`<catDir>/<filename>`) become file rbfs.
        // Files at depth 2 (`<catDir>/<folder>/<rbf>`) collapse to a
        // single folder-shaped rbf record per parent dir.
        const categoryName = parts[1] ?? '';
        const fullPath = parts.slice(2).join('\t');
        const category = parseCategory(categoryName);
        if (!category) continue;
        const catDir = MISTER_CATEGORY_DIRS.find(
          (c) => c.category === category && fullPath.startsWith(`${c.dir}/`),
        )?.dir;
        if (catDir === undefined) continue;
        const rel = fullPath.slice(catDir.length + 1);
        const slash = rel.indexOf('/');
        if (slash < 0) {
          rbfs.push({
            category,
            filename: rel,
            fullPath,
            isFolder: false,
          });
        } else {
          const folder = rel.slice(0, slash);
          const folderFullPath = `${catDir}/${folder}`;
          if (folderCoreDirs.has(folderFullPath)) continue;
          folderCoreDirs.add(folderFullPath);
          rbfs.push({
            category,
            filename: folder,
            fullPath: folderFullPath,
            isFolder: true,
          });
        }
      } else if (tag === 'G' && parts.length >= 2) {
        // Games-dir announcement. Initialises the bucket so empty
        // dirs (no GF/GD lines following) still appear in the matcher
        // input — without this they'd be lost.
        const rawName = parts[1] ?? '';
        if (rawName !== '') ensureDirBuilder(rawName);
      } else if (tag === 'GF' && parts.length >= 3) {
        const rawName = parts[1] ?? '';
        const filename = parts.slice(2).join('\t');
        ensureDirBuilder(rawName).files.push(filename);
      } else if (tag === 'GD' && parts.length >= 3) {
        const rawName = parts[1] ?? '';
        const dirname = parts.slice(2).join('\t');
        ensureDirBuilder(rawName).dirs.push(dirname);
      } else if (tag === 'SE' && parts.length >= 5) {
        // Subfolder entry: parent games dir, subfolder name, kind
        // ('f' for file, 'd' for dir), and the entry's own basename.
        // Used to feed `classifyFolder` with one-level-deep content.
        const parent = parts[1] ?? '';
        const subName = parts[2] ?? '';
        const kind = parts[3] ?? '';
        const basename = parts.slice(4).join('\t');
        if (parent === '' || subName === '' || basename === '') continue;
        const sub = ensureSubFolder(ensureDirBuilder(parent), subName);
        if (kind === 'f') sub.files.push(basename);
        else if (kind === 'd') sub.dirs.push(basename);
      } else if (tag === 'F' && parts.length >= 2) {
        // Recursive-file line: %P relative to /media/fat/games.
        // Format: F\t<topLevelDir>/<subFolder>/<...rest>. We
        // aggregate per (topLevelDir, subFolder), filtering each
        // file via shouldCountAsRom — same function `listRoms`
        // calls, so the two paths can't drift apart.
        const rel = parts.slice(1).join('\t');
        const segs = rel.split('/');
        if (segs.length < 3) continue;
        const topLevelDir = segs[0]!;
        const subName = segs[1]!;
        const visibleTop = topLevelDir.startsWith('.')
          ? topLevelDir.slice(1)
          : topLevelDir;
        // relPath relative to the games dir for shouldCountAsRom:
        // segments AFTER the topLevelDir. Vectrex/Overlays/x.png
        // becomes "Overlays/x.png" with coreId="Vectrex".
        const relInGamesDir = segs.slice(1).join('/');
        if (
          !shouldCountAsRom({
            relPath: relInGamesDir,
            isDirectory: false,
            coreId: visibleTop,
            marks: systemFilesMarks,
          })
        ) {
          continue;
        }
        // PR-B (PR #24): positive launchable-extension filter on top
        // of the negative system-file filter. Without this, anything
        // not BIOS-shaped + not inside a system folder counted —
        // .png screenshots, .ips ROM-hack patches, .nfo notes,
        // .sav save states, .nsf music files all inflated counts
        // (NES showed ~680 vs 25 actual ROMs). Same `CART/DISC`
        // extension lists `classifyFolder` already uses, so the
        // two pipelines stay in sync.
        const leafName = segs[segs.length - 1]!;
        if (!isLaunchableRomExtension(leafName)) {
          continue;
        }
        // fix/scrape-and-count-correctness commit 2: bucket leaf
        // basenames by their immediate parent dir so the grouping
        // helper can collapse `Game.cue` + sibling `.bin` tracks
        // into one game. Per-parent so a `Game.cue` in `dirA/` does
        // not falsely claim a `.bin` from `dirB/`. Group counts
        // resolve at the conversion step below.
        const sub = ensureSubFolder(ensureDirBuilder(topLevelDir), subName);
        const parentRel = segs.slice(0, -1).join('/');
        bucketLeaf(sub.filesByParent, parentRel, leafName);
        if (leafName.startsWith('.')) {
          bucketLeaf(sub.hiddenFilesByParent, parentRel, leafName);
        }
      }
    }
    const gamesDirs: RawGamesDirInput[] = Array.from(
      gamesDirsBuilder,
      ([rawName, b]): RawGamesDirInput => {
        const subFolders: RawSubFolderInput[] = Array.from(
          b.subFolders.values(),
          (s) => ({
            name: s.name,
            files: s.files,
            dirs: s.dirs,
            recursiveFileCount: sumGroupCounts(s.filesByParent),
            recursiveHiddenFileCount: sumGroupCounts(s.hiddenFilesByParent),
          }),
        );
        return { rawName, files: b.files, dirs: b.dirs, subFolders };
      },
    );

    return matchRbfsToGamesDirs({
      rbfs,
      gamesDirs,
      arcadeDirExists,
      systemFilesMarks,
    });
  }

  /**
   * Collect a structured diagnostic report — one record per matcher
   * decision plus a discovery pass that enumerates directories the
   * normal code path would skip.
   *
   * Read-only, pure observation. Calls the same `buildListAllCoresScript`
   * the production path uses (so what the matcher sees is exactly what
   * the live cores list saw) plus a separate discovery script that
   * lists every _* dir under /media/fat and any rbf/mgl at the fat
   * root. The matcher itself runs with an `InMemoryDiagnosticsCollector`
   * so every rbf, games-dir, system-filter check, recursive-count walk
   * step, and dedupe group is captured in the returned report.
   *
   * Diagnostic mode only — used by `scripts/diag-real-client.ts`. Not
   * exposed on the IPC bridge.
   */
  async collectDiagnosticReport(connectionInfo: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
  }): Promise<DiagReport> {
    this.assertConnected();

    const collector = new InMemoryDiagnosticsCollector();
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    // Pass 1: the production list-all-cores script. Same shell as the
    // live cores list — so any drift between this report and the
    // on-screen list is downstream of parsing or matcher logic.
    const listScript = buildListAllCoresScript();
    const listStartMs = Date.now();
    const listResult = await this.runSshOp(listScript, () =>
      this.ssh.execCommand(listScript),
    );
    const listElapsed = Date.now() - listStartMs;
    collector.emit({
      kind: 'shell-raw',
      source: 'list-all-cores',
      stdout: listResult.stdout,
      stderr: listResult.stderr,
      exitCode: listResult.code ?? 0,
      elapsedMs: listElapsed,
    });
    if (listResult.code !== 0) {
      throw new Error(
        `Failed to list cores during diagnostics: ${
          listResult.stderr.trim() || `exit code ${String(listResult.code)}`
        }`,
      );
    }

    const { rbfs, gamesDirs, arcadeDirExists } =
      parseListAllCoresShellOutput(listResult.stdout);

    // Pass 2: the discovery script. Enumerates ALL _* dirs (catches
    // _Console (autoboot)/ which the production loop misses), the
    // _Console/._hidden/ stash, and any rbf/mgl at /media/fat root
    // (e.g. menu.rbf). One DiscoveryRecord per find.
    const discoveryScript = buildDiscoveryScript();
    const discoveryStartMs = Date.now();
    const discoveryResult = await this.runSshOp(discoveryScript, () =>
      this.ssh.execCommand(discoveryScript),
    );
    const discoveryElapsed = Date.now() - discoveryStartMs;
    collector.emit({
      kind: 'shell-raw',
      source: 'discovery',
      stdout: discoveryResult.stdout,
      stderr: discoveryResult.stderr,
      exitCode: discoveryResult.code ?? 0,
      elapsedMs: discoveryElapsed,
    });
    parseDiscoveryShellOutput(discoveryResult.stdout, collector);

    // Pass 3: re-run the matcher with the collector active. Same
    // input as the production path, so the records reflect the
    // exact decisions the live cores list saw.
    const cores = matchRbfsToGamesDirs({
      rbfs,
      gamesDirs,
      arcadeDirExists,
      diagnostics: collector,
    });

    const elapsedMs = Date.now() - startedAtMs;
    const records: readonly DiagRecord[] = collector.toArray();
    return {
      header: {
        version: 1,
        mister: { ...connectionInfo },
        startedAt,
        elapsedMs,
        // Two ssh.execCommand calls; each command's internal shell
        // forks vary by device shape (the regular pass forks per
        // category dir for the find-rbf check).
        subprocessForks: 2,
      },
      records,
      cores,
    };
  }

  async listRecursiveRomFiles(args: {
    readonly coreId: string;
    readonly gamesDirBasename: string;
    readonly marks?: SystemFilesMarks;
  }): Promise<readonly string[]> {
    this.assertConnected();
    assertSafeSegment('coreId', args.coreId);
    assertSafeSegment('gamesDirBasename', args.gamesDirBasename);

    // PR-C round 2: SSH find for ALL files in the core's games dir,
    // then filter on the main side by the same predicate the
    // sidebar count uses (shouldCountAsRom + isLaunchableRomExtension
    // — see shared/folder-rom.ts and shared/system-files.ts). Engine
    // pre-round-2 only saw `listRoms`'s top-level entries, so a
    // GBA core with 145 ROMs (most in nested folders) appeared as
    // "GBA · 39/62" — 39 file rows out of 62 top-level entries.
    // The new method returns the full launchable-ROM list so the
    // engine's footer total matches the sidebar's count.
    const targetDir = `${MISTER_GAMES_DIR}/${args.gamesDirBasename}`;
    const script = [
      `[ -d ${shellQuote(targetDir)} ] || exit 0`,
      `find ${shellQuote(targetDir)} -type f -printf '%P\\n' 2>/dev/null`,
    ].join('\n');
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) return [];

    const out: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      if (
        !shouldCountAsRom({
          relPath: line,
          isDirectory: false,
          coreId: args.coreId,
          marks: args.marks,
        })
      ) {
        continue;
      }
      if (!isLaunchableRomExtension(line)) continue;
      out.push(`${targetDir}/${line}`);
    }
    return out;
  }

  async listArcadeRawListing(): Promise<
    readonly { readonly type: 'f' | 'd'; readonly relPath: string }[]
  > {
    this.assertConnected();
    // `find -mindepth 1 -maxdepth 3` matches the shape `listRoms`
    // uses for ROM trees — captures top-level entries, one level
    // of subfolder content, and nested .mra files inside organisational
    // subfolders. Deeper trees (4+ levels) don't surface in Phase 1.
    const script = [
      `[ -d ${shellQuote(MISTER_ARCADE_DIR)} ] || exit 0`,
      `find ${shellQuote(MISTER_ARCADE_DIR)} -mindepth 1 -maxdepth 3 -printf '%y\\t%P\\n' 2>/dev/null`,
    ].join('\n');
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) return [];
    const out: { type: 'f' | 'd'; relPath: string }[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const type = line.slice(0, tab);
      const relPath = line.slice(tab + 1);
      if (relPath === '') continue;
      if (type === 'f' || type === 'd') {
        out.push({ type, relPath });
      }
    }
    return out;
  }

  async parseArcadeMras(): Promise<readonly ArcadeMraMeta[]> {
    this.assertConnected();
    // Server-side parsing in one round-trip. We need four pieces of
    // information per .mra (relativePath, zip-attr blocks, rbf,
    // setname); shipping the raw .mra heads over the wire is ~7-9MB
    // for a typical 1800-mra library. Pushing the regex into awk on
    // the device drops that to ~200KB (one TSV row per .mra).
    //
    // Strategy: heredoc the awk script to MISTER_AGENT_DIR (a
    // throwaway tmpfs path the rest of the app already uses), then
    // pipe `find … -print0 | xargs -0 awk -f …` to run it once
    // across every matching file. The single-file-load approach
    // sidesteps shell-quoting hell with awk regex literals that
    // contain both single and double quote characters.
    //
    // Top-level mras only (`-maxdepth 1`). `_alternatives/` and
    // user-organisational subfolders are deferred to a follow-up
    // by spec — the arcade menu surfaces only top-level entries
    // anyway, so this matches the firmware's own view.
    //
    // The trailing `/dev/null` argument to awk is a defensive
    // touch: it ensures FILENAME / FNR behave consistently even
    // when only one .mra file is matched (some awk builds skip
    // resetting FNR if argv has exactly one entry). Cheap, safe.
    const awkPath = `${MISTER_AGENT_DIR}/arcade-parse.awk`;
    const awkScript = buildArcadeParseAwkScript();
    const script = [
      `[ -d ${shellQuote(MISTER_ARCADE_DIR)} ] || exit 0`,
      `mkdir -p ${shellQuote(MISTER_AGENT_DIR)}`,
      `cat > ${shellQuote(awkPath)} <<'AWK_EOF'`,
      awkScript,
      `AWK_EOF`,
      `cd ${shellQuote(MISTER_ARCADE_DIR)} || exit 1`,
      // BusyBox find groups `\( ... \)` for the OR; -print0 is widely
      // supported on the MiSTer's busybox build (already used in
      // listRecursiveRomFiles' shell sibling).
      `find . -maxdepth 1 -type f \\( -name '*.mra' -o -name '.*.mra' \\) -print0 2>/dev/null | \\`,
      `  xargs -0 awk -f ${shellQuote(awkPath)} /dev/null`,
      `rc=$?`,
      `rm -f ${shellQuote(awkPath)}`,
      `exit $rc`,
    ].join('\n');
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) {
      // feat/arcade-parse-tolerance-gallery-polish — tolerate the
      // hide/parse race. `find … | xargs awk` enumerates entries
      // up-front, then awk opens each. If the renderer renames a
      // .mra mid-flight (Foo.mra → .Foo.mra via the hide ledger),
      // awk's open of the vanished path emits
      //   `awk: ./Foo.mra: No such file or directory`
      // to stderr and the script exits non-zero, but the other
      // entries' TSV rows have already streamed to stdout. We split
      // that case from a genuine script bug by inspecting stderr:
      // when EVERY non-empty line is the ENOENT shape, log a warn
      // and use the partial stdout. Anything else still throws so
      // an awk syntax error or shell failure stays loud.
      const stderrLines = result.stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      const ENOENT_RE = /^awk: .+: No such file or directory$/;
      const onlyVanishedFiles =
        stderrLines.length > 0 &&
        stderrLines.every((l) => ENOENT_RE.test(l));
      if (!onlyVanishedFiles) {
        // Surface the error rather than hiding it — a non-zero exit
        // here means the awk script blew up or the heredoc failed,
        // both of which are bugs in this method (not absence of
        // _Arcade/, which short-circuits cleanly above).
        throw new Error(
          `parseArcadeMras failed (code ${String(result.code)}): ${result.stderr.trim() || 'no stderr'}`,
        );
      }
      diagLog('warn', 'arcade', '·', 'parse-skip-vanished', {
        code: result.code ?? undefined,
        skipped: stderrLines.length,
      });
    }
    const out: ArcadeMraMeta[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const meta = decodeArcadeMraTsv(line);
      if (meta !== null) out.push(meta);
    }
    return out;
  }

  async listArcadeZipBasenames(): Promise<readonly string[]> {
    this.assertConnected();
    // One `find` per candidate dir, guarded by `[ -d ]`. Either may
    // be missing on a freshly-flashed MiSTer; the guard skips the
    // find cleanly when the dir doesn't exist.
    //
    // First-cut (pre-live-verify) tried to build a `$present` list
    // and run `find $present ...` once. That looked clean but
    // unquoted variable expansion does NOT honor inner shell quotes
    // — `present="'/media/fat/games/mame'"` re-tokenized as the
    // literal four-char path `/'/...'/` and find matched nothing,
    // yielding an empty zip set and rendering every .mra "missing"
    // in the live trace (`playable=0 missing=490`). Two finds with
    // direct quoted args sidestep the fragility; each invocation is
    // ms-cheap on busybox.
    //
    // `-printf '%f\\n'` returns the basename only; duplicates across
    // dirs (rare — a zip basename usually lives in one or the other)
    // get folded by the JS Set construction at the call site.
    const script = [
      ...MISTER_ARCADE_ZIP_DIRS.map(
        (d) =>
          `[ -d ${shellQuote(d)} ] && find ${shellQuote(d)} -maxdepth 1 -name '*.zip' -printf '%f\\n' 2>/dev/null`,
      ),
      `exit 0`,
    ].join('\n');
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) return [];
    const out: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      out.push(line);
    }
    return out;
  }

  async listRoms(
    coreId: string,
    subPath = '',
    folderClassifications: FolderClassifications = EMPTY_FOLDER_CLASSIFICATIONS,
  ): Promise<Rom[]> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    assertSafeSubPath(subPath);

    const targetDir =
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`;
    const relPrefix = subPath === '' ? '' : `${subPath}/`;

    // PR #11 round 4: one find pass, JS aggregation. The pre-Round-4
    // shell ran `du -sb` + a case-statement scan per immediate
    // sub-folder; on cores like X68000 (649 folders × ~3 files each)
    // that was 1300+ subprocess invocations on busybox and tripped
    // the 10s SSH op deadline. Now: a single `find` with maxdepth=3
    // emits raw `<type>\t<relpath>\t<size>` lines and JS does the
    // aggregation + classification using `classifyFolder` directly
    // (the same function the FakeMisterClient + shared tests use).
    //
    // Output line format: `<%y>\t<%P>\t<%s>` where
    //   %y → 'f' (file) or 'd' (directory)
    //   %P → path relative to the find starting point (no leading
    //         './'; busybox find supports this idiom — already in
    //         production use in `listAllCoresWithFiles` and the
    //         discovery script).
    //   %s → size in bytes.
    //
    // maxdepth=3 keeps the output bounded and covers the realistic
    // depth of folder ROMs (top-level entry, direct children for
    // classification, grandchildren for size accuracy on multi-disc
    // dumps like Saturn `Game/Disc 1/file.bin`). Files at depth 4+
    // do not contribute to folder size; we accept that tradeoff to
    // bound stdout volume on cores with very deep trees.
    //
    // Subprocess budget: 1 fork for `find`. The `[` test and `echo`
    // are shell builtins on busybox ash. Total per-call: 1 fork.
    const script = [
      `[ -d ${shellQuote(targetDir)} ] || { echo MISSING_DIR; exit 1; }`,
      `find ${shellQuote(targetDir)} -mindepth 1 -maxdepth 3 -printf '%y\\t%P\\t%s\\n' 2>/dev/null`,
    ].join('\n');

    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0 || result.stdout.includes('MISSING_DIR')) {
      throw new Error(`Unknown core: ${coreId}`);
    }

    interface FolderAcc {
      readonly name: string;
      sizeBytes: number;
      readonly directFiles: string[];
      readonly directDirs: string[];
    }
    const topLevelFiles: { name: string; sizeBytes: number }[] = [];
    const folderAccs = new Map<string, FolderAcc>();
    const ensureFolderAcc = (name: string): FolderAcc => {
      let acc = folderAccs.get(name);
      if (acc === undefined) {
        acc = { name, sizeBytes: 0, directFiles: [], directDirs: [] };
        folderAccs.set(name, acc);
      }
      return acc;
    };

    for (const line of result.stdout.split('\n')) {
      if (line === '' || line === 'MISSING_DIR') continue;
      const parts = line.split('\t');
      if (parts.length < 3) continue;
      const type = parts[0];
      const relPath = parts[1] ?? '';
      const sizeBytes = Number.parseInt(parts[2] ?? '0', 10);
      if (relPath === '' || Number.isNaN(sizeBytes)) continue;
      if (type !== 'f' && type !== 'd') continue;

      const segments = relPath.split('/');
      // Issue #17 — drop OS metadata before any path enters the
      // hash queue or surfaces to the renderer. `._sonic.zip`,
      // `.DS_Store`, `Thumbs.db`, and friends are filesystem
      // sidecars from cross-FS copies, not ROMs. Also poison entire
      // subtrees rooted in `.AppleDouble/`, `$RECYCLE.BIN/`, etc.
      let osJunk = false;
      for (let i = 0; i < segments.length - 1; i += 1) {
        if (isOsMetadataDir(segments[i]!)) {
          osJunk = true;
          break;
        }
      }
      if (!osJunk) {
        const leaf = segments[segments.length - 1]!;
        if (type === 'd' && isOsMetadataDir(leaf)) osJunk = true;
        else if (type === 'f' && isOsMetadataFile(leaf)) osJunk = true;
      }
      if (osJunk) continue;

      if (segments.length === 1) {
        // Top-level entry.
        const name = segments[0]!;
        if (type === 'f') {
          topLevelFiles.push({ name, sizeBytes });
        } else {
          ensureFolderAcc(name);
        }
      } else {
        // Descendant of a top-level folder. Top is segments[0].
        const top = segments[0]!;
        const acc = ensureFolderAcc(top);
        if (type === 'f') acc.sizeBytes += sizeBytes;
        // Direct children of the top-level folder feed classifyFolder.
        // segments.length === 2 means the entry sits exactly one level
        // below the top folder.
        if (segments.length === 2) {
          const childName = segments[1]!;
          if (type === 'f') acc.directFiles.push(childName);
          else acc.directDirs.push(childName);
        }
      }
    }

    const roms: Rom[] = [];
    for (const f of topLevelFiles) {
      const hidden = f.name.startsWith('.');
      const visibleBase = hidden ? f.name.slice(1) : f.name;
      if (!isLaunchableRomExtension(visibleBase)) {
        diagLog('info', 'roms-pane', '·', 'skip-non-rom-extension', {
          coreId,
          name: f.name,
        });
        continue;
      }
      const relativePath = `${relPrefix}${f.name}`;
      roms.push({
        coreId,
        filename: f.name,
        displayName: displayRomName(visibleBase),
        sizeBytes: f.sizeBytes,
        hidden,
        path: `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`,
        kind: 'file',
        relativePath,
      });
    }
    for (const acc of folderAccs.values()) {
      const hidden = acc.name.startsWith('.');
      const visibleBase = hidden ? acc.name.slice(1) : acc.name;
      const relativePath = `${relPrefix}${acc.name}`;
      const visibleRelPath = `${relPrefix}${visibleBase}`;
      const heuristic = classifyFolder({
        files: acc.directFiles,
        dirs: acc.directDirs,
        // fix/count-and-status-indicator commit 1: pass the folder
        // basename (un-dotted) so the shared-prefix-atomic rule can
        // fire on X68000 game folders whose .zip variants all share
        // the game name as a prefix.
        folderName: visibleBase,
      });
      const override = getFolderOverride(
        folderClassifications,
        coreId,
        visibleRelPath,
      );
      const classification = resolveClassification(heuristic, override);
      const kind =
        classification === 'container' ? 'folder-container' : 'folder-atomic';
      // PR-D1 (PR #27): for atomic folders, identify the
      // alphabetical-first launchable ROM file inside so the
      // renderer can bind metadata (box art etc.) to the folder
      // row by looking up the contained file's hash. Container
      // folders don't get this — they're drilled into.
      const containedRomPath =
        kind === 'folder-atomic'
          ? pickPrimaryRomFile(
              acc.directFiles,
              `${MISTER_GAMES_DIR}/${coreId}/${visibleRelPath}`,
            )
          : undefined;
      roms.push({
        coreId,
        filename: acc.name,
        displayName: displayRomName(visibleBase),
        sizeBytes: acc.sizeBytes,
        hidden,
        path: `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`,
        kind,
        relativePath,
        containedRomPath,
      });
    }

    roms.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return roms;
  }

  async setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath = '',
  ): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    assertSafeSegment('filename', filename);
    assertSafeSubPath(subPath);

    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;
    if (targetName === filename) {
      return;
    }

    const dirPart =
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`;
    const src = `${dirPart}/${filename}`;
    const dst = `${dirPart}/${targetName}`;
    const command = `mv ${shellQuote(src)} ${shellQuote(dst)}`;

    const result = await this.runSshOp(command, () =>
      this.ssh.execCommand(command),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to rename ${filename}: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
    subPath = '',
  ): Promise<BulkRomResult> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    assertSafeSubPath(subPath);
    for (const change of changes) {
      assertSafeSegment('filename', change.filename);
    }

    interface PendingRename {
      readonly filename: string;
      readonly src: string;
      readonly dst: string;
    }

    const pending: PendingRename[] = [];
    for (const change of changes) {
      const visible = change.filename.startsWith('.')
        ? change.filename.slice(1)
        : change.filename;
      const target = change.hidden ? `.${visible}` : visible;
      if (target === change.filename) continue;
      pending.push({ filename: change.filename, src: change.filename, dst: target });
    }

    if (pending.length === 0) {
      return { succeeded: [], failed: [] };
    }

    // Chunk the batch so each SSH `execCommand` stays under Dropbear's
    // command-channel buffer. Pre-fix this code built a single script
    // for every pending rename — for 1455 rows that script ran ~555KB,
    // which Dropbear silently truncated/dropped on the MiSTer end. The
    // execCommand call returned with `stdout === ''`, the bulk parser
    // produced `{ succeeded: [], failed: [] }`, and the renderer's
    // toast read "Nothing to do" — confusing on a directory the user
    // had just confirmed contains hundreds of visible ROMs.
    //
    // 100 paths/chunk → ~38KB per script with worst-case 380-char rows,
    // well under common SSH exec buffer limits. Sequential dispatch
    // (NOT parallel) keeps semantics simple: failures stay attributed
    // to specific filenames and the per-op timeout applies per chunk.
    const coreDir =
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`;
    const succeeded: string[] = [];
    const failed: { readonly filename: string; readonly reason: string }[] = [];
    for (let i = 0; i < pending.length; i += BULK_ROM_RENAME_CHUNK_SIZE) {
      const chunk = pending.slice(i, i + BULK_ROM_RENAME_CHUNK_SIZE);
      const lines: string[] = [`cd ${shellQuote(coreDir)}`];
      for (const p of chunk) {
        const id = shellQuote(p.filename);
        lines.push(
          `if err=$(mv ${shellQuote(p.src)} ${shellQuote(p.dst)} 2>&1); then`,
          `  printf 'OK\\t%s\\n' ${id}`,
          `else`,
          `  printf 'FAIL\\t%s\\t%s\\n' ${id} "$(printf '%s' "$err" | tr '\\n\\t' '  ' | head -c 200)"`,
          `fi`,
        );
      }
      const script = lines.join('\n');
      const result = await this.runSshOp(script, () =>
        this.ssh.execCommand(script),
      );
      const parsed = parseBulkResult<BulkRomResult>(result.stdout, 'filename');
      succeeded.push(...parsed.succeeded);
      failed.push(...parsed.failed);
    }
    return { succeeded, failed };
  }

  async setArcadeMraVisibility(
    relativePath: string,
    hidden: boolean,
  ): Promise<void> {
    this.assertConnected();
    // `_Arcade/` paths are slash-joined for nested entries
    // (`_Konami/TMNT.mra`); validate each segment + reject path
    // traversal segments via assertSafeSubPath.
    const segments = relativePath.split('/');
    if (segments.length === 0 || segments[segments.length - 1] === '') {
      throw new Error(`Invalid arcade .mra path: ${relativePath}`);
    }
    const filename = segments[segments.length - 1]!;
    const subSegments = segments.slice(0, -1);
    assertSafeSegment('filename', filename);
    if (subSegments.length > 0) {
      assertSafeSubPath(subSegments.join('/'));
    }
    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;
    if (targetName === filename) return;
    const dirPart =
      subSegments.length === 0
        ? MISTER_ARCADE_DIR
        : `${MISTER_ARCADE_DIR}/${subSegments.join('/')}`;
    const src = `${dirPart}/${filename}`;
    const dst = `${dirPart}/${targetName}`;
    const command = `mv ${shellQuote(src)} ${shellQuote(dst)}`;
    const result = await this.runSshOp(command, () =>
      this.ssh.execCommand(command),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to rename ${relativePath}: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async setBulkArcadeMraVisibility(
    changes: readonly { readonly relativePath: string; readonly hidden: boolean }[],
  ): Promise<BulkRomResult> {
    this.assertConnected();
    interface PendingRename {
      readonly relativePath: string;
      readonly src: string;
      readonly dst: string;
    }
    // Validate + plan each rename. Same structure as
    // `setBulkRomVisibility` — the only difference is the base
    // directory (`MISTER_ARCADE_DIR`) and that we operate on the
    // full relative path (which may include subfolders) instead of
    // a top-level filename.
    const pending: PendingRename[] = [];
    for (const change of changes) {
      const segments = change.relativePath.split('/');
      if (segments.length === 0 || segments[segments.length - 1] === '') {
        throw new Error(`Invalid arcade .mra path: ${change.relativePath}`);
      }
      const filename = segments[segments.length - 1]!;
      const subSegments = segments.slice(0, -1);
      assertSafeSegment('filename', filename);
      if (subSegments.length > 0) {
        assertSafeSubPath(subSegments.join('/'));
      }
      const visible = filename.startsWith('.') ? filename.slice(1) : filename;
      const target = change.hidden ? `.${visible}` : visible;
      if (target === filename) continue;
      const subPrefix = subSegments.length === 0 ? '' : `${subSegments.join('/')}/`;
      pending.push({
        relativePath: change.relativePath,
        src: `${subPrefix}${filename}`,
        dst: `${subPrefix}${target}`,
      });
    }
    if (pending.length === 0) return { succeeded: [], failed: [] };
    // Reuse the chunking shape from `setBulkRomVisibility` (PR #30).
    // 100 paths/chunk keeps each script under dropbear's exec buffer.
    const succeeded: string[] = [];
    const failed: { readonly filename: string; readonly reason: string }[] = [];
    for (let i = 0; i < pending.length; i += BULK_ROM_RENAME_CHUNK_SIZE) {
      const chunk = pending.slice(i, i + BULK_ROM_RENAME_CHUNK_SIZE);
      const lines: string[] = [`cd ${shellQuote(MISTER_ARCADE_DIR)}`];
      for (const p of chunk) {
        const id = shellQuote(p.relativePath);
        lines.push(
          `if err=$(mv ${shellQuote(p.src)} ${shellQuote(p.dst)} 2>&1); then`,
          `  printf 'OK\\t%s\\n' ${id}`,
          `else`,
          `  printf 'FAIL\\t%s\\t%s\\n' ${id} "$(printf '%s' "$err" | tr '\\n\\t' '  ' | head -c 200)"`,
          `fi`,
        );
      }
      const script = lines.join('\n');
      const result = await this.runSshOp(script, () =>
        this.ssh.execCommand(script),
      );
      const parsed = parseBulkResult<BulkRomResult>(result.stdout, 'filename');
      succeeded.push(...parsed.succeeded);
      failed.push(...parsed.failed);
    }
    return { succeeded, failed };
  }

  async hideCore(core: CoreEntry): Promise<void> {
    this.assertConnected();
    if (!isRealCore(core)) {
      throw new Error(
        `Refusing to hide '${core.id}': not a real core (likely a user folder or the Arcade placeholder).`,
      );
    }
    if (!HIDEABLE_CATEGORIES.has(core.category)) {
      throw new Error(`Refusing to hide a core in category '${core.category}'.`);
    }
    const renames = computeCoreRenames(core, true);
    if (renames.length === 0) return;
    const conflicts = renames.filter((r) => core.rbfPaths.includes(r.to));
    if (conflicts.length > 0) {
      throw new DestinationAlreadyExistsError(conflicts);
    }
    await this.runRenameScript(renames, `hide core ${core.id}`);
  }

  async showCore(core: CoreEntry): Promise<void> {
    this.assertConnected();
    if (!isRealCore(core)) {
      throw new Error(
        `Refusing to show '${core.id}': not a real core (likely a user folder or the Arcade placeholder).`,
      );
    }
    if (!HIDEABLE_CATEGORIES.has(core.category)) {
      throw new Error(`Refusing to show a core in category '${core.category}'.`);
    }
    const renames = computeCoreRenames(core, false);
    if (renames.length === 0) return;
    const conflicts = renames.filter((r) => core.rbfPaths.includes(r.to));
    if (conflicts.length > 0) {
      throw new DestinationAlreadyExistsError(conflicts);
    }
    await this.runRenameScript(renames, `show core ${core.id}`);
  }

  async setBulkCoreVisibility(
    changes: readonly CoreVisibilityChange[],
    options: BulkCoreOptions = {},
  ): Promise<BulkCoreResult> {
    this.assertConnected();

    interface PerCorePlan {
      readonly coreId: string;
      readonly renames: readonly CoreRename[];
    }
    const plans: PerCorePlan[] = [];
    for (const change of changes) {
      if (!isRealCore(change.core)) {
        throw new Error(
          `Refusing to toggle '${change.core.id}': not a real core (likely a user folder or the Arcade placeholder).`,
        );
      }
      if (!HIDEABLE_CATEGORIES.has(change.core.category)) {
        throw new Error(
          `Refusing to toggle a core in category '${change.core.category}'.`,
        );
      }
      const renames = computeCoreRenames(change.core, change.hidden);
      if (renames.length === 0) continue;
      const conflicts = renames.filter((r) => change.core.rbfPaths.includes(r.to));
      if (conflicts.length > 0) {
        throw new DestinationAlreadyExistsError(conflicts);
      }
      plans.push({ coreId: change.core.id, renames });
    }
    if (plans.length === 0) {
      return { succeeded: [], failed: [] };
    }

    const total = plans.length;
    const lines: string[] = [];
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i]!;
      // Each core's renames run in a `(set -e ...)` subshell so the
      // core itself is atomic — partial state is impossible inside one
      // core. But subshells are independent, so a failure in core A
      // does NOT abort core B.
      const moves = plan.renames
        .map((r) => `mv ${shellQuote(r.from)} ${shellQuote(r.to)}`)
        .join('\n  ');
      const id = shellQuote(plan.coreId);
      const done = String(i + 1);
      const totalStr = String(total);
      lines.push(
        `if err=$( (set -e\n  ${moves}) 2>&1 ); then`,
        // PROGRESS lines are the *only* per-core output now. The renderer
        // streams them off the SSH channel as ticks; the parser at the
        // end builds the BulkCoreResult from the same stream.
        `  printf 'PROGRESS\\t${done}\\t${totalStr}\\t%s\\n' ${id}`,
        `else`,
        `  printf 'PROGRESS_FAIL\\t${done}\\t${totalStr}\\t%s\\t%s\\n' ${id} "$(printf '%s' "$err" | tr '\\n\\t' '  ' | head -c 200)"`,
        `fi`,
      );
    }

    const script = lines.join('\n');
    const succeeded: string[] = [];
    const failed: { coreId: string; reason: string }[] = [];
    let buffer = '';

    const handleLine = (line: string): void => {
      if (line === '') return;
      const parts = line.split('\t');
      const tag = parts[0];
      if (tag === 'PROGRESS' && parts.length >= 4) {
        const done = Number.parseInt(parts[1] ?? '0', 10);
        const totalParsed = Number.parseInt(parts[2] ?? '0', 10);
        const coreId = parts.slice(3).join('\t');
        if (Number.isNaN(done) || Number.isNaN(totalParsed)) return;
        succeeded.push(coreId);
        try {
          options.onProgress?.({ done, total: totalParsed, coreId, result: 'ok' });
        } catch {
          /* swallow renderer-side throws so the bulk op continues */
        }
      } else if (tag === 'PROGRESS_FAIL' && parts.length >= 5) {
        const done = Number.parseInt(parts[1] ?? '0', 10);
        const totalParsed = Number.parseInt(parts[2] ?? '0', 10);
        const coreId = parts[3] ?? '';
        const reason = parts.slice(4).join('\t') || 'unknown error';
        if (Number.isNaN(done) || Number.isNaN(totalParsed)) return;
        failed.push({ coreId, reason });
        try {
          options.onProgress?.({
            done,
            total: totalParsed,
            coreId,
            result: 'fail',
            reason,
          });
        } catch {
          /* swallow */
        }
      }
      // Lines that don't match either prefix are ignored — defensive
      // against shell preamble/echoes that some hosts inject.
    };

    // Streaming exec uses an idle-style timeout — we reset the
    // 10s deadline on every chunk so a long bulk-rename batch with
    // healthy progress doesn't false-fire. If the device goes silent
    // mid-stream for 10s we treat it as dead, same as the per-op
    // path.
    await this.runSshStreamOp(script, ({ touch }) =>
      this.ssh.exec(script, [], {
        stream: 'stdout',
        onStdout: (chunk: Buffer) => {
          touch();
          buffer += chunk.toString('utf-8');
          for (;;) {
            const i = buffer.indexOf('\n');
            if (i < 0) break;
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            handleLine(line);
          }
        },
      }),
    );
    // Flush any trailing partial line (no terminating newline).
    if (buffer !== '') handleLine(buffer);

    return { succeeded, failed };
  }

  async readHideLedger(): Promise<HideLedger> {
    this.assertConnected();
    // `cat` returns non-zero when the file is missing; we want that to be a
    // soft "empty ledger" outcome, so we tolerate it inline and rely on the
    // parser to handle the empty string.
    const ledgerCmd = `cat ${shellQuote(MISTER_LEDGER_PATH)} 2>/dev/null || true`;
    const result = await this.runSshOp(ledgerCmd, () =>
      this.ssh.execCommand(ledgerCmd),
    );
    const raw = parseLedger(result.stdout);

    // Self-heal: drop entries that no longer correspond to a real core
    // on disk and rewrite the cleaned ledger. Costs an extra
    // listAllCoresWithFiles + a writeHideLedger when entries actually
    // got dropped, in exchange for keeping the ledger truthful.
    if (raw.hiddenCores.length === 0) return raw;

    const cores = await this.listAllCoresWithFiles();
    const healed = healLedger(raw, cores);
    if (!ledgerEqual(raw, healed)) {
      const dropped = raw.hiddenCores.length - healed.hiddenCores.length;
      console.log(`Ledger self-healed: dropped ${String(dropped)} stale entries.`);
      await this.writeHideLedger(healed);
    }
    return healed;
  }

  async writeHideLedger(ledger: HideLedger): Promise<void> {
    this.assertConnected();
    // serializeLedger validates the payload does not contain the ledger
    // delimiter — kept as defense-in-depth even though stdin piping makes
    // shell injection impossible.
    const json = serializeLedger(ledger);
    const tmpPath = `${MISTER_LEDGER_PATH}.tmp`;
    // JSON is piped via stdin rather than embedded in the script string so
    // the command length stays well under ARG_MAX regardless of payload size.
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)} && ` +
      `cat > ${shellQuote(tmpPath)} && ` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_LEDGER_PATH)}`;

    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script, { stdin: json }),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to write hide ledger: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readSystemFilesMarks(): Promise<SystemFilesMarks> {
    this.assertConnected();
    const cmd = `cat ${shellQuote(MISTER_SYSTEM_FILES_PATH)} 2>/dev/null || true`;
    const result = await this.runSshOp(cmd, () =>
      this.ssh.execCommand(cmd),
    );
    return parseSystemFilesMarks(result.stdout);
  }

  async addSystemFileMark(coreId: string, filename: string): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    if (filename === '' || filename.includes('\0')) {
      throw new Error(`Invalid filename: ${filename}`);
    }
    const current = await this.readSystemFilesMarks();
    const next = withMark(current, {
      coreId,
      filename,
      markedAt: new Date().toISOString(),
    });
    if (next === current) return;
    await this.writeSystemFilesMarks(next);
  }

  async removeSystemFileMark(coreId: string, filename: string): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    if (filename === '' || filename.includes('\0')) {
      throw new Error(`Invalid filename: ${filename}`);
    }
    const current = await this.readSystemFilesMarks();
    const next = withoutMark(current, coreId, filename);
    if (next === current) return;
    await this.writeSystemFilesMarks(next);
  }

  async setSystemFileMarks(
    coreId: string,
    changes: readonly SystemFileMarkChange[],
  ): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    for (const c of changes) {
      if (c.filename === '' || c.filename.includes('\0')) {
        throw new Error(`Invalid filename: ${c.filename}`);
      }
    }
    if (changes.length === 0) return;

    const current = await this.readSystemFilesMarks();
    const markedAt = new Date().toISOString();
    let next = current;
    for (const change of changes) {
      next = change.marked
        ? withMark(next, { coreId, filename: change.filename, markedAt })
        : withoutMark(next, coreId, change.filename);
    }
    if (next === current) return;
    await this.writeSystemFilesMarks(next);
  }

  private async writeSystemFilesMarks(marks: SystemFilesMarks): Promise<void> {
    const json = serializeSystemFilesMarks(marks);
    const tmpPath = `${MISTER_SYSTEM_FILES_PATH}.tmp`;
    // JSON via stdin — avoids ARG_MAX for large mark sets.
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)} && ` +
      `cat > ${shellQuote(tmpPath)} && ` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_SYSTEM_FILES_PATH)}`;

    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script, { stdin: json }),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to write system-files marks: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readFolderClassifications(): Promise<FolderClassifications> {
    this.assertConnected();
    const cmd = `cat ${shellQuote(MISTER_FOLDER_CLASSIFICATIONS_PATH)} 2>/dev/null || true`;
    const result = await this.runSshOp(cmd, () =>
      this.ssh.execCommand(cmd),
    );
    return parseFolderClassifications(result.stdout);
  }

  async setFolderClassification(
    override:
      | FolderClassificationOverride
      | { coreId: string; folderPath: string; classification: undefined },
  ): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', override.coreId);
    assertSafeSubPath(override.folderPath);
    const current = await this.readFolderClassifications();
    let next: FolderClassifications;
    if (override.classification === undefined) {
      next = withoutFolderOverride(current, override.coreId, override.folderPath);
    } else {
      next = withFolderOverride(current, {
        coreId: override.coreId,
        folderPath: override.folderPath,
        classification: override.classification,
        setAt: new Date().toISOString(),
      });
    }
    if (next === current) return;
    await this.writeFolderClassifications(next);
  }

  /**
   * PR #12 connect-time prime. One SSH command that emits the three
   * small JSON files (ledger, marks, classifications) plus mtime
   * witnesses for the cores cache. Replaces three sequential `cat`s
   * + a stat call with a single round trip — the warm-connect path
   * needs to come in under 1s on a normal LAN.
   *
   * Reads only — never writes. The ledger self-heal stays in
   * `ConnectionManager` so it can use cached cores when the cache
   * hits, avoiding the otherwise-mandatory listAllCoresWithFiles
   * walk during heal.
   */
  async primeConnect(
    coresWitnessPaths: readonly string[],
  ): Promise<PrimeConnectResult> {
    this.assertConnected();
    const script = buildPrimeScript({
      ledgerPath: MISTER_LEDGER_PATH,
      marksPath: MISTER_SYSTEM_FILES_PATH,
      classificationsPath: MISTER_FOLDER_CLASSIFICATIONS_PATH,
      coresWitnessPaths,
    });
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to prime connection: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
    const parsed = parsePrimeOutput(result.stdout);
    if (parsed === null) {
      throw new Error(
        'Prime output did not match the expected shape — refusing to ' +
          'use it (the connect path will fall back to per-file reads).',
      );
    }
    return {
      ledger: parseLedger(parsed.ledgerJson),
      marks: parseSystemFilesMarks(parsed.marksJson),
      classifications: parseFolderClassifications(parsed.classificationsJson),
      witnesses: parsed.witnesses,
    };
  }

  /**
   * Stat a batch of absolute paths in one SSH round trip. Used by the
   * listRoms cache (one path per call) and write-through refreshes
   * (the witnesses we recorded for cores.json need to be re-stat'd
   * after we mutate the device).
   */
  async statWitnesses(
    paths: readonly string[],
  ): Promise<Readonly<Record<string, number>>> {
    this.assertConnected();
    if (paths.length === 0) return {};
    // feat/sample-based-hashing — JS-side chunking via the shared
    // `chunked` helper. `buildWitnessScript` embeds each path 3×
    // per line (the `[ -e ]` test, the `stat` arg, and the
    // fallback echo); for a 666-path mame core that's a ~177 KB
    // script, well past ssh2's 32 KB default exec-channel send
    // window — the EPIPE-in-27ms loop the user hit in the
    // disconnect-cycle investigation. 100-path chunks bring each
    // script under ~26 KB. Errors propagate from the first failing
    // chunk; no partial-result merging on failure.
    return chunked<string, Record<string, number>>(
      paths,
      WITNESS_CHUNK_SIZE,
      async (chunk) => {
        const script = buildWitnessScript(chunk);
        const result = await this.runSshOp(script, () =>
          this.ssh.execCommand(script),
        );
        // A non-zero exit here is rare (the script tolerates per-path
        // stat failures internally) but possible on full-disk / fork-fail
        // edge cases. Throw rather than return a partial map so the
        // caller treats this as "couldn't validate" → cache miss.
        if (result.code !== 0) {
          throw new Error(
            `Failed to stat witnesses: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
          );
        }
        const parsed = parseWitnessOutput(result.stdout);
        if (parsed === null) {
          throw new Error(
            'Witness output did not match the expected shape (likely truncated).',
          );
        }
        return parsed;
      },
      (acc, next) => Object.assign(acc, next),
      {},
    );
  }

  /**
   * Compute a content-hash witness for each cores-witness directory.
   * One SSH round trip; each line `<32-hex-hash> <path>` or `0 <path>`
   * for missing. See `buildContentHashScript` for the shell pipeline
   * and rationale.
   *
   * Empty input short-circuits — no SSH call. Same chunking pattern
   * as `statWitnesses` (cores-witness lines are markedly longer than
   * mtime lines because each embeds a `find ... | sort | md5sum`
   * pipeline). For the 5-path `CORES_CACHE_WITNESS_PATHS` the cost
   * is one round trip and a few KB of script.
   */
  async computeCoresWitnessHashes(
    paths: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    this.assertConnected();
    if (paths.length === 0) return {};
    return chunked<string, Record<string, string>>(
      paths,
      WITNESS_CHUNK_SIZE,
      async (chunk) => {
        const script = buildContentHashScript(chunk);
        const result = await this.runSshOp(script, () =>
          this.ssh.execCommand(script),
        );
        if (result.code !== 0) {
          throw new Error(
            `Failed to compute cores witness hashes: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
          );
        }
        const parsed = parseContentHashOutput(result.stdout);
        if (parsed === null) {
          throw new Error(
            'Cores-witness-hash output did not match the expected shape (likely truncated).',
          );
        }
        return parsed;
      },
      (acc, next) => Object.assign(acc, next),
      {},
    );
  }

  /**
   * fix/count-and-status-indicator commit 4 — stat (size + mtime)
   * for a batch of absolute file paths in one SSH round-trip. Used
   * by the hash-cache v3→v4 lazy migration to populate `diskSizeBytes`
   * without re-running the slow `unzip -p | md5sum` pipeline.
   *
   * Empty input short-circuits — no SSH call. Throws on a non-zero
   * exit so the caller treats this as "couldn't validate" → fall
   * back to the existing rehash path.
   */
  async statPathsWithSize(
    paths: readonly string[],
  ): Promise<Record<string, SizeAndMtime>> {
    this.assertConnected();
    if (paths.length === 0) return {};
    const script = buildSizeAndMtimeScript(paths);
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to stat paths with size: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
    const parsed = parseSizeAndMtimeOutput(result.stdout);
    if (parsed === null) {
      throw new Error(
        'Size+mtime output did not match the expected shape (likely truncated).',
      );
    }
    return parsed;
  }

  /**
   * PR #16 round 2: hash a batch of paths in one SSH round trip.
   * Returns md5 + sha1 + size + mtime per path. HashService caches
   * the lot; ScreenScraper takes md5+sha1 in one query for variant
   * coverage.
   *
   * Empty input short-circuits — no SSH call. A non-zero exit from
   * the script throws (the loop tolerates per-file failures
   * internally; a top-level non-zero means fork-exhaustion or a
   * broken shell, neither worth silently papering over).
   */
  async hashPaths(paths: readonly string[]): Promise<readonly HashRecord[]> {
    this.assertConnected();
    if (paths.length === 0) return [];
    const script = buildHashScript(paths);
    // Hash batches stream every byte through `unzip -p | md5sum`,
    // which legitimately runs minutes for a large batch on a slow
    // SD card. Use the higher hash-specific timeout so we don't
    // false-fire on real progress.
    // Round 5 — `disposeOnTimeout: false`. A single multi-GB ROM
    // legitimately exceeding 120s should not tear down the SSH
    // session; the orchestrator catches the timeout and emits a
    // per-path error, leaving the rest of the per-ROM hash loop
    // free to proceed.
    const result = await this.runSshOp(
      script,
      () => this.ssh.execCommand(script),
      SSH_HASH_OP_TIMEOUT_MS,
      false,
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to hash paths: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
    return parseHashOutput(result.stdout);
  }

  async computeSampleMd5s(
    paths: readonly string[],
  ): Promise<Record<string, string>> {
    this.assertConnected();
    if (paths.length === 0) return {};
    // feat/sample-based-hashing — JS-side chunking via the shared
    // `chunked` helper. `buildSampleScript` builds a `set --`
    // shell line with every path quoted; for ~666 mame paths
    // that argv list approaches busybox's argv limit, and the
    // sibling `statWitnesses` chunking exists for the same SSH
    // overflow reason. 100-path chunks each read at most ~12.5 MB
    // of bounded file content (head 64 KB + tail 64 KB per file)
    // — dominated by RTT, not I/O.
    return chunked<string, Record<string, string>>(
      paths,
      WITNESS_CHUNK_SIZE,
      async (chunk) => {
        const script = buildSampleScript(chunk);
        const result = await this.runSshOp(
          script,
          () => this.ssh.execCommand(script),
          SSH_HASH_OP_TIMEOUT_MS,
          false, // disposeOnTimeout — keep session alive; a single slow ISO shouldn't tear down the connection
        );
        if (result.code !== 0) {
          throw new Error(
            `Failed to compute sample md5s: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
          );
        }
        return parseSampleOutput(result.stdout);
      },
      (acc, next) => Object.assign(acc, next),
      {},
    );
  }

  async walkHiddenFiles(): Promise<readonly string[]> {
    this.assertConnected();
    // Category dirs (_Console, _Computer, _Other, _Utility): capture hidden
    // .rbf/.mgl files and hidden subdirectories at depth 1. (#51)
    const categoryFindCmds = MISTER_CATEGORY_DIRS
      .filter(({ category }) => category !== 'Arcade')
      .map(({ dir }) =>
        `find ${shellQuote(dir)} -mindepth 1 -maxdepth 1 \\( -type f -o -type d \\) -name '.*' -printf '%p\\n' 2>/dev/null || true`,
      );
    const script = [
      ...categoryFindCmds,
      // Depth-1 hidden game dirs (e.g. games/.NES) — mindepth 2 misses these. (#51)
      `find ${shellQuote(MISTER_GAMES_DIR)} -mindepth 1 -maxdepth 1 -type d -name '.*' -printf '%p\\n' 2>/dev/null || true`,
      `find ${shellQuote(MISTER_GAMES_DIR)} -mindepth 2 -maxdepth 5 -type f -name '.*' -printf '%p\\n' 2>/dev/null || true`,
      `find ${shellQuote(MISTER_ARCADE_DIR)} -mindepth 1 -maxdepth 4 -type f -name '.*' -printf '%p\\n' 2>/dev/null || true`,
    ].join('\n');
    const result = await this.runSshOp(script, () => this.ssh.execCommand(script));
    return result.stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }

  async writeUpdateSnapshot(json: string): Promise<void> {
    this.assertConnected();
    const tmpPath = `${MISTER_UPDATE_SNAPSHOT_PATH}.tmp`;
    // JSON is piped via stdin rather than embedded in the script string.
    // With 1800+ hidden files the snapshot JSON exceeds ~150 KB — well past
    // busybox's ARG_MAX (~128 KB) when the full script is passed as a single
    // argv to execvp. stdin has no equivalent limit. (#47)
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)} && ` +
      `cat > ${shellQuote(tmpPath)} && ` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_UPDATE_SNAPSHOT_PATH)}`;
    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script, { stdin: json }),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to write update snapshot: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readUpdateSnapshot(): Promise<string | null> {
    this.assertConnected();
    const cmd = `cat ${shellQuote(MISTER_UPDATE_SNAPSHOT_PATH)} 2>/dev/null || true`;
    const result = await this.runSshOp(cmd, () => this.ssh.execCommand(cmd));
    const text = result.stdout.trim();
    return text.length > 0 ? text : null;
  }

  async deleteUpdateSnapshot(): Promise<void> {
    this.assertConnected();
    const cmd = `rm -f ${shellQuote(MISTER_UPDATE_SNAPSHOT_PATH)}`;
    await this.runSshOp(cmd, () => this.ssh.execCommand(cmd));
  }

  async batchRenameAbsolutePaths(
    renames: readonly { readonly src: string; readonly dst: string; readonly id: string }[],
    checkSrcExists: boolean,
    onProgress: (done: number, total: number) => void,
  ): Promise<readonly {
    readonly id: string;
    readonly status: 'ok' | 'missing' | 'fail';
    readonly reason?: string;
  }[]> {
    this.assertConnected();
    if (renames.length === 0) return [];

    const results: { id: string; status: 'ok' | 'missing' | 'fail'; reason?: string }[] = [];
    const total = renames.length;

    for (let i = 0; i < renames.length; i += BULK_ROM_RENAME_CHUNK_SIZE) {
      const chunk = renames.slice(i, i + BULK_ROM_RENAME_CHUNK_SIZE);
      const lines: string[] = [];
      for (const r of chunk) {
        const idQ = shellQuote(r.id);
        if (checkSrcExists) {
          lines.push(
            `if [ ! -e ${shellQuote(r.src)} ]; then`,
            `  printf 'MISSING\\t%s\\n' ${idQ}`,
            `elif err=$(mv ${shellQuote(r.src)} ${shellQuote(r.dst)} 2>&1); then`,
            `  printf 'OK\\t%s\\n' ${idQ}`,
            `else`,
            `  printf 'FAIL\\t%s\\t%s\\n' ${idQ} "$(printf '%s' "$err" | tr '\\n\\t' '  ' | head -c 200)"`,
            `fi`,
          );
        } else {
          lines.push(
            `if err=$(mv ${shellQuote(r.src)} ${shellQuote(r.dst)} 2>&1); then`,
            `  printf 'OK\\t%s\\n' ${idQ}`,
            `else`,
            `  printf 'FAIL\\t%s\\t%s\\n' ${idQ} "$(printf '%s' "$err" | tr '\\n\\t' '  ' | head -c 200)"`,
            `fi`,
          );
        }
      }
      const script = lines.join('\n');
      const result = await this.runSshOp(script, () => this.ssh.execCommand(script));
      for (const line of result.stdout.split('\n')) {
        if (line === '') continue;
        const parts = line.split('\t');
        const tag = parts[0];
        const id = parts[1] ?? '';
        if (tag === 'OK') {
          results.push({ id, status: 'ok' });
        } else if (tag === 'MISSING') {
          results.push({ id, status: 'missing' });
        } else if (tag === 'FAIL') {
          results.push({ id, status: 'fail', reason: parts.slice(2).join('\t') || 'unknown error' });
        }
      }
      onProgress(Math.min(i + chunk.length, total), total);
    }
    return results;
  }

  private async writeFolderClassifications(
    marks: FolderClassifications,
  ): Promise<void> {
    const json = serializeFolderClassifications(marks);
    const tmpPath = `${MISTER_FOLDER_CLASSIFICATIONS_PATH}.tmp`;
    // JSON via stdin — avoids ARG_MAX for large classification sets.
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)} && ` +
      `cat > ${shellQuote(tmpPath)} && ` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_FOLDER_CLASSIFICATIONS_PATH)}`;

    const result = await this.runSshOp(script, () =>
      this.ssh.execCommand(script, { stdin: json }),
    );
    if (result.code !== 0) {
      throw new Error(
        `Failed to write folder classifications: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  private async runRenameScript(renames: readonly CoreRename[], label: string): Promise<void> {
    const lines = ['set -e'];
    for (const r of renames) {
      lines.push(
        `[ -e ${shellQuote(r.to)} ] && { printf 'DEST_EXISTS:%s\\n' ${shellQuote(r.to)} >&2; exit 1; }`,
        `mv ${shellQuote(r.from)} ${shellQuote(r.to)}`,
      );
    }
    const setMarksCmd = lines.join('\n');
    const result = await this.runSshOp(setMarksCmd, () =>
      this.ssh.execCommand(setMarksCmd),
    );
    if (result.code !== 0) {
      const destExistsLines = result.stderr
        .split('\n')
        .filter((l) => l.startsWith('DEST_EXISTS:'));
      if (destExistsLines.length > 0) {
        const toSet = new Set(destExistsLines.map((l) => l.slice('DEST_EXISTS:'.length)));
        const sshConflicts = renames.filter((r) => toSet.has(r.to));
        throw new DestinationAlreadyExistsError(
          sshConflicts.length > 0
            ? sshConflicts
            : destExistsLines.map((l) => ({ from: '?', to: l.slice('DEST_EXISTS:'.length) })),
        );
      }
      throw new Error(
        `Failed to ${label}: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async deleteFilesOrDirs(
    paths: readonly string[],
  ): Promise<{ deleted: readonly string[]; failed: readonly string[] }> {
    this.assertConnected();
    if (paths.length === 0) return { deleted: [], failed: [] };
    // Build a script that attempts each rm -rf independently (set +e) and
    // emits OK:<index> or FAIL:<index> to stdout so results can be mapped
    // back to the original paths by position.
    const lines = ['set +e'];
    paths.forEach((p, i) => {
      lines.push(
        `rm -rf ${shellQuote(p)} && printf 'OK:%d\\n' ${String(i)} || printf 'FAIL:%d\\n' ${String(i)}`,
      );
    });
    const script = lines.join('\n');
    const result = await this.runSshOp(script, () => this.ssh.execCommand(script));
    const deleted: string[] = [];
    const failed: string[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith('OK:')) {
        const idx = parseInt(line.slice(3), 10);
        if (!isNaN(idx) && idx < paths.length) deleted.push(paths[idx]!);
      } else if (line.startsWith('FAIL:')) {
        const idx = parseInt(line.slice(5), 10);
        if (!isNaN(idx) && idx < paths.length) failed.push(paths[idx]!);
      }
    }
    return { deleted, failed };
  }

  private assertConnected(): void {
    if (!this.ssh.isConnected()) {
      throw new Error('RealMisterClient is not connected. Call connect() first.');
    }
  }

  private safelyDispose(): void {
    try {
      this.ssh.dispose();
    } catch {
      // Ignore — dispose is best-effort cleanup.
    }
  }

  /**
   * Wraps an SSH operation in a total-time race. If the operation
   * doesn't finish within `timeoutMs` (default `SSH_OP_TIMEOUT_MS`,
   * raised to 60s in round 3) we treat the transport as dead: tear
   * down the socket, fire `handleUnexpectedDisconnect` (so the
   * manager kicks off auto-retry + the renderer paints the banner),
   * and surface a typed `MisterConnectionError` to the caller. Other
   * errors propagate untouched — we only own the timeout case.
   *
   * Per-call override: hash commands pass `SSH_HASH_OP_TIMEOUT_MS`
   * (120s) because a single batched `unzip -p | md5sum` over many
   * ROMs can legitimately run for minutes without being stuck.
   *
   * Round 4 — `cmd` is the script string for diagnostic logging
   * only. Truncated to 200 chars so a long `find` doesn't drown the
   * structured fields. Required so we have visibility into which
   * shell call hangs when the cascade fires.
   *
   * Round 5 — `disposeOnTimeout` (default true). Hash commands pass
   * `false`: a single multi-GB ROM legitimately exceeding the 120s
   * cap should NOT tear down the SSH transport, because the next
   * per-ROM hash command can still proceed. With false we throw the
   * timed-out promise but leave ssh2 connected — the orphaned remote
   * `unzip|md5sum` process keeps running but doesn't poison the
   * session. ssh2's own keepalive (round 3 widened to 60s) still
   * detects a TRULY dead transport and triggers the unexpected-
   * disconnect path independently.
   */
  private async runSshOp<T>(
    cmd: string,
    fn: () => Promise<T>,
    timeoutMs: number = SSH_OP_TIMEOUT_MS,
    disposeOnTimeout = true,
  ): Promise<T> {
    const opId = nextSshOpId();
    const start = Date.now();
    diagLog('info', 'ssh', '→', 'exec', {
      opId,
      timeoutMs,
      cmd: truncateForLog(cmd),
    });
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new SshOpTimeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);
      diagLog('info', 'ssh', '←', 'exit', {
        opId,
        ms: Date.now() - start,
      });
      return result;
    } catch (err) {
      const ms = Date.now() - start;
      if (err instanceof SshOpTimeoutError) {
        diagLog('error', 'ssh', '✗', 'timeout', {
          opId,
          ms,
          timeoutMs: err.timeoutMs,
          cmd: truncateForLog(cmd),
          disposed: disposeOnTimeout ? 1 : 0,
        });
        const seconds = Math.round(err.timeoutMs / 1000);
        if (disposeOnTimeout) {
          this.handleUnexpectedDisconnect();
          this.safelyDispose();
          throw new MisterConnectionError(
            'unknown',
            `The MiSTer stopped responding (no reply within ${String(seconds)}s). Reconnecting…`,
          );
        }
        // Transport stays alive; let the caller treat this as a
        // per-call failure and move on. The orphaned remote process
        // keeps running until it exits on its own.
        throw new MisterConnectionError(
          'unknown',
          `Command timed out after ${String(seconds)}s; SSH session preserved.`,
        );
      }
      diagLog('error', 'ssh', '✗', 'error', {
        opId,
        ms,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Idle-style wrapper for the streaming bulk exec. Resets the
   * deadline whenever the caller reports activity (via `touch()`),
   * so a slow but progressing bulk-rename batch doesn't false-fire
   * the timeout. Catches the same SshOpTimeoutError as `runSshOp`
   * and converts to the same typed error.
   *
   * Round 4 — `cmd` is for diagnostic logging only (same shape as
   * `runSshOp`'s parameter).
   */
  private async runSshStreamOp<T>(
    cmd: string,
    fn: (api: { readonly touch: () => void }) => Promise<T>,
  ): Promise<T> {
    const opId = nextSshOpId();
    const startWall = Date.now();
    diagLog('info', 'ssh', '→', 'stream-exec', {
      opId,
      timeoutMs: SSH_OP_TIMEOUT_MS,
      cmd: truncateForLog(cmd),
    });
    let lastActivity = Date.now();
    let cancelled = false;
    const aborter: { reject: ((err: Error) => void) | null } = { reject: null };
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const arm = (): void => {
      if (cancelled) return;
      const sinceLast = Date.now() - lastActivity;
      const remaining = SSH_OP_TIMEOUT_MS - sinceLast;
      if (remaining <= 0) {
        aborter.reject?.(new SshOpTimeoutError(SSH_OP_TIMEOUT_MS));
        return;
      }
      timeoutHandle = setTimeout(() => {
        if (Date.now() - lastActivity >= SSH_OP_TIMEOUT_MS) {
          aborter.reject?.(new SshOpTimeoutError(SSH_OP_TIMEOUT_MS));
        } else {
          arm();
        }
      }, remaining);
    };

    const touch = (): void => {
      lastActivity = Date.now();
    };

    try {
      const result = await new Promise<T>((resolve, reject) => {
        aborter.reject = (err) => {
          if (cancelled) return;
          cancelled = true;
          reject(err);
        };
        arm();
        fn({ touch }).then(
          (value) => {
            cancelled = true;
            resolve(value);
          },
          (err: unknown) => {
            cancelled = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          },
        );
      });
      diagLog('info', 'ssh', '←', 'stream-exit', {
        opId,
        ms: Date.now() - startWall,
      });
      return result;
    } catch (err) {
      const ms = Date.now() - startWall;
      if (err instanceof SshOpTimeoutError) {
        diagLog('error', 'ssh', '✗', 'stream-timeout', {
          opId,
          ms,
          timeoutMs: err.timeoutMs,
          cmd: truncateForLog(cmd),
        });
        this.handleUnexpectedDisconnect();
        this.safelyDispose();
        const seconds = Math.round(err.timeoutMs / 1000);
        throw new MisterConnectionError(
          'unknown',
          `The MiSTer stopped responding (no progress for ${String(seconds)}s). Reconnecting…`,
        );
      }
      diagLog('error', 'ssh', '✗', 'stream-error', {
        opId,
        ms,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
}

/**
 * fix/scrape-and-count-correctness commit 2 helpers — push a leaf
 * basename onto the per-parent-dir bucket within a subFolder. Mutates
 * the supplied map in place. The parent path is the directory the
 * leaf lives in (relative to /media/fat/games), so two `Game.cue`
 * files in different parents never bleed into each other's group.
 */
function bucketLeaf(
  byParent: Map<string, string[]>,
  parentRel: string,
  leafName: string,
): void {
  const list = byParent.get(parentRel);
  if (list) list.push(leafName);
  else byParent.set(parentRel, [leafName]);
}

/**
 * Sum `countRomGroups` across every parent bucket. The matcher's
 * `recursiveFileCount` field is intentionally a single integer the
 * matcher can sum further; we collapse the per-parent buckets here
 * so the upstream interface doesn't grow a new payload shape.
 */
function sumGroupCounts(byParent: Map<string, string[]>): number | undefined {
  let total = 0;
  let any = false;
  for (const files of byParent.values()) {
    any = true;
    total += countRomGroups(files);
  }
  return any ? total : undefined;
}

function buildListAllCoresScript(): string {
  // PR #11 round 2 / Change 1: one `find` per category dir does the
  // entire structural enumeration. Replaces the per-entry shell loop
  // that ran a second find inside each top-level subdir to check for
  // folder-shaped cores — that pattern (a) had a per-folder fork
  // cost we couldn't afford, and (b) treated `_Console/._hidden/` as
  // a folder-shaped core because the dir contained rbfs (it's the
  // firmware's stash; we MUST NOT enumerate inside it).
  //
  // The new shape:
  //
  //   find "$catDir" -mindepth 1 -maxdepth 2 \
  //     \( -type d -name '.*' -prune \) -o \
  //     \( -type f \( -iname '*.rbf' -o -iname '*.mgl' \) -printf '%p\n' \)
  //
  // The `-prune` clause skips any DIRECTORY whose name starts with
  // a dot — `._hidden`, `._foo`, etc. Top-level dot-prefixed FILES
  // (`.Atari 2600.mgl`, `.Game Gear.mgl`) are user-hidden cores and
  // the prune doesn't touch them.
  //
  // Output: one line per rbf/mgl, full path. Top-level files print
  // as `<catDir>/<filename>`; folder-shaped cores print as
  // `<catDir>/<folder>/<rbf>`. JS picks the parent on slash and
  // dedupes folder-shaped emission.
  //
  // The R record format: `R\t<category>\t<file|dir>\t<fullPath>`.
  // Including the full path lets the matcher disambiguate when two
  // category dirs share a category — e.g. `_Console` and
  // `_Console (autoboot)` both have category=Console; the rbf in
  // either dir resolves to the right `fullPath`.
  const dirsScript = MISTER_CATEGORY_DIRS.map(({ category, dir }) => {
    return [
      `if [ -d ${shellQuote(dir)} ]; then`,
      `  find ${shellQuote(dir)} -mindepth 1 -maxdepth 2 \\`,
      `    \\( -type d -name '.*' -prune \\) -o \\`,
      `    \\( -type f \\( -iname '*.rbf' -o -iname '*.mgl' \\) -printf 'P\\t${category}\\t%p\\n' \\) \\`,
      `    2>/dev/null`,
      'fi',
    ].join('\n');
  }).join('\n');

  // Per-entry emission: one G line announcing the games dir, then
  // GF/GD per top-level file/dir, plus SE per immediate child of each
  // top-level subfolder. SR (recursive totals) is computed in a
  // SEPARATE bulk pass below — see `recursivePass`. The matcher
  // applies `isSystemFile` for the top-level filter and walks SE/SR
  // data to compute `recursiveRomCount` (Round 3 / Issue 5). Folder-
  // shaped ROMs (Saturn/MegaCD discs) come through as GD lines and
  // are NEVER filtered out as system content.
  //
  // The case-insensitive globbing (`* .[!.]*` covers BOTH visible AND
  // dot-prefixed dirs) is what surfaces externally-hidden games dirs
  // like `.ATARI7800` so the matcher can flag them — see Issue 4.
  //
  // The structural pass uses pure shell builtins: `printf`, `[`, the
  // `${var##pattern}` substring stripper, and glob expansion. None of
  // these fork on busybox, so a real MiSTer with 870 top-level dirs
  // walks in well under a second.
  const gamesScript = [
    `if [ -d ${shellQuote(MISTER_GAMES_DIR)} ]; then`,
    `  cd ${shellQuote(MISTER_GAMES_DIR)}`,
    '  for d in * .[!.]*; do',
    '    [ -d "$d" ] || continue',
    `    printf 'G\\t%s\\n' "$d"`,
    '    for entry in "$d"/* "$d"/.[!.]*; do',
    '      [ -e "$entry" ] || continue',
    '      name="${entry##*/}"',
    '      if [ -f "$entry" ]; then',
    `        printf 'GF\\t%s\\t%s\\n' "$d" "$name"`,
    '      elif [ -d "$entry" ]; then',
    `        printf 'GD\\t%s\\t%s\\n' "$d" "$name"`,
    // Walk one level deeper so the matcher can classify this folder
    // (atomic vs container) — but stop at immediate children. The
    // recursive count comes from the bulk find pass, not from a
    // per-folder fork.
    '        for sub in "$entry"/* "$entry"/.[!.]*; do',
    '          [ -e "$sub" ] || continue',
    '          subname="${sub##*/}"',
    '          if [ -f "$sub" ]; then',
    `            printf 'SE\\t%s\\t%s\\tf\\t%s\\n' "$d" "$name" "$subname"`,
    '          elif [ -d "$sub" ]; then',
    `            printf 'SE\\t%s\\t%s\\td\\t%s\\n' "$d" "$name" "$subname"`,
    '          fi',
    '        done',
    '      fi',
    '    done',
    '  done',
    'fi',
  ].join('\n');

  // Bulk recursive-file emission. PR #11 round 2 / Change 3:
  // the previous awk aggregation pre-computed per-(top, subfolder)
  // counts on the device, but it had no notion of system folders.
  // Files inside `Vectrex/Overlays/` were counted toward
  // recursiveRomCount even though `listRoms` correctly suppressed
  // them — the cores list and the drill-in disagreed.
  //
  // Round 2 emits raw `F\t%P` lines (one per file), and the JS
  // parser aggregates per (top, subfolder) WITH `shouldCountAsRom`
  // applied. Both code paths (cores-list count and listRoms) use
  // the same filter, so they can never drift apart.
  //
  //   `find -mindepth 3 -type f` skips:
  //     - the games-dir layer (depth 1 below games/)
  //     - top-level files of each games dir (depth 2; those are GF
  //       lines and don't contribute to a SUBFOLDER's count)
  //   and includes:
  //     - every regular file at depth 3+ (i.e. anywhere under a
  //       top-level subfolder), which is exactly the candidate set
  //       for the recursive count.
  //
  // Performance: ~6,400 files on the user's MiSTer = ~200KB of
  // stdout. The single find runs in 2-3 seconds; the JS aggregation
  // is O(files) and microseconds per call.
  const recursivePass = [
    `if [ -d ${shellQuote(MISTER_GAMES_DIR)} ]; then`,
    `  find ${shellQuote(MISTER_GAMES_DIR)} -mindepth 3 -type f -printf 'F\\t%P\\n' 2>/dev/null`,
    'fi',
  ].join('\n');

  // Emit an A-tagged line if the arcade directory exists on the device,
  // regardless of contents. The renderer needs this signal because real
  // MiSTers populate `_Arcade/` with `.mra` files (and subfolders), not
  // `.rbf` / `.mgl` — so we cannot infer arcade presence from the rbfs
  // stream alone.
  const arcadeProbeScript = [
    `if [ -d ${shellQuote('/media/fat/_Arcade')} ]; then`,
    `  printf 'A\\n'`,
    `fi`,
  ].join('\n');

  return `set -e\n${dirsScript}\n${gamesScript}\n${recursivePass}\n${arcadeProbeScript}\n`;
}

/**
 * Parses the OK / FAIL stream produced by a bulk-rename shell script.
 * Each line is either:
 *   OK\t<id>
 *   FAIL\t<id>\t<single-line reason>
 * The shape is identifier-agnostic — same parser for ROMs and cores.
 */
function parseBulkResult<T extends BulkRomResult | BulkCoreResult>(
  stdout: string,
  idKey: 'filename' | 'coreId',
): T {
  const succeeded: string[] = [];
  const failed: { readonly filename?: string; readonly coreId?: string; readonly reason: string }[] = [];
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag === 'OK' && parts.length >= 2) {
      succeeded.push(parts[1] ?? '');
    } else if (tag === 'FAIL' && parts.length >= 3) {
      const id = parts[1] ?? '';
      const reason = parts.slice(2).join('\t') || 'unknown error';
      const entry =
        idKey === 'filename'
          ? { filename: id, reason }
          : { coreId: id, reason };
      failed.push(entry);
    }
  }
  return { succeeded, failed } as unknown as T;
}

function parseCategory(name: string): CoreCategory | null {
  const valid: ReadonlySet<CoreCategory> = new Set([
    'Console',
    'Computer',
    'Other',
    'Utility',
    'Arcade',
  ]);
  return valid.has(name as CoreCategory) ? (name as CoreCategory) : null;
}

/**
 * Parses the stdout of `buildListAllCoresScript()` into the matcher
 * input shape. Mirrors the inline parser in `listAllCoresWithFiles`
 * verbatim; pulled out as a top-level helper so the diagnostic path
 * can reuse it without forking the production parsing logic.
 *
 * Diagnostic-only: do not call this from new production code without
 * confirming the inline parser stays bug-compatible.
 */
function parseListAllCoresShellOutput(stdout: string): {
  readonly rbfs: readonly RawRbfInput[];
  readonly gamesDirs: readonly RawGamesDirInput[];
  readonly arcadeDirExists: boolean;
} {
  const rbfs: RawRbfInput[] = [];
  const folderCoreDirs = new Set<string>();
  interface DirBuilder {
    files: string[];
    dirs: string[];
    subFolders: Map<string, MutableSubFolderBuilder>;
  }
  interface MutableSubFolderBuilder {
    name: string;
    files: string[];
    dirs: string[];
    filesByParent: Map<string, string[]>;
    hiddenFilesByParent: Map<string, string[]>;
  }
  const gamesDirsBuilder = new Map<string, DirBuilder>();
  const ensureDirBuilder = (rawName: string): DirBuilder => {
    let bucket = gamesDirsBuilder.get(rawName);
    if (!bucket) {
      bucket = { files: [], dirs: [], subFolders: new Map() };
      gamesDirsBuilder.set(rawName, bucket);
    }
    return bucket;
  };
  const ensureSubFolder = (
    bucket: DirBuilder,
    subName: string,
  ): MutableSubFolderBuilder => {
    let sub = bucket.subFolders.get(subName);
    if (!sub) {
      sub = {
        name: subName,
        files: [],
        dirs: [],
        filesByParent: new Map(),
        hiddenFilesByParent: new Map(),
      };
      bucket.subFolders.set(subName, sub);
    }
    return sub;
  };

  let arcadeDirExists = false;
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag === 'A') {
      arcadeDirExists = true;
    } else if (tag === 'P' && parts.length >= 3) {
      const categoryName = parts[1] ?? '';
      const fullPath = parts.slice(2).join('\t');
      const category = parseCategory(categoryName);
      if (!category) continue;
      const catDir = MISTER_CATEGORY_DIRS.find(
        (c) => c.category === category && fullPath.startsWith(`${c.dir}/`),
      )?.dir;
      if (catDir === undefined) continue;
      const rel = fullPath.slice(catDir.length + 1);
      const slash = rel.indexOf('/');
      if (slash < 0) {
        rbfs.push({
          category,
          filename: rel,
          fullPath,
          isFolder: false,
        });
      } else {
        const folder = rel.slice(0, slash);
        const folderFullPath = `${catDir}/${folder}`;
        if (folderCoreDirs.has(folderFullPath)) continue;
        folderCoreDirs.add(folderFullPath);
        rbfs.push({
          category,
          filename: folder,
          fullPath: folderFullPath,
          isFolder: true,
        });
      }
    } else if (tag === 'G' && parts.length >= 2) {
      const rawName = parts[1] ?? '';
      if (rawName !== '') ensureDirBuilder(rawName);
    } else if (tag === 'GF' && parts.length >= 3) {
      const rawName = parts[1] ?? '';
      const filename = parts.slice(2).join('\t');
      ensureDirBuilder(rawName).files.push(filename);
    } else if (tag === 'GD' && parts.length >= 3) {
      const rawName = parts[1] ?? '';
      const dirname = parts.slice(2).join('\t');
      ensureDirBuilder(rawName).dirs.push(dirname);
    } else if (tag === 'SE' && parts.length >= 5) {
      const parent = parts[1] ?? '';
      const subName = parts[2] ?? '';
      const kind = parts[3] ?? '';
      const basename = parts.slice(4).join('\t');
      if (parent === '' || subName === '' || basename === '') continue;
      const sub = ensureSubFolder(ensureDirBuilder(parent), subName);
      if (kind === 'f') sub.files.push(basename);
      else if (kind === 'd') sub.dirs.push(basename);
    } else if (tag === 'F' && parts.length >= 2) {
      // Diagnostic helper aggregates without marks (the diag CLI
      // doesn't have the renderer's user-marks cache); the result
      // matches what the production path produces for all paths
      // that are NOT user-marked.
      const rel = parts.slice(1).join('\t');
      const segs = rel.split('/');
      if (segs.length < 3) continue;
      const topLevelDir = segs[0]!;
      const subName = segs[1]!;
      const visibleTop = topLevelDir.startsWith('.')
        ? topLevelDir.slice(1)
        : topLevelDir;
      const relInGamesDir = segs.slice(1).join('/');
      if (
        !shouldCountAsRom({
          relPath: relInGamesDir,
          isDirectory: false,
          coreId: visibleTop,
        })
      ) {
        continue;
      }
      const sub = ensureSubFolder(ensureDirBuilder(topLevelDir), subName);
      const leaf = segs[segs.length - 1]!;
      const parentRel = segs.slice(0, -1).join('/');
      bucketLeaf(sub.filesByParent, parentRel, leaf);
      if (leaf.startsWith('.')) {
        bucketLeaf(sub.hiddenFilesByParent, parentRel, leaf);
      }
    }
  }

  const gamesDirs: RawGamesDirInput[] = Array.from(
    gamesDirsBuilder,
    ([rawName, b]): RawGamesDirInput => {
      const subFolders: RawSubFolderInput[] = Array.from(
        b.subFolders.values(),
        (s) => ({
          name: s.name,
          files: s.files,
          dirs: s.dirs,
          recursiveFileCount: sumGroupCounts(s.filesByParent),
          recursiveHiddenFileCount: sumGroupCounts(s.hiddenFilesByParent),
        }),
      );
      return { rawName, files: b.files, dirs: b.dirs, subFolders };
    },
  );

  return { rbfs, gamesDirs, arcadeDirExists };
}

/**
 * Discovery shell pass — enumerates every directory under
 * /media/fat that could plausibly hold rbf or mgl cores plus any
 * rbf/mgl files at /media/fat root itself.
 *
 * Output line shapes (TAB-separated):
 *   TOP\t<type>\t<name>           one per top-level entry at /media/fat
 *                                  (type = d|f, the GNU `find -printf %y`)
 *   FILE\t<categoryDir>\t<rel>    one per rbf/mgl found inside any _*
 *                                  category dir (recursive, includes
 *                                  dot-prefixed paths)
 *   HIDDEN\t<type>\t<name>        one per entry inside _Console/._hidden
 *                                  (the firmware's stash that the
 *                                  production loop does not enumerate)
 *
 * Read-only — never writes, never modifies. Safe to run repeatedly.
 */
function buildDiscoveryScript(): string {
  return [
    // 1. Every top-level entry at /media/fat — surfaces _* dirs (incl
    //    `_Console (autoboot)`) and any rbf/mgl at root (menu.rbf).
    `if [ -d ${shellQuote('/media/fat')} ]; then`,
    `  find ${shellQuote('/media/fat')} -maxdepth 1 -mindepth 1 -printf 'TOP\\t%y\\t%P\\n' 2>/dev/null`,
    'fi',
    // 2. Recursive find of rbf/mgl inside every _* dir — captures
    //    files in _Console (autoboot)/ AND the contents of any
    //    dot-prefixed subdir like _Console/._hidden/.
    'for d in /media/fat/_*; do',
    '  [ -d "$d" ] || continue',
    '  base="${d##*/}"',
    `  find "$d" -type f \\( -iname '*.rbf' -o -iname '*.mgl' \\) -printf "FILE\\t\${base}\\t%P\\n" 2>/dev/null`,
    'done',
    // 3. Explicit listing of _Console/._hidden — the find above
    //    would catch the rbf/mgl files inside, but a flat listing
    //    here also captures any non-core files / nested subdirs the
    //    user may want to see.
    `if [ -d ${shellQuote('/media/fat/_Console/._hidden')} ]; then`,
    `  for entry in ${shellQuote('/media/fat/_Console/._hidden')}/* ${shellQuote('/media/fat/_Console/._hidden')}/.[!.]*; do`,
    '    [ -e "$entry" ] || continue',
    '    base="${entry##*/}"',
    '    if [ -f "$entry" ]; then',
    `      printf 'HIDDEN\\tfile\\t%s\\n' "$base"`,
    '    elif [ -d "$entry" ]; then',
    `      printf 'HIDDEN\\tdir\\t%s\\n' "$base"`,
    '    fi',
    '  done',
    'fi',
  ].join('\n');
}

/**
 * Parse the discovery shell output into DiscoveryRecords on the
 * collector. Each line yields exactly one record.
 */
function parseDiscoveryShellOutput(
  stdout: string,
  collector: InMemoryDiagnosticsCollector,
): void {
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const parts = line.split('\t');
    const tag = parts[0];
    if (tag === 'TOP' && parts.length >= 3) {
      const typeChar = parts[1] ?? '';
      const name = parts.slice(2).join('\t');
      const entryType: 'file' | 'dir' = typeChar === 'd' ? 'dir' : 'file';
      const path = `/media/fat/${name}`;
      let note: string;
      if (entryType === 'dir' && name.startsWith('_')) {
        note = 'category-like dir at /media/fat root';
      } else if (entryType === 'file' && isCoreFile(name)) {
        note = 'rbf/mgl at /media/fat root';
      } else if (entryType === 'dir') {
        note = 'top-level dir at /media/fat (informational)';
      } else {
        note = 'top-level file at /media/fat (informational)';
      }
      const extractedPrefix =
        entryType === 'file' && isCoreFile(name)
          ? extractCorePrefix(name)
          : undefined;
      collector.emit({
        kind: 'discovery',
        path,
        entryType,
        note,
        extractedPrefix,
      });
    } else if (tag === 'FILE' && parts.length >= 3) {
      const categoryDir = parts[1] ?? '';
      const rel = parts.slice(2).join('\t');
      const path = `/media/fat/${categoryDir}/${rel}`;
      const baseName = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel;
      const extractedPrefix = isCoreFile(baseName)
        ? extractCorePrefix(baseName)
        : undefined;
      collector.emit({
        kind: 'discovery',
        path,
        entryType: 'file',
        note: `rbf/mgl found under ${categoryDir}`,
        extractedPrefix,
      });
    } else if (tag === 'HIDDEN' && parts.length >= 3) {
      const typeChar = parts[1] ?? '';
      const name = parts.slice(2).join('\t');
      const entryType: 'file' | 'dir' = typeChar === 'dir' ? 'dir' : 'file';
      const path = `/media/fat/_Console/._hidden/${name}`;
      const extractedPrefix =
        entryType === 'file' && isCoreFile(name)
          ? extractCorePrefix(name)
          : undefined;
      collector.emit({
        kind: 'discovery',
        path,
        entryType,
        note: 'inside _Console/._hidden — the firmware stash',
        extractedPrefix,
      });
    }
  }
}

/**
 * Priority order for picking the primary file in an atomic folder.
 * Lower number = higher priority. Drives `pickPrimaryRomFile`.
 *
 * fix/cd-hash-prefer-cue-over-bin: plain alphabetical order caused
 * `(Track 01).bin` to sort before `.cue` (space 0x20 < period 0x2E),
 * so audio lead-in tracks were hashed instead of the unique .cue.
 * Many PCE-CD / MegaCD games share identical-length silence on
 * Track 01, producing the same MD5 for completely different titles.
 *
 * Priority rationale:
 *   0  .chd / .iso / .gdi — single-file disc images, inherently unique
 *   0  all other formats (cart, archive) — single-file per game, fine
 *   1  .cue — text launcher for multi-track sets, unique per disc layout
 *   2  .bin — raw track data, often shared CD-DA silence (collision risk)
 */
const ROM_FILE_EXT_PRIORITY: Readonly<Record<string, number>> = {
  '.cue': 1,
  '.bin': 2,
};

function romFilePriority(filename: string): number {
  const dot = filename.lastIndexOf('.');
  const ext = dot < 0 ? '' : filename.slice(dot).toLowerCase();
  return ROM_FILE_EXT_PRIORITY[ext] ?? 0;
}

/**
 * PR-D1 (PR #27): pick the primary launchable ROM file inside an
 * atomic folder. Used to populate `Rom.containedRomPath` so the
 * renderer can bind metadata to the folder row by looking up the
 * file's hash.
 *
 * fix/cd-hash-prefer-cue-over-bin: sorts by extension priority first
 * (prefers .cue over .bin for multi-track CD sets), then alphabetically
 * as a tiebreaker within the same priority tier.
 *
 * Returns undefined when no immediate-child file has a launchable
 * extension. Doesn't recurse: deeply-nested ROMs inside an atomic
 * folder are unusual and would confuse the metadata binding.
 */
function pickPrimaryRomFile(
  immediateFiles: readonly string[],
  folderPath: string,
): string | undefined {
  const launchable = [...immediateFiles].filter(isLaunchableRomExtension);
  if (launchable.length === 0) return undefined;
  launchable.sort((a, b) => {
    const pd = romFilePriority(a) - romFilePriority(b);
    if (pd !== 0) return pd;
    return a.localeCompare(b);
  });
  return `${folderPath}/${launchable[0]!}`;
}

/**
 * Reject a path segment that's unsafe to splice into an SSH command
 * built around `/media/fat/games/<seg>/...`. This is path-correctness
 * only — command-injection defense lives in `shellQuote` (single-
 * quoted shell args). Keep the rules narrow and explicit so legitimate
 * filenames aren't false-rejected.
 *
 * Rules:
 *   • Empty string                — invalid (no segment)
 *   • Exactly `..` or `.`         — path-traversal attempt
 *   • Contains `/` (forward) or
 *     `\\` (backslash)            — multiple segments in one input
 *   • Contains a null byte (\\0)  — would terminate the C string the
 *                                   shell hands to its filesystem
 *                                   syscalls, smuggling truncation
 *
 * NOT rejected:
 *   • `..` as a SUBSTRING of a longer name. The previous `'.includes('..')`
 *     rule false-rejected ROM titles with literal triple-dot ellipses
 *     ("Nights Into Dreams...", "Yu Gi Oh... GX") because `'...'`
 *     contains `'..'`. Path traversal needs the segment to BE `..` —
 *     a substring inside a longer filename routes to that filename
 *     verbatim, not up a directory.
 *
 * Exported (round 2 — fix/safe-segment-ellipsis) so the test suite
 * can pin every rule directly without going through a higher-level
 * caller.
 */
export function assertSafeSegment(label: string, value: string): void {
  if (value === '') {
    throw new Error(`Invalid ${label}: (empty)`);
  }
  if (value === '..' || value === '.') {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (value.includes('/') || value.includes('\\')) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  if (value.includes('\0')) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function assertSafeSubPath(subPath: string): void {
  if (subPath === '') return;
  if (subPath.includes('\0') || subPath.startsWith('/') || subPath.endsWith('/')) {
    throw new Error(`Invalid subPath: ${subPath}`);
  }
  for (const segment of subPath.split('/')) {
    if (segment === '' || segment === '..' || segment === '.') {
      throw new Error(`Invalid subPath: ${subPath}`);
    }
  }
}

function mapConnectError(err: unknown): MisterConnectionError {
  if (err instanceof MisterConnectionError) {
    return err;
  }

  const message = err instanceof Error ? err.message : String(err);
  const code =
    err instanceof Error && 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : undefined;

  const networkCodes = new Set([
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'EHOSTDOWN',
    'ENETUNREACH',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]);

  if (code !== undefined && networkCodes.has(code)) {
    return new MisterConnectionError(
      'unreachable',
      `Could not reach the MiSTer (${code}). Check the host, port, and that the device is powered on.`,
    );
  }
  if (/timed?\s*out/i.test(message)) {
    return new MisterConnectionError(
      'unreachable',
      'Connection to the MiSTer timed out. Check the host, port, and that the device is reachable.',
    );
  }
  if (/authentication/i.test(message)) {
    return new MisterConnectionError(
      'auth_failed',
      'SSH authentication failed. Check the username and password or key.',
    );
  }
  return new MisterConnectionError(
    'unknown',
    `Could not connect to the MiSTer: ${message}`,
  );
}

/**
 * The on-device awk program that extracts (relativePath, zip-attr
 * blocks, rbf, setname) from one or more .mra files. Emitted as a
 * heredoc by `parseArcadeMras` and removed immediately after the
 * find/xargs invocation. Kept in lock-step with `parseArcadeMra`
 * (the JS reference parser in `shared/arcade-mra-parse.ts`) — when
 * a regex changes there, change it here too.
 *
 * Output format: one TSV row per .mra:
 *   relativePath \t zipBlocks \t rbf \t setname
 *
 *   • relativePath — basename only (top-level mras), incl. any
 *     leading dot for hidden entries.
 *   • zipBlocks    — one entry per `<rom ... zip="...">` block,
 *     joined by ASCII Unit Separator (0x1F). Each entry retains
 *     its internal `|` pipe-fallback alternatives. Empty when the
 *     .mra references no zips (TTL / discrete-logic games).
 *   • rbf, setname — `<rbf>` / `<setname>` text content. Empty
 *     when absent or self-closing.
 *
 * Portability notes (BusyBox awk):
 *   • Uses `match() + RSTART/RLENGTH + substr/sub` only; no
 *     `gensub`, no array capture, no `nextfile`.
 *   • Bounded at 200 lines per file via a `done` flag — the four
 *     tags we need are always near the top, so capping protects
 *     against pathological 100MB .mra files (none exist in the
 *     wild but the cap is cheap insurance).
 *   • Builds the value-quote character class via `sprintf("%c",
 *     39)` / `sprintf("%c", 34)` rather than embedding `'` and `"`
 *     directly — keeps the heredoc payload free of shell-quoting
 *     escape hazards regardless of how the embedding evolves.
 *
 * The first FNR==1 in each file flushes the previous file's
 * accumulated state via emit(); the END block flushes the last
 * file. `done` blocks late lines from contributing to a file
 * whose first 200 lines we've already scanned.
 */
function buildArcadeParseAwkScript(): string {
  return [
    `BEGIN {`,
    `  US = sprintf("%c", 31)`,
    `  SQ = sprintf("%c", 39)`,
    `  DQ = sprintf("%c", 34)`,
    `  # Regexes built from runtime strings so the heredoc never`,
    `  # has to contain raw single or double quote characters in`,
    `  # awkward positions.`,
    `  ZIP_RE = "zip=[" SQ DQ "][^" SQ DQ "]*[" SQ DQ "]"`,
    `  STRIP_LEFT_RE = "^zip=[" SQ DQ "]"`,
    `  STRIP_RIGHT_RE = "[" SQ DQ "]$"`,
    `}`,
    `FNR == 1 {`,
    `  if (curfile != "") emit()`,
    `  curfile = FILENAME`,
    `  sub(/^.*\\//, "", curfile)`,
    `  zips = ""; rbf = ""; setname = ""; done = 0`,
    `}`,
    `done { next }`,
    `FNR > 200 { done = 1; next }`,
    `{`,
    `  if (rbf == "" && match($0, /<rbf[^>]*>[^<]*<\\/rbf>/)) {`,
    `    s = substr($0, RSTART, RLENGTH)`,
    `    sub(/^<rbf[^>]*>/, "", s)`,
    `    sub(/<\\/rbf>$/, "", s)`,
    `    rbf = s`,
    `  }`,
    `  if (setname == "" && match($0, /<setname[^>]*>[^<]*<\\/setname>/)) {`,
    `    s = substr($0, RSTART, RLENGTH)`,
    `    sub(/^<setname[^>]*>/, "", s)`,
    `    sub(/<\\/setname>$/, "", s)`,
    `    setname = s`,
    `  }`,
    `  line = $0`,
    `  while (match(line, ZIP_RE)) {`,
    `    attr = substr(line, RSTART, RLENGTH)`,
    `    val = attr`,
    `    sub(STRIP_LEFT_RE, "", val)`,
    `    sub(STRIP_RIGHT_RE, "", val)`,
    `    if (val != "") {`,
    `      if (zips == "") zips = val`,
    `      else zips = zips US val`,
    `    }`,
    `    line = substr(line, RSTART + RLENGTH)`,
    `  }`,
    `}`,
    `END { if (curfile != "") emit() }`,
    `function emit() {`,
    `  printf "%s\\t%s\\t%s\\t%s\\n", curfile, zips, rbf, setname`,
    `}`,
  ].join('\n');
}
