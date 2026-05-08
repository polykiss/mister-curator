import { NodeSSH } from 'node-ssh';

import { shellQuote } from '@app/main/clients/shell';
import {
  HIDEABLE_CATEGORIES,
  MISTER_CATEGORY_DIRS,
  MISTER_FOLDER_CLASSIFICATIONS_PATH,
  MISTER_GAMES_DIR,
  MISTER_LEDGER_DIR,
  MISTER_LEDGER_PATH,
  MISTER_SYSTEM_FILES_PATH,
} from '@shared/constants';
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
  FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER,
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
  LEDGER_HEREDOC_DELIMITER,
  parseLedger,
  serializeLedger,
} from '@shared/ledger';
import {
  parseSystemFilesMarks,
  serializeSystemFilesMarks,
  SYSTEM_FILES_HEREDOC_DELIMITER,
  withMark,
  withoutMark,
} from '@shared/system-files-marks';
import {
  buildHashScript,
  parseHashOutput,
} from '@shared/hash-script';
import {
  buildPrimeScript,
  buildWitnessScript,
  parsePrimeOutput,
  parseWitnessOutput,
  type WitnessMtimes,
} from '@shared/prime-parse';
import { MisterConnectionError } from '@shared/types';
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
 * Per-operation SSH timeout. Live testing showed that pulling the
 * MiSTer's network cable mid-session left ROM-list calls hanging for
 * 30+ seconds before the OS-level TCP timeout fired. 10 s is generous
 * enough not to false-positive against a slow MiSTer (the
 * `listAllCoresWithFiles` benchmark on a real device is ~7 s) but
 * tight enough that "unplug, click, see frozen UI" never lasts a
 * full 30 s.
 */
const SSH_OP_TIMEOUT_MS = 10_000;

/**
 * SSH-level keepalive cadence. ssh2 sends an empty keepalive packet
 * every `keepaliveInterval` ms; after `keepaliveCountMax` missed
 * responses the socket fires its own `'close'` / `'error'` event and
 * `RealMisterClient.handleUnexpectedDisconnect` kicks in. With
 * 5s × 2, an idle but dead connection is detected within ~10–15 s
 * even if no user action is happening — complementing the per-op
 * timeout above for the active-call case. Round 2 used 10s × 2
 * (~30s); live testing pushed for tighter detection.
 */
const SSH_KEEPALIVE_INTERVAL_MS = 5_000;
const SSH_KEEPALIVE_COUNT_MAX = 2;

/**
 * Marker error thrown by the per-op timeout race. Internal-only —
 * caught by `runSshOp` and converted to a typed
 * `MisterConnectionError` before it leaves the client.
 */
class SshOpTimeoutError extends Error {
  constructor() {
    super(`SSH operation timed out after ${String(SSH_OP_TIMEOUT_MS)}ms`);
    this.name = 'SshOpTimeoutError';
  }
}

export class RealMisterClient implements IMisterClient {
  private readonly ssh: NodeSSH;
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

    const dirCheck = await this.runSshOp(() => this.ssh.execCommand(
      `[ -d ${shellQuote(MISTER_GAMES_DIR)} ]`,
    ));
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
    const result = await this.runSshOp(() => this.ssh.execCommand(script));
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
      recursiveFileCount?: number;
      recursiveHiddenFileCount?: number;
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
        sub = { name: subName, files: [], dirs: [] };
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
        const sub = ensureSubFolder(ensureDirBuilder(topLevelDir), subName);
        sub.recursiveFileCount = (sub.recursiveFileCount ?? 0) + 1;
        const leaf = segs[segs.length - 1]!;
        if (leaf.startsWith('.')) {
          sub.recursiveHiddenFileCount =
            (sub.recursiveHiddenFileCount ?? 0) + 1;
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
            recursiveFileCount: s.recursiveFileCount,
            recursiveHiddenFileCount: s.recursiveHiddenFileCount,
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
    const listResult = await this.runSshOp(() =>
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
    const discoveryResult = await this.runSshOp(() =>
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

    const result = await this.runSshOp(() => this.ssh.execCommand(script));
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
      });
      const override = getFolderOverride(
        folderClassifications,
        coreId,
        visibleRelPath,
      );
      const classification = resolveClassification(heuristic, override);
      roms.push({
        coreId,
        filename: acc.name,
        displayName: displayRomName(visibleBase),
        sizeBytes: acc.sizeBytes,
        hidden,
        path: `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`,
        kind:
          classification === 'container' ? 'folder-container' : 'folder-atomic',
        relativePath,
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

    const result = await this.runSshOp(() => this.ssh.execCommand(command));
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

    const coreDir =
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`;
    const lines: string[] = [`cd ${shellQuote(coreDir)}`];
    for (const p of pending) {
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
    const result = await this.runSshOp(() => this.ssh.execCommand(script));
    return parseBulkResult<BulkRomResult>(result.stdout, 'filename');
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
    await this.runSshStreamOp(({ touch }) =>
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
    const result = await this.runSshOp(() => this.ssh.execCommand(
      `cat ${shellQuote(MISTER_LEDGER_PATH)} 2>/dev/null || true`,
    ));
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
    // serializeLedger refuses to produce a payload containing the heredoc
    // delimiter — defense-in-depth so a hostile coreId / rbfPath value can
    // never close the heredoc early and turn the tail of the JSON into
    // shell commands.
    const json = serializeLedger(ledger);
    const tmpPath = `${MISTER_LEDGER_PATH}.tmp`;
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)}\n` +
      `cat > ${shellQuote(tmpPath)} <<'${LEDGER_HEREDOC_DELIMITER}'\n` +
      json +
      `${LEDGER_HEREDOC_DELIMITER}\n` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_LEDGER_PATH)}\n`;

    const result = await this.runSshOp(() => this.ssh.execCommand(script));
    if (result.code !== 0) {
      throw new Error(
        `Failed to write hide ledger: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readSystemFilesMarks(): Promise<SystemFilesMarks> {
    this.assertConnected();
    const result = await this.runSshOp(() => this.ssh.execCommand(
      `cat ${shellQuote(MISTER_SYSTEM_FILES_PATH)} 2>/dev/null || true`,
    ));
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
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)}\n` +
      `cat > ${shellQuote(tmpPath)} <<'${SYSTEM_FILES_HEREDOC_DELIMITER}'\n` +
      json +
      `${SYSTEM_FILES_HEREDOC_DELIMITER}\n` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_SYSTEM_FILES_PATH)}\n`;

    const result = await this.runSshOp(() => this.ssh.execCommand(script));
    if (result.code !== 0) {
      throw new Error(
        `Failed to write system-files marks: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readFolderClassifications(): Promise<FolderClassifications> {
    this.assertConnected();
    const result = await this.runSshOp(() => this.ssh.execCommand(
      `cat ${shellQuote(MISTER_FOLDER_CLASSIFICATIONS_PATH)} 2>/dev/null || true`,
    ));
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
    const result = await this.runSshOp(() => this.ssh.execCommand(script));
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
  async statWitnesses(paths: readonly string[]): Promise<WitnessMtimes> {
    this.assertConnected();
    if (paths.length === 0) return {};
    const script = buildWitnessScript(paths);
    const result = await this.runSshOp(() => this.ssh.execCommand(script));
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
    const result = await this.runSshOp(() => this.ssh.execCommand(script));
    if (result.code !== 0) {
      throw new Error(
        `Failed to hash paths: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
    return parseHashOutput(result.stdout);
  }

  private async writeFolderClassifications(
    marks: FolderClassifications,
  ): Promise<void> {
    const json = serializeFolderClassifications(marks);
    const tmpPath = `${MISTER_FOLDER_CLASSIFICATIONS_PATH}.tmp`;
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)}\n` +
      `cat > ${shellQuote(tmpPath)} <<'${FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER}'\n` +
      json +
      `${FOLDER_CLASSIFICATIONS_HEREDOC_DELIMITER}\n` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_FOLDER_CLASSIFICATIONS_PATH)}\n`;

    const result = await this.runSshOp(() => this.ssh.execCommand(script));
    if (result.code !== 0) {
      throw new Error(
        `Failed to write folder classifications: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  private async runRenameScript(renames: readonly CoreRename[], label: string): Promise<void> {
    const lines = ['set -e'];
    for (const r of renames) {
      lines.push(`mv ${shellQuote(r.from)} ${shellQuote(r.to)}`);
    }
    const result = await this.runSshOp(() => this.ssh.execCommand(lines.join('\n')));
    if (result.code !== 0) {
      throw new Error(
        `Failed to ${label}: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
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
   * Wraps an SSH operation in a 10-second total-time race. If the
   * operation doesn't finish in time we treat the transport as dead:
   * tear down the socket, fire `handleUnexpectedDisconnect` (so the
   * manager kicks off auto-retry + the renderer paints the banner),
   * and surface a typed `MisterConnectionError` to the caller. Other
   * errors propagate untouched — we only own the timeout case.
   */
  private async runSshOp<T>(fn: () => Promise<T>): Promise<T> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new SshOpTimeoutError());
          }, SSH_OP_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (err instanceof SshOpTimeoutError) {
        this.handleUnexpectedDisconnect();
        this.safelyDispose();
        throw new MisterConnectionError(
          'unknown',
          'The MiSTer stopped responding (no reply within 10s). Reconnecting…',
        );
      }
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
   */
  private async runSshStreamOp<T>(
    fn: (api: { readonly touch: () => void }) => Promise<T>,
  ): Promise<T> {
    let lastActivity = Date.now();
    let cancelled = false;
    const aborter: { reject: ((err: Error) => void) | null } = { reject: null };
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const arm = (): void => {
      if (cancelled) return;
      const sinceLast = Date.now() - lastActivity;
      const remaining = SSH_OP_TIMEOUT_MS - sinceLast;
      if (remaining <= 0) {
        aborter.reject?.(new SshOpTimeoutError());
        return;
      }
      timeoutHandle = setTimeout(() => {
        if (Date.now() - lastActivity >= SSH_OP_TIMEOUT_MS) {
          aborter.reject?.(new SshOpTimeoutError());
        } else {
          arm();
        }
      }, remaining);
    };

    const touch = (): void => {
      lastActivity = Date.now();
    };

    try {
      return await new Promise<T>((resolve, reject) => {
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
    } catch (err) {
      if (err instanceof SshOpTimeoutError) {
        this.handleUnexpectedDisconnect();
        this.safelyDispose();
        throw new MisterConnectionError(
          'unknown',
          'The MiSTer stopped responding (no progress for 10s). Reconnecting…',
        );
      }
      throw err;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }
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
    recursiveFileCount?: number;
    recursiveHiddenFileCount?: number;
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
      sub = { name: subName, files: [], dirs: [] };
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
      sub.recursiveFileCount = (sub.recursiveFileCount ?? 0) + 1;
      const leaf = segs[segs.length - 1]!;
      if (leaf.startsWith('.')) {
        sub.recursiveHiddenFileCount =
          (sub.recursiveHiddenFileCount ?? 0) + 1;
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
          recursiveFileCount: s.recursiveFileCount,
          recursiveHiddenFileCount: s.recursiveHiddenFileCount,
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

function assertSafeSegment(label: string, value: string): void {
  if (value === '' || value.includes('/') || value.includes('..') || value.includes('\0')) {
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
