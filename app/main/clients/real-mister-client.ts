import { NodeSSH } from 'node-ssh';

import { shellQuote } from '@app/main/clients/shell';
import {
  HIDEABLE_CATEGORIES,
  MISTER_CATEGORY_DIRS,
  MISTER_GAMES_DIR,
  MISTER_LEDGER_DIR,
  MISTER_LEDGER_PATH,
} from '@shared/constants';
import {
  computeCoreRenames,
  matchRbfsToGamesDirs,
  type CoreRename,
  type RawGamesDirInput,
  type RawRbfInput,
} from '@shared/core-matching';
import {
  LEDGER_HEREDOC_DELIMITER,
  parseLedger,
  serializeLedger,
} from '@shared/ledger';
import { MisterConnectionError } from '@shared/types';
import type {
  CoreCategory,
  CoreEntry,
  HideLedger,
  MisterProfile,
  Rom,
} from '@shared/types';
import type {
  CoreVisibilityChange,
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

  async listAllCoresWithFiles(): Promise<CoreEntry[]> {
    this.assertConnected();

    // One batched shell script that emits two kinds of TAB-separated lines:
    //   R\t<category>\t<file|dir>\t<filename>      one per rbf or folder-core
    //   G\t<rawname>\t<total>\t<hidden>            one per games dir
    // The JS side joins them via matchRbfsToGamesDirs.
    const script = buildListAllCoresScript();
    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Failed to list cores: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }

    const rbfs: RawRbfInput[] = [];
    const gamesDirs: RawGamesDirInput[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '') continue;
      const parts = line.split('\t');
      const tag = parts[0];
      if (tag === 'R' && parts.length >= 4) {
        const categoryName = parts[1] ?? '';
        const kind = parts[2] ?? '';
        const filename = parts.slice(3).join('\t');
        const category = parseCategory(categoryName);
        if (!category) continue;
        const dirForCategory = MISTER_CATEGORY_DIRS.find((c) => c.category === category)?.dir;
        if (dirForCategory === undefined) continue;
        rbfs.push({
          category,
          filename,
          fullPath: `${dirForCategory}/${filename}`,
          isFolder: kind === 'dir',
        });
      } else if (tag === 'G' && parts.length >= 4) {
        const rawName = parts[1] ?? '';
        const total = Number.parseInt(parts[2] ?? '0', 10);
        const hidden = Number.parseInt(parts[3] ?? '0', 10);
        gamesDirs.push({ rawName, romCount: total, hiddenCount: hidden });
      }
    }

    return matchRbfsToGamesDirs({ rbfs, gamesDirs });
  }

  async listRoms(coreId: string): Promise<Rom[]> {
    this.assertConnected();
    assertSafeSegment('coreId', coreId);

    const coreDir = `${MISTER_GAMES_DIR}/${coreId}`;

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

  async hideCore(core: CoreEntry): Promise<void> {
    this.assertConnected();
    if (!HIDEABLE_CATEGORIES.has(core.category)) {
      throw new Error(`Refusing to hide a core in category '${core.category}'.`);
    }
    const renames = computeCoreRenames(core, true);
    if (renames.length === 0) return;
    await this.runRenameScript(renames, `hide core ${core.id}`);
  }

  async showCore(core: CoreEntry): Promise<void> {
    this.assertConnected();
    if (!HIDEABLE_CATEGORIES.has(core.category)) {
      throw new Error(`Refusing to show a core in category '${core.category}'.`);
    }
    const renames = computeCoreRenames(core, false);
    if (renames.length === 0) return;
    await this.runRenameScript(renames, `show core ${core.id}`);
  }

  async setBulkCoreVisibility(changes: readonly CoreVisibilityChange[]): Promise<void> {
    this.assertConnected();
    const allRenames: CoreRename[] = [];
    for (const change of changes) {
      if (!HIDEABLE_CATEGORIES.has(change.core.category)) {
        throw new Error(
          `Refusing to toggle a core in category '${change.core.category}'.`,
        );
      }
      allRenames.push(...computeCoreRenames(change.core, change.hidden));
    }
    if (allRenames.length === 0) return;
    await this.runRenameScript(allRenames, 'bulk core visibility');
  }

  async readHideLedger(): Promise<HideLedger> {
    this.assertConnected();
    // `cat` returns non-zero when the file is missing; we want that to be a
    // soft "empty ledger" outcome, so we tolerate it inline and rely on the
    // parser to handle the empty string.
    const result = await this.ssh.execCommand(
      `cat ${shellQuote(MISTER_LEDGER_PATH)} 2>/dev/null || true`,
    );
    return parseLedger(result.stdout);
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

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Failed to write hide ledger: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  private async runRenameScript(renames: readonly CoreRename[], label: string): Promise<void> {
    const lines = ['set -e'];
    for (const r of renames) {
      lines.push(`mv ${shellQuote(r.from)} ${shellQuote(r.to)}`);
    }
    const result = await this.ssh.execCommand(lines.join('\n'));
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
}

function buildListAllCoresScript(): string {
  // Both `.rbf` (compiled FPGA cores) and `.mgl` (XML pointer cores)
  // count as cores. A subdirectory under a category dir is only treated
  // as a folder-shaped core when it contains at least one such file
  // directly inside — otherwise it's a user-created organizational
  // folder (e.g. `_alternatives`) and we ignore it.
  const dirsScript = MISTER_CATEGORY_DIRS.map(({ category, dir }) => {
    return [
      `if [ -d ${shellQuote(dir)} ]; then`,
      `  cd ${shellQuote(dir)}`,
      '  for entry in * .[!.]*; do',
      '    [ -e "$entry" ] || continue',
      '    if [ -d "$entry" ]; then',
      `      if find "$entry" -maxdepth 1 -type f \\( -iname '*.rbf' -o -iname '*.mgl' \\) 2>/dev/null | grep -q .; then`,
      `        printf 'R\\t${category}\\tdir\\t%s\\n' "$entry"`,
      '      fi',
      '    elif [ -f "$entry" ]; then',
      '      case "$entry" in',
      `        *.rbf|*.RBF|*.mgl|*.MGL) printf 'R\\t${category}\\tfile\\t%s\\n' "$entry" ;;`,
      '      esac',
      '    fi',
      '  done',
      'fi',
    ].join('\n');
  }).join('\n');

  const gamesScript = [
    `if [ -d ${shellQuote(MISTER_GAMES_DIR)} ]; then`,
    `  cd ${shellQuote(MISTER_GAMES_DIR)}`,
    '  for d in * .[!.]*; do',
    '    [ -d "$d" ] || continue',
    `    visible=$(find "$d" -maxdepth 1 -type f ! -name '.*' 2>/dev/null | wc -l)`,
    `    hidden=$(find "$d" -maxdepth 1 -type f -name '.*' 2>/dev/null | wc -l)`,
    '    total=$((visible + hidden))',
    `    printf 'G\\t%s\\t%s\\t%s\\n' "$d" "$total" "$hidden"`,
    '  done',
    'fi',
  ].join('\n');

  return `set -e\n${dirsScript}\n${gamesScript}\n`;
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
