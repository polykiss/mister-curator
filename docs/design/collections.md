# Collections

**Status:** Designed, not yet implemented. Targeted for v0.1.0.

## Problem

Even with hide/show working, the user has exactly one visibility state at a time. A collector has multiple use cases — "Saturday Night Arcade," "Kids," "Speedrun Practice," "On the Couch" — and currently has to manually re-curate visibility every time they switch contexts. Collections solve this by treating curated visibility states as named, savable presets.

## Approach: hybrid allowlist with whole-core shortcuts

A collection is an explicit description of what should be visible. Loading a collection sets the system to that state in one operation; saving captures the current state into a collection.

### Data model

```json
{
  "schemaVersion": 1,
  "id": "saturday-night-arcade",
  "name": "Saturday Night Arcade",
  "description": "optional free text",
  "cores": {
    "NES": "all",
    "SNES": ["Super Mario World (USA).sfc", "Chrono Trigger (USA).sfc"],
    "Genesis": "none"
  },
  "defaultBehaviorForUnlistedCores": "hide",
  "createdAt": "ISO8601",
  "modifiedAt": "ISO8601"
}
```

Per-core values:

- `"all"` — every ROM in this core is visible (including ROMs added in the future).
- `"none"` — the entire core is hidden (games dir + .rbf, using the hide-cores mechanism).
- `string[]` — explicit allowlist of filenames; everything else in this core is hidden.

`defaultBehaviorForUnlistedCores`:

- `"hide"` — cores not mentioned in `cores` are hidden entirely. Strict allowlist mode.
- `"show"` — cores not mentioned are shown as-is (current visibility preserved). Use for collections that only care about specific cores.

### Storage

- **On the MiSTer**, at `/media/fat/.mistercurator/collections/<id>.json`. One file per collection.
- Collections survive across the app being reinstalled and across multiple Macs/PCs running the app.
- The MiSTer is the source of truth; local cache (per the caching design) holds a copy for performance.

### Active state

At most one collection is active at a time. The app tracks active state in the existing ledger at `/media/fat/.mistercurator/state.json`:

```json
{
  "schemaVersion": 1,
  "hiddenCores": [ /* existing */ ],
  "activeCollectionId": "saturday-night-arcade" | null,
  "activeCollectionDirty": false
}
```

States:

- **No active collection** ("manual mode") — visibility is whatever the user has set ad-hoc. This is the baseline / current behavior.
- **Active and clean** — visibility matches the collection's defined state exactly.
- **Active and dirty** — user has made ad-hoc visibility changes since loading the collection. UI shows "Saturday Night Arcade (modified)" and a "Save changes" affordance.

### Loading a collection

1. Compute the diff between current visibility state and the collection's defined state.
2. Show a confirmation dialog: "This will hide N ROMs and show M ROMs. Apply?"
3. On confirm: execute all changes in one batched SSH command (extends `setBulkRomVisibility` and `setBulkCoreVisibility` infrastructure).
4. Update the ledger to mark the collection as active and clean.
5. Toast: "Loaded Saturday Night Arcade." with an Undo action that lasts ~10 seconds.

### Saving a collection

Two save paths:

- **Save current state as new collection** — prompt for name, capture current visibility, write to MiSTer.
- **Save changes to active collection** — only enabled when active and dirty; overwrites the existing collection file.

When saving, the snapshot algorithm:

1. For each core, count visible ROMs.
2. If all visible: store as `"all"`.
3. If none visible: store as `"none"`.
4. Otherwise: store the explicit array of visible filenames.
5. Cores that don't exist on this MiSTer aren't included in the snapshot.

### Built-in "Everything" collection

A non-deletable collection named "Everything" that shows every ROM and every core. Loading it is the "before update" panic-restore button. It's stored in the same location with a reserved id (`"everything"`) and is initialized on first connect if missing.

### Conflict with hide-cores feature

Collections supersede manual hide-cores state. Loading a collection that hides a core overwrites any prior manual hide; loading a collection that shows a core reveals one that was manually hidden. The ledger's `hiddenCores` array is updated to reflect the post-load state.

When no collection is active, manual hide-cores behavior is unchanged.

### Conflict with auto-reapply

Auto-reapply on reconnect (from the hide-cores feature) only fires when no collection is active. When a collection is active, the active-collection state IS the source of truth and gets reapplied on connect instead.

## UX surface

### Collections panel

A new "Collections" tab or sidebar section, accessible from the connected screen. Shows:

- List of saved collections, with name, description, ROM/core counts, last-modified date.
- "Active: Saturday Night Arcade" indicator at the top.
- "Save current state as collection" button.
- Per-collection actions: Load, Edit (name/description), Duplicate, Delete.

### Top bar in browser screen

When a collection is active, the top bar shows:

- Collection name + active indicator.
- "(modified)" suffix if dirty.
- "Save changes" / "Discard changes" / "Exit collection" actions.

### Building a collection

The natural workflow: enter manual mode, curate visibility freely, click "Save as collection," name it. No separate "edit collection" mode needed for v1.

A power-user feature for v2: a dedicated collection editor where ROMs can be drag-dropped between "in collection" and "not in collection" panes, ideally with metadata thumbnails for visual curation.

## What this enables

- Instant context switching: "Saturday night, click Saturday Night Arcade, done."
- Use-case-specific curation: kid mode, focus mode, party mode.
- Sharing curated lists (future v2: export collection as JSON, import on another MiSTer).
- Combined with metadata: visual collection browsing and building.
- Combined with audit: "all verified non-prototype SNES games" → save as collection.

## Out of scope

- Multiple simultaneous active collections (overlay / merge semantics).
- Collection sharing / import / export (v2).
- Smart / dynamic collections ("all platformers from 1992") — comes after audit + metadata.
- Per-collection permissions or sub-collections.
- Sync between multiple MiSTers (future, requires a sync infrastructure we don't have).

## Open questions for implementation phase

- Collection IDs: slug from name, or UUID? (Lean: slug for human readability, with collision suffix.)
- Editing: does renaming a collection rename its file on the MiSTer? (Lean: yes, atomic mv.)
- Conflict resolution: if two devices write the same collection file simultaneously, last write wins. Acceptable for v1; revisit if real users hit it.
