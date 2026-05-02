#!/usr/bin/env tsx
/**
 * Read-only smoke test for the production RealMisterClient against a live
 * MiSTer. Run after any change to RealMisterClient. Does not call any
 * visibility-changing methods.
 *
 * Usage:
 *   MISTER_HOST=192.168.1.42 MISTER_PASSWORD=hunter2 npm run smoke:real
 *
 * See docs/smoke-testing.md for the full env-var list and a .env.local
 * pattern for not pasting credentials into your shell history.
 */
import { createMisterClient } from '@app/main/clients';
import { MisterConnectionError } from '@shared/types';
import type { MisterProfile } from '@shared/types';
import type { IMisterClient, MisterSecret } from '@shared/mister-client';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    console.error(`✗ Missing required environment variable: ${name}`);
    console.error('  See docs/smoke-testing.md for the full list.');
    process.exit(1);
  }
  return value;
}

function getEnv(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await fn();
  const elapsed = Math.round(performance.now() - start);
  console.log(`  ✓ ${label}  (${String(elapsed)}ms)`);
  return result;
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

async function safeDisconnect(client: IMisterClient): Promise<void> {
  try {
    if (client.isConnected()) {
      await client.disconnect();
    }
  } catch {
    // Best-effort cleanup; smoke-test outcome is already determined.
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
    id: 'smoke',
    name: 'Smoke Test',
    host,
    port,
    username,
    authMethod: 'password',
  };
  const secret: MisterSecret = { type: 'password', password };

  console.log(`Smoke-testing RealMisterClient against ${username}@${host}:${String(port)}\n`);

  const client = createMisterClient('real');
  try {
    await timed('connect()', () => client.connect(profile, secret));

    const cores = await timed('listCores()', () => client.listCores());
    console.log(`\n  Found ${String(cores.length)} core(s).`);
    if (cores.length > 0) {
      console.log('  First 10:');
      for (const core of cores.slice(0, 10)) {
        const visible = core.romCount - core.hiddenCount;
        console.log(
          `    ${core.id.padEnd(20)}  ${String(core.romCount).padStart(5)} ROMs` +
            `  (${String(visible)} visible, ${String(core.hiddenCount)} hidden)`,
        );
      }
    }

    const coreWithRoms = cores.find((c) => c.romCount > 0);
    if (!coreWithRoms) {
      console.log('\n  No cores with ROMs found — skipping listRoms().');
    } else {
      console.log('');
      const roms = await timed(
        `listRoms('${coreWithRoms.id}')`,
        () => client.listRoms(coreWithRoms.id),
      );
      console.log(`\n  Found ${String(roms.length)} ROM(s) in ${coreWithRoms.id}.`);
      console.log('  First 10:');
      for (const rom of roms.slice(0, 10)) {
        const flag = rom.hidden ? '[hidden] ' : '[visible]';
        console.log(
          `    ${flag}  ${rom.displayName.padEnd(50)}  ${String(rom.sizeBytes).padStart(10)} bytes`,
        );
      }
    }

    console.log('');
    await timed('disconnect()', () => client.disconnect());

    console.log('\n✓ Smoke test passed.');
  } catch (err) {
    printError(err);
    await safeDisconnect(client);
    process.exit(1);
  }
}

await main();
