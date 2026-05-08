#!/usr/bin/env tsx
/**
 * End-to-end metadata pipeline check against a real MiSTer.
 *
 * Round 3: pivoted to OpenVGDB + libretro-thumbnails. No credentials
 * needed — first run downloads the OpenVGDB SQLite (~50MB) once.
 *
 * What it does:
 *   1. Ensure the OpenVGDB database is downloaded (with progress).
 *   2. Connect to the MiSTer.
 *   3. Walk the library, pick 5–10 well-known cartridge ROMs across
 *      multiple systems.
 *   4. For each: md5 → OpenVGDB lookup → libretro thumbnail URL →
 *      verify the box-art URL resolves (HEAD request).
 *   5. Print a summary.
 *
 * Usage:
 *   MISTER_HOST=192.168.50.194 MISTER_PASSWORD=1 npm run test:metadata
 *
 * Required env (MiSTer SSH):
 *   MISTER_HOST, MISTER_PASSWORD
 *
 * Optional env:
 *   MISTER_PORT (22), MISTER_USER (root)
 *   METADATA_TEST_DIR=/tmp/x — override the cache root (default: a
 *     persistent dir under tmp so subsequent runs reuse the DB).
 *
 * The DB lives in `<cacheDir>/openvgdb.sqlite`. Delete it to force a
 * redownload.
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMisterClient } from '@app/main/clients';
import { HashService } from '@app/main/metadata/hash-service';
import { ImageCache } from '@app/main/metadata/image-cache';
import { LibretroThumbnailsFetcher } from '@app/main/metadata/libretro-thumbnails';
import { MetadataService } from '@app/main/metadata/metadata-service';
import { OpenVGDBService } from '@app/main/metadata/openvgdb-service';
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
  metadataColdMs: 200, // local SQLite + URL building only
  metadataWarmMs: 50,
  imageColdMs: 5000,
  imageWarmMs: 50,
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
  // ROMs (NES/SNES cartridges) live. Disc folders are out of scope
  // for v0 hashing.
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

interface ArtProbe {
  readonly status: number | null; // null on network failure
  readonly bytes: number | null; // from Content-Length, when present
}

/**
 * HEAD-probe a libretro-thumbnails URL to learn whether the asset
 * exists. Returns the raw HTTP status and (when supplied) the
 * `Content-Length` so callers can print "200 / 38 KB" lines.
 */
async function probeArtUrl(url: string): Promise<ArtProbe> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    const lenHeader = res.headers.get('content-length');
    const len = lenHeader === null ? null : Number.parseInt(lenHeader, 10);
    const bytes = len !== null && Number.isFinite(len) ? len : null;
    return { status: res.status, bytes };
  } catch {
    return { status: null, bytes: null };
  }
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '?';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

  // Default to a stable subfolder under tmpdir so re-runs reuse the
  // ~50MB OpenVGDB download. METADATA_TEST_DIR overrides if you want
  // a clean run.
  const cacheDir =
    process.env['METADATA_TEST_DIR'] ?? join(tmpdir(), 'mister-curator-metadata-test');
  await fs.mkdir(cacheDir, { recursive: true });

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

  const client = createMisterClient('real');
  const hashService = new HashService(cacheDir);
  const openVgdb = new OpenVGDBService(cacheDir);
  const thumbnails = new LibretroThumbnailsFetcher();
  const metadataService = new MetadataService(cacheDir, openVgdb, thumbnails);
  const imageCache = new ImageCache(join(cacheDir, 'images'));

  const warnings: string[] = [];

  try {
    // ── Step 1: ensure OpenVGDB ─────────────────────────────────────
    console.log('• OpenVGDB:');
    const dbT = await timed(async () => {
      await openVgdb.ensureDatabase((event) => {
        if (event.kind === 'started') {
          console.log('  starting download…');
        } else if (event.kind === 'downloading') {
          const pct =
            event.bytesTotal !== null && event.bytesTotal > 0
              ? `${Math.round((event.bytesReceived / event.bytesTotal) * 100)}%`
              : `${Math.round(event.bytesReceived / 1024)} KB`;
          // Single line; carriage return so it ticks in place.
          process.stdout.write(`  downloading… ${pct}\r`);
        } else if (event.kind === 'ready') {
          process.stdout.write('\n');
          console.log(`  ready: ${event.path}`);
        } else if (event.kind === 'error') {
          process.stdout.write('\n');
          console.warn(`  error: ${event.message}`);
        }
      });
    });
    console.log(`  ensure: ${Math.round(dbT.elapsedMs)}ms`);
    if (!openVgdb.isReady()) {
      console.error('\n✗ OpenVGDB is not ready — abort.');
      process.exit(1);
    }
    console.log('');

    // ── Step 2: connect ─────────────────────────────────────────────
    const connectT = await timed(() => client.connect(profile, secret));
    console.log(`✓ connect()  ${Math.round(connectT.elapsedMs)}ms`);

    // ── Step 3: pick target ROMs ────────────────────────────────────
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
    let boxArtVerified = 0;
    let boxArtDownloaded = 0;

    for (const { rom, keyword } of picked) {
      console.log(`\n— ${rom.filename}`);
      void keyword;

      // Hash.
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

      // Metadata lookup (cold).
      const coldT = await timed(() => metadataService.getMetadata(hash));
      const meta = coldT.value;
      if (coldT.elapsedMs > PERF_BUDGETS.metadataColdMs) {
        warnings.push(
          `metadata-cold over budget for ${rom.filename}: ${Math.round(
            coldT.elapsedMs,
          )}ms > ${String(PERF_BUDGETS.metadataColdMs)}ms`,
        );
      }
      if (meta === null || meta.source === 'none') {
        console.log(`  ✗ no OpenVGDB match  (${Math.round(coldT.elapsedMs)}ms)`);
        continue;
      }
      matched += 1;
      console.log(
        `  source      ${meta.source}  (${Math.round(coldT.elapsedMs)}ms cold)`,
      );
      console.log(`  name        ${meta.name}`);
      console.log(`  system      ${meta.system}`);
      console.log(`  year        ${meta.year === null ? '—' : String(meta.year)}`);
      console.log(`  genre       ${meta.genre ?? '—'}`);
      console.log(`  publisher   ${meta.publisher ?? '—'}`);

      // Warm metadata fetch should be a cache hit.
      const warmT = await timed(() => metadataService.getMetadata(hash));
      if (warmT.elapsedMs > PERF_BUDGETS.metadataWarmMs) {
        warnings.push(
          `metadata-warm over budget for ${rom.filename}: ${Math.round(
            warmT.elapsedMs,
          )}ms > ${String(PERF_BUDGETS.metadataWarmMs)}ms`,
        );
      }

      // Box art:
      //   - URL null  → log the system name so we know which mapping
      //     to add to the libretro map next round.
      //   - HEAD 200  → cache the bytes locally too (round 7 spec).
      //   - HEAD 4xx  → log the status + URL; libretro coverage is
      //     known to be sparse for some systems.
      if (meta.boxArtUrl !== null) {
        const probe = await probeArtUrl(meta.boxArtUrl);
        if (probe.status === 200) {
          boxArtVerified += 1;
          console.log(
            `  box art ✓   ${meta.boxArtUrl} (${formatBytes(probe.bytes)})`,
          );
          const imgT = await timed(() => imageCache.fetch(meta.boxArtUrl ?? ''));
          if (imgT.value !== null) {
            boxArtDownloaded += 1;
            console.log(
              `  box art→    ${imgT.value}  (${Math.round(imgT.elapsedMs)}ms cold)`,
            );
            if (imgT.elapsedMs > PERF_BUDGETS.imageColdMs) {
              warnings.push(
                `image-cold over budget for ${rom.filename}: ${Math.round(
                  imgT.elapsedMs,
                )}ms > ${String(PERF_BUDGETS.imageColdMs)}ms`,
              );
            }
            const imgWarmT = await timed(() =>
              imageCache.fetch(meta.boxArtUrl ?? ''),
            );
            if (imgWarmT.elapsedMs > PERF_BUDGETS.imageWarmMs) {
              warnings.push(
                `image-warm over budget for ${rom.filename}: ${Math.round(
                  imgWarmT.elapsedMs,
                )}ms > ${String(PERF_BUDGETS.imageWarmMs)}ms`,
              );
            }
          } else {
            console.log(`  box art ✗   download failed after HEAD 200`);
          }
        } else if (probe.status === null) {
          console.log(
            `  box art ✗   network error  ${meta.boxArtUrl}`,
          );
        } else {
          console.log(
            `  box art ✗   ${String(probe.status)} ${meta.boxArtUrl}`,
          );
        }
      } else {
        console.log(
          `  box art —   (system '${meta.system}' not in libretro map)`,
        );
      }
    }

    console.log(
      `\n✓ Summary: ${String(hashed)} hashed · ${String(matched)} matched in OpenVGDB · ` +
        `${String(boxArtVerified)} box art URLs valid · ${String(boxArtDownloaded)} box art downloaded`,
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
