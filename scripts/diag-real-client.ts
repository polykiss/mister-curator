#!/usr/bin/env tsx
/**
 * Matcher diagnostic CLI for PR #11.
 *
 * Connects to a real MiSTer (read-only — no writes, no renames,
 * nothing leaves /tmp/mistercurator-diag.json on the local box),
 * runs `RealMisterClient.collectDiagnosticReport`, and prints a
 * compact summary to stdout while also writing the full structured
 * JSON to /tmp/mistercurator-diag.json for later inspection.
 *
 * Usage:
 *   MISTER_HOST=192.168.1.42 MISTER_PASSWORD=hunter2 npm run diag:real
 *
 * Same env-var convention as `npm run smoke:real`. See
 * docs/diagnostics.md for the full layout of the JSON file and how
 * to grep it for the matcher bugs PR #11 is investigating.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { RealMisterClient } from '@app/main/clients/real-mister-client';
import {
  serializeReport,
  type DiagRecord,
  type DiagReport,
} from '@shared/diag';
import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';
import type { MisterSecret } from '@shared/mister-client';

const REPORT_PATH = '/tmp/mistercurator-diag.json';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`✗ Missing required environment variable: ${name}`);
    console.error('  See docs/diagnostics.md for the full list.');
    process.exit(1);
  }
  return value;
}

function getEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function printError(err: unknown): void {
  if (err instanceof MisterConnectionError) {
    console.error(`\n✗ MisterConnectionError [${err.code}]`);
    console.error(`  ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    console.error(`\n✗ ${err.name}: ${err.message}`);
    if (err.stack !== undefined) {
      console.error(err.stack);
    }
    return;
  }
  console.error(`\n✗ Unknown error: ${String(err)}`);
}

type KindCounts = Readonly<Record<string, number>>;

function countByKind(records: readonly DiagRecord[]): KindCounts {
  const counts: Record<string, number> = {};
  for (const r of records) {
    counts[r.kind] = (counts[r.kind] ?? 0) + 1;
  }
  return counts;
}

function summarizeReport(report: DiagReport): void {
  const counts = countByKind(report.records);
  console.log('\nReport summary');
  console.log('==============');
  console.log(
    `  ${String(report.cores.length).padStart(5)} cores in final list`,
  );
  console.log(`  ${String(report.records.length).padStart(5)} diagnostic records`);
  console.log(
    `  ${String(report.header.elapsedMs).padStart(5)} ms total wall clock`,
  );
  console.log('');
  console.log('Records by kind:');
  for (const [k, v] of Object.entries(counts).sort()) {
    console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}`);
  }

  // Discovery surfaces — show all of them. These are the directories
  // the production matcher might have missed.
  const discovery = report.records.filter(
    (r): r is Extract<DiagRecord, { kind: 'discovery' }> => r.kind === 'discovery',
  );
  if (discovery.length > 0) {
    console.log('\nDiscovery (all paths):');
    for (const d of discovery) {
      const prefix = d.extractedPrefix ? `  prefix=${d.extractedPrefix}` : '';
      console.log(`  [${d.entryType}] ${d.path}  — ${d.note}${prefix}`);
    }
  }

  // Quick scan: cores with the suspect shapes from the spec.
  const coreEntries = report.records.filter(
    (r): r is Extract<DiagRecord, { kind: 'core-entry' }> => r.kind === 'core-entry',
  );
  const noRbf = coreEntries.filter(
    (c) => c.rbfPaths.length === 0 && c.gamesDirExists,
  );
  if (noRbf.length > 0) {
    console.log('\nCores with NO matching rbf (orphan games dirs):');
    for (const c of noRbf) {
      console.log(
        `  ${c.coreId.padEnd(28)} ${String(c.romCount).padStart(4)} ROMs, recursive ${String(c.recursiveRomCount ?? 0).padStart(5)}, gamesDirHidden=${String(c.gamesDirHidden)}`,
      );
    }
  }
  const noGamesDir = coreEntries.filter(
    (c) => !c.gamesDirExists && c.rbfPaths.length > 0,
  );
  if (noGamesDir.length > 0) {
    console.log('\nCores with rbf but NO games dir (potential phantom-duplicate sources):');
    for (const c of noGamesDir) {
      const rbfBase = c.rbfPaths
        .map((p) => p.split('/').pop() ?? p)
        .join(', ');
      console.log(`  ${c.coreId.padEnd(28)} rbfs: ${rbfBase}`);
    }
  }
}

async function main(): Promise<void> {
  const host = requireEnv('MISTER_HOST');
  const portRaw = getEnv('MISTER_PORT', '22');
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.error(`✗ MISTER_PORT must be a valid port number, got: ${portRaw}`);
    process.exit(1);
  }
  const username = getEnv('MISTER_USER', 'root');
  const password = requireEnv('MISTER_PASSWORD');

  const profile: MisterProfile = {
    id: 'diag',
    name: 'Diagnostics',
    host,
    port,
    username,
    authMethod: 'password',
  };
  const secret: MisterSecret = { type: 'password', password };

  console.log(
    `Collecting matcher diagnostics from ${username}@${host}:${String(port)}…`,
  );

  const client = new RealMisterClient();
  try {
    await client.connect(profile, secret);
    const report = await client.collectDiagnosticReport({
      host,
      port,
      username,
    });
    await client.disconnect();

    // Pretty-print the full report to /tmp/mistercurator-diag.json
    // (path documented in docs/diagnostics.md so the user knows
    // where to find it after running the script).
    await fs.mkdir(path.dirname(REPORT_PATH), { recursive: true });
    await fs.writeFile(REPORT_PATH, serializeReport(report), 'utf-8');
    console.log(`\nFull report written to ${REPORT_PATH}`);

    summarizeReport(report);

    console.log('\n✓ Diagnostics complete.');
  } catch (err) {
    printError(err);
    try {
      if (client.isConnected()) await client.disconnect();
    } catch {
      // Best-effort cleanup.
    }
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  printError(err);
  process.exit(1);
});
