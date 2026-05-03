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
  isRealCore,
  matchRbfsToGamesDirs,
  type CoreRename,
  type RawGamesDirInput,
  type RawRbfInput,
} from '@shared/core-matching';
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
import { classifyFromFlags, resolveClassification } from '@shared/folder-rom';
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
  IMisterClient,
  MisterSecret,
  RomVisibilityChange,
  SystemFileMarkChange,
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
    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Failed to list cores: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }

    const rbfs: RawRbfInput[] = [];
    // Aggregate per-games-dir entries from the GF / GD lines so the
    // matcher can apply the system-file filter to derive romCount.
    const gamesDirsBuilder = new Map<
      string,
      { files: string[]; dirs: string[] }
    >();
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
      } else if (tag === 'R' && parts.length >= 4) {
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
      } else if (tag === 'G' && parts.length >= 2) {
        // Games-dir announcement. Initialises the bucket so empty
        // dirs (no GF/GD lines following) still appear in the matcher
        // input — without this they'd be lost.
        const rawName = parts[1] ?? '';
        if (rawName !== '' && !gamesDirsBuilder.has(rawName)) {
          gamesDirsBuilder.set(rawName, { files: [], dirs: [] });
        }
      } else if (tag === 'GF' && parts.length >= 3) {
        const rawName = parts[1] ?? '';
        const filename = parts.slice(2).join('\t');
        let bucket = gamesDirsBuilder.get(rawName);
        if (!bucket) {
          bucket = { files: [], dirs: [] };
          gamesDirsBuilder.set(rawName, bucket);
        }
        bucket.files.push(filename);
      } else if (tag === 'GD' && parts.length >= 3) {
        const rawName = parts[1] ?? '';
        const dirname = parts.slice(2).join('\t');
        let bucket = gamesDirsBuilder.get(rawName);
        if (!bucket) {
          bucket = { files: [], dirs: [] };
          gamesDirsBuilder.set(rawName, bucket);
        }
        bucket.dirs.push(dirname);
      }
    }
    const gamesDirs: RawGamesDirInput[] = Array.from(gamesDirsBuilder, ([rawName, b]) => ({
      rawName,
      files: b.files,
      dirs: b.dirs,
    }));

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
    assertSafeSegment('coreId', coreId);
    assertSafeSubPath(subPath);

    const targetDir =
      subPath === ''
        ? `${MISTER_GAMES_DIR}/${coreId}`
        : `${MISTER_GAMES_DIR}/${coreId}/${subPath}`;
    const relPrefix = subPath === '' ? '' : `${subPath}/`;

    // Single batched script that emits per-entry rows. For folders we
    // also emit four classification flags (disc / track / cart / sub-
    // dir) computed by a single case-statement scan over their direct
    // contents — keeps classification on the device but the *decision*
    // in JS so we can layer user overrides without re-deploying the
    // shell.
    //
    // Lines:
    //   F\t<filename>\t<size>
    //   D\t<dirname>\t<size>\t<has_disc>\t<has_track>\t<has_cart>\t<has_subdir>
    const script = [
      `cd ${shellQuote(targetDir)} 2>/dev/null || { echo MISSING_DIR; exit 1; }`,
      `find . -mindepth 1 -maxdepth 1 -type f -printf 'F\\t%f\\t%s\\n' 2>/dev/null || true`,
      // For each immediate dir: collect a recursive byte total (du -sb)
      // AND a quick four-flag scan of its top level.
      'for d in */ .[!.]*/; do',
      '  [ -d "$d" ] || continue',
      '  d="${d%/}"',
      '  size=$(du -sb -- "$d" 2>/dev/null | awk \'{print $1; exit}\')',
      '  [ -z "$size" ] && size=0',
      '  has_disc=0; has_track=0; has_cart=0; has_subdir=0',
      '  for child in "$d"/* "$d"/.[!.]*; do',
      '    [ -e "$child" ] || continue',
      '    base="${child##*/}"',
      '    if [ -d "$child" ]; then has_subdir=1; continue; fi',
      '    case "$base" in',
      '      *.cue|*.CUE|*.gdi|*.GDI|*.iso|*.ISO|*.chd|*.CHD) has_disc=1 ;;',
      '    esac',
      '    case "$base" in',
      '      *Track\\ *|*track\\ *|*Track[0-9]*|*track[0-9]*) has_track=1 ;;',
      '    esac',
      '    case "$base" in',
      '      *.zip|*.ZIP|*.7z|*.7Z|*.rar|*.RAR|*.sfc|*.SFC|*.smc|*.SMC|*.nes|*.NES|*.gba|*.GBA|*.gb|*.GB|*.gbc|*.GBC|*.md|*.MD|*.gen|*.GEN|*.pce|*.PCE|*.lnx|*.LNX|*.col|*.COL|*.gg|*.GG|*.sms|*.SMS|*.a78|*.A78|*.a26|*.A26|*.bin|*.BIN) has_cart=1 ;;',
      '    esac',
      '  done',
      '  printf "D\\t%s\\t%s\\t%d\\t%d\\t%d\\t%d\\n" "$d" "$size" "$has_disc" "$has_track" "$has_cart" "$has_subdir"',
      'done',
    ].join('\n');

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0 || result.stdout.includes('MISSING_DIR')) {
      throw new Error(`Unknown core: ${coreId}`);
    }

    const roms: Rom[] = [];
    for (const line of result.stdout.split('\n')) {
      if (line === '' || line === 'MISSING_DIR') continue;
      const parts = line.split('\t');
      const tag = parts[0];
      if (tag === 'F' && parts.length >= 3) {
        const filename = parts[1] ?? '';
        const sizeBytes = Number.parseInt(parts[2] ?? '0', 10);
        if (filename === '' || Number.isNaN(sizeBytes)) continue;
        const hidden = filename.startsWith('.');
        const visibleBase = hidden ? filename.slice(1) : filename;
        const relativePath = `${relPrefix}${filename}`;
        roms.push({
          coreId,
          filename,
          displayName: displayRomName(visibleBase),
          sizeBytes,
          hidden,
          path: `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`,
          kind: 'file',
          relativePath,
        });
      } else if (tag === 'D' && parts.length >= 7) {
        const filename = parts[1] ?? '';
        const sizeBytes = Number.parseInt(parts[2] ?? '0', 10);
        if (filename === '' || Number.isNaN(sizeBytes)) continue;
        const hidden = filename.startsWith('.');
        const visibleBase = hidden ? filename.slice(1) : filename;
        const flags = {
          hasDisc: parts[3] === '1',
          hasTrack: parts[4] === '1',
          hasCart: parts[5] === '1',
          hasSubdir: parts[6] === '1',
        };
        const relativePath = `${relPrefix}${filename}`;
        const visibleRelPath = `${relPrefix}${visibleBase}`;
        const heuristic = classifyFromFlags(flags);
        const override = getFolderOverride(
          folderClassifications,
          coreId,
          visibleRelPath,
        );
        const classification = resolveClassification(heuristic, override);
        roms.push({
          coreId,
          filename,
          displayName: displayRomName(visibleBase),
          sizeBytes,
          hidden,
          path: `${MISTER_GAMES_DIR}/${coreId}/${relativePath}`,
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
    const result = await this.ssh.execCommand(script);
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

    await this.ssh.exec(script, [], {
      stream: 'stdout',
      onStdout: (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        for (;;) {
          const i = buffer.indexOf('\n');
          if (i < 0) break;
          const line = buffer.slice(0, i);
          buffer = buffer.slice(i + 1);
          handleLine(line);
        }
      },
    });
    // Flush any trailing partial line (no terminating newline).
    if (buffer !== '') handleLine(buffer);

    return { succeeded, failed };
  }

  async readHideLedger(): Promise<HideLedger> {
    this.assertConnected();
    // `cat` returns non-zero when the file is missing; we want that to be a
    // soft "empty ledger" outcome, so we tolerate it inline and rely on the
    // parser to handle the empty string.
    const result = await this.ssh.execCommand(
      `cat ${shellQuote(MISTER_LEDGER_PATH)} 2>/dev/null || true`,
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

  async readSystemFilesMarks(): Promise<SystemFilesMarks> {
    this.assertConnected();
    const result = await this.ssh.execCommand(
      `cat ${shellQuote(MISTER_SYSTEM_FILES_PATH)} 2>/dev/null || true`,
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
    const script =
      `mkdir -p ${shellQuote(MISTER_LEDGER_DIR)}\n` +
      `cat > ${shellQuote(tmpPath)} <<'${SYSTEM_FILES_HEREDOC_DELIMITER}'\n` +
      json +
      `${SYSTEM_FILES_HEREDOC_DELIMITER}\n` +
      `mv ${shellQuote(tmpPath)} ${shellQuote(MISTER_SYSTEM_FILES_PATH)}\n`;

    const result = await this.ssh.execCommand(script);
    if (result.code !== 0) {
      throw new Error(
        `Failed to write system-files marks: ${result.stderr.trim() || `exit code ${String(result.code)}`}`,
      );
    }
  }

  async readFolderClassifications(): Promise<FolderClassifications> {
    this.assertConnected();
    const result = await this.ssh.execCommand(
      `cat ${shellQuote(MISTER_FOLDER_CLASSIFICATIONS_PATH)} 2>/dev/null || true`,
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

    const result = await this.ssh.execCommand(script);
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

  // Per-entry emission: one G line announcing the games dir, then one
  // GF/GD line per top-level file/dir inside it. The matcher applies
  // `isSystemFile` to derive romCount/hiddenCount — keeping the heuristic
  // in JS means the shell stays dumb and we can extend the patterns
  // without re-deploying. Folder-shaped ROMs (Saturn/MegaCD discs) come
  // through as GD lines and are NEVER filtered out as system content.
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
    '      fi',
    '    done',
    '  done',
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

  return `set -e\n${dirsScript}\n${gamesScript}\n${arcadeProbeScript}\n`;
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
