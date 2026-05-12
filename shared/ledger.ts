import type { ArcadeMraMeta } from '@shared/arcade-mra-parse';
import { isRealCore } from '@shared/core-matching';
import type { CoreEntry, HiddenCoreEntry, HideLedger } from '@shared/types';

/**
 * The heredoc delimiter used by the real client when writing the ledger
 * over SSH. Exported so the serializer can hard-fail before producing a
 * payload that would prematurely terminate the heredoc on the MiSTer.
 *
 * If you ever change this string, change it in both the writer
 * (real-mister-client.ts) and here in lockstep — the writer's contract is
 * "the payload `serializeLedger` produced will never contain this string".
 */
export const LEDGER_HEREDOC_DELIMITER = 'MISTERCURATOR_LEDGER_EOF';

export const EMPTY_LEDGER: HideLedger = { schemaVersion: 1, hiddenCores: [] };

/**
 * feat/arcade-ux-and-ledger (PR 2/2) — default value for the
 * arcade auto-hide-enabled preference. ON by default so a brand-
 * new connect (or a ledger written by a pre-V1 client) auto-hides
 * missing-ROM .mras out of the box. The user can toggle it off via
 * the Arcade pane header at any time.
 */
export const DEFAULT_ARCADE_AUTO_HIDE_ENABLED = true;

/**
 * Lenient parser: empty input or malformed JSON yields an empty ledger,
 * because that's how a freshly-installed MiSTer presents itself. Strict
 * about *recognized-but-incompatible* shapes — an unknown schema version
 * throws so future-incompatible upgrades fail loudly instead of silently
 * dropping data.
 */
export function parseLedger(raw: string): HideLedger {
  const trimmed = raw.trim();
  if (trimmed === '') return EMPTY_LEDGER;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return EMPTY_LEDGER;
  }

  if (!isLedgerObject(parsed)) {
    return EMPTY_LEDGER;
  }
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `Hide ledger has an unsupported schemaVersion (${String(parsed.schemaVersion)}). ` +
        `This MiSTer was probably written by a newer version of MiSTerCurator — ` +
        `update before continuing.`,
    );
  }
  // PR-2 arcade fields are optional on the wire — pre-V1 ledgers
  // simply don't carry them. The parser surfaces undefined for an
  // absent field; consumers use `EMPTY_LEDGER` defaults or the
  // helpers below to resolve.
  return parsed;
}

/**
 * Serializes the ledger to pretty JSON. Hard-fails if the payload would
 * collide with the SSH heredoc delimiter — paranoia paid forward, because
 * a coreId or rbfPath chosen by an attacker (or a strange MiSTer setup)
 * could otherwise close the heredoc early and turn the rest of the
 * payload into shell commands.
 */
export function serializeLedger(ledger: HideLedger): string {
  const json = `${JSON.stringify(ledger, null, 2)}\n`;
  if (json.includes(LEDGER_HEREDOC_DELIMITER)) {
    throw new Error(
      `Refusing to write the hide ledger: payload contains the heredoc ` +
        `delimiter '${LEDGER_HEREDOC_DELIMITER}'. Rename or remove the offending ` +
        `entry and try again.`,
    );
  }
  return json;
}

export function withCoreHidden(ledger: HideLedger, entry: HiddenCoreEntry): HideLedger {
  const others = ledger.hiddenCores.filter((e) => e.coreId !== entry.coreId);
  return { ...ledger, hiddenCores: [...others, entry] };
}

export function withCoreShown(ledger: HideLedger, coreId: string): HideLedger {
  // Case-insensitive comparison so an entry written under one canonical
  // id (e.g. APOGEE pre-dedupe) is still removed when the new canonical
  // is `Apogee`. Real ledgers should match exactly, but defensive.
  const lower = coreId.toLowerCase();
  return {
    ...ledger,
    hiddenCores: ledger.hiddenCores.filter((e) => e.coreId.toLowerCase() !== lower),
  };
}

/**
 * Drops ledger entries that no longer correspond to a real core in the
 * current device snapshot. Used by the IMisterClient layer on every
 * read so that a ledger that has accumulated junk (a `_hidden` user
 * folder we mis-recorded before the closeout fix, a case-duplicate
 * that's since been deduped, a core uninstalled by the user, etc.) is
 * cleaned up the next time we touch it.
 *
 * Lookups are case-insensitive against `currentCores` so a ledger
 * written with one case continues to match an entry whose canonical
 * id has shifted (e.g. APOGEE → Apogee after the case-dedupe step).
 *
 * Returns the same ledger object if nothing was dropped — callers can
 * use referential equality to skip a needless rewrite.
 */
export function healLedger(
  ledger: HideLedger,
  currentCores: readonly CoreEntry[],
): HideLedger {
  if (ledger.hiddenCores.length === 0) return ledger;

  const byLowerId = new Map<string, CoreEntry>();
  for (const c of currentCores) byLowerId.set(c.id.toLowerCase(), c);

  let dropped = 0;
  const kept: HiddenCoreEntry[] = [];
  for (const entry of ledger.hiddenCores) {
    const core = byLowerId.get(entry.coreId.toLowerCase());
    if (!core) {
      // The cores list is the source of truth for "what's on the device
      // right now". If a ledger entry doesn't map to any current core,
      // the underlying paths are gone (or the case-dedupe dropped them
      // as MiSTer leftover) — drop the entry.
      dropped += 1;
      continue;
    }
    if (!isRealCore(core)) {
      // The core resolves to a non-real entry (Arcade placeholder,
      // user folder, etc). The ledger should never carry these; clean
      // up so the user-folder bug from earlier rounds can't linger.
      dropped += 1;
      continue;
    }
    kept.push(entry);
  }

  if (dropped === 0) return ledger;
  return { ...ledger, hiddenCores: kept };
}

/**
 * Structural equality for two ledgers. Used by callers that want to
 * skip a rewrite when `healLedger` was a no-op. Order-sensitive
 * because we don't promise a particular sort.
 */
export function ledgerEqual(a: HideLedger, b: HideLedger): boolean {
  if (a === b) return true;
  if (a.schemaVersion !== b.schemaVersion) return false;
  if (a.hiddenCores.length !== b.hiddenCores.length) return false;
  for (let i = 0; i < a.hiddenCores.length; i += 1) {
    const ea = a.hiddenCores[i]!;
    const eb = b.hiddenCores[i]!;
    if (ea.coreId !== eb.coreId) return false;
    if (ea.gamesDirHidden !== eb.gamesDirHidden) return false;
    if (ea.gamesDirName !== eb.gamesDirName) return false;
    if (ea.hiddenAt !== eb.hiddenAt) return false;
    if (ea.rbfPaths.length !== eb.rbfPaths.length) return false;
    for (let j = 0; j < ea.rbfPaths.length; j += 1) {
      if (ea.rbfPaths[j] !== eb.rbfPaths[j]) return false;
    }
  }
  if (
    (a.arcadeAutoHideEnabled ?? DEFAULT_ARCADE_AUTO_HIDE_ENABLED) !==
    (b.arcadeAutoHideEnabled ?? DEFAULT_ARCADE_AUTO_HIDE_ENABLED)
  ) {
    return false;
  }
  if (!stringArrayEqual(a.arcadeAutoHidden ?? [], b.arcadeAutoHidden ?? [])) {
    return false;
  }
  if (
    !stringArrayEqual(
      a.arcadeUserShownDespiteMissing ?? [],
      b.arcadeUserShownDespiteMissing ?? [],
    )
  ) {
    return false;
  }
  return true;
}

function stringArrayEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * feat/arcade-ux-and-ledger (PR 2/2) — strip a leading dot from the
 * basename of a .mra relative path. The renderer + ledger track the
 * visible (undotted) form so a hide/show cycle doesn't drift the
 * identity. Subfolder paths preserve their parent segments.
 *
 *   `Foo.mra`               → `Foo.mra`
 *   `.Foo.mra`              → `Foo.mra`
 *   `_Konami/.Foo.mra`      → `_Konami/Foo.mra`
 *   `_Konami/Foo.mra`       → `_Konami/Foo.mra`
 */
export function arcadeMraVisiblePath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  if (slash === -1) {
    return relativePath.startsWith('.') ? relativePath.slice(1) : relativePath;
  }
  const dir = relativePath.slice(0, slash + 1);
  const base = relativePath.slice(slash + 1);
  return base.startsWith('.') ? `${dir}${base.slice(1)}` : `${dir}${base}`;
}

/**
 * Inverse of `arcadeMraVisiblePath`: prepend a leading dot to the
 * basename so the path matches the on-disk hidden form. Used by the
 * arcade auto-hide write-through to patch the cached entries[] in
 * place after `setBulkArcadeMraVisibility` renames a .mra:
 *
 *   `Foo.mra`               → `.Foo.mra`
 *   `.Foo.mra`              → `.Foo.mra`   (idempotent)
 *   `_Konami/Foo.mra`       → `_Konami/.Foo.mra`
 *   `_Konami/.Foo.mra`      → `_Konami/.Foo.mra` (idempotent)
 */
export function arcadeMraHiddenPath(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  if (slash === -1) {
    return relativePath.startsWith('.') ? relativePath : `.${relativePath}`;
  }
  const dir = relativePath.slice(0, slash + 1);
  const base = relativePath.slice(slash + 1);
  return base.startsWith('.') ? `${dir}${base}` : `${dir}.${base}`;
}

/**
 * feat/arcade-ux-and-ledger (PR 2/2) — drop arcade ledger entries
 * whose VISIBLE relative path no longer maps to a .mra on the device.
 * Used on connect right after `parseArcadeMras` populates the
 * playability snapshot. Mirrors the existing `healLedger` for cores:
 * a removed .mra in the firmware update or via user deletion
 * shouldn't keep a tombstone or auto-hide record alive.
 *
 * The match is exact on visible paths — both the device entries (via
 * `arcadeMraVisiblePath` on each ArcadeMraMeta.relativePath) and the
 * ledger entries (already stored visible). Order-preserving;
 * returns the same object when nothing changes so a caller can use
 * referential equality to skip a write-through.
 */
export function healArcadeLedger(
  ledger: HideLedger,
  entries: readonly ArcadeMraMeta[],
): HideLedger {
  const autoHidden = ledger.arcadeAutoHidden;
  const tombstones = ledger.arcadeUserShownDespiteMissing;
  if (
    (autoHidden === undefined || autoHidden.length === 0) &&
    (tombstones === undefined || tombstones.length === 0)
  ) {
    return ledger;
  }
  const visibleOnDevice = new Set<string>();
  for (const e of entries) {
    visibleOnDevice.add(arcadeMraVisiblePath(e.relativePath));
  }
  const keepAuto = (autoHidden ?? []).filter((p) => visibleOnDevice.has(p));
  const keepTomb = (tombstones ?? []).filter((p) => visibleOnDevice.has(p));
  const autoChanged =
    keepAuto.length !== (autoHidden?.length ?? 0) ||
    !stringArrayEqual(keepAuto, autoHidden ?? []);
  const tombChanged =
    keepTomb.length !== (tombstones?.length ?? 0) ||
    !stringArrayEqual(keepTomb, tombstones ?? []);
  if (!autoChanged && !tombChanged) return ledger;
  return {
    ...ledger,
    arcadeAutoHidden: keepAuto,
    arcadeUserShownDespiteMissing: keepTomb,
  };
}

/**
 * Replace the auto-hidden set on a ledger with a fresh snapshot.
 * Used by the connect-time auto-hide pass and the OFF→ON / ON→OFF
 * toggle handlers. Visible-path entries; the caller normalises.
 */
export function withArcadeAutoHidden(
  ledger: HideLedger,
  autoHidden: readonly string[],
): HideLedger {
  return { ...ledger, arcadeAutoHidden: [...autoHidden] };
}

/**
 * Add a single tombstone (user-shown-despite-missing). Idempotent;
 * duplicates collapse so re-promoting the same row is a no-op.
 */
export function withArcadeTombstoneAdded(
  ledger: HideLedger,
  visibleRelPath: string,
): HideLedger {
  const current = ledger.arcadeUserShownDespiteMissing ?? [];
  if (current.includes(visibleRelPath)) return ledger;
  return {
    ...ledger,
    arcadeUserShownDespiteMissing: [...current, visibleRelPath],
  };
}

/**
 * Remove a tombstone. Used when the user re-hides a previously-
 * tombstoned mra (they're reversing their previous intent).
 * No-op when the entry isn't present.
 */
export function withArcadeTombstoneRemoved(
  ledger: HideLedger,
  visibleRelPath: string,
): HideLedger {
  const current = ledger.arcadeUserShownDespiteMissing ?? [];
  if (!current.includes(visibleRelPath)) return ledger;
  return {
    ...ledger,
    arcadeUserShownDespiteMissing: current.filter((p) => p !== visibleRelPath),
  };
}

/**
 * Flip the persisted auto-hide preference on a ledger.
 */
export function withArcadeAutoHideEnabled(
  ledger: HideLedger,
  enabled: boolean,
): HideLedger {
  return { ...ledger, arcadeAutoHideEnabled: enabled };
}

function isLedgerObject(v: unknown): v is HideLedger {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') return false;
  if (!Array.isArray(obj.hiddenCores)) return false;
  if (!obj.hiddenCores.every(isHiddenCoreEntry)) return false;
  // PR-2 arcade fields — optional, but if present must be the
  // right shape. A malformed entry (wrong type) treats the whole
  // ledger as malformed and falls back to EMPTY_LEDGER per the
  // existing lenient-parse contract.
  if (
    obj.arcadeAutoHideEnabled !== undefined &&
    typeof obj.arcadeAutoHideEnabled !== 'boolean'
  ) {
    return false;
  }
  if (obj.arcadeAutoHidden !== undefined) {
    if (!Array.isArray(obj.arcadeAutoHidden)) return false;
    if (!obj.arcadeAutoHidden.every((s) => typeof s === 'string')) return false;
  }
  if (obj.arcadeUserShownDespiteMissing !== undefined) {
    if (!Array.isArray(obj.arcadeUserShownDespiteMissing)) return false;
    if (
      !obj.arcadeUserShownDespiteMissing.every((s) => typeof s === 'string')
    ) {
      return false;
    }
  }
  return true;
}

function isHiddenCoreEntry(v: unknown): v is HiddenCoreEntry {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.coreId !== 'string') return false;
  if (typeof obj.gamesDirHidden !== 'boolean') return false;
  if (typeof obj.hiddenAt !== 'string') return false;
  if (!Array.isArray(obj.rbfPaths)) return false;
  return obj.rbfPaths.every((s) => typeof s === 'string');
}
