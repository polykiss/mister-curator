# MiSTerCurator

A cross-platform desktop app to curate your [MiSTer FPGA](https://misterfpga.org/) ROM collection over SSH.

**Status:** Work in progress. Pre-MVP.

## What it does (planned)

- Connects to your MiSTer over SSH — nothing installed on the device
- Browse your ROM collection by core
- Hide and show individual ROMs or whole cores from the MiSTer menu
- Audit your collection against No-Intro and Redump DAT files
- Manage saves, favorites, and more

## Stack

Electron + React + TypeScript + Vite + Tailwind. Python (stdlib only) for on-device helper scripts.

## License

MIT — see [LICENSE](LICENSE).
