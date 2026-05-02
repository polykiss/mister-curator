import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import { MISTER_GAMES_DIR } from '@shared/constants';
import { MisterConnectionError } from '@shared/types';
import type { Core, MisterProfile, Rom } from '@shared/types';
import type {
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
} from '@shared/mister-client';

export interface FakeMisterClientOptions {
  readonly rootPath: string;
  readonly pristineRootPath?: string;
  readonly latencyMs?: number;
}

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

  async listCores(): Promise<Core[]> {
    this.assertConnected();
    await this.delay();

    const entries = await fs.readdir(this.rootPath, { withFileTypes: true });
    const cores: Core[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) {
        continue;
      }
      const coreDir = path.join(this.rootPath, entry.name);
      const files = await fs.readdir(coreDir, { withFileTypes: true });

      let romCount = 0;
      let hiddenCount = 0;
      for (const file of files) {
        if (!file.isFile()) {
          continue;
        }
        romCount += 1;
        if (file.name.startsWith('.')) {
          hiddenCount += 1;
        }
      }

      cores.push({
        id: entry.name,
        name: entry.name,
        romCount,
        hiddenCount,
      });
    }

    cores.sort((a, b) => a.id.localeCompare(b.id));
    return cores;
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    await this.delay();

    const coreDir = path.join(this.rootPath, coreId);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(coreDir, { withFileTypes: true });
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        throw new Error(`Unknown core: ${coreId}`);
      }
      throw err;
    }

    const roms: Rom[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filename = entry.name;
      const stat = await fs.stat(path.join(coreDir, filename));
      const hidden = filename.startsWith('.');
      const displayName = hidden ? filename.slice(1) : filename;

      roms.push({
        coreId,
        filename,
        displayName,
        sizeBytes: stat.size,
        hidden,
        path: `${MISTER_GAMES_DIR}/${coreId}/${filename}`,
      });
    }

    roms.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return roms;
  }

  async setRomVisibility(coreId: string, filename: string, hidden: boolean): Promise<void> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    this.assertSafeFilename(filename);
    await this.delay();
    await this.applyRename(coreId, filename, hidden);
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<void> {
    this.assertConnected();
    this.assertSafeCoreId(coreId);
    for (const change of changes) {
      this.assertSafeFilename(change.filename);
    }

    // One round-trip latency hit, regardless of batch size, mirroring how the
    // real client will run all renames in a single SSH command.
    await this.delay();

    await Promise.all(
      changes.map((change) => this.applyRename(coreId, change.filename, change.hidden)),
    );
  }

  /**
   * Test-only helper: clears the working root and re-copies the pristine
   * fixture tree. Refuses to run when rootPath and pristineRootPath point at
   * the same directory — that would destroy the source of truth.
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

  private async ensureRootPopulated(): Promise<void> {
    let exists = true;
    try {
      const entries = await fs.readdir(this.rootPath);
      if (entries.length === 0) {
        exists = false;
      }
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        exists = false;
      } else {
        throw err;
      }
    }

    if (exists) {
      return;
    }

    if (!this.pristineRootPath) {
      throw new MisterConnectionError(
        'not_a_mister',
        `Could not find ${MISTER_GAMES_DIR} on this host — is it a MiSTer?`,
      );
    }

    await fs.mkdir(this.rootPath, { recursive: true });
    await fs.cp(this.pristineRootPath, this.rootPath, { recursive: true });
  }

  private async applyRename(coreId: string, filename: string, hidden: boolean): Promise<void> {
    const coreDir = path.join(this.rootPath, coreId);
    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;

    if (filename === targetName) {
      // Already in desired state; verify it actually exists so silent no-ops
      // don't mask a bad filename.
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
    if (this.latencyMs <= 0) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, this.latencyMs));
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}
