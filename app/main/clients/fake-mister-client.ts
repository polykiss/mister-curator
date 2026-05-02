import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import {
  HIDEABLE_CATEGORIES,
  MISTER_CATEGORY_DIRS,
  MISTER_GAMES_DIR,
  MISTER_LEDGER_DIR,
  MISTER_LEDGER_PATH,
} from '@shared/constants';
import {
  computeCoreRenames,
  isCoreFile,
  isRealCore,
  matchRbfsToGamesDirs,
  type RawGamesDirInput,
  type RawRbfInput,
} from '@shared/core-matching';
import {
  healLedger,
  ledgerEqual,
  parseLedger,
  serializeLedger,
} from '@shared/ledger';
import { MisterConnectionError } from '@shared/types';
import type {
  CoreEntry,
  HideLedger,
  MisterProfile,
  Rom,
} from '@shared/types';
import type {
  BulkCoreResult,
  BulkRomResult,
  CoreVisibilityChange,
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
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

  async listAllCoresWithFiles(): Promise<CoreEntry[]> {
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
      // ROM count = files + folder-shaped ROMs (subdirectories). Disc-
      // based cores like Saturn ship as 1 file + 17 dirs and must NOT be
      // treated as empty just because they have one .cue file.
      let romCount = 0;
      let hiddenCount = 0;
      for (const f of inner) {
        if (!f.isFile() && !f.isDirectory()) continue;
        romCount += 1;
        if (f.name.startsWith('.')) hiddenCount += 1;
      }
      gamesDirs.push({ rawName: entry.name, romCount, hiddenCount });
    }

    let arcadeDirExists = false;
    try {
      await fs.access(this.toLocal('/media/fat/_Arcade'));
      arcadeDirExists = true;
    } catch {
      // _Arcade/ doesn't exist on this fixture — leave the flag false.
    }

    return matchRbfsToGamesDirs({ rbfs, gamesDirs, arcadeDirExists });
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    await this.delay();

    const localDir = this.toLocal(`${MISTER_GAMES_DIR}/${coreId}`);

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
      const displayName = hidden ? filename.slice(1) : filename;
      const fullPath = path.join(localDir, filename);

      if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        roms.push({
          coreId,
          filename,
          displayName,
          sizeBytes: stat.size,
          hidden,
          path: `${MISTER_GAMES_DIR}/${coreId}/${filename}`,
          kind: 'file',
        });
      } else if (entry.isDirectory()) {
        // Folder ROMs (Saturn, MegaCD, X68000 …) — the directory itself
        // is the unit of hide/show. Size is the recursive byte total of
        // everything inside.
        const sizeBytes = await sumDirectoryBytes(fullPath);
        roms.push({
          coreId,
          filename,
          displayName,
          sizeBytes,
          hidden,
          path: `${MISTER_GAMES_DIR}/${coreId}/${filename}`,
          kind: 'folder',
        });
      }
    }

    roms.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return roms;
  }

  async setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    this.assertSafeFilename(filename);
    await this.delay();
    await this.applyRomRename(coreId, filename, hidden);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<BulkRomResult> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    for (const change of changes) {
      this.assertSafeFilename(change.filename);
    }
    await this.delay();

    const succeeded: string[] = [];
    const failed: { filename: string; reason: string }[] = [];
    for (const change of changes) {
      try {
        await this.applyRomRename(coreId, change.filename, change.hidden);
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
    for (const plan of plans) {
      try {
        // Per-core atomic: each rename runs sequentially; if any throws,
        // we record the core as failed and move on to the next core.
        for (const r of plan.renames) await this.renamePath(r);
        succeeded.push(plan.coreId);
      } catch (err) {
        failed.push({
          coreId: plan.coreId,
          reason: err instanceof Error ? err.message : String(err),
        });
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
  ): Promise<void> {
    const coreDir = this.toLocal(`${MISTER_GAMES_DIR}/${coreId}`);
    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;

    if (filename === targetName) {
      try {
        await fs.access(path.join(coreDir, filename));
        return;
      } catch {
        throw new Error(`ROM not found: ${coreId}/${filename}`);
      }
    }
    try {
      await fs.rename(path.join(coreDir, filename), path.join(coreDir, targetName));
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(`ROM not found: ${coreId}/${filename}`);
      }
      throw err;
    }
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
