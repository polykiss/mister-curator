# MiSTerCurator Design System

Status: **Locked.** Phase 1 proposal accepted with revisions; Phase 2
applies it across the app. See section 9 (Decisions) for what changed
between proposal and lock-in.

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
**exclusively** for active navigation state and one primary CTA per
screen. Never used for status or success.

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
| List row (cores, ROMs)     | **40px** | Tight enough for 50+ visible; loose enough to click  |
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

- Height 40px, paddingX 16px, no borders by default
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

### Status bar

32px, `border-t border-subtle`, lives at bottom of window. Slot layout:

```
●  Connected  ·  bedroom-mister  ·  192.168.1.42:22                          1247 ROMs · 312 hidden
```

- Caption type, single line
- Bullet (`·`) separators are `fg-disabled`
- Host slot is mono
- Right-aligned slot: counts (mono), or progress text during bulk ops

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
| Core              | `Cpu`             |
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
| Q3 | Row density  | **40px** rows.                                                                            |
| Q4 | Light mode   | **Defer to post-v0.1.0.** Tokens wired for both modes; `<body>` forced to `dark`.         |
| Q5 | Wordmark     | **Restrained.** Plex Sans 700 with letter-spacing `-0.02em`. No separate display font.    |

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

### Visual spec

- **Geometry**: pinned to the row's right edge, after any trailing
  actions. Width = 50% of the row height (~20px on a 40px row),
  height = full row height, no border-radius (sharp rectangle).
- **Fill**: `color-mix(in oklch, <row-bg> <(1 - r) × 100%>, hsl(var(--accent)))`
  where `r = clamp(value / max, 0, 1)`. The mix happens in OKLCH so
  the perceptual midpoint reads as a midpoint, not a muddy lerp
  through HSL grey.
- **Row-bg basis**: matches the pane the row lives in.
  - Cores list (sits on `bg-surface`): floor color is `bg-surface`.
  - ROMs list (sits on `bg-elevated`, see §4 / pane elevation): floor
    color is `bg-elevated`.
  At `r = 0` the rectangle is invisible against the row; at `r = 1`
  it is full signal-green.
- **No glow, no halo, no ambient bleed, no animation.** Computed
  once per render, stable across hover.

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
