# Smoke testing the RealMisterClient

Run [`scripts/smoke-test-real-client.ts`](../scripts/smoke-test-real-client.ts) after any change to `RealMisterClient` to catch real-world regressions the mocked unit tests can't cover (handshake quirks, BusyBox shell differences on the MiSTer, real filesystem layouts, etc.).

The smoke test is **read-only** — it does not call `setRomVisibility` or `setBulkRomVisibility`, and never modifies anything on the MiSTer.

## Prerequisites

- A MiSTer FPGA powered on, attached to your network, with SSH enabled.
- Its IP (or hostname) and the SSH password. Default user is `root`.

## Environment variables

| Variable          | Required | Default | Description              |
| ----------------- | -------- | ------- | ------------------------ |
| `MISTER_HOST`     | yes      | —       | Host or IP of the MiSTer |
| `MISTER_PASSWORD` | yes      | —       | SSH password             |
| `MISTER_PORT`     | no       | `22`    | SSH port                 |
| `MISTER_USER`     | no       | `root`  | SSH username             |

## Running it

The simplest path is a `.env.local` file in the repo root, sourced into the shell before running the script:

```sh
# .env.local — never commit this. *.local.* is already gitignored.
MISTER_HOST=192.168.1.42
MISTER_PASSWORD=hunter2
```

```sh
# bash/zsh — load .env.local into the environment for one command
set -a; . ./.env.local; set +a
npm run smoke:real
```

Or pass the variables inline:

```sh
MISTER_HOST=192.168.1.42 MISTER_PASSWORD=hunter2 npm run smoke:real
```

## What it does

1. `connect()` to the MiSTer.
2. `listCores()` and prints the first 10 cores with their ROM and hidden counts.
3. Picks the first core with at least one ROM and `listRoms()` it, printing the first 10 entries with `displayName`, `hidden`, and `sizeBytes`.
4. `disconnect()`.

Each step is wall-clock-timed and the elapsed milliseconds are printed alongside the result.

`MisterConnectionError` is caught specifically so a broken connection prints a friendly diagnosis (one of `unreachable`, `auth_failed`, `not_a_mister`, `unknown`) instead of a raw SSH stack trace. Any other error prints its stack.

The script exits **0** on success, **1** on any failure.

## Never commit credentials

`.gitignore` already excludes `*.local.*` (which covers `.env.local`) and `config.json`. **Do not** add credentials to any other file or commit them — see the *"Never do"* section of [AGENTS.md](../AGENTS.md).
