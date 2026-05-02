import { NodeSSH } from 'node-ssh';

import { shellQuote } from '@app/main/clients/shell';
import { MISTER_GAMES_DIR } from '@shared/constants';
import { MisterConnectionError } from '@shared/types';
import type { Core, MisterProfile, Rom } from '@shared/types';
import type {
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
} from '@shared/mister-client';

const CONNECT_TIMEOUT_MS = 8000;

export class RealMisterClient implements IMisterClient {
  private readonly ssh: NodeSSH;

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

    const dirCheck = await this.ssh.execCommand(
      `[ -d ${shellQuote(MISTER_GAMES_DIR)} ]`,
    );
    if (dirCheck.code !== 0) {
      this.safelyDispose();
      throw new MisterConnectionError(
        'not_a_mister',
        `Could not find ${MISTER_GAMES_DIR} on this host — is it a MiSTer?`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.ssh.isConnected()) {
      return;
    }
    this.safelyDispose();
    return Promise.resolve();
  }

  isConnected(): boolean {
    return this.ssh.isConnected();
  }

  async listCores(): Promise<Core[]> {
    this.assertConnected();

    // Single batched shell loop: emit one TAB-separated line per core with
    // total file count and hidden file count. Avoids one SSH call per core.
    const script = [
      'set -e',
      `cd ${shellQuote(MISTER_GAMES_DIR)}`,
      'for d in */; do',
      '  [ -d "$d" ] || continue',
      '  d="${d%/}"',
      `  visible=$(find "$d" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l)`,
      `  hidden=$(find "$d" -maxdepth 1 -type f -name '.*' 2>/dev/null | wc -l)`,
      '  total=$((visible + hidden))',
      `  printf '%s\\t%s\\t%s\\n' "$d" "$total" "$hidden"`,
      'done',
    ].join('\n');

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Failed to list cores: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }

    const cores: Core[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line.trim() === '') continue;
      const match = /^([^\t]+)\t(\d+)\t(\d+)$/.exec(line);
      if (!match) continue;
      const id = match[1] ?? '';
      const total = Number.parseInt(match[2] ?? '0', 10);
      const hidden = Number.parseInt(match[3] ?? '0', 10);
      cores.push({ id, name: id, romCount: total, hiddenCount: hidden });
    }

    cores.sort((a, b) => a.id.localeCompare(b.id));
    return cores;
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);

    const coreDir = `${MISTER_GAMES_DIR}/${coreId}`;

    // Single batched shell loop: list visible and dot-prefixed files with
    // their byte sizes, TAB-separated. One SSH call regardless of file count.
    const script = [
      'set -e',
      `cd ${shellQuote(coreDir)}`,
      'for f in * .[!.]*; do',
      '  [ -f "$f" ] || continue',
      `  size=$(stat -c '%s' "$f")`,
      `  printf '%s\\t%s\\n' "$f" "$size"`,
      'done',
    ].join('\n');

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(`Unknown core: ${coreId}`);
    }

    const roms: Rom[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const tabIndex = line.lastIndexOf('\t');
      if (tabIndex < 0) continue;
      const filename = line.slice(0, tabIndex);
      const sizeStr = line.slice(tabIndex + 1);
      const sizeBytes = Number.parseInt(sizeStr, 10);
      if (Number.isNaN(sizeBytes)) continue;

      const hidden = filename.startsWith('.');
      const displayName = hidden ? filename.slice(1) : filename;

      roms.push({
        coreId,
        filename,
        displayName,
        sizeBytes,
        hidden,
        path: `${MISTER_GAMES_DIR}/${coreId}/${filename}`,
      });
    }

    roms.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return roms;
  }

  async setRomVisibility(
    coreId: string,
    filename: string,
    hidden: boolean,
  ): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    assertSafeSegment('filename', filename);

    const visibleName = filename.startsWith('.') ? filename.slice(1) : filename;
    const targetName = hidden ? `.${visibleName}` : visibleName;
    if (targetName === filename) {
      return;
    }

    const src = `${MISTER_GAMES_DIR}/${coreId}/${filename}`;
    const dst = `${MISTER_GAMES_DIR}/${coreId}/${targetName}`;
    const command = `mv ${shellQuote(src)} ${shellQuote(dst)}`;

    const result = await this.ssh.execCommand(command);
    if (result.code !== 0) {
      throw new Error(
        `Failed to rename ${filename}: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async setBulkRomVisibility(
    coreId: string,
    changes: readonly RomVisibilityChange[],
  ): Promise<void> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);
    for (const change of changes) {
      assertSafeSegment('filename', change.filename);
    }

    const renames: string[] = [];
    for (const change of changes) {
      const visible = change.filename.startsWith('.')
        ? change.filename.slice(1)
        : change.filename;
      const target = change.hidden ? `.${visible}` : visible;
      if (target === change.filename) continue;
      renames.push(`mv ${shellQuote(change.filename)} ${shellQuote(target)}`);
    }

    if (renames.length === 0) {
      return;
    }

    const coreDir = `${MISTER_GAMES_DIR}/${coreId}`;
    const script = ['set -e', `cd ${shellQuote(coreDir)}`, ...renames].join('\n');

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Bulk rename failed: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
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
}

function assertSafeSegment(label: string, value: string): void {
  if (value === '' || value.includes('/') || value.includes('..') || value.includes('\0')) {
    throw new Error(`Invalid ${label}: ${value}`);
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
