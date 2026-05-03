import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

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
  isCoreFile,
  isRealCore,
  matchRbfsToGamesDirs,
  type RawGamesDirInput,
  type RawRbfInput,
} from '@shared/core-matching';
import { displayRomName } from '@shared/display';
import {
  classifyFolder,
  resolveClassification,
} from '@shared/folder-rom';
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
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
  SystemFileMarkChange,
} from '@shared/mister-client';

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
      gamesDirs.push({ rawName: entry.name, files, dirs });
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
        roms.push({
          coreId,
          filename,
          displayName,
          sizeBytes,
          hidden,
          path: onDevicePath,
          kind:
            classification === 'container' ? 'folder-container' : 'folder-atomic',
          relativePath,
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
