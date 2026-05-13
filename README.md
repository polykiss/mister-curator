# MiSTerCurator

> A desktop curation tool for your MiSTer FPGA ROM collection.

![MiSTerCurator screenshot](screenshots/hero.png)

**Status:** Public beta (`v0.1.0-beta.1`). macOS, Linux, and Windows.

## Why

Large MiSTer collections accumulate fast — full No-Intro sets, MAME romsets, regional dumps, hacks, demos, doubles. Browsing through them on the device is slow, deleting is permanent, and most curation tools work in the opposite direction (pulling files off the device).

MiSTerCurator runs on your desktop and curates a collection that lives on your MiSTer over SSH. Hiding a ROM renames it with a leading dot (`Sonic.md` → `.Sonic.md`); MiSTer's menu doesn't show dot-prefixed files, so the entry disappears from the device UI. The file stays on disk and unhide reverses the rename — fully reversible, no data loss.

The same hide pattern handles arcade `.mra` files. The app reads each `.mra`'s required ROM zip list, checks which zips are actually installed on the device, and can auto-hide entries whose ROMs aren't there — so the arcade menu only shows what you can actually play.

## Features

### Connection

- SSH password / private-key authentication
- Per-host caching (cores, ROM lists, arcade entries, playability) — warm reconnects skip the cold-walk
- Automatic reconnect with a token-cancellation pattern so a manual reconnect always wins over an in-flight retry
- Mid-session disconnect detection with a documented backoff schedule

### Cores & ROMs

- Per-core ROM browser, filterable by visibility and system-file status
- ScreenScraper metadata for each ROM (box art, year, genre, rating, players, description, tags)
- Hide / unhide individual ROMs or whole cores via dot-prefix rename
- Density bars showing each ROM's size against the peer max for the visible row set
- Sortable columns: Name / Year / Genre / Rating
- Folder-as-ROM detection — multi-file games (`.cue` + `.bin`, multi-disk titles) presented as a single row with one box art
- System-file detection — BIOS / config / palette files auto-marked and hidden from the default view

### Arcade

- Full UX parity with the cores pane
- `.mra` playability scan classifies every entry as **playable**, **missing-ROMs**, or **no-ROMs-needed** (TTL / discrete-logic games)
- "Auto-hide missing ROMs" toggle (default ON, per host) — flips missing-ROM `.mra` files to dot-prefixed names so the arcade menu shows only what you can play
- Sortable headers + subfolder drill with breadcrumb navigation
- MAME / HBMame hidden from the cores sidebar by default — they're surfaced as a single synthetic "Arcade" row instead, with the option to show them separately

### Detail dialog

- Multi-image gallery: box art, title screen, screenshots (N), 3D box, marquee, clear logo
- Click any thumbnail to swap the primary image
- Fullscreen lightbox with prev / next arrow navigation + keyboard arrow keys + Esc / backdrop close
- Two-column responsive layout: art + thumbnails + provenance on the left, stats + synopsis + tags on the right
- Sticky header (with ROM-position navigation) + sticky footer (action buttons)
- Click-through Previous / Next ROM navigation — power-curation flow that advances over the same filter + sort order the row view uses, with a "12 of 87" position indicator
- Hide / Unhide button with auto-advance — hides the current entry, advances to the next, surfaces a toast on SSH failure
- Re-renders cleanly when the user navigates: image, lightbox state, and gallery selection all reset

### ScreenScraper

- Auto-scrape on connect — every core walked, every ROM hashed (MD5), every hash looked up against ScreenScraper's `jeuInfos` endpoint
- Name-search fallback for files SS doesn't recognize by hash (the most common case for MAME romsets and regional dumps)
- 30+ mapped systems: Nintendo NES / SNES / GB / GBC / GBA / N64 / VirtualBoy, Sega Genesis / SMS / Game Gear / 32X / CD / Saturn / SG1000, Atari 2600 / 5200 / 7800 / Lynx, NEC TurboGrafx-16 / CD, SNK NeoGeo / NGP / NGPC, Sony PSX, Commodore 64 / Amiga, Atari ST, Acorn BBC Micro, Amstrad CPC, Sharp X68000, Apple-II, and more (full list in `app/main/metadata/screenscraper-system-map.ts`)
- Manual search dialog for entries SS misses automatically — pick the right match, the metadata binds
- User metadata overrides for hand-fixed entries; box-art / title / genre / etc. overrides keyed on the primary zip's MD5 propagate automatically to clones sharing that zip
- Special path-keyed override store for no-ROMs-needed arcade entries (no zip → no hash → can't share the by-hash store)

## Installation

### Download

Pre-built releases for macOS, Linux, and Windows live on the [Releases page](https://github.com/polykiss/mister-curator/releases). The current beta is [`v0.1.0-beta.1`](https://github.com/polykiss/mister-curator/releases/tag/v0.1.0-beta.1).

> **macOS:** the build is currently unsigned. On first launch macOS will block it; right-click the app → Open to bypass the Gatekeeper prompt.

### Build from source

```sh
git clone https://github.com/polykiss/mister-curator
cd mister-curator
npm install
npm run dev
```

**Prerequisites:** Node.js 20+. Tested on macOS (Apple Silicon and Intel), Linux, and Windows.

To build a production bundle:

```sh
npm run build
```

## Quick Start

1. Launch the app.
2. Click **Connect**, enter your MiSTer's host / IP and SSH credentials (password or private key).
3. Set ScreenScraper credentials so metadata can populate — see [Configuration](#configuration) below.
4. Wait for the initial auto-scrape. The first connect to a new MiSTer walks every core and hashes every ROM, which can take several minutes for a full collection; subsequent connects use the cache and warm up in seconds.
5. Browse, sort, hide what you don't want. Click a ROM row to open the detail dialog; use Previous / Next inside the dialog to step through entries quickly.

![Detail dialog](screenshots/detail-dialog.png)

## Configuration

### ScreenScraper credentials

ScreenScraper credentials are required for metadata. Register at [screenscraper.fr](https://www.screenscraper.fr), then provide them via environment variables before launching the app:

```sh
export SCREENSCRAPER_DEV_ID="your-dev-id"
export SCREENSCRAPER_DEV_PASSWORD="your-dev-password"
```

Optional member credentials (`SCREENSCRAPER_SSID` / `SCREENSCRAPER_SSPASSWORD`) unlock the higher member-tier quota; without them you get the public quota.

Without dev credentials, metadata falls through to the bundled OpenVGDB + libretro-thumbnails sources, which cover the major Nintendo / Sega / Atari systems but lack the depth (regional metadata, MAME, arcade) of ScreenScraper.

### Cache locations

User data lives under your platform's app-data directory:

- **macOS:** `~/Library/Application Support/mister-curator/`
- **Linux:** `~/.config/mister-curator/`
- **Windows:** `%APPDATA%/mister-curator/`

Subdirectories:

| Path                              | Contents                                                |
| --------------------------------- | ------------------------------------------------------- |
| `mister-cache/<host>/`            | Per-host cores, arcade entries, ROM metadata snapshots  |
| `metadata/by-hash/`               | Content-addressed metadata cache (shared across hosts)  |
| `metadata/<host>/hashes.json`     | File-hash cache (path → md5)                            |
| `scrape-state/<host>/`            | Auto-scrape progress + completed-cores set              |
| `profiles.json` / `secrets.json`  | Saved hosts + credentials                               |

Wipe `metadata/` to force a full re-scrape; wipe `mister-cache/` to force a full re-walk on next connect.

### Settings

Persisted per host or per session, surfaced as toggles in the UI:

- **Show MAME / HBMame as separate cores** (cores pane, default OFF) — when off, MAME and HBMame are folded into the synthetic "Arcade" sidebar row.
- **Auto-hide missing ROMs** (arcade pane, default ON, per-host) — dot-prefixes every `.mra` whose required ROM zips aren't installed on the device.
- **Show hidden** (per pane) — surfaces dot-prefixed entries so you can review / unhide.

## How It Works

### Hide mechanism

ROMs and `.mra` files are hidden by renaming them on the device with a leading dot (`Sonic.md` → `.Sonic.md`). MiSTer's firmware menu skips dot-prefixed files. The file stays on disk, unhide reverses the rename. Bulk operations chain renames in a single SSH session; per-row toggles are optimistic on the renderer side and revert with a toast if the SSH `mv` fails.

The set of cores you've hidden via the app is tracked in an on-device ledger (`.mistercurator/hide-ledger.json`) so the "Unhide all" button can restore exactly what the app hid, never touching dot-prefixed entries placed there by the firmware or by your previous tooling.

### Auto-scrape

On connect, the auto-scrape engine walks every core in sidebar order, calling `listRomPaths` to enumerate each core's ROM directory and `getRomsMetadata` to hash each file and look up metadata. Hashes use streaming MD5 over SSH (`md5sum`), with the result cached to `metadata/<host>/hashes.json`. ScreenScraper's `jeuInfos` endpoint resolves the hash to a record; when the hash misses, a name-search fallback uses the filename (with parenthesized region / version tags stripped) as a hint.

Once a core completes a full pass, its identifier persists to `scrape-state/<host>/scrape-state.json` with a timestamp. Reconnects within the freshness window skip those cores. The user can pivot the queue at any time by clicking a core in the sidebar — the engine pauses the current core, advances to the focused one, and resumes the queue from there. Manual Refresh or a re-click of an already-completed core clears its completion mark and re-runs it.

### Arcade

`.mra` files are XML manifests pointing at one or more ROM zips (`<rom>` elements with `index="0"` for the primary zip and additional zips for samples / extras). The arcade pane parses every `.mra`, builds the set of referenced zips, intersects with the actual `games/mame/` + `games/hbmame/` zip listings, and classifies each `.mra`:

- **`playable`** — every required zip is installed
- **`missing`** — at least one required zip is not on the device; the `.mra` is auto-hidden when the per-host auto-hide rule is on
- **`no-ROMs-needed`** — TTL / discrete-logic games that need no ROM data; playable directly from the FPGA core

Metadata for playable `.mra` entries is cached by the primary zip's MD5, so `.mra` clones (different region or hack of the same arcade game) sharing a zip share metadata — bind one, the rest update automatically. For no-ROMs-needed entries there's no zip to hash, so metadata is stored in a parallel path-keyed override store.

### Architecture

- **Stack:** Electron + React + TypeScript + Vite
- **SSH:** [node-ssh](https://github.com/steelbrain/node-ssh) for device operations
- **UI:** [shadcn/ui](https://ui.shadcn.com) primitives, Tailwind CSS, [Lucide](https://lucide.dev) icons
- **State:** React contexts (ConnectionContext, CoresContext) — no global state library
- **Tests:** Vitest, ~2,200 tests covering connection lifecycle, metadata orchestration, arcade parsing, UI structural contracts

The main process owns SSH, file caching, and metadata orchestration; the renderer is pure UI. IPC types are shared at `shared/preload-api.ts` so wire shapes are typecheck-enforced on both ends. The renderer never touches the device or disk directly.

Deeper notes live in [docs/architecture.md](docs/architecture.md).

## Known Limitations

This is a beta. Caveats:

- **macOS first-launch:** the build is unsigned; right-click → Open or run `xattr -d com.apple.quarantine MiSTerCurator.app` to bypass the Gatekeeper prompt.
- **First connect is slow on large collections.** A full No-Intro + arcade collection can take several minutes on a cold connect (every file gets hashed). Subsequent connects warm from cache and complete in seconds.
- **ScreenScraper rate limits.** The free tier has a per-day quota; very large collections may hit it on the first pass. The auto-scrape engine retries and the cache picks up where it left off on the next session.
- **Atari7800 / Gameboy2P matcher.** Pre-existing hidden-game directories on the device (created by other tools) aren't always picked up by the matcher; the entries show up as un-named on the first pass and re-bind correctly after a manual Refresh.
- **Connect is synchronous in the UI.** The full cores + arcade walk runs before the UI flips to the "connected" state. For very slow networks this can feel like the app is hung; the v0.2 plan flips this to async.
- **No incremental scraping** — the auto-scrape engine always walks the full queue. Cores you've touched recently are skipped via the persisted completion set, but you can't say "scrape only this core right now".
- **No cancel for in-flight SSH ops** — switching cores during a heavy SSH op (a 600-ROM SNES walk) waits for the current op to finish before pivoting.

## Roadmap

**v0.2 (next):**

- Core-level metadata (system image, year, manual edit form)
- Settings pane consolidation
- Async connect — flip to "connected" after the SSH handshake; defer scans to background
- Folder-as-ROM wrapper hashing for multi-disc / multi-floppy titles
- Strict playability mode for arcade
- Cancellable prefetch on core switch
- Better empty-state UX during first connection

**Further out:**

- Sets / profiles for multiple curation states (default, modern, fighters, favorites, etc.)
- Multi-image system / core metadata
- Performance: parallel SSH ops, incremental scrapes
- Atari7800 + Gameboy2P matcher fixes for pre-existing hidden directories

## Contributing

- Issues welcome at [github.com/polykiss/mister-curator/issues](https://github.com/polykiss/mister-curator/issues) — please include the OS, MiSTer firmware version, and (if possible) the cores / ROMs that trigger the issue.
- PRs welcome. A short description of motivation + the manual smoke test you ran is enough; CI runs `npm run typecheck` and `npm run test` on push.
- Smoke testing against a real MiSTer is documented in [docs/smoke-testing.md](docs/smoke-testing.md).
- Architecture notes in [docs/architecture.md](docs/architecture.md).

## Credits

- [ScreenScraper.fr](https://www.screenscraper.fr) — game metadata + art
- [shadcn/ui](https://ui.shadcn.com) — component primitives
- [Lucide](https://lucide.dev) — icons
- [MiSTer FPGA project](https://misterfpga.org) — the device this whole thing is built around
- Built with [Claude](https://claude.ai) as technical guide

## License

MIT — see [LICENSE](LICENSE).
