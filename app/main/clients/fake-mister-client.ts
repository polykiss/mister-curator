import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';

import {
  HIDEABLE_CATEGORIES,
  MISTER_CATEGORY_DIRS,
  MISTER_FOLDER_CLASSIFICATIONS_PATH,
  MISTER_ARCADE_DIR,
  MISTER_GAMES_DIR,
  MISTER_LEDGER_DIR,
  MISTER_LEDGER_PATH,
  MISTER_SYSTEM_FILES_PATH,
} from '@shared/constants';
import {
  computeCoreRenames,
  isCoreFile,
  isRealCore,
  matchRbfsToGamesDirs,
  type RawGamesDirInput,
  type RawRbfInput,
  type RawSubFolderInput,
} from '@shared/core-matching';
import { displayRomName } from '@shared/display';
import { isOsMetadataDir, isOsMetadataFile } from '@shared/library-filter';
import {
  classifyFolder,
  isLaunchableRomExtension,
  resolveClassification,
} from '@shared/folder-rom';
import { shouldCountAsRom } from '@shared/system-files';
import {
  EMPTY_FOLDER_CLASSIFICATIONS,
  getFolderOverride,
  parseFolderClassifications,
  serializeFolderClassifications,
  withFolderOverride,
  withoutFolderOverride,
} from '@shared/folder-classifications';
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
import { MisterConnectionError } from '@shared/types';
import type {
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
import type { WitnessMtimes } from '@shared/prime-parse';

export interface FakeMisterClientOptions {
  /** Working root that simulates `/media/fat/` on the device. */
  readonly rootPath: string;
  readonly pristineRootPath?: string;
  readonly latencyMs?: number;
}

const FAKE_FAT_DIR = '/media/fat';

export class FakeMisterClient implements IMisterClient {
  private readonly rootPath: string;
  private readonly pristineRootPath: string | undefined;
  private readonly latencyMs: number;
  private connected = false;
  private readonly unexpectedDisconnectListeners = new Set<() => void>();

  constructor(options: FakeMisterClientOptions) {
    this.rootPath = options.rootPath;
    this.pristineRootPath = options.pristineRootPath;
    this.latencyMs = options.latencyMs ?? 75;
  }

  async connect(profile: MisterProfile, secret: MisterSecret): Promise<void> {
    await this.delay();

    if (profile.authMethod !== secret.type) {
      throw new MisterConnectionError(
        'auth_failed',
        `Auth method '${profile.authMethod}' does not match supplied secret of type '${secret.type}'.`,
      );
    }

    await this.ensureRootPopulated();

    this.connected = true;
  }

  async disconnect(): Promise<void> {
    await this.delay();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onUnexpectedDisconnect(listener: () => void): () => void {
    this.unexpectedDisconnectListeners.add(listener);
    return () => {
      this.unexpectedDisconnectListeners.delete(listener);
    };
  }

  /**
   * Test-only: simulate the underlying SSH transport dropping mid-
   * session. Exposed because there's no real socket to break in unit
   * tests; production code never calls this.
   */
  simulateUnexpectedDisconnect(): void {
    this.connected = false;
    for (const listener of this.unexpectedDisconnectListeners) {
      try {
        listener();
      } catch {
        /* swallow */
      }
    }
  }

  async listAllCoresWithFiles(
    systemFilesMarks?: SystemFilesMarks,
  ): Promise<CoreEntry[]> {
    this.assertConnected();
    await this.delay();

    const rbfs: RawRbfInput[] = [];
    for (const { category, dir: logicalDir } of MISTER_CATEGORY_DIRS) {
      const localDir = this.toLocal(logicalDir);
      let entries: Dirent[];
      try {
        entries = await fs.readdir(localDir, { withFileTypes: true });
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') continue;
        throw err;
      }
      for (const entry of entries) {
        const filename = entry.name;
        if (entry.isDirectory()) {
          // A directory under a category dir is only a core if it contains
          // at least one .rbf or .mgl file directly inside. Otherwise it's
          // a user-created organizational folder (e.g. `_alternatives`).
          const inner = await fs.readdir(path.join(localDir, filename), {
            withFileTypes: true,
          });
          const looksLikeCore = inner.some(
            (innerEntry) => innerEntry.isFile() && isCoreFile(innerEntry.name),
          );
          if (!looksLikeCore) continue;
          rbfs.push({
            category,
            filename,
            fullPath: `${logicalDir}/${filename}`,
            isFolder: true,
          });
        } else if (entry.isFile() && isCoreFile(filename)) {
          rbfs.push({
            category,
            filename,
            fullPath: `${logicalDir}/${filename}`,
            isFolder: false,
          });
        }
      }
    }

    const gamesDirs: RawGamesDirInput[] = [];
    const localGamesRoot = this.toLocal(MISTER_GAMES_DIR);
    let gamesEntries: Dirent[];
    try {
      gamesEntries = await fs.readdir(localGamesRoot, { withFileTypes: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        gamesEntries = [];
      } else {
        throw err;
      }
    }

    for (const entry of gamesEntries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(localGamesRoot, entry.name);
      const inner = await fs.readdir(dirPath, { withFileTypes: true });
      // The matcher applies the system-file filter to derive
      // `romCount` and `hiddenCount` from this raw split, so the fake
      // and real clients stay in sync on what counts as "empty".
      const files: string[] = [];
      const dirs: string[] = [];
      for (const f of inner) {
        if (f.isFile()) files.push(f.name);
        else if (f.isDirectory()) dirs.push(f.name);
      }
      // One level deeper: per-subfolder content + recursive file count.
      // The matcher uses these to derive `recursiveRomCount` (Issue 5):
      // container folders contribute their recursive count; atomic
      // disc folders count as 1.
      const subFolders: RawSubFolderInput[] = [];
      for (const subName of dirs) {
        const subPath = path.join(dirPath, subName);
        try {
          subFolders.push(await readSubFolderForMatcher(subPath, subName));
        } catch {
          // Unreadable / vanished — skip; the matcher falls back to
          // atomic (1) when there's no subfolder data for a top-level
          // dir.
        }
      }
      gamesDirs.push({ rawName: entry.name, files, dirs, subFolders });
    }

    let arcadeDirExists = false;
    try {
      await fs.access(this.toLocal('/media/fat/_Arcade'));
      arcadeDirExists = true;
    } catch {
      // _Arcade/ doesn't exist on this fixture — leave the flag false.
    }

    return matchRbfsToGamesDirs({
      rbfs,
      gamesDirs,
      arcadeDirExists,
      systemFilesMarks,
    });
  }

  async listRecursiveRomFiles(args: {
    readonly coreId: string;
    readonly gamesDirBasename: string;
    readonly marks?: SystemFilesMarks;
  }): Promise<readonly string[]> {
    this.assertConnected();
    this.assertSafeCoreId(args.coreId);
    this.assertSafeCoreId(args.gamesDirBasename);
    await this.delay();

    // PR-C round 2: walk the games dir recursively, filter by the
    // same predicate the sidebar count uses. See
    // RealMisterClient.listRecursiveRomFiles for the full rationale —
    // this fake mirrors the SSH-based walk with a local-fs walk so
    // tests against the fake client see the same paths the real
    // client would on the same data.
    const localRoot = this.toLocal(
      `${MISTER_GAMES_DIR}/${args.gamesDirBasename}`,
    );
    const onDeviceRoot = `${MISTER_GAMES_DIR}/${args.gamesDirBasename}`;
    const out: string[] = [];

    async function walk(localDir: string, relPrefix: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(localDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
        if (entry.isFile()) {
          if (
            !shouldCountAsRom({
              relPath: rel,
              isDirectory: false,
              coreId: args.coreId,
              marks: args.marks,
            })
          ) {
            continue;
          }
          if (!isLaunchableRomExtension(rel)) continue;
          out.push(`${onDeviceRoot}/${rel}`);
        } else if (entry.isDirectory()) {
          await walk(path.join(localDir, entry.name), rel);
        }
      }
    }

    await walk(localRoot, '');
    return out;
  }

  async listArcadeRawListing(): Promise<
    readonly { readonly type: 'f' | 'd'; readonly relPath: string }[]
  > {
    this.assertConnected();
    await this.delay();
    const localRoot = this.toLocal(MISTER_ARCADE_DIR);
    const out: { type: 'f' | 'd'; relPath: string }[] = [];
    // Mirror RealMisterClient's `find -mindepth 1 -maxdepth 3`. The
    // depth cap matches what a real `_Arcade/` actually contains
    // (one or two levels of organisational folders + a `cores/`
    // stash); deeper trees would surface via a Phase 2 enhancement.
    async function walk(
      dir: string,
      relPrefix: string,
      depth: number,
    ): Promise<void> {
      if (depth > 3) return;
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
        if (entry.isFile()) {
          out.push({ type: 'f', relPath: rel });
        } else if (entry.isDirectory()) {
          out.push({ type: 'd', relPath: rel });
          await walk(path.join(dir, entry.name), rel, depth + 1);
        }
      }
    }
    await walk(localRoot, '', 1);
    return out;
  }

  async listRoms(
    coreId: string,
    subPath = '',
    folderClassifications: FolderClassifications = EMPTY_FOLDER_CLASSIFICATIONS,
  ): Promise<Rom[]> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    this.assertSafeSubPath(subPath);
    await this.delay();

    const relPrefix = subPath === '' ? '' : `${subPath}/`;
    const localDir = this.toLocal(
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`,
    );

    let entries: Dirent[];
    try {
      entries = await fs.readdir(localDir, { withFileTypes: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(`Unknown core: ${coreId}`);
      }
      throw err;
    }

    const roms: Rom[] = [];
    for (const entry of entries) {
      const filename = entry.name;
      // Issue #17 — drop OS metadata sidecars (`._*`, `.DS_Store`,
      // `Thumbs.db`, `desktop.ini`, `.directory`) and metadata
      // directories (`.AppleDouble`, `$RECYCLE.BIN`, etc.) before
      // they surface as ROM candidates.
      if (entry.isFile() && isOsMetadataFile(filename)) continue;
      if (entry.isDirectory() && isOsMetadataDir(filename)) continue;

      const hidden = filename.startsWith('.');
      const visibleBase = hidden ? filename.slice(1) : filename;
      const displayName = displayRomName(visibleBase);
      const fullPath = path.join(localDir, filename);
      const relativePath = `${relPrefix}${filename}`;
      const onDevicePath = `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`;

      if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        roms.push({
          coreId,
          filename,
          displayName,
          sizeBytes: stat.size,
          hidden,
          path: onDevicePath,
          kind: 'file',
          relativePath,
        });
      } else if (entry.isDirectory()) {
        // Folder ROMs — classify so the renderer knows whether to drill.
        // The classification key uses the *visible* path so an override
        // set while the folder was visible still applies after a hide.
        const visibleRelPath = `${relPrefix}${visibleBase}`;
        const sizeBytes = await sumDirectoryBytes(fullPath);
        const classification = await this.classifyLocalFolder(
          fullPath,
          coreId,
          visibleRelPath,
          folderClassifications,
        );
        const kind =
          classification === 'container' ? 'folder-container' : 'folder-atomic';
        // PR-D1 (PR #27): mirror real-mister-client — for atomic
        // folders, identify the alphabetical-first launchable file
        // for renderer-side metadata binding. Walks immediate
        // children only (matches the real client's behavior).
        let containedRomPath: string | undefined;
        if (kind === 'folder-atomic') {
          try {
            const innerEntries = await fs.readdir(fullPath, {
              withFileTypes: true,
            });
            const launchable = innerEntries
              .filter((e) => e.isFile() && isLaunchableRomExtension(e.name))
              .map((e) => e.name)
              .sort((a, b) => a.localeCompare(b));
            if (launchable.length > 0) {
              containedRomPath = `${onDevicePath}/${launchable[0]!}`;
            }
          } catch {
            // Unreadable folder — skip; renderer falls back to
            // ImageOff + folder badge.
          }
        }
        roms.push({
          coreId,
          filename,
          displayName,
          sizeBytes,
          hidden,
          path: onDevicePath,
          kind,
          relativePath,
          containedRomPath,
        });
      }
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
    this.assertSafeCoreId(coreId);
    this.assertSafeFilename(filename);
    this.assertSafeSubPath(subPath);
    await this.delay();
    await this.applyRomRename(coreId, filename, hidden, subPath);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
    subPath = '',
  ): Promise<BulkRomResult> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    this.assertSafeSubPath(subPath);
    for (const change of changes) {
      this.assertSafeFilename(change.filename);
    }
    await this.delay();

    const succeeded: string[] = [];
    const failed: { filename: string; reason: string }[] = [];
    for (const change of changes) {
      try {
        await this.applyRomRename(coreId, change.filename, change.hidden, subPath);
        succeeded.push(change.filename);
      } catch (err) {
        failed.push({
          filename: change.filename,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
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
    await this.delay();
    for (const r of renames) await this.renamePath(r);
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
    await this.delay();
    for (const r of renames) await this.renamePath(r);
  }

  async setBulkCoreVisibility(
    changes: readonly CoreVisibilityChange[],
    options: BulkCoreOptions = {},
  ): Promise<BulkCoreResult> {
    this.assertConnected();

    interface Plan {
      readonly coreId: string;
      readonly renames: readonly { from: string; to: string }[];
    }
    const plans: Plan[] = [];
    for (const c of changes) {
      if (!isRealCore(c.core)) {
        throw new Error(
          `Refusing to toggle '${c.core.id}': not a real core (likely a user folder or the Arcade placeholder).`,
        );
      }
      if (!HIDEABLE_CATEGORIES.has(c.core.category)) {
        throw new Error(`Refusing to toggle a core in category '${c.core.category}'.`);
      }
      const renames = computeCoreRenames(c.core, c.hidden);
      if (renames.length === 0) continue;
      plans.push({ coreId: c.core.id, renames });
    }
    if (plans.length === 0) return { succeeded: [], failed: [] };

    await this.delay();
    const succeeded: string[] = [];
    const failed: { coreId: string; reason: string }[] = [];
    const total = plans.length;
    for (let i = 0; i < plans.length; i += 1) {
      const plan = plans[i]!;
      const done = i + 1;
      try {
        // Per-core atomic: each rename runs sequentially; if any throws,
        // we record the core as failed and move on to the next core.
        for (const r of plan.renames) await this.renamePath(r);
        succeeded.push(plan.coreId);
        try {
          options.onProgress?.({
            done,
            total,
            coreId: plan.coreId,
            result: 'ok',
          });
        } catch {
          /* swallow */
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failed.push({ coreId: plan.coreId, reason });
        try {
          options.onProgress?.({
            done,
            total,
            coreId: plan.coreId,
            result: 'fail',
            reason,
          });
        } catch {
          /* swallow */
        }
      }
    }
    return { succeeded, failed };
  }

  async readHideLedger(): Promise<HideLedger> {
    this.assertConnected();
    await this.delay();
    const localPath = this.toLocal(MISTER_LEDGER_PATH);
    let raw: HideLedger;
    try {
      const text = await fs.readFile(localPath, 'utf-8');
      raw = parseLedger(text);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        raw = parseLedger('');
      } else {
        throw err;
      }
    }

    if (raw.hiddenCores.length === 0) return raw;

    // Self-heal: drop entries that no longer correspond to a real core.
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
    await this.delay();
    const localDir = this.toLocal(MISTER_LEDGER_DIR);
    const localPath = this.toLocal(MISTER_LEDGER_PATH);
    await fs.mkdir(localDir, { recursive: true });
    const json = serializeLedger(ledger);
    const tmp = `${localPath}.tmp`;
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, localPath);
  }

  async readSystemFilesMarks(): Promise<SystemFilesMarks> {
    this.assertConnected();
    await this.delay();
    const localPath = this.toLocal(MISTER_SYSTEM_FILES_PATH);
    try {
      const text = await fs.readFile(localPath, 'utf-8');
      return parseSystemFilesMarks(text);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return parseSystemFilesMarks('');
      }
      throw err;
    }
  }

  async addSystemFileMark(coreId: string, filename: string): Promise<void> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    this.assertSafeFilename(filename);
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
    this.assertSafeCoreId(coreId);
    this.assertSafeFilename(filename);
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
    this.assertSafeCoreId(coreId);
    for (const c of changes) this.assertSafeFilename(c.filename);
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

  async readFolderClassifications(): Promise<FolderClassifications> {
    this.assertConnected();
    await this.delay();
    const localPath = this.toLocal(MISTER_FOLDER_CLASSIFICATIONS_PATH);
    try {
      const text = await fs.readFile(localPath, 'utf-8');
      return parseFolderClassifications(text);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        return parseFolderClassifications('');
      }
      throw err;
    }
  }

  async setFolderClassification(
    override:
      | FolderClassificationOverride
      | { coreId: string; folderPath: string; classification: undefined },
  ): Promise<void> {
    this.assertConnected();
    this.assertSafeCoreId(override.coreId);
    this.assertSafeSubPath(override.folderPath);
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
    await this.writeFolderClassifications(next);
  }

  private async writeFolderClassifications(
    marks: FolderClassifications,
  ): Promise<void> {
    await this.delay();
    const localDir = this.toLocal(MISTER_LEDGER_DIR);
    const localPath = this.toLocal(MISTER_FOLDER_CLASSIFICATIONS_PATH);
    await fs.mkdir(localDir, { recursive: true });
    const json = serializeFolderClassifications(marks);
    const tmp = `${localPath}.tmp`;
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, localPath);
  }

  /**
   * PR #12 prime — composes the existing read methods plus a stat
   * batch. The fake client doesn't have an SSH layer to optimise so
   * the implementation just calls each method independently; tests
   * that assert "the connect path makes one round trip" use the
   * RealMisterClient mock where that constraint actually matters.
   */
  async primeConnect(
    coresWitnessPaths: readonly string[],
  ): Promise<PrimeConnectResult> {
    this.assertConnected();
    const [ledger, marks, classifications, witnesses] = await Promise.all([
      this.readHideLedgerRaw(),
      this.readSystemFilesMarks(),
      this.readFolderClassifications(),
      this.statWitnesses(coresWitnessPaths),
    ]);
    return { ledger, marks, classifications, witnesses };
  }

  async statWitnesses(paths: readonly string[]): Promise<WitnessMtimes> {
    this.assertConnected();
    if (paths.length === 0) return {};
    const out: Record<string, number> = {};
    for (const p of paths) {
      const local = this.toLocal(p);
      try {
        const st = await fs.stat(local);
        // Match the device-side `stat -c '%Y'` semantics: epoch
        // seconds, integer. fs.Stats.mtimeMs is milliseconds.
        out[p] = Math.floor(st.mtimeMs / 1000);
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          out[p] = 0;
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  async statPathsWithSize(
    paths: readonly string[],
  ): Promise<Record<string, { readonly mtime: number; readonly size: number }>> {
    this.assertConnected();
    if (paths.length === 0) return {};
    const out: Record<string, { mtime: number; size: number }> = {};
    for (const p of paths) {
      const local = this.toLocal(p);
      try {
        const st = await fs.stat(local);
        out[p] = {
          mtime: Math.floor(st.mtimeMs / 1000),
          size: st.size,
        };
      } catch (err) {
        if (isNodeError(err) && err.code === 'ENOENT') {
          out[p] = { mtime: 0, size: 0 };
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  async hashPaths(paths: readonly string[]): Promise<readonly HashRecord[]> {
    this.assertConnected();
    if (paths.length === 0) return [];
    await this.delay();
    const out: HashRecord[] = [];
    for (const p of paths) {
      const local = this.toLocal(p);
      let st;
      try {
        st = await fs.stat(local);
      } catch (err) {
        // Mirror the real client's busybox loop: missing or non-file
        // paths silently drop instead of throwing — the caller filters
        // the result map for the paths it cares about.
        if (isNodeError(err) && err.code === 'ENOENT') continue;
        throw err;
      }
      if (!st.isFile()) continue;
      // PR #16 round 2: compute md5 + sha1 + inner size in one pass.
      // .zip wrappers get the inner-content hashed (mirroring the
      // device-side `unzip -p | md5sum` / `sha1sum` / `wc -c`
      // pipeline); other paths hash the raw bytes. mtime stays on
      // the wrapper either way — cache invalidation tracks what the
      // user touches, not the inner file.
      const lower = p.toLowerCase();
      const hashes = lower.endsWith('.zip')
        ? await hashZipContents(local)
        : hashBuffer(await fs.readFile(local));
      if (hashes === null) continue;
      out.push({
        path: p,
        md5: hashes.md5,
        sha1: hashes.sha1,
        size: hashes.size,
        mtime: Math.floor(st.mtimeMs / 1000),
      });
    }
    return out;
  }

  /**
   * The PR #12 prime path needs a self-heal-free ledger read so the
   * manager can run heal once with cached cores. `readHideLedger`
   * still self-heals for legacy callers; this raw variant is private
   * to the prime call.
   */
  private async readHideLedgerRaw(): Promise<HideLedger> {
    await this.delay();
    const localPath = this.toLocal(MISTER_LEDGER_PATH);
    try {
      const text = await fs.readFile(localPath, 'utf-8');
      return parseLedger(text);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return parseLedger('');
      throw err;
    }
  }

  private async writeSystemFilesMarks(marks: SystemFilesMarks): Promise<void> {
    await this.delay();
    const localDir = this.toLocal(MISTER_LEDGER_DIR);
    const localPath = this.toLocal(MISTER_SYSTEM_FILES_PATH);
    await fs.mkdir(localDir, { recursive: true });
    const json = serializeSystemFilesMarks(marks);
    const tmp = `${localPath}.tmp`;
    await fs.writeFile(tmp, json, 'utf-8');
    await fs.rename(tmp, localPath);
  }

  /**
   * Test-only helper: clears the working root and re-copies the pristine
   * fixture tree. Refuses to run when rootPath and pristineRootPath point at
   * the same directory.
   */
  async reset(): Promise<void> {
    if (!this.pristineRootPath) {
      throw new Error('FakeMisterClient.reset() requires `pristineRootPath` to be configured.');
    }
    if (path.resolve(this.rootPath) === path.resolve(this.pristineRootPath)) {
      throw new Error(
        'FakeMisterClient.reset() refuses to run when rootPath equals pristineRootPath.',
      );
    }
    await fs.rm(this.rootPath, { recursive: true, force: true });
    await fs.mkdir(this.rootPath, { recursive: true });
    await fs.cp(this.pristineRootPath, this.rootPath, { recursive: true });
  }

  /** Convert a logical MiSTer path (`/media/fat/...`) to a local fs path
   * under this fake's `rootPath`. */
  private toLocal(misterPath: string): string {
    if (misterPath === FAKE_FAT_DIR) return this.rootPath;
    if (!misterPath.startsWith(`${FAKE_FAT_DIR}/`)) {
      throw new Error(`Cannot map non-/media/fat path to local: ${misterPath}`);
    }
    const relative = misterPath.slice(`${FAKE_FAT_DIR}/`.length);
    return path.join(this.rootPath, relative);
  }

  private async renamePath({ from, to }: { from: string; to: string }): Promise<void> {
    const fromLocal = this.toLocal(from);
    const toLocal = this.toLocal(to);
    try {
      await fs.rename(fromLocal, toLocal);
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(`Path not found: ${from}`);
      }
      throw err;
    }
  }

  private async ensureRootPopulated(): Promise<void> {
    let exists = true;
    try {
      const entries = await fs.readdir(this.rootPath);
      if (entries.length === 0) exists = false;
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') exists = false;
      else throw err;
    }

    if (exists) return;
    if (!this.pristineRootPath) {
      throw new MisterConnectionError(
        'not_a_mister',
        `Could not find ${MISTER_GAMES_DIR} on this host — is it a MiSTer?`,
      );
    }
    await fs.mkdir(this.rootPath, { recursive: true });
    await fs.cp(this.pristineRootPath, this.rootPath, { recursive: true });
  }

  private async applyRomRename(
    coreId: string,
    filename: string,
    hidden: boolean,
    subPath: string,
  ): Promise<void> {
    const coreDir = this.toLocal(
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`,
    );
    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;
    const relLabel = subPath === '' ? coreId : `${coreId}/${subPath}`;

    if (filename === targetName) {
      try {
        await fs.access(path.join(coreDir, filename));
        return;
      } catch {
        throw new Error(`ROM not found: ${relLabel}/${filename}`);
      }
    }
    try {
      await fs.rename(path.join(coreDir, filename), path.join(coreDir, targetName));
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(`ROM not found: ${relLabel}/${filename}`);
      }
      throw err;
    }
  }

  /**
   * Reads one level deep into `localDir`, applies the heuristic, then
   * layers any user override for `(coreId, visibleRelPath)` on top.
   * Resolves to a definite call (`'container'` or `'atomic'`) — the
   * `'unknown'` case falls back to `'atomic'` per `resolveClassification`.
   */
  private async classifyLocalFolder(
    localDir: string,
    coreId: string,
    visibleRelPath: string,
    overrides: FolderClassifications,
  ): Promise<'container' | 'atomic'> {
    let inner: Dirent[];
    try {
      inner = await fs.readdir(localDir, { withFileTypes: true });
    } catch {
      // Unreadable folder is treated as atomic — never offer a drill on it.
      return resolveClassification(
        'unknown',
        getFolderOverride(overrides, coreId, visibleRelPath),
      );
    }
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of inner) {
      if (e.isFile()) files.push(e.name);
      else if (e.isDirectory()) dirs.push(e.name);
    }
    return resolveClassification(
      classifyFolder({ files, dirs }),
      getFolderOverride(overrides, coreId, visibleRelPath),
    );
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new Error('FakeMisterClient is not connected. Call connect() first.');
    }
  }

  private assertSafeCoreId(coreId: string): void {
    if (coreId.includes('/') || coreId.includes('..') || coreId === '') {
      throw new Error(`Invalid core id: ${coreId}`);
    }
  }

  private assertSafeFilename(filename: string): void {
    if (filename.includes('/') || filename.includes('..') || filename === '') {
      throw new Error(`Invalid filename: ${filename}`);
    }
  }

  private assertSafeSubPath(subPath: string): void {
    if (subPath === '') return;
    if (subPath.startsWith('/') || subPath.endsWith('/')) {
      throw new Error(`Invalid subPath: ${subPath}`);
    }
    for (const segment of subPath.split('/')) {
      if (segment === '' || segment === '..' || segment === '.') {
        throw new Error(`Invalid subPath: ${subPath}`);
      }
    }
  }

  private async delay(): Promise<void> {
    if (this.latencyMs <= 0) return;
    await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

interface HashTriple {
  readonly md5: string;
  readonly sha1: string;
  readonly size: number;
}

function hashBuffer(buf: Buffer | Uint8Array): HashTriple {
  return {
    md5: createHash('md5').update(buf).digest('hex'),
    sha1: createHash('sha1').update(buf).digest('hex'),
    size: buf.byteLength,
  };
}

/**
 * Mirror the device-side three-pass pipeline (`unzip -p | md5sum`,
 * `unzip -p | sha1sum`, `unzip -p | wc -c`) — but read the archive
 * once and feed every entry concatenated through both hashers. Same
 * byte stream as `unzip -p` produces, so the resulting hashes match
 * what the real client computes against the same archive.
 *
 * Returns null on a corrupt or unreadable archive — the caller drops
 * the row, same as the device side does for `unzip -p` failures.
 */
async function hashZipContents(localPath: string): Promise<HashTriple | null> {
  let zip: JSZip;
  try {
    const buf = await fs.readFile(localPath);
    zip = await JSZip.loadAsync(buf);
  } catch {
    return null;
  }
  const md5 = createHash('md5');
  const sha1 = createHash('sha1');
  let size = 0;
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const bytes = await entry.async('uint8array');
    md5.update(bytes);
    sha1.update(bytes);
    size += bytes.byteLength;
  }
  return {
    md5: md5.digest('hex'),
    sha1: sha1.digest('hex'),
    size,
  };
}

/**
 * Sums byte sizes of every regular file under `dir`, recursively. Mirrors
 * the real client's `du -sb` behaviour so the fake reports identical
 * sizes for folder ROMs against the same fixture content.
 */
async function sumDirectoryBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile()) {
      const stat = await fs.stat(full);
      total += stat.size;
    } else if (entry.isDirectory()) {
      total += await sumDirectoryBytes(full);
    }
  }
  return total;
}

/**
 * Walks a top-level games-dir subfolder and produces the input the
 * matcher needs to compute `recursiveRomCount`: immediate children
 * (for `classifyFolder`) plus a recursive file count. Files anywhere
 * beneath the folder count toward `recursiveFileCount`; dot-prefixed
 * leaf files count toward `recursiveHiddenFileCount`.
 *
 * Mirrors the real client's `find -type f` shell pass, so an identical
 * fixture tree yields identical counts across both clients.
 */
async function readSubFolderForMatcher(
  dir: string,
  name: string,
): Promise<RawSubFolderInput> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  const dirs: string[] = [];
  for (const e of entries) {
    if (e.isFile()) files.push(e.name);
    else if (e.isDirectory()) dirs.push(e.name);
  }
  const { recursiveFileCount, recursiveHiddenFileCount } =
    await countRecursiveFiles(dir);
  return {
    name,
    files,
    dirs,
    recursiveFileCount,
    recursiveHiddenFileCount,
  };
}

async function countRecursiveFiles(
  dir: string,
): Promise<{ recursiveFileCount: number; recursiveHiddenFileCount: number }> {
  let total = 0;
  let hidden = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      total += 1;
      if (entry.name.startsWith('.')) hidden += 1;
    } else if (entry.isDirectory()) {
      const nested = await countRecursiveFiles(path.join(dir, entry.name));
      total += nested.recursiveFileCount;
      hidden += nested.recursiveHiddenFileCount;
    }
  }
  return { recursiveFileCount: total, recursiveHiddenFileCount: hidden };
}
