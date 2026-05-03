# Architecture notes

Living document. Add entries as load-bearing decisions land — keep
each one short and link the relevant code.

## On-MiSTer ledger (`/media/fat/.mistercurator/state.json`)

The hide-core feature persists a tiny JSON ledger so the app can
re-apply the user's hides after a MiSTer update and so it can refuse
to un-hide directories it didn't hide itself ("permission slip").

- Owned by [`ConnectionManager`](../app/main/ipc/connection-manager.ts).
  The IPC bridge intentionally never exposes ledger I/O to the renderer.
- Serialized via a heredoc with a fixed delimiter
  (`MISTERCURATOR_LEDGER_EOF`); `serializeLedger` refuses payloads that
  would close the heredoc early.
- Self-heals on every `readHideLedger` — entries whose coreId no
  longer maps to a real core are dropped and the cleaned ledger is
  rewritten. See [`shared/ledger.ts#healLedger`](../shared/ledger.ts).

## System-file detection (`shared/system-files.ts`)

Real-world games dirs are noisy. `NEOGEO/` ships ~12 BIOS / config
files (`.lo`, `.sp1`, `.sfix`, `.rom`, `.xml`) mixed with the actual
ROM folders. The user's snapshot lists the exact set
(`docs/snapshots/real-mister-layout.txt`).

`isSystemFile({ filename, kind })` is a conservative heuristic the
RomsPane uses to suppress this noise behind a "Show system files"
toggle (default off):

- **Files** are flagged when the lowercase basename matches:
  - an exact entry from `SYSTEM_FILE_EXACT`
    (`cd_bios.rom`, `neocd.bin`, `top-sp1.bin`, `uni-bioscd.rom`,
    `uni-bios.rom`)
  - a prefix from `SYSTEM_FILE_PREFIXES`
    (`boot.`, `bios.`, `neo-epo.sp1`, `sfix.sfix`, `sp-s2.sp1`,
    `000-lo.lo`, …)
  - an extension from `SYSTEM_FILE_EXTENSIONS` (`.xml`, `.ini`)
- **Folders** are flagged when their lowercase name is one of
  `palettes`, `overlays`, `filters`, `old`.
- The leading-dot (hidden) form of any of the above is also flagged.

### Extending the heuristic

When a user reports a core whose ROM list is contaminated, add the
relevant filename(s) to one of the constants in `shared/system-files.ts`
and add a regression test in `shared/system-files.test.ts`. The
NEOGEO test list is the reference shape — keep it pinned to the real
on-disk layout from the snapshot.

False positives (real ROMs marked as system) are worse than false
negatives. When in doubt, prefer adding an exact-name match over a
broader prefix.
