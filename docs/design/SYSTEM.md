# MiSTerCurator Design System

Status: **Locked (rev. 2).** Phase 1 proposal accepted with revisions;
Phase 2 applies it across the app. Rev. 2 ratifies thirteen field
divergences — see section 9 (Decisions) D6–D20 and the amended §4 / §5 / §10.

This document is the single coherent visual identity that replaces the
cumulative drift accumulated across MVP iterations. It is the reference
that every component restyles against.

---

## 1. Direction

MiSTerCurator is an **operator's console** for a piece of dedicated retro
hardware. The audience is hobbyists, archivists, and tinkerers who already
SSH into their MiSTer, edit `MiSTer.ini` by hand, and care more about a
trustworthy, scannable interface than a glossy one. The references the
user pulled are pointing the same direction: SmartShort and Nextmove (the
two darkest, most restrained sidebar layouts in the set) read as the
strongest fits — disciplined dark canvas, generous quiet, one accent
saved for the active state. Taskplus and GR8R sit further from us: they
are SaaS dashboards full of stat cards, and we are a desktop list tool.

The proposed direction is **terminal-luxe** — the technical character of
a developer-tool console, executed with the spatial discipline of a
high-end editorial layout. Deep blue-black surfaces (the README's "touch
of blue"), a clearly-resolved type system that does most of the visual
work, and one signal-green accent reserved for *active* state and
*primary* action. Borders are subtle and informational, not structural —
hierarchy comes from typographic weight and negative space, almost never
from filled cards. Dense where dense is useful (file lists), generous
where breathing helps (connection screen, modals, banners).

The principles extracted from the references:
- **Typography as primary structure** (all five references) — title /
  metadata distinction is carried by size, weight, case, and color, not
  by chrome.
- **One accent against neutral** (SmartShort lime, Nextmove magenta,
  GR8R magenta-bar) — *one* color earns the eye; everything else is
  greyscale.
- **Atmospheric depth, not decorative depth** (Authentication Error
  reference) — colored haloes only at moments of state change, never as
  ambient texture.
- **Sidebar / panel inset on a darker page** (Nextmove, GR8R) — the
  app surface floats inside a deeper outer canvas, giving native-window
  context.

What we explicitly do **not** take from the references:
- The SaaS-dashboard stat-card grid (Taskplus, GR8R Company Details).
- Avatar stacks, "Welcome Back" personalization, "Upgrade to Pro" CTAs.
- Pure-black canvases (Authentication Error). We keep blue-black with
  measurable elevation steps.

---

## 2. Color palette

Default theme is **dark**. Light mode ships at parity (see open
questions). All values are sRGB hex; HSL is given for tokens whose hue
matters for tooling.

### Dark — surfaces

| Token             | Hex       | HSL                | Use                                            |
| ----------------- | --------- | ------------------ | ---------------------------------------------- |
| `bg-canvas`       | `#06080B` | `218 30% 4%`       | Outer page (behind the inset panel)            |
| `bg-chrome`       | `#0B0F14` | `212 25% 6%`       | Header, sidebar, status bar                    |
| `bg-surface`      | `#0F141A` | `213 22% 8%`       | Default panel (cores list, ROMs list)          |
| `bg-elevated`     | `#151B22` | `213 19% 11%`      | Hover row, dropdown, popover                   |
| `bg-overlay`      | `#1B222A` | `213 18% 14%`      | Active row, modal surface, selected state      |

The five-step ladder (canvas → overlay) is intentional: drilled-in
contexts (a ROM row inside a selected core inside a panel inside the
window) can each take one step up without ever crossing into "card on
white" territory.

### Dark — foreground

| Token         | Hex       | Use                                                       |
| ------------- | --------- | --------------------------------------------------------- |
| `fg-primary`  | `#E6E9EE` | Headings, row labels, primary content                     |
| `fg-body`     | `#C2C8D1` | Body copy, secondary labels                               |
| `fg-muted`    | `#888F99` | Metadata, counts, captions, breadcrumb separators         |
| `fg-disabled` | `#565E69` | Disabled controls, placeholders, "removed" suffix on rows |

`fg-muted` (HSL `218 8% 57%`) must hit WCAG AA on `bg-surface`
(verified 4.6:1).

### Dark — borders

| Token              | Hex       | Use                                                 |
| ------------------ | --------- | --------------------------------------------------- |
| `border-subtle`    | `#171C23` | Default row separators, status-bar top edge         |
| `border-default`   | `#232932` | Inputs, modal edges, panel boundaries               |
| `border-emphasis`  | `#2E3540` | Focused inputs, hovered secondary buttons           |

### Accent (proposed: **signal green**)

A nod to LED indicators and CRT phosphor — culturally aligned with the
audience, and lifted directly from the SmartShort reference. Reserved
for active navigation state and one primary CTA per screen.
**One sanctioned exception:** the brand mark (the pixel-M monogram)
renders in `accent` as identity — either inside the full wordmark
lockup (connection screen) or as the bare monogram alone (the quiet
app-presence mark at the far left of the browser's top header). This
is the single non-state, non-CTA use of accent permitted in the system.
It is still never used for status or success.

| Token            | Hex       | Use                                                  |
| ---------------- | --------- | ---------------------------------------------------- |
| `accent`         | `#B8F500` | Active row edge, primary button fill, focus ring     |
| `accent-hover`   | `#C7FF33` | Primary button hover                                 |
| `accent-active`  | `#9FD500` | Primary button pressed                               |
| `accent-soft`    | `#1A2306` | Tinted fill behind active state (very low alpha use) |
| `accent-fg`      | `#0A0E07` | Text/icon color on `accent` fill                     |

### Status

Tuned for dark-mode legibility. Note that **`success` is teal-leaning**
to read distinctly from `accent` — a saturated grass-green next to the
signal-green accent would collide.

| Token         | Hex       | Use                                  |
| ------------- | --------- | ------------------------------------ |
| `success`     | `#3FCFA3` | "Connected" indicator, success toast |
| `warning`     | `#F2B544` | "Connecting" pulse, warning banners  |
| `destructive` | `#E5484D` | Errors, destructive confirms         |
| `info`        | `#7AA8FF` | Neutral system information           |

### Light — surfaces (parity, less detailed by intent)

| Token         | Hex       |
| ------------- | --------- |
| `bg-canvas`   | `#F7F6F3` |
| `bg-chrome`   | `#FAFAF8` |
| `bg-surface`  | `#FFFFFF` |
| `bg-elevated` | `#F2F1ED` |
| `bg-overlay`  | `#E9E7E1` |
| `fg-primary`  | `#0E1116` |
| `fg-body`     | `#2A2F37` |
| `fg-muted`    | `#5C6370` |
| `fg-disabled` | `#9DA3AC` |
| `border-*`    | `#E2DFD8` / `#CCC9C0` / `#A8A49A` |
| `accent` family | unchanged hex values; `accent-fg` becomes `#0A0E07` (still dark) |
| `success/warning/destructive/info` | unchanged hex (recalibrated only if AA fails) |

**No gradients in the system.** The references that use them
(Authentication Error red halo, Nextmove magenta edge glow) are *one*
moment per app, not a vocabulary. The single defensible gradient
appearance in this system is the focus state on a primary action — and
only if user-tested. See open questions.

---

## 3. Typography

**Family: IBM Plex Sans + IBM Plex Mono** (IBM; SIL OFL; available via
Google Fonts; self-hosted in this project).

IBM Plex carries technical-tool character without sliding into the
default-developer-tool aesthetic that Geist or Inter would. It is:

- explicitly **not** Inter / Roboto / Arial / system-ui,
- a paired sans + mono family with matched proportions, so a path
  rendered next to a name never breaks optical rhythm,
- rich in personality at display sizes (the wordmark uses Plex Sans
  700 with tight tracking — see section 5),
- shipped in the weight range we need (400 / 500 / 600 / 700).

We **self-host** the woff2 files (CSP `default-src 'self'` would block
the Google Fonts CDN, and we want the renderer to paint correctly when
the user is offline on a LAN-only setup).

### Type scale

The body baseline is **13px**, deliberately denser than web-default
16px. This is a desktop list tool; ROMs lists and core lists must
remain scannable at 50+ rows visible.

| Name        | Size           | Line height | Weight  | Use                                                                              |
| ----------- | -------------- | ----------- | ------- | -------------------------------------------------------------------------------- |
| `caption`   | 11px / 0.6875r | 16px        | 500     | Section labels (UPPERCASE, +0.08em tracking), badge text                         |
| `body-sm`   | 12px / 0.75r   | 18px        | 400     | Metadata, counts, secondary row info                                             |
| `body`      | 13px / 0.8125r | 20px        | 400     | Default body, ROM names, core names                                              |
| `body-lg`   | 14px / 0.875r  | 22px        | 400     | Connection screen body, modal body                                               |
| `heading-sm`| 16px / 1r      | 22px        | 600     | Card titles, "Profiles" / "Cores" panel headers                                  |
| `heading`   | 20px / 1.25r   | 28px        | 600     | Modal titles, screen-section headers                                             |
| `heading-lg`| 28px / 1.75r   | 34px        | 600     | Connection screen heading                                                        |
| `display`   | 40px / 2.5r    | 44px        | 700     | Connection screen "MiSTerCurator" wordmark, empty-state titles                   |

### Weight strategy

- **400** body and labels — most of the app
- **500** active row label, hovered link, button text — subtle emphasis
- **600** all headings without exception
- **700** display only (wordmark, big numbers in empty states)

Hierarchy emerges from **size → weight → color → case** in that order.
No row needs a background fill or a left-border to "look like a row" —
the typography carries it.

### Mono usage rules

IBM Plex Mono is reserved for **content that is technically meaningful
as a string**:
- File and directory paths (breadcrumb segments, ledger paths)
- Hostnames, IPs, ports
- Counts where alignment matters (`1,247 ROMs · 312 hidden`)
- Status codes, error codes, version strings

Never use mono for human-readable labels (button text, headings, ROM
display names).

---

## 4. Spacing & density

Tailwind's 4px base scale stays. The system uses these tokens:

| Token | px  | Use                                          |
| ----- | --- | -------------------------------------------- |
| `0`   | 0   |                                              |
| `1`   | 4   | Icon-to-label gap, badge inner padding       |
| `2`   | 8   | Tight inline (row internal)                  |
| `3`   | 12  | Default internal padding (button px)         |
| `4`   | 16  | Row horizontal padding, panel padding (sm)   |
| `5`   | 20  | Card padding                                 |
| `6`   | 24  | Section gap, panel padding (default)         |
| `8`   | 32  | Section gap (large), modal padding           |
| `12`  | 48  | Connection-screen vertical rhythm            |
| `16`  | 64  | Empty-state breathing                        |

### Density targets

| Element                    | Height | Note                                                  |
| -------------------------- | ------ | ----------------------------------------------------- |
| List row (cores, ROMs)     | **56px** (`h-14`) | Holds a 48px logo/thumbnail; still scannable at ~40 visible. Was 40px in rev. 1 — raised once art entered the row. |
| Header (top app chrome)    | 56px   |                                                       |
| Status bar                 | 32px   | Caption type only                                     |
| Button (default)           | 32px   | sm: 28px, lg: 36px                                    |
| Input                      | 32px   | Matches button height for inline filter rows          |
| Badge                      | 18px   |                                                       |

Row gap: **0px** (rows separated by `border-subtle` only). This pulls
the lists tighter than the references — reference list density was
~48–56px, but those are SaaS dashboards with fewer rows. ROM curation
needs the density.

---

## 5. Component patterns

The brief's question — *change shape or just restyle?* — is answered
once here, and per-component below.

**Shape changes (scope-limited):**
1. Buttons lose their solid-fill default; primary becomes the *only*
   filled button on a screen.
2. Row state (HIDDEN, SYSTEM) is expressed by **dimming the row** and
   placing a small icon to the left of the name. No badge pills.
3. Breadcrumbs gain a path-style mono treatment.
4. Active row gains a 2px left-edge accent (no background change).
5. Each list row carries a **full-height density rectangle** at its
   far right — see §10.

**Everything else: restyle in place.** The DOM shapes from PR #6 / #7
are correct.

### List row (CoreRow, RomRow)

```
┌──────────────────────────────────────────────────────────────────┐
│ ▌  [icon]  Label name                  metadata · counts   ⋯  ▰  │
└──────────────────────────────────────────────────────────────────┘
  ↑                                                            ↑  ↑
  2px accent edge (active)                  actions on hover     density
                                                                rectangle
```

- Height **56px** (`h-14`), paddingX 16px, no borders by default
- Bottom: `border-subtle` (one-line separator across the panel)
- Hover: `bg-elevated` (cores) / `bg-overlay` (ROMs, since the ROMs
  pane sits on `bg-elevated` already — see §4 / pane elevation), with
  trailing actions slot revealing
- Active (cores list): `bg-overlay` + 2px left-edge `accent` bar (the
  SmartShort move)
- Density rectangle: pinned to the right edge, full row height, 50%
  of row height wide (~20px on a 40px row), zero radius. Color
  computed once per row from `value / max` — see §10.
- Hidden state: `opacity-50` on the row, `italic` on the row label,
  text color steps down to `fg-disabled`. **No badge.** Dimming is
  the entire signal.
- System state: same dimming as Hidden + a 14px lucide `Settings`
  (gear) icon at the **left of the name**, inheriting the row's
  current text color so it dims with the row. **No badge.**
- A row that is *both* hidden and system: gear icon on the left, single
  application of the dimming treatment.
- Selection (multi-select): no checkbox visual at rest — Cmd/Shift-click
  selection inserts a 1px `border-emphasis` ring inside the row hover

### List row — count semantics

The metadata slot on the right of a cores-list row shows either a
single number or a two-part breakdown:

- **Single number** when the recursive ROM count equals the top-level
  item count (no container subfolders to walk into). NES with 9
  cartridge files reads as `9`. The hidden-count tail
  (`(N hidden)`) follows in `fg-disabled` when relevant.
- **Two-part breakdown** when the recursive count exceeds the
  top-level count (containers were walked). NEOGEO's 9 organisational
  subfolders containing ~30 games each renders as
  `9 folders · ~300 ROMs`. Numbers stay in `font-mono` (tabular);
  the labels (`folders`, `ROMs`, separator) render in
  `fg-disabled`. The tilde (`~`) on the recursive total is
  intentional — recursive counts are approximate (non-standard ROM
  extensions, atomic folders nested inside containers, …) and the
  user reads the prefix as "approximately."

Atomic disc folders (Saturn, MegaCD) count as 1 ROM each, so a
Saturn games dir with 17 disc folders renders the single-number
form (`17`). This matches the user's mental model — the folder is
the unit.

### Core identity cell (rev. 2)

The leading cell of a CoreRow shows the core's **logo if one is
available, otherwise the core name set as a wordmark** — never a
generic placeholder icon. The two cases are mutually exclusive:

- **Logo present**: render the monochrome system logo (white-on-
  transparent), left-aligned, full cell height, max ~124×38.
- **No logo**: render the core name in `heading-sm` (16px/600)
  `fg-primary`, left-aligned. Do **not** also show the gamepad icon,
  and do not repeat the name in the metadata column.

Beside the identity sits the **core-id** in `font-mono` `body-sm`
`fg-disabled` (e.g. `MRA`, `Minimig`, `AO486`, `MegaCD`, `MegaDrive`,
`MSX1`) — the technical core string, always shown. When two visible
cores share a display name (the two MSX cores), the core-id is the
disambiguator and may be promoted into the badge slot so the rows read
distinctly.

The scrape-progress `StatusIndicator` renders at **7px with no halo** in
the cores-list row (the color still encodes progress: cold-blue = not
yet scraped, green = metadata resolved). The larger glowing form is
reserved for the footer's active-scrape indicator.

### PlatformBadge (D11)

The leading identity slot of every cores-list row: a fixed **104×40** box.
- **Logo present**: the monochrome system logo normalized to a **26px
  cap-height** (`width: auto`, clamped to the box), left-aligned. Every
  system therefore sits at the same visual size and baseline.
- **No logo**: the core name as a wordmark (`heading-sm`/700) in the
  same box. Logo-less cores (Amiga, Arcade, DOS Games) are NOT a
  separate bare-text row type — they use the badge slot like everyone else.

### ROMs-pane view toolbar (D13)

On the ROMs-pane search row, after the filter input:
- **View-mode toggle** — segmented `[list | poster]`. Active segment uses
  `bg-overlay` fill + `accent` icon; inactive is `fg-muted`.
- **Scale stepper** — `−  [S|M|L|XL]  +` in a single bordered group;
  the current size shows in mono. Drives `viewSize` (tile/row density).
- **Sort-by dropdown** — rendered **only in poster mode** (list/detailed
  sort via clickable column headers, which poster lacks). Options mirror
  the list columns: Name / Year / Genre / Rating / Size, with an asc/desc
  direction. Wired to the same sort state the list headers use.

"Show MAME / HBMame as separate cores" is NOT in the cores-sidebar
header — it lives in the Settings dialog.

### Count summary (CountPill) (D16, rev. 2)

The pane header summarizes the list as a row of filled pills, not a
"N ROMs · M hidden" text line. Each pill is `bg-overlay rounded-md px-2`,
`body-sm`, tabular: a **bold** count in `fg` followed by a receded `fg-muted`
label, with an optional leading status dot. Tones: total ROMs = neutral (no
dot); hidden = amber dot (`warning`); system = blue dot (`info`). When a filter
is active the first pill reads "N / M shown". No border — the filled surface
is the signal.

### Switch (D17, rev. 2)

Boolean view-options (Show hidden, Show system files, Auto-hide missing ROMs,
Show MAME/HBMame as separate cores) render as a Switch: an `h-[18px] w-8` pill,
`bg-accent` track when on / `bg-overlay` when off, **white** (`bg-white`) knob
with `shadow-sm` and `duration-200` slide transition. Replaces
`<input type="checkbox" className="accent-accent">`. Per-row / per-tile
SELECTION stays a checkbox.

### Pane header layout (D18–D23)

Vertical stack: (1) **pane title** (`text-heading font-bold text-fg`, left) +
view-option Switches (right-aligned on the same row); (2) the CountPill
summary; (3) the tools row — filter input (`flex-1`, fills the row) + view-mode
toggle + size stepper + (poster mode only) sort dropdown; (4) the action-button
row — joined **segmented groups** (`inline-flex overflow-hidden rounded border
border-default`, ghost variant, `border-l border-default` separators), not
individual spaced buttons. `space-y-3`, `border-b border-subtle`, `px-4 py-3`.
Both panes share this structure (arcade omits system pill, system-file toggle,
and Mark-as-system group).

### App header gradient (D24)

The browser top header (`h-14`) replaces the flat `bg-chrome` with a
`bg-gradient-to-b from-surface to-chrome` gradient: surface (8% lightness)
at the top fades to chrome (6% lightness) at the bottom. Uses existing design
tokens; no raw hex.

### DetailHeader (CoreInfoDialog + RomDetailDialog) (D14)

Both detail dialogs open with the same header, top→bottom:
- **Kicker** — tracked caps (`caption`, `font-bold`, `tracking-[0.19em]`,
  `fg-muted`): "Core info" / "ROM detail".
- **Platform logo** — top-left, monochrome system logo inverted to white
  (`max-h-12`, `object-contain`, `invert`). Omitted when no logo exists.
- **Title** — the system display name (CoreInfo, `heading`) or the game
  title (RomDetail, `heading-lg`), `font-bold`, `break-words`.
- **Metadata row** — either inline **badge chips** beside the title
  (CoreInfo: company·years·media) OR a muted **subtitle** line below it
  (RomDetail: developer · year · genre · system).

The logo sits ABOVE the title in both dialogs (not inline) — this unifies
the two and matches the detail mockups. The component owns the system-logo
blob fetch; CoreInfoDialog's previously-inline logo fetch is removed.

### Settings dialog (D35 + D36)

A 1040×`min(88vh,672px)` modal (`rounded-[14px]`, `bg-surface`, `border-default`, custom shadow). No footer — dismiss via the boxed 32×32 close button or Esc.

Header (`border-b border-subtle`): "Settings" title (24px/700) + connection subtitle (green dot · profile name · mono host IP) + boxed close.

Body: `grid-cols-[1fr_396px]` — left column (settings, `border-r border-subtle`) + right column (diagnostics, `bg-black/[0.13]`).

Section labels share the **mono-caps** style (`text-[11px] font-mono font-semibold uppercase tracking-[0.16em] text-fg-disabled`) with a 14px leading lucide icon.

Options wrap in cards (`rounded-xl border-subtle bg-canvas/40`), rows at `px-4 py-[15px] flex items-start justify-between gap-4`. Inline code literals use a `CodeChip` (`font-mono text-[12px] bg-overlay border-default rounded-[5px]`).

**Display section** — Core menu style dropdown (D36, see below) + Show MAME toggle.
**Arcade section** — Auto-hide missing ROMs Switch.
**System section** — Enter Update Mode secondary button.

Diagnostics: status chip (amber count / success "No issues"); each issue group title-rows a flex-fill table (`border-default rounded-[10px] overflow-hidden`), mono-caps `th` on `bg-elevated`, row hover, footnote pinned below.

**Switch token** — `bg-switch-off` (HSL `213 22% 20%`) as the off-track color, replacing `bg-overlay`.

### Core menu style (D36)

Three modes for how cores appear in the browser sidebar:
- **Text only** (`text`) — name wordmark for every core; no logos or photos.
- **System logos** (`logos`, default) — monochrome ScreenScraper logo via PlatformBadge; logo-less cores show a **category icon** (Arcade → Joystick, Computer → Monitor, everything else → Gamepad2), NOT a name wordmark.
- **System images** (`images`) — ScreenScraper hardware photo (`catalogEntry.photoUrl`, same URL shape as `logoUrl`) rendered `object-contain max-h-[52px]`; photo-less systems fall back to the category icon. The core-id column shows display-name (bold) + `games/<id>` path (mono fg-muted).

Persisted at `mistercurator.coreMenuStyle.${host}` (default `logos`).

⚠️ Photo coverage: `photoUrl` is populated by the ScreenScraper system catalog for major platforms (NES, SNES, Genesis, GBA, N64, etc.). Niche/future cores may have `photoUrl: null` — these gracefully fall back to the category icon. No fabricated assets.

### Status bar — progress ring + sub-task bar (D30)

During an auto-scrape session the status bar left zone gains two visual signals:

- **Session ring** — a 14px SVG ring (`ScrapeProgressRing`) that fills clockwise using `stroke="hsl(var(--accent))"` (green) against a `hsl(var(--border-default))` track. Fill = `(processedCoreCount + 1) / totalCoreCount`. Rendered during `active` and `discovering` states; hidden on `idle`. Data comes from the existing `AutoScrapeProgressEvent`.
- **Sub-task bar** — a `h-1 w-20 bg-elevated` inline bar with an `bg-accent` fill that tracks the active core's `done / total`. Shown during `active` state only.

Both use design tokens only. In `idle` state, `totalCoreCount` is not in the event — rings and bars are hidden rather than fabricated.

### Thumbnail radius (D19)

Box-art thumbnails use the standard `rounded-md` in BOTH list view and
poster tiles (previously list thumbnails were `rounded-sm`). Art stays
`object-contain` (no crop) in list view, `object-cover` in poster tiles.

### Selection (D20)

Selected items carry the accent (signal-green):
- **List rows** — a 2px `accent` left edge (inset box-shadow) plus a faint
  `bg-accent/[0.07]` tint (was `bg-overlay`).
- **Poster tiles** — a `ring-2 ring-accent` and a filled-green corner
  checkmark (top-left) in place of the bare selection checkbox.

Selection is wired to existing selection state; the accent here is a
selection signal, a sanctioned use alongside active-nav and the brand mark.

### Detail-dialog footer (D15)

ROM detail dialog footer order: `Hide` (ghost) · `Edit…` (ghost) ·
`Find on ScreenScraper…` (**primary** — the single filled button) ·
`Close` (secondary). The empty-metadata state hides `Edit…` and keeps
`Find on ScreenScraper…` as primary. Never make `Close` the primary/filled
action — closing is not the screen's main verb.

### Wordmark / brand mark (rev. 2)

The brand lockup is the **pixel-M monogram tile + "MiSTerCurator"
wordmark**. The monogram is an 8-bit "M" in `accent` on a `bg-elevated`
tile (radius ≈ 0.26 × size). The wordmark stays IBM Plex Sans 700,
`-0.02em` tracking, **monochrome `fg-primary`** — the lime lives only
in the monogram and the primary CTA, preserving one-accent discipline.
Appears at tile 44 / wordmark `display` on the connection screen; tile
~32 / wordmark `heading` in the app header / status contexts.

### Buttons

Six variants total. `cva` setup keeps shadcn's API.

| Variant       | Bg                | Border             | Fg            | Use                                |
| ------------- | ----------------- | ------------------ | ------------- | ---------------------------------- |
| `primary`     | `accent`          | none               | `accent-fg`   | One per screen — "Connect", "Apply"|
| `secondary`   | transparent       | `border-emphasis`  | `fg-primary`  | Default action                     |
| `destructive` | transparent       | `destructive` 1px  | `destructive` | Hide-empty confirm, Delete profile |
| `ghost`       | transparent       | none               | `fg-body`     | Icon button, row inline action     |
| `link`        | transparent       | none               | `accent`      | Inline learn-more                  |
| `subtle`      | `bg-elevated`     | none               | `fg-primary`  | "Cancel" inside a modal            |

Heights: sm 28 / default 32 / lg 36. Radius: **6px** across all sizes.

The PR #8 round-4 lesson is encoded here: *only one filled button per
screen.* Stacked rows of solid buttons read as shouting; outlined
buttons keep the slate-vs-accent cue without weight.

### Badges (deprecated for row state)

The HIDDEN and SYSTEM pill badges that PR #7 introduced have been
removed (Round 2 of the design pass). Row state is now expressed
through dimming (opacity + italic + `fg-disabled`) plus, for system
rows, a 14px gear icon left of the name. See "List row" above.

The `Badge` primitive remains in the codebase (`components/ui/badge.tsx`)
in case a future surface — non-row metadata, neutral tags, etc. — has
a genuine need for outline pills. We just don't use it for row state
anymore.

### Inputs

- `bg-chrome` fill, 1px `border-default`, 6px radius, 32px h
- Padding 12px / 8px
- Focus: `border-emphasis` → adds a 1px `accent` outer ring at
  `--ring-offset: 0`. No outer glow.
- Placeholder: `fg-disabled`
- Disabled: `bg-elevated`, `fg-disabled`, no border

### Status indicators (ConnectionStatus dot)

A 6px circular dot + caption-typed label.

| Status        | Dot color    | Animation                                |
| ------------- | ------------ | ---------------------------------------- |
| Connected     | `success`    | static                                   |
| Connecting    | `warning`    | 1.5s ease-in-out opacity 0.5 → 1.0 pulse |
| Disconnected  | `fg-disabled`| static                                   |
| Error         | `destructive`| static                                   |

### Breadcrumbs

Mono path, lives in the panel header above ROMs:

```
mister:games / SNES / 1 World A-Z
```

- IBM Plex Mono, body-sm
- Segments: `fg-body`, hover `fg-primary`
- Separators (` / `): `fg-disabled`
- No icons, no chevrons — the slash is the visual

### Banners (failure card, disconnect notice)

Inline, panel-width, no fill:

```
│ ╳  Could not connect — host unreachable.                 [Retry]
│    Check that the MiSTer is on the same network.
```

- 2px left border in the relevant status color
- 16px paddingX, 12px paddingY
- Icon at left (16px, status color)
- Title in `fg-primary` body weight 500, body in `fg-body`
- Action button right-aligned (secondary variant)
- No background fill — the left bar carries the meaning

This is also the shape for the disconnect banner that PR #8 introduced
(which is currently reverted) — the system pre-defines its surface so
it lands consistent.

### Status bar (rev. 2)

32px, `border-t border-subtle`, `bg-chrome`, caption type. Two zones:

- **Left** — transient op / scrape message, the scrape `StatusIndicator`,
  and the bulk-op progress bar. (Unchanged from rev. 1.)
- **Right — connection identity zone:** profile name (`fg`, normal-case)
  · `username@host:port` (mono, `fg-muted`) · status dot + state label.
  This is the single home for connection identity; the top header no
  longer shows it.

```
◐ Scraping NES (18/681) ……… bedroom-mister · root@192.168.1.42:22 · ● CONNECTED
```

- Bullet (`·`) separators are `fg-disabled`
- Host segment is mono

The browser top header (`h-14 bg-chrome`) carries the **brand lockup on
the left** (pixel-M monogram + compact wordmark, tile 28) and the real
actions on the right (Refresh / Settings / Disconnect). It does NOT show
the profile name or host — those live in the status bar's identity zone
(rev. 2, superseding PR-A item 7).

### Modals

- `bg-overlay` surface, **no backdrop blur**, 8px radius, soft
  shadow `0 16px 48px -16px rgba(0,0,0,0.7)`
- Backdrop: `bg-canvas` at 0.6 opacity
- Padding 24px, max-w 480px
- Title `heading`, body `body-lg`
- Action row: `subtle` Cancel left + `primary` action right, 16px gap

### Resizable divider (between cores and ROMs panels)

- 1px `border-default` at rest
- 4px hover hit area, hover bg `bg-elevated`
- Active drag: 1px `accent` line, no thickness change

### Toasts (sonner)

- `bg-overlay` surface, 1px `border-default`, 6px radius
- Title `body` weight 500, description `body-sm` `fg-body`
- Status accent: 2px left bar (matches banner pattern)
- Auto-dismiss 5s; stack in top-right, max 3 visible

### Empty states

When there are no cores, no ROMs, or no profiles:

- Display heading (`display`, 700)
- One-line `body-lg fg-muted` description
- One CTA (primary if the action is "Add profile"; secondary otherwise)
- Vertically centered in the panel, 64px breathing top and bottom

---

## 6. Iconography

**Library: lucide-react** (already a transitive dep via shadcn/ui — no
new dependency).

Rules:
- **Stroke weight 1.5px** uniformly. Lucide ships at 2px default;
  override with `strokeWidth={1.5}`.
- **Sizes**: 14px (badges, status indicators), 16px (inline body, row
  icons, buttons), 20px (panel headers), 24px (modal titles, empty
  states).
- **Color**: inherit `currentColor`; never bake color into the icon.
  Active = `accent`, hovered = `fg-primary`, default = `fg-muted`.
- **No filled icons** anywhere. Outline style only.

A short iconography vocabulary (set up once in a mapping file so it
stays consistent):

| Concept           | Icon              |
| ----------------- | ----------------- |
| Core (no logo)    | name as wordmark — no icon |
| ROM               | `Disc`            |
| Folder (drillable)| `Folder`          |
| Folder (atomic)   | `FolderArchive`   |
| Hidden            | `EyeOff`          |
| System file       | `Settings`        |
| Connect           | `Plug` / `Link2`  |
| Disconnect        | `Unplug`          |
| Error             | `AlertCircle`     |
| Success           | `Check`           |
| Settings          | `Settings`        |

---

## 7. Motion

**Static-first.** Animation is reserved for state changes that
otherwise would be invisible.

| Trigger                       | Duration | Curve              |
| ----------------------------- | -------- | ------------------ |
| Hover color transitions       | 120ms    | ease-out           |
| Focus ring                    | 0        | instant            |
| Connecting indicator pulse    | 1.5s     | ease-in-out, loop  |
| Toast enter                   | 200ms    | ease-out (fade+y4) |
| Toast exit                    | 150ms    | ease-in (fade)     |
| Modal enter                   | 150ms    | ease-out (fade)    |
| Modal exit                    | 100ms    | ease-in (fade)     |
| Bulk-op progress shimmer      | 1.6s     | linear, loop       |
| Row reveal during list render | 0        | none — instant     |

Explicitly ruled out:
- Page transitions
- Slide-ins, parallax, hero motion
- Scale on button hover
- Backdrop blur (electron desktop chrome handles this contextually;
  we don't add to it)
- Any "AI shimmer" gradient

References here: SmartShort and Nextmove are visually static — every
motion they use happens at the *boundary of a state change*, never as
ambient texture. That's the bar.

---

## 8. What changes vs. what stays

### Changes (require code in Phase 2)

1. **Tailwind config** — palette tokens, type scale, spacing tokens,
   font-family IBM Plex Sans + IBM Plex Mono, radius scale.
2. **Global CSS** — CSS variables for both modes; load IBM Plex via
   self-hosted woff2 + `@font-face`. Force `dark` class on `<body>`
   for v0.1.0; light tokens stay wired for the post-v0.1.0 follow-up.
3. **Buttons** — `cva` variants restructured: only `primary` is
   filled; default-action becomes outlined `secondary`.
4. **Row state** (Round 2) — HIDDEN/SYSTEM badges removed. Hidden +
   system rows recede via `opacity-50` + italic + `fg-disabled`, with
   a 14px `Settings` (gear) icon left of the name on system rows.
5. **Rows** — 40px height, no rest borders, hover/active styles match
   spec, 2px left-edge active marker. Trailing density rectangle (§10).
6. **Pane elevation** (Round 2) — Cores pane sits on `bg-surface`;
   ROMs pane sits on `bg-elevated` so the right side of the split
   reads as one step closer to the viewer.
7. **Breadcrumbs** — restyled to mono path with `/` separators.
8. **Banners** — left-bar variant introduced; existing inline error
   surfaces converted.
9. **Status bar** — slot layout normalized; host segment becomes mono.
10. **Connection screen** — display wordmark, breathing scale.
11. **Modals** — surface tone, no blur, soft shadow.
12. **Toasts (sonner)** — themed with the system tokens.
13. **Icons** — strokeWidth 1.5 override applied globally; sizing
    standardized. System-file icon swapped from `Wrench` to `Settings`
    (Round 2).

### Stays (no behavioral or structural change)

1. shadcn/ui as the component foundation.
2. lucide-react as the icon library.
3. Tailwind utility approach — no CSS-in-JS, no styled-components.
4. sonner for toasts.
5. Information architecture: ConnectionScreen → BrowserScreen
   (cores | ROMs split) → drilled-in subpath.
6. Resizable divider behavior.
7. Component DOM shapes — props, structure, callbacks unchanged.
8. All 480 existing tests' assertions on text content, role, and
   labels.

---

## 9. Decisions

The five questions raised in the Phase 1 proposal are resolved. This
section records what was chosen and why so the lock-in is legible to
anyone re-reading the document.

| #  | Topic        | Decision                                                                                  |
| -- | ------------ | ----------------------------------------------------------------------------------------- |
| Q1 | Accent       | **Signal green `#B8F500`**. No dual-accent rule — cores and ROMs differ by icon + layout. |
| Q2 | Typography   | **IBM Plex Sans + IBM Plex Mono**. Self-hosted woff2 (CSP blocks Google Fonts CDN).       |
| Q3 | Row density  | **56px (`h-14`) rows** (rev. 2). Raised from 40px so a logo/box-art tile fits the row without clipping; density target is now ~40 visible rather than 50+. |
| Q4 | Light mode   | **Defer to post-v0.1.0.** Tokens wired for both modes; `<body>` forced to `dark`.         |
| Q5 | Wordmark | **Pixel-M monogram (accent) + monochrome wordmark.** Plex Sans 700, -0.02em. Logo carries the accent; wordmark stays fg-primary. (rev. 2) |
| D6  | Density bar        | Full-height, 24px wide, solid teal→green fill. §10 amended. |
| D7  | Core identity      | Logo OR name-wordmark; no gamepad fallback; mono core-id subtitle. §5 amended. |
| D8  | Brand mark         | Pixel-M monogram in accent (sanctioned exception). §2/§5 amended. |
| D9  | Row height         | List rows are 56px (`h-14`), not 40px. §4 / §9-Q3 amended. |
| D10 | Identity location  | Connection identity (name + host + state) lives in the status-bar right zone; the top header is brand + actions. Supersedes PR-A item 7. §5 amended. |
| D11 | PlatformBadge      | Fixed 104×40 badge; logo normalized to 26px cap-height; name-wordmark fallback; always-shown mono core-id. New §5 entry. |
| D12 | Scrape dot         | `StatusIndicator` is 7px + haloless in list rows (color encoding kept). §5 amended. |
| D13 | ROMs view toolbar  | list/poster toggle + S–XL scale stepper; poster mode adds a Sort-by dropdown (Name/Year/Genre/Rating/Size) since it has no column headers. MAME-as-cores toggle lives in Settings. §5 amended. |
| D14 | DetailHeader | CoreInfoDialog + RomDetailDialog share one header primitive: kicker → logo-on-top → title → chips (Core) / subtitle (ROM). CoreInfo's logo moves from inline to top. §5 amended. |
| D15 | Detail footer | ROM detail's single filled button is "Find on ScreenScraper…"; Close is secondary (was filled). One-primary-per-screen rule. §5 amended. |
| D16 | Count pills | Pane-header counts are outline CountPills (total / hidden=amber / system=blue dots), replacing the "N ROMs · M hidden" text line. §5 amended. |
| D17 | Toggle switches | View-option booleans are Switches (accent-green on); row/tile selection stays a checkbox. §5 amended. |
| D18 | Pane-header layout | path+toggles row → count pills → tools row → actions row, shared by ROM + arcade panes. §5 amended. |
| D19 | Thumbnail radius | List + poster box-art thumbnails are rounded-md (was rounded-sm in list). §5 amended. |
| D20 | Selection ring | Selected list rows get a green left edge + tint; poster tiles get a green ring + corner checkmark. §5 amended. |
| D21 | Pane title | Core / pane name rendered as `text-heading font-bold text-fg` above the sub-path breadcrumb, not as mono body text. §5 amended. |
| D22 | Search full-width | Filter input in the tools row is `flex-1` — fills the remaining width, pushing view toggle + size stepper to the right edge. §5 amended. |
| D23 | Segmented action groups | Hide all/Unhide all, Hide selected/Unhide selected, Mark/Unmark system are joined segmented controls (`inline-flex overflow-hidden rounded border border-default`), not spaced separate buttons. §5 amended. |
| D24 | Header gradient | App top header uses `bg-gradient-to-b from-surface to-chrome` instead of flat `bg-chrome`. §5 amended. |
| D25 | Badge refinements | PlatformBadge logo 26px→32px cap-height; name-wordmark fallback uses `text-body-sm font-semibold` (was `text-[17px] font-bold`) so logo-less rows don't visually dominate. §5 amended. |
| D26 | DetailHeader compact | DetailHeader adds `compact` prop: CoreInfo keeps the roomy stacked layout (+50% logo to 72px); RomDetail uses compact inline logo+title on one row, tighter padding, `text-heading` title (was `text-heading-lg`). §5 amended. |
| D27 | CountPill polish | CountPill changed to `rounded-full h-5 px-1.5 text-caption` — smaller, fully-round pills. §5 amended. |
| D28 | Switch thumb contrast | Switch thumb is `bg-accent-fg` (dark) on ON/accent track, `bg-white` on OFF/overlay track. §5 amended. |
| D29 | Size header centering | "Size" header in ROM list uses `pr-8` to center over the 24px density bar only, not the full 56px column. §5 amended. |
| D30 | Progress ring + sub-task bar | Status bar gains a `ScrapeProgressRing` SVG (session overall: processedCoreCount+1 / totalCoreCount) and a thin sub-task bar (current core: done/total). Both show during `active`/`discovering` states; hide on `idle`. Data is available from the existing `AutoScrapeProgressEvent`. §5 amended. |
| D31 | CoreInfo header size | CoreInfo dialog: core name drops to `text-body font-bold` (was `text-heading`); metadata chips shrink to `text-caption px-[8px] py-[2px]`. §5 amended. |
| D32 | RomDetail compact header | RomDetail compact layout: logo left; stacked text right: (1) game title bold body, (2) system name muted body-sm, (3) publisher·year·genre muted body-sm. System name extracted from subtitle to its own line via `systemName` prop. §5 amended. |
| D33 | Thumbnail container clip | `DetailedThumbnailCell` (M/L/XL) wraps art in a fixed `overflow-hidden` container (`thumbPx × thumbPx*THUMB_ASPECT`). `TableHead` width matches exactly. Art can never bleed into the name column. §5 amended. |
| D34 | Sort persistence | `sortState` persisted globally at `mistercurator.sort.${host}` (serialized `key:dir`), shared by all ROM cores and the arcade pane. No longer resets on core switch. §5 amended. |
| D35 | Settings dialog | 1040px modal (`rounded-[14px]`, `bg-surface`, `border-default`, 88vh×672px bounded height, no footer); `border-b` header with title + green dot + mono host + boxed 32px close; `grid-cols-[1fr_396px]` body; mono-caps section labels (`11px`, `font-mono`, `fg-disabled`); option rows in `rounded-xl bg-canvas/40` cards; diagnostics status chip (amber count / success clear); flex-fill tables with mono-caps headers and row hover; `switch-off` token for the Switch off-state track. §5 amended. |
| D36 | Core menu style | New Display setting with three modes: **Text only** (name wordmark for all), **System logos** (logo or category icon, no name wordmark), **System images** (hardware photo from `catalogEntry.photoUrl` or category icon + name + `games/id` path). Persisted at `mistercurator.coreMenuStyle.${host}`. §5 amended. |

A few notes on the choices:

- **Signal green** stays culturally true to the references (SmartShort
  lime) and the audience (LED indicators, CRT phosphor). The "no
  dual-accents" rule is now load-bearing — if a future PR is tempted
  to introduce pink for cores or teal for ROMs, the panes should
  differentiate via icon and layout instead.
- **IBM Plex** carries more personality than Geist at display sizes
  (the connection-screen wordmark earns the space), and pairs with the
  deep-blue palette. Self-hosting is a mechanical workaround for the
  renderer's strict `default-src 'self'` CSP, not a stylistic choice.
- **40px rows** balance ROM-list scannability (50+ visible at a
  reasonable window height) against fingerprint-readiness; the
  references skew looser but they're not list-heavy.
- **Dark-only ship** keeps the visual-QA surface contained for the
  v0.1.0 release. The light tokens are already in `index.css` and the
  Tailwind config — flipping the body class is a one-line change in a
  follow-up PR.
- **Restrained wordmark** keeps the brand moment in-family and avoids
  another font load.

---

## 10. Density indicator addendum

The "no gradients" rule in section 7 has one carve-out: a per-row
density indicator. Round 2 of the design pass replaces the original
sparkline with a **full-height intensity rectangle** — a single solid
fill whose color is interpolated, in OKLCH space, between the row's
background tone and `accent`. This is the only place in the system
where two colors mix into one fill.

### What it is

A solid-filled rectangle pinned to the right edge of every list row.
The fill *color* (not width) varies with the row's `value / max`.
Rows that lead the pane glow signal-green; rows at the bottom fade
nearly invisible against the pane's surface tone.

```
Cores list (bg-surface)              ROMs list (bg-elevated)
┌──────────────────────────────┐     ┌──────────────────────────────┐
│ SNES                  227   ▰│     │ Final Fantasy III   4.0M    ▰│
│ NES                   118   ▰│     │ Chrono Trigger      3.8M    ▰│
│ Game Boy               59   ▰│     │ Earthbound          2.4M    ▰│
└──────────────────────────────┘     └──────────────────────────────┘
                              ↑                                    ↑
       intensity = romCount / maxRomCount    intensity = sizeBytes / maxSize
```

### Visual spec (rev. 2)

- **Geometry**: pinned to the row's right edge, after any trailing
  actions. Full row height, top and bottom flush to the row edges
  (≤1px breathing). Width = **24px** (`w-6`) — identical in the cores
  sidebar and the ROM list (final mockup value). No border-radius.
- **Fill**: a single flat color along a fixed **teal → signal-green**
  density ramp, indexed by `r = clamp(value / max, 0, 1)`:
  `color-mix(in oklch, hsl(var(--density-fill-low)) <(1 − r)×100%>,
  hsl(var(--density-fill-high)))`, where `--density-fill-low` is the
  teal floor and `--density-fill-high` is `accent`. The bar is a solid
  block — the magnitude reads from *hue/lightness*, never from width.
- **Row-bg basis**: no longer relevant — the bar is a solid block at
  full opacity against the row, not a low-r fade into the surface.
  Empty/zero-value rows render the floor teal (still visibly a bar),
  not "invisible against the row."
- **No glow, no halo, no animation.** Computed once per render.

Density tokens (add to both modes in `index.css`):

| Token               | Value                                         |
| ------------------- | --------------------------------------------- |
| `density-fill-low`  | teal floor of the density ramp (≈ `#2BB89B`) |
| `density-fill-high` | `accent` — top of the density ramp           |

> The floor was `fg-muted` grey in rev. 1. Rev. 2 makes it teal so the
> ramp reads as a deliberate teal→green scale. Pick the exact teal during
> implementation; `success` (`#3FCFA3`) is a reasonable anchor but a
> touch lighter — a slightly deeper teal reads better as "low."

### Where it appears

- **Cores list** (CoreRow): `r` uses each core's recursive ROM count
  (top-level files plus the contents of every container subfolder)
  rather than the top-level item count. Empty cores
  (`recursiveRomCount === 0`) render the rectangle at floor color
  (effectively invisible against the row). The cores-list label keeps
  showing the top-level count alongside the recursive total when the
  two diverge — e.g. NEOGEO's "9 folders · ~300 ROMs" — see §5
  Component patterns / List row count semantics.
- **ROMs list** (RomRow), file rows: `r = rom.sizeBytes / maxSize`.
- **ROMs list**, folder rows (atomic + container): same — folder
  size is the byte count `formatBytes` already shows.
- **Excluded**: system files (no rectangle at all), the arcade
  placeholder row, the back-row, and any row missing a value.

### What it is not

- Not a focus glow, not a hover highlight, not a selection halo.
- Not a progress bar (no animation, no shimmer).
- Not used on any non-list surface. The status bar's progress bar
  during a bulk op is a separate component that does not use this
  interpolation.

### Why a rectangle instead of a sparkline

The sparkline encoded `value / max` as fractional width inside a
fixed track. Width-as-magnitude works for charts but reads as
*progress* on a row — every row looks like a partially-completed
task. The intensity rectangle encodes the same magnitude as
saturation against the row surface, which is what hardware-tool
audiences associate with "this is the heavyweight in the list" (level
meters, signal strength). The geometry also makes the indicator
**always present** at the same position, so the eye has a fixed
column to track.

Rev. 2 widens the bar to ~row-height and makes it full-bleed top-to-
bottom so the density column is unmistakable as a fixed scannable
lane, and switches the fill from a fade-into-surface mix to a solid
teal→green block: at a glance the *column of color* is the signal, and
faint near-floor rows no longer disappear. The fill still encodes
magnitude as color (level-meter mental model), not as width/progress.

If a future PR is tempted to apply this OKLCH interpolation to
anything besides these per-row indicators, it should propose it as a
new addendum and get explicit approval. The constraint is the design.

---

## Appendix: token shorthand for Phase 2

This section is a forward reference — Phase 2 will use these names in
`tailwind.config.js` and `index.css`.

```
colors:
  bg.canvas      → bg-canvas
  bg.chrome      → bg-chrome
  bg.surface     → bg-surface
  bg.elevated    → bg-elevated
  bg.overlay     → bg-overlay
  fg.primary     → fg-primary
  fg.body        → fg-body
  fg.muted       → fg-muted
  fg.disabled    → fg-disabled
  border.subtle  → border-subtle
  border.default → border-default
  border.emphasis→ border-emphasis
  accent.DEFAULT → accent
  accent.hover   → accent-hover
  accent.active  → accent-active
  accent.soft    → accent-soft
  accent.fg      → accent-fg
  success / warning / destructive / info
fontFamily:
  sans → ['IBM Plex Sans', 'system-ui', 'sans-serif']
  mono → ['IBM Plex Mono', 'ui-monospace', 'monospace']
fontSize:
  caption / body-sm / body / body-lg / heading-sm /
  heading / heading-lg / display
borderRadius:
  sm 4 / DEFAULT 6 / md 8 / lg 12
boxShadow:
  modal → 0 16px 48px -16px rgb(0 0 0 / 0.7)
```

shadcn `cva` consumes the same names via CSS variables — no parallel
universe of token sources.
