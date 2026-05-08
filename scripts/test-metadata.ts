#!/usr/bin/env tsx
/**
 * End-to-end metadata pipeline check against a real MiSTer.
 *
 * What it does:
 *   1. Connects via env-supplied credentials.
 *   2. Lists every core via listAllCoresWithFiles + listRoms.
 *   3. Picks 5–10 well-known ROMs by filename keyword.
 *   4. For each: md5 → ScreenScraper → cache box art.
 *   5. Prints a summary and basic perf assertions.
 *
 * Usage:
 *   MISTER_HOST=192.168.1.42 MISTER_PASSWORD=hunter2 \
 *   SCREENSCRAPER_DEVID=xxx SCREENSCRAPER_DEVPASSWORD=yyy \
 *     npm run test:metadata
 *
 * Required env (MiSTer SSH):
 *   MISTER_HOST, MISTER_PASSWORD
 *
 * Optional env:
 *   MISTER_PORT (22), MISTER_USER (root)
 *   SCREENSCRAPER_DEVID / SCREENSCRAPER_DEVPASSWORD
 *     ScreenScraper requires developer credentials. Without them the
 *     ScreenScraper client returns null cleanly and the script
 *     continues — useful for verifying the rest of the pipeline (hash
 *     computation, image-cache integration) without hitting the API.
 *     Obtain credentials via the ScreenScraper forum:
 *     https://www.screenscraper.fr/forumsujets.php?frub=12
 *   METADATA_THEGAMESDB_KEY — enables TheGamesDB fallback when set
 *   METADATA_DISABLE_SCREENSCRAPER=1 — disable upstream calls
 *   METADATA_TEST_DIR=/tmp/x — override the cache root (default: tmp dir)
 *
 * The script writes its caches to a fresh temp dir by default so a
 * verification run never collides with the desktop app's caches; pass
 * `METADATA_TEST_DIR` if you want to inspect or persist them.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMisterClient } from '@app/main/clients';
import { ScreenScraperClient } from '@app/main/metadata/clients/screenscraper-client';
import { TheGamesDBClient } from '@app/main/metadata/clients/thegamesdb-client';
import { HashService } from '@app/main/metadata/hash-service';
import { ImageCache } from '@app/main/metadata/image-cache';
import { MetadataService } from '@app/main/metadata/metadata-service';
import { MisterConnectionError } from '@shared/types';
import type { MisterProfile, Rom } from '@shared/types';
import type { IMisterClient, MisterSecret } from '@shared/mister-client';

/** Filename keywords (case-insensitive) we'll try to find in the library. */
const TARGET_KEYWORDS = [
  'super mario world',
  'sonic the hedgehog 2',
  'chrono trigger',
  'metroid',
  'zelda',
  'final fantasy',
  'castlevania',
  'mega man',
  'street fighter',
  'tetris',
] as const;

/** Cold-cache perf budgets. Used as soft assertions — we warn but don't exit. */
const PERF_BUDGETS = {
  metadataColdMs: 3500, // 1.1s rate floor + network — give a little slack
  metadataWarmMs: 50,
  imageColdMs: 5000,
  imageWarmMs: 50, // disk read; spec says 20 but Electron-less Node may be slower
};

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    console.error(`✗ Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

function getEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

interface Timed<T> {
  readonly value: T;
  readonly elapsedMs: number;
}

async function timed<T>(fn: () => Promise<T>): Promise<Timed<T>> {
  const start = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - start };
}

function printError(err: unknown): void {
  if (err instanceof MisterConnectionError) {
    console.error(`\n✗ MisterConnectionError [${err.code}]: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`\n✗ ${err.name}: ${err.message}`);
    if (err.stack !== undefined) console.error(err.stack);
  } else {
    console.error(`\n✗ Unknown error: ${String(err)}`);
  }
}

async function safeDisconnect(client: IMisterClient): Promise<void> {
  try {
    if (client.isConnected()) await client.disconnect();
  } catch {
    /* best-effort */
  }
}

interface PickedRom {
  readonly rom: Rom;
  readonly keyword: string;
}

async function findTargetRoms(client: IMisterClient): Promise<PickedRom[]> {
  // Walk every core, top-level only — that's where the simple file
  // ROMs (NES/SNES/Genesis cartridges) live. Disc folders are out of
  // scope for v0 hashing per option 3a.
  const cores = await client.listAllCoresWithFiles();
  const picked: PickedRom[] = [];
  const seen = new Set<string>();
  for (const core of cores) {
    if (!core.gamesDirExists) continue;
    let roms: readonly Rom[];
    try {
      roms = await client.listRoms(core.id);
    } catch {
      continue;
    }
    for (const rom of roms) {
      if (rom.kind !== 'file') continue;
      const lower = rom.filename.toLowerCase();
      for (const kw of TARGET_KEYWORDS) {
        if (lower.includes(kw) && !seen.has(kw)) {
          picked.push({ rom, keyword: kw });
          seen.add(kw);
          break;
        }
      }
    }
    if (picked.length >= 10) break;
  }
  return picked;
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

  const cacheDir =
    process.env['METADATA_TEST_DIR'] ?? (await fs.mkdtemp(join(tmpdir(), 'mc-meta-test-')));
  console.log(`Metadata pipeline test against ${username}@${host}:${String(port)}`);
  console.log(`Cache root: ${cacheDir}\n`);

  const profile: MisterProfile = {
    id: 'metadata-test',
    name: 'Metadata Test',
    host,
    port,
    username,
    authMethod: 'password',
  };
  const secret: MisterSecret = { type: 'password', password };

  const ssDevId = process.env['SCREENSCRAPER_DEVID'] ?? null;
  const ssDevPassword = process.env['SCREENSCRAPER_DEVPASSWORD'] ?? null;
  const ssDisabledExplicit = process.env['METADATA_DISABLE_SCREENSCRAPER'] === '1';
  const ssCredsConfigured =
    ssDevId !== null && ssDevId.length > 0 && ssDevPassword !== null && ssDevPassword.length > 0;
  if (ssDisabledExplicit) {
    console.log('• ScreenScraper: disabled via METADATA_DISABLE_SCREENSCRAPER=1');
  } else if (!ssCredsConfigured) {
    console.log(
      '• ScreenScraper: credentials not configured — skipping. ' +
        'Set SCREENSCRAPER_DEVID and SCREENSCRAPER_DEVPASSWORD to enable.\n' +
        '  (Forum: https://www.screenscraper.fr/forumsujets.php?frub=12)',
    );
  } else {
    console.log('• ScreenScraper: credentials configured');
  }
  if (process.env['METADATA_THEGAMESDB_KEY'] !== undefined) {
    console.log('• TheGamesDB: API key configured');
  } else {
    console.log('• TheGamesDB: no API key (fallback disabled)');
  }
  console.log('');

  const client = createMisterClient('real');
  const hashService = new HashService(cacheDir);
  const screenScraper = new ScreenScraperClient({
    disabled: ssDisabledExplicit,
    devId: ssDevId,
    devPassword: ssDevPassword,
    logger: (m) => console.warn(m),
  });
  const theGamesDb = new TheGamesDBClient({
    apiKey: process.env['METADATA_THEGAMESDB_KEY'] ?? null,
    disabled: process.env['METADATA_DISABLE_THEGAMESDB'] === '1',
    logger: (m) => console.warn(m),
  });
  const metadataService = new MetadataService(cacheDir, screenScraper, theGamesDb, {
    logger: (m) => console.warn(m),
  });
  const imageCache = new ImageCache(join(cacheDir, 'images'));
  // We deliberately drive the four services directly rather than the
  // MetadataOrchestrator — timing each step independently is more
  // informative for this verification tool. The orchestrator's
  // delegation logic is exercised by `metadata-ipc.test.ts`.

  const warnings: string[] = [];

  try {
    const connectT = await timed(() => client.connect(profile, secret));
    console.log(`✓ connect()  ${Math.round(connectT.elapsedMs)}ms`);

    const findT = await timed(() => findTargetRoms(client));
    const picked = findT.value;
    console.log(
      `✓ scan library  ${Math.round(findT.elapsedMs)}ms  (found ${String(
        picked.length,
      )}/${String(TARGET_KEYWORDS.length)} target ROMs)`,
    );
    if (picked.length === 0) {
      console.error('\n✗ No target ROMs found. Is the library populated with cartridge dumps?');
      await safeDisconnect(client);
      process.exit(1);
    }

    let hashed = 0;
    let matched = 0;
    let boxArtDownloaded = 0;

    for (const { rom, keyword } of picked) {
      console.log(`\n— ${rom.filename}`);

      const hashesT = await timed(() =>
        hashService.getHash(client, host, [rom.path]),
      );
      const hash = hashesT.value.get(rom.path);
      if (hash === undefined) {
        console.log(`  ✗ md5 returned no entry (file not regular?)`);
        continue;
      }
      hashed += 1;
      console.log(`  md5         ${hash}  (${Math.round(hashesT.elapsedMs)}ms)`);

      const coldT = await timed(() =>
        metadataService.getMetadata(hash, { name: rom.displayName }),
      );
      const meta = coldT.value;
      if (coldT.elapsedMs > PERF_BUDGETS.metadataColdMs) {
        warnings.push(
          `metadata-cold over budget for "${keyword}": ${Math.round(
            coldT.elapsedMs,
          )}ms > ${String(PERF_BUDGETS.metadataColdMs)}ms`,
        );
      }
      if (meta === null || meta.source === 'none') {
        console.log(`  ✗ no metadata match  (${Math.round(coldT.elapsedMs)}ms)`);
        continue;
      }
      matched += 1;
      console.log(
        `  source      ${meta.source}  (${Math.round(coldT.elapsedMs)}ms cold)`,
      );
      console.log(`  name        ${meta.name}`);
      console.log(`  year        ${meta.year === null ? '—' : String(meta.year)}`);
      if (meta.criticScore !== null) {
        console.log(`  score       ${String(meta.criticScore)}/100`);
      }
      console.log(`  box art     ${meta.boxArtUrl ?? '—'}`);

      // Warm metadata fetch should be a disk read.
      const warmT = await timed(() => metadataService.getMetadata(hash));
      if (warmT.elapsedMs > PERF_BUDGETS.metadataWarmMs) {
        warnings.push(
          `metadata-warm over budget for "${keyword}": ${Math.round(
            warmT.elapsedMs,
          )}ms > ${String(PERF_BUDGETS.metadataWarmMs)}ms`,
        );
      }

      if (meta.boxArtUrl !== null) {
        const imgT = await timed(() => imageCache.fetch(meta.boxArtUrl ?? ''));
        if (imgT.value !== null) {
          boxArtDownloaded += 1;
          console.log(
            `  box art→    ${imgT.value}  (${Math.round(imgT.elapsedMs)}ms cold)`,
          );
          if (imgT.elapsedMs > PERF_BUDGETS.imageColdMs) {
            warnings.push(
              `image-cold over budget for "${keyword}": ${Math.round(
                imgT.elapsedMs,
              )}ms > ${String(PERF_BUDGETS.imageColdMs)}ms`,
            );
          }
          // Warm cache hit.
          const imgWarmT = await timed(() => imageCache.fetch(meta.boxArtUrl ?? ''));
          if (imgWarmT.elapsedMs > PERF_BUDGETS.imageWarmMs) {
            warnings.push(
              `image-warm over budget for "${keyword}": ${Math.round(
                imgWarmT.elapsedMs,
              )}ms > ${String(PERF_BUDGETS.imageWarmMs)}ms`,
            );
          }
        } else {
          console.log(`  ✗ box art download failed`);
        }
      }
    }

    console.log(
      `\n✓ Summary: ${String(hashed)} hashed · ${String(matched)} matched · ${String(
        boxArtDownloaded,
      )} box art downloaded`,
    );

    if (warnings.length > 0) {
      console.log(`\n⚠ Perf budget warnings (${String(warnings.length)}):`);
      for (const w of warnings) console.log(`  - ${w}`);
    }

    await client.disconnect();
    console.log('\n✓ Done.');
  } catch (err) {
    printError(err);
    await safeDisconnect(client);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  printError(err);
  process.exit(1);
});
