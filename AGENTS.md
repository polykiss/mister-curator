# AGENTS.md

Guidance for AI coding agents (Claude Code, etc.) working in this repo.
Read this file at the start of every session.

## What this project is

**MiSTerCurator** — a cross-platform desktop app that connects to a
MiSTer FPGA over SSH and lets users curate their ROM collection: audit
their library, toggle visibility of individual ROMs and whole cores,
manage saves, and more — without touching the MiSTer directly.

The user's MiSTer is treated as a remote filesystem. The only persistent
state the app writes is a small JSON ledger under
`/media/fat/.mistercurator/`. No code is permanently installed.

## Core architectural principle: remote-only

The MiSTer is accessed exclusively via SSH and SFTP. No code is permanently
installed on the device. Helper scripts in `agent/` are copied to
`/tmp/mistercurator/` on demand, executed, and may be left there for the
session but must never be assumed to persist.

The app persists a handful of small JSON state files under
`/media/fat/.mistercurator/` (the hide ledger, user-marked system
files, per-folder classification overrides). The directory is reserved
for this app; aside from these files and the renames that implement
hide/show, nothing is written outside of `/tmp/mistercurator/`.

The app must work correctly against a freshly-flashed MiSTer with default
settings. If you're tempted to add a "first run setup on the MiSTer"
step — don't. Find another way.

## Stack (locked in — do not propose alternatives)

- **Electron** — desktop shell
- **React + TypeScript** — UI
- **Vite** (via `electron-vite`) — build tool
- **Tailwind CSS** + **shadcn/ui** — styling and components
- **node-ssh** — SSH and SFTP client
- **Python 3 (stdlib only)** — on-device agent scripts; no pip installs
- **Vitest** — unit tests
- **electron-builder** — packaging and releases

Do not add: Redux, Zustand, MobX, Next.js, an ORM, Docker, a database,
or any other state/data library without explicit approval. Use React's
built-in `useState` and `useContext` until proven insufficient.

## Repository structure
/app — Electron app source
	/app/main — Electron main process (Node)
	/app/preload — Preload scripts (IPC bridge)
	/app/renderer — React UI (browser context)
/agent — Python scripts that run on the MiSTer via SSH
/shared — TypeScript types and constants used by main + renderer
/fixtures — Sample data for offline development and tests
/docs — Architecture notes, decisions, runbooks

`shared/types.ts` is the source of truth for cross-cutting data shapes
(`MisterProfile`, `Core`, `Rom`, `ConnectionStatus`, `AuditResult`, etc.).
Update it before changing consumers.

## Always do

- **Mock the SSH layer.** All MiSTer access goes through an `IMisterClient`
  interface. A `FakeMisterClient` reads from `fixtures/`. UI code never
  imports `node-ssh` directly.
- **Batch SSH operations.** Hiding 47 files is one SSH call running one
  shell command, never 47 calls. Same for any bulk operation.
- **Cache directory listings in memory.** Re-fetch on explicit refresh or
  after a write operation, not on every render.
- **Type everything.** No `any`. If a type is genuinely unknown, use
  `unknown` and narrow.
- **Write a Vitest unit test for any non-trivial pure function** (path
  parsing, DAT matching, name normalization, etc.). Skip tests for thin
  UI glue and SSH calls — those get manual smoke tests.
- **Surface errors clearly.** "Could not find /media/fat/games/ — is this
  a MiSTer?" not a stack trace. Every SSH failure gets a user-facing
  message with a suggested next step.
- **Use the agent script versioning convention.** Every Python script in
  `agent/` has a `VERSION = "x.y.z"` constant at the top. The app checks
  the deployed version on connect and re-deploys if missing or stale.
- **Prefer renaming over moving or deleting.** ROM visibility uses dot-
  prefix renames (`game.sfc` ↔ `.game.sfc`). Never delete user files.

## Never do

- Never install anything persistent on the MiSTer (no apt, no pip, no
  files outside `/tmp/mistercurator/` and `/media/fat/.mistercurator/`).
- Never delete a user's ROM, save, config, or BIOS file. Hide via rename;
  that's it.
- Never make assumptions about the MiSTer's filesystem layout beyond
  the documented defaults. If a path might vary, detect and report.
- Never store SSH passwords or private keys in plaintext config. Use
  Electron's `safeStorage` API for secrets.
- Never put SSH credentials, MiSTer IPs, or fixture data containing
  real user info in commits. `.gitignore` covers `config.json` and
  `*.local.*` already — keep it that way.
- Never ship a feature that mutates the MiSTer without a clear undo path
  or a dry-run preview.
- Never use synchronous `fs` calls in the main process. Async only.

## Naming and identifiers

- Product name (UI, marketing, docs): **MiSTerCurator**
- Repo / package / binary: `mister-curator`
- App data folder: resolved via Electron's `app.getPath('userData')` —
  yields `MiSTerCurator/` on each platform automatically
- App-local cache directory: `<userData>/cache/<host>/` (PR #12). One
  subdirectory per MiSTer host. Holds:
  - `cores.json` — last `listAllCoresWithFiles` result + the on-device
    mtime witnesses used to validate it on next connect.
  - `roms/<coreId>.json` — last `listRoms` result(s) per core, keyed
    internally by `subPath`. LRU-evicted at 100 files per host.

  Cold-connect-then-warm-reconnect benchmark on a real MiSTer goes
  from ~7s → ~500ms once the cache is populated. The cache layer
  validates with one-shot `stat` calls on the device — no on-device
  writes for cache management, no agent code. Safe to delete the
  directory at any time; next connect rebuilds it. Known staleness
  caveat: a ROM file added inside an existing core's games dir via
  SFTP doesn't bump the cores-list witnesses (the parent `games/`
  mtime only changes on top-level renames), so the cores-list
  romCount can read stale until Refresh. Drilling into the affected
  core picks up the change correctly via the listRoms cache.
- App-local metadata directory: `<userData>/metadata/` (PR #15).
  Holds the ROM-hash + metadata + image caches that drive the box-art
  / scoring UI in PR #16/#17. No on-device writes, no agent code;
  safe to delete at any time.

  Source-priority chain (PR #16 round 2):
    1. **ScreenScraper** (when credentialed) — the richest source.
    2. **OpenVGDB + libretro-thumbnails** — credential-free fallback.
    3. **`'none'` sentinel** — 30-day TTL on records neither matched.

  - **ScreenScraper** — `https://api.screenscraper.fr/api2/jeuInfos.php`.
    Multi-hash query (md5 + sha1 + crc + romnom + romtaille). Adds
    fields OpenVGDB doesn't carry: descriptions, developer, ratings,
    players, multiple art types. Required env vars:
    - `SCREENSCRAPER_DEV_ID` — developer credential ID.
    - `SCREENSCRAPER_DEV_PASSWORD` — developer credential password.

    Optional env vars (unlock the higher member-tier quota):
    - `SCREENSCRAPER_SSID` — user account ID.
    - `SCREENSCRAPER_SSPASSWORD` — user account password.

    Without dev creds the service stays `unavailable` and
    MetadataService silently falls through to OpenVGDB+libretro.
    Credentials never go in committed source — `.env.local` is
    gitignored (see `.gitignore` for the full env-pattern).
  - **OpenVGDB** — a SQLite snapshot (~50 MB) of the
    https://github.com/OpenVGDB/OpenVGDB index, downloaded once on
    first use. Maps md5 → name + system + year + genre + publisher
    + developer + region. Distributed under the OpenVGDB project's
    license; check `LICENSE` in that repo for the canonical terms.
    Source: GitHub Releases (queried via the public unauthenticated
    API at `https://api.github.com/repos/OpenVGDB/OpenVGDB/releases/latest`).
    The release ships the SQLite inside a `.zip`; we extract it on
    download with `jszip`. The release tag is recorded in
    `openvgdb.version.json` next to the SQLite — once both files are
    on disk and the schema is valid, subsequent calls skip the
    network entirely. Manual delete of either file forces a re-fetch.
  - **libretro-thumbnails** — community-curated PNG archive at
    https://thumbnails.libretro.com/, organized per system. URL
    builder lives in `app/main/metadata/libretro-thumbnails.ts`;
    the system-name → directory map covers cartridge consoles
    (NES / SNES / Genesis / Game Boy family / Atari / NEC PC
    Engine / SNK Neo Geo / Vectrex / etc). Some MiSTer cores have
    no libretro-thumbnails counterpart (X68000, DOS, Apogee, …) —
    those return null from the builder. Image archive usage
    follows the same conventions as RetroArch's own access.

  Layout:
  - `<host>/hashes.json` — md5 of every hashed ROM file, mtime-keyed.
    File-only (kind: 'file') ROMs in v0; folder-atomic / folder-
    container hashing (Saturn, MegaCD, X68000) is deferred — those
    sources index disc images by hash inconsistently and need a
    separate strategy.

    For `.zip`-wrapped ROMs (case-insensitive), HashService hashes
    the EXTRACTED inner content (`unzip -p <zip> | md5sum` on the
    device), not the wrapper bytes — OpenVGDB indexes inner-file
    hashes. mtime stays on the wrapper, so cache invalidation
    follows the user's actions on the visible file. Limitation:
    multi-file zips concatenate into a single hash that won't match
    OpenVGDB and surface as "no match" cleanly. Other archive
    formats (`.7z`, `.gz`, `.rar`) fall through to direct md5sum
    and won't match OpenVGDB but won't error.
  - `openvgdb.sqlite` — the downloaded SQLite snapshot.
  - `by-hash/<XX>/<hash>.json` — RomMetadata records (matched OR a
    `source: 'none'` sentinel cached for 30 days). Sharded by hash
    prefix to keep one directory from hitting millions of files.
    Schema is `version: 4` (PR #16 round 2 added SS-only fields:
    players, rating, releaseDate; `source` carries 'screenscraper'
    | 'openvgdb' | 'none'). Older versions fail the parse guard and
    get silently rewritten on the next lookup — no migration step.
  - `images/<XX>/<sha1>.bin` — full-size box art / screenshots.

  PR #15 + #16 ship the foundation; no UI consumes it yet (PR #17).
  Without ScreenScraper creds the OpenVGDB+libretro fallback runs
  unchanged. Disable any source by deleting the relevant cache
  files / unsetting the env vars; reset everything by `rm -rf`-ing
  `<userData>/metadata/`.

  Verification tool: `npm run test:metadata`. Without SS env vars
  it exercises the OpenVGDB+libretro path (no credentials required;
  first run downloads the OpenVGDB SQLite once). With SS env vars
  set it exercises the SS-primary path and prints `source: …` per
  ROM.
- On-MiSTer agent directory: `/tmp/mistercurator/`
- On-MiSTer state directory: `/media/fat/.mistercurator/` — holds the
  small JSON state files the app persists across sessions:
  - `state.json` — hide ledger (which cores the app hid). Used solely
    to scope the "Unhide all" bulk-target list so a one-click revert
    can't sweep up dot-prefixed system folders the firmware placed.
    Single-core hide / show ops do NOT consult it; the user can
    hide or unhide any core in the list directly.
  - `system-files.json` — user-marked system files (`(coreId, filename)` pairs)
  - `folder-classifications.json` — per-folder container/atomic overrides

  All small, all our domain. Add new state files here as the app grows.
- Bundle identifier (for code signing): TBD at packaging time

## Conventions

- **Naming:** `camelCase` for variables and functions, `PascalCase` for
  components and types, `kebab-case` for filenames except React
  components which are `PascalCase.tsx`.
- **Imports:** absolute imports from `@app/`, `@shared/`, `@agent-types/`
  configured in `tsconfig.json`. No deep relative paths like `../../../`.
- **Commits:** conventional commits (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `test:`).
- **Branches:** `feat/<short-name>`, `fix/<short-name>`. One issue per
  branch per PR.
- **PRs:** include a brief "what changed and why," a "how I tested it"
  section, and screenshots for any UI change.

## How to work on this repo

1. Read the linked GitHub issue. If acceptance criteria are unclear,
   ask before coding.
2. Check `docs/architecture.md` for relevant context.
3. Make changes on a feature branch.
4. Run `npm run typecheck`, `npm run lint`, `npm test` before pushing.
5. Open a PR against `main`.

If a task seems to require violating a rule in this file, stop and
flag it in the PR description. Don't quietly work around it.

## Definition of done for any feature

- TypeScript compiles with no errors and no `any`.
- Lint passes.
- Unit tests pass; new pure functions have tests.
- Manual smoke test: feature works against `FakeMisterClient`.
- Manual smoke test: feature works against a real MiSTer (when applicable).
- Errors have user-facing messages, not stack traces.
- README or `docs/` updated if user-facing behavior changed.

## Out of scope for MVP (do not build until asked)

- Audit engine, DAT file matching
- Favorites, playlists, collections
- Save state or NVRAM backup
- Cheat file management
- MRA / arcade-specific handling
- Multi-MiSTer sync
- Auto-updates

ROM hashing and metadata scraping (box art, scoring) are now in
scope as of PR #15 — the foundation lives in `app/main/metadata/`,
no UI yet. Treat the four services there as stable; new metadata
work composes against `MetadataOrchestrator`. The full UI
(view-mode toggle, grid view, detail modal) lands in PR #16/#17.

Everything else listed above remains roadmap-but-not-MVP. Stay
focused.
