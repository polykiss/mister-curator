import type { HiddenCoreEntry, HideLedger } from '@shared/types';

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
  return {
    ...ledger,
    hiddenCores: ledger.hiddenCores.filter((e) => e.coreId !== coreId),
  };
}

function isLedgerObject(v: unknown): v is HideLedger {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.schemaVersion !== 'number') return false;
  if (!Array.isArray(obj.hiddenCores)) return false;
  return obj.hiddenCores.every(isHiddenCoreEntry);
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
