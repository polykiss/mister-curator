/**
 * Matcher diagnostics — pure observation layer for PR #11.
 *
 * The matcher has accumulated a few subtle bugs (phantom duplicate
 * cores, `_Console (autoboot)/` not enumerated, system-folder filter
 * disagreement between the cores list and `listRoms`, recursive
 * counts overshooting on `X68000` / `Vectrex`, etc). Before
 * touching matcher logic again, we emit structured records for
 * every decision the matcher makes so the next rewrite has a real
 * baseline to compare against.
 *
 * This module owns:
 *   - the record shapes for every kind of diagnostic event
 *   - a tiny in-memory collector that the matcher and the
 *     `RealMisterClient` push records into
 *   - a no-throw `emit` helper that's a no-op when the caller
 *     didn't supply a collector (so production code paths can
 *     thread `diagnostics?: DiagnosticsCollector` everywhere
 *     without `if` guards at every call site)
 *
 * The diagnostics collector is OFF in production. The CLI
 * `scripts/diag-real-client.ts` and the optional `MISTER_DIAG=1`
 * env-var-gated path in `RealMisterClient.collectDiagnosticReport`
 * are the only enabled callers.
 */

/**
 * Top-level header of a diagnostic report. Captured once at the
 * boundary, before the report's records are emitted.
 */
export interface DiagHeader {
  /** Schema version of the diagnostic format. Bump on any change. */
  readonly version: 1;
  /** Connection target. Includes the on-MiSTer username so we can
   *  spot env-var mistakes (smoke-tests and production share env
   *  layout, so it's nice to confirm we hit the right box). */
  readonly mister: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
  };
  /** ISO-8601 UTC timestamp at the moment we started the report. */
  readonly startedAt: string;
  /** Total wall-clock time (ms) from start to last record. Set by
   *  the orchestrator after collecting all records. */
  readonly elapsedMs: number;
  /** Best-effort count of subprocess fork()s the diagnostic shell
   *  pass triggered. Approximate; the discovery script reports its
   *  own cost separately. */
  readonly subprocessForks?: number;
}

/**
 * One rbf / mgl file found in a category dir (or at /media/fat/
 * root for `menu.rbf`-style siblings, surfaced by the discovery
 * pass).
 */
export interface RbfRecord {
  readonly kind: 'rbf';
  readonly category: string;
  /** Folder-shaped cores (`_Computer/AO486/` with rbfs inside)
   *  emit type `'dir'`; everything else `'file'`. */
  readonly type: 'file' | 'dir';
  readonly filename: string;
  readonly fullPath: string;
  /** Output of `extractCorePrefix(filename)` — the core id we'd
   *  match this rbf to. */
  readonly extractedPrefix: string;
  readonly hasLeadingDot: boolean;
}

/**
 * One games-dir entry as the matcher saw it. `rawName` may be
 * dot-prefixed; `visibleName` is the un-dotted form used as the
 * map key.
 */
export interface GamesDirRecord {
  readonly kind: 'games-dir';
  readonly rawName: string;
  readonly visibleName: string;
  readonly isHidden: boolean;
  readonly fileCount: number;
  readonly dirCount: number;
}

/**
 * One rbf-to-games-dir match decision. Emitted from the matcher's
 * dedupe step so we can see WHY two case-mismatched siblings
 * collapsed (or didn't).
 */
export interface MatchAttemptRecord {
  readonly kind: 'match-attempt';
  /** Either a coreId from an rbf, or a visibleName from a games dir. */
  readonly key: string;
  /** Lowercase form of `key` — the dedupe map key. */
  readonly lowerKey: string;
  /** Number of CoreEntries that fell into this lowercase bucket. */
  readonly groupSize: number;
  /** Member ids in this group, in insertion order. */
  readonly groupIds: readonly string[];
  /** Final action: kept / merged / dropped. */
  readonly outcome: 'kept-singleton' | 'merged' | 'dropped-all-hidden';
  /** When `outcome === 'merged'`, the id picked as the canonical winner. */
  readonly winnerId?: string;
}

/**
 * One per-entry filter decision under a games dir. With ~700
 * top-level entries on a real MiSTer, expect a few hundred records
 * per report. Cheap to emit; massively useful for tracing why a
 * specific file got counted (or didn't).
 */
export interface SystemFilterRecord {
  readonly kind: 'system-filter';
  /** Visible name of the games dir (matches `core.id` post-dedupe). */
  readonly coreId: string;
  /** Basename of the file/folder being inspected, with any dot. */
  readonly path: string;
  readonly entryType: 'file' | 'dir';
  readonly isAutoSystem: boolean;
  readonly isMarkedSystem: boolean;
  readonly decision: 'kept' | 'filtered';
}

/**
 * One per-top-level-folder entry in the recursive ROM count walk.
 * The "Vectrex says 90 but listRoms shows 0" mystery should fall
 * out of these records.
 */
export interface RecursiveCountRecord {
  readonly kind: 'recursive-count';
  readonly coreId: string;
  /** Top-level entry inside the games dir (file basename or
   *  folder basename). Dot-prefixed entries keep the dot. */
  readonly topLevelEntry: string;
  readonly entryType: 'file' | 'folder';
  /** Folder classification when entryType === 'folder' (matcher's
   *  view, before override layering). */
  readonly classification?: 'container' | 'atomic' | 'unknown' | 'no-info';
  /** Recursive contribution this entry makes to the running total. */
  readonly contributesCount: number;
  /** Same as above but for the hidden subset. */
  readonly contributesHiddenCount: number;
  /** What rule fired — for grepping a specific scenario quickly. */
  readonly reason: string;
}

/**
 * Final post-dedupe CoreEntry, captured AFTER the matcher's full
 * pipeline. Compare against the live cores-list display to spot
 * "we have a core in the report but no row on screen" cases.
 */
export interface CoreEntryRecord {
  readonly kind: 'core-entry';
  readonly coreId: string;
  readonly name: string;
  readonly category: string;
  readonly romCount: number;
  readonly hiddenCount: number;
  readonly recursiveRomCount: number | undefined;
  readonly recursiveHiddenCount: number | undefined;
  readonly gamesDirExists: boolean;
  readonly gamesDirHidden: boolean;
  readonly gamesDirName: string | undefined;
  readonly hasAnyVisibleRbf: boolean;
  readonly rbfPaths: readonly string[];
}

/**
 * One entry the discovery pass found that the regular matcher does
 * NOT enumerate. Examples: `_Console (autoboot)/`, `menu.rbf` at
 * /media/fat/ root, `_Console/._hidden/` and its contents.
 */
export interface DiscoveryRecord {
  readonly kind: 'discovery';
  readonly path: string;
  readonly entryType: 'file' | 'dir';
  /** Why we noticed this path — e.g. "category-like dir at root",
   *  "rbf at root level", "._hidden subfolder". */
  readonly note: string;
  /** When the entry is itself an rbf/mgl, the extracted prefix the
   *  matcher WOULD assign if it were enumerated. */
  readonly extractedPrefix?: string;
}

/**
 * Raw shell stdout/stderr for each subprocess the diagnostic
 * orchestrator ran. Useful as a last-resort "what did the device
 * actually say" record when a parse step misbehaves.
 */
export interface ShellRawRecord {
  readonly kind: 'shell-raw';
  /** Logical name: 'list-all-cores', 'discovery', etc. */
  readonly source: string;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly elapsedMs: number;
}

export type DiagRecord =
  | RbfRecord
  | GamesDirRecord
  | MatchAttemptRecord
  | SystemFilterRecord
  | RecursiveCountRecord
  | CoreEntryRecord
  | DiscoveryRecord
  | ShellRawRecord;

/**
 * Sink interface — the matcher pushes records here without caring
 * who's listening. Production code passes `undefined` to disable
 * the entire mechanism at the call site.
 */
export interface DiagnosticsCollector {
  emit(record: DiagRecord): void;
}

/**
 * Default collector. Holds records in memory; the orchestrator
 * pulls them at the end via `toArray()`. Not designed for streams
 * of millions of events — the matcher emits thousands at most.
 */
export class InMemoryDiagnosticsCollector implements DiagnosticsCollector {
  private readonly records: DiagRecord[] = [];

  emit(record: DiagRecord): void {
    this.records.push(record);
  }

  /** Returns a defensive copy. */
  toArray(): readonly DiagRecord[] {
    return [...this.records];
  }

  /** Number of records emitted so far. Cheaper than copying. */
  size(): number {
    return this.records.length;
  }

  /** Subset by kind — convenient for tests and for the CLI summary. */
  byKind<K extends DiagRecord['kind']>(
    kind: K,
  ): readonly Extract<DiagRecord, { kind: K }>[] {
    return this.records.filter(
      (r): r is Extract<DiagRecord, { kind: K }> => r.kind === kind,
    );
  }
}

/**
 * Push a record into the collector if one was supplied. Wraps the
 * `if (collector)` boilerplate so call sites stay one-liner. NEVER
 * throws — a misbehaving collector must not break the matcher.
 */
export function emit(
  collector: DiagnosticsCollector | undefined,
  record: DiagRecord,
): void {
  if (!collector) return;
  try {
    collector.emit(record);
  } catch {
    // Diagnostics are observation, not contract. Swallow.
  }
}

/**
 * Final report shape — header + records + the cores list the
 * matcher actually returned. The CLI writes this verbatim to
 * `/tmp/mistercurator-diag.json`.
 *
 * `cores` is `unknown[]` here so this module doesn't depend on
 * `@shared/types`; the CLI casts to `CoreEntry[]` at write time.
 */
export interface DiagReport {
  readonly header: DiagHeader;
  readonly records: readonly DiagRecord[];
  readonly cores: readonly unknown[];
}

/**
 * Pretty-print a diag report at 2-space indent. Stable key order
 * via JSON.stringify's iteration of own properties — readers don't
 * have to write a parser to grep for "what's wrong with Vectrex".
 */
export function serializeReport(report: DiagReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
