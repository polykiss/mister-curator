# Matcher diagnostics

A read-only structured report of every decision the cores matcher
makes against a real MiSTer. Built for PR #11: before changing
matcher logic again, we want a baseline of what the matcher actually
sees on the user's device — phantom duplicate cores, missing
`_Console (autoboot)/`, mystery folder counts on `Vectrex` /
`X68000`, and the rest of the bug list — captured as a JSON
document we can grep, diff, and reason about.

## Running the CLI

```sh
MISTER_HOST=192.168.1.42 MISTER_PASSWORD=hunter2 npm run diag:real
```

Same env-var convention as `npm run smoke:real`:

| Variable | Required | Default | Notes |
| -------- | -------- | ------- | ----- |
| `MISTER_HOST`     | yes | — | Hostname or IP of the MiSTer. |
| `MISTER_PASSWORD` | yes | — | SSH password. Use `MISTER_USER=user MISTER_PASSWORD=...` from a `.env.local` to keep it out of shell history. |
| `MISTER_USER`     | no  | `root` | SSH username. |
| `MISTER_PORT`     | no  | `22`   | SSH port. |

The script:

1. Connects with the same `RealMisterClient` the production app uses.
2. Runs `RealMisterClient.collectDiagnosticReport` (read-only, no
   renames, no writes — pure observation).
3. Writes the structured JSON to **`/tmp/mistercurator-diag.json`**
   on your local machine. NEVER on the MiSTer.
4. Prints a compact summary to stdout — total cores, record counts
   by kind, anything the discovery pass surfaced, and an early
   warning list of orphan-shaped cores.

Read the full JSON in your editor, or grep it:

```sh
jq '.records[] | select(.kind == "discovery")' /tmp/mistercurator-diag.json
jq '.records[] | select(.kind == "core-entry") | select(.coreId == "Vectrex")' /tmp/mistercurator-diag.json
jq '.records[] | select(.kind == "recursive-count") | select(.coreId == "X68000")' /tmp/mistercurator-diag.json
```

The Electron renderer is NOT involved. The only side effects are
the SSH calls (which the real client makes anyway during a normal
connect) and the local JSON file write.

## Report shape

```jsonc
{
  "header": {
    "version": 1,
    "mister": { "host": "...", "port": 22, "username": "root" },
    "startedAt": "2026-05-08T12:34:56.789Z",
    "elapsedMs": 4321,
    "subprocessForks": 2
  },
  "records": [ /* DiagRecord[] */ ],
  "cores": [ /* CoreEntry[] — the matcher's final output */ ]
}
```

`records` is an array of strongly-typed events. Every record carries
a `kind` discriminator; entries with the same `kind` have the same
shape. Pretty-printed with 2-space indent.

### Record kinds

| `kind`             | What it means                                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `shell-raw`        | Raw stdout/stderr/exit/elapsed of one of the SSH execCommand calls. There are two: `list-all-cores` (production script) and `discovery` (extra dirs the matcher would normally skip). |
| `rbf`              | One per rbf or mgl found by the production script. Includes `extractedPrefix` (the core id the matcher would assign to it) and `hasLeadingDot`. |
| `games-dir`        | One per `/media/fat/games/<name>/` entry. `rawName` may be dot-prefixed; `visibleName` is the un-dotted form used as the matcher's map key. |
| `match-attempt`    | One per dedupe group (lowercase id bucket). Reports the group size, member ids, and whether the group was kept-singleton, merged, or dropped because every sibling was hidden. |
| `system-filter`    | One per file/dir filter check inside a games dir. Includes both the auto-detector verdict (`isAutoSystem`) AND the user-marks verdict (`isMarkedSystem`), plus the final `decision`. NOTE: cores-list filtering today only filters dirs by user-mark (NOT auto-detected) — Vectrex's "Overlays counts as 90 ROMs" mismatch should fall out of this directly. |
| `recursive-count`  | One per top-level entry walked during the recursive count. Reports the entry's classification (`container` / `atomic` / `unknown` / `no-info`), its `contributesCount`, and a `reason` string. The X68000 / Vectrex recursive-count surprises will be visible here. |
| `core-entry`       | One per finalized CoreEntry, AFTER dedupe. Fields mirror the runtime CoreEntry plus a derived `hasAnyVisibleRbf`. Compare against the on-screen cores list to identify phantoms. |
| `discovery`        | One per directory or file the discovery pass found. Surfaces `_Console (autoboot)/`, `_Console/._hidden/` contents, `menu.rbf` at root — paths the production matcher does NOT enumerate. Each carries a human-readable `note`. |

## What this PR is investigating

PR #11 collects baseline data; the matcher rewrite happens in a
later PR informed by the report. Expected findings:

1. **Phantom duplicates.** Look for `core-entry` records where two
   ids differ only in space/punctuation (`Amstrad PCW` vs
   `Amstrad-PCW`, `Atari 2600` vs `Atari2600`). The `rbf` records
   should explain where each came from — and crucially, whether
   only one of them actually has a corresponding rbf or mgl.
2. **Missing `_Console (autoboot)/`.** The `discovery` records
   should list every mgl in there. None of those should appear in
   the regular `rbf` records.
3. **`_Console/._hidden/` contents.** Same — see what's there, and
   confirm whether any of those are appearing as cores.
4. **Vectrex / Overlays.** Look at the `recursive-count` records
   for Vectrex. The `Overlays` entry should be in the dirs list
   but the cores-list system filter only marks files (not
   folders) as auto-system, so it's counted there while
   `listRoms` separately suppresses it. Both code paths read the
   same dir; the `system-filter` and `recursive-count` records
   together pin down where they diverge.
5. **X68000 / huge folder counts.** The `core-entry` for X68000
   should report `recursiveRomCount` ≈ 2017 (the actual file
   total under the games dir tree). The `recursive-count` records
   trace which top-level subfolder contributed how much.

## Tweaking what gets reported

The records are emitted by:

- `shared/core-matching.ts` — `matchRbfsToGamesDirs` accepts an
  optional `diagnostics: DiagnosticsCollector` in its input. Add
  more `emit(diag, {...})` calls there to widen the trace.
- `app/main/clients/real-mister-client.ts` —
  `collectDiagnosticReport()` runs the discovery pass and threads
  the collector through. Tweak `buildDiscoveryScript()` to
  enumerate more paths.

The `DiagnosticsCollector` interface lives in `shared/diag.ts`. New
record kinds go there, then in the matcher / client emitter calls.
