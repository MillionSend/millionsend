# MillionSend dashboard design system — "Rollover"

Scale stated as numbers that keep counting. Black void, bone type, one steel
accent per view. **Dark theme only.** All values live in `src/styles/` as
`--ms-*` custom properties; components apply the `ms-*` classes from
`components.css`. Do not invent new colors, radii, or font sizes; the one
sanctioned exception is the touch text-field size (Controls).

## The five rules

1. **Steel `#7F8791` appears exactly once per view** — the primary CTA, the
   live status dot, or the lit odometer digit. If two things are lit, one is
   wrong. The primary button is **bone-filled**, not steel.
2. **Separation by darkness + 1px `--ms-line` lines.** No shadows, no colored
   card fills, no elevation system. The only glow is the steel focus ring.
3. **Erode at display sizes (≥20px) only, weight 500** (page titles 30px,
   card/modal titles 22px — `.ms-display`). UI/body = system grotesque. Data
   (IDs, emails, DNS, code) = JetBrains Mono (`.ms-mono`).
4. **Every number that counts = tabular figures, weight 800** (`.ms-digits`),
   animating as an odometer digit-roll — the product's only flourish
   (`prefers-reduced-motion` → plain swap). Never Erode for numbers.
5. **Status colors stay dim and desaturated and always carry text labels.**
   Semantic only, never decorative, never the accent.

## Voice — deadpan, numeric, engineer-to-engineer

- Lead with the number, state facts, stop: "12,847 delivered. 3 bounced."
- **No exclamation points. No "Oops". No emoji.** No cheer, no apology theater.
- Sentence case everywhere — buttons ("Create API key"), headers, nav.
  Uppercase only in 11px `.ms-microlabel` ("EMAILS DELIVERED").
- Empty states state the count: "0 API keys."
- Data rendered as data: full addresses, real UUIDs, masked keys
  (`ms_••••••••abcd`), mono DNS values. Never truncate a value an engineer
  might paste — give it a copy button (`.ms-chip`) instead.
- Timestamps compact and relative: "24min ago", "1h ago" — the exact local
  stamp shows on hover (`RelativeTime`), never inline.
- Keycaps are part of the copy: ⌘ ↵ in modal confirm buttons, Esc to cancel.
- Every user-facing string lives in the i18n catalogs. No hardcoded copy.

## Iconography

**Text is the icon system for inline affordances:** unicode glyphs in the
running font — `⧉` copy, `✓` confirmed, `●` status dot, `…` overflow, `</>`
code (mono), `→` follow-through. The drawn icons are the 10 nav glyphs in
`src/components/icons/nav-icons.tsx`: lucide-derived (ISC) paths, 16px,
stroke 1.4, currentColor, each with a semantic hover micro-animation driven
by `motion` (≤500ms on `--ms-ease`, disabled under
`prefers-reduced-motion`) and triggered by the parent nav item's hover. The
command palette and page action buttons may reuse these glyphs. Do not add
other icon fonts or icon libraries. Logos in
`public/logo/` are never redrawn.

## Fonts

- **Erode** (Fontshare, © Indian Type Foundry): loaded from the Fontshare
  CDN in the root layout. The EULA forbids committing the font files to this
  repository — never vendor them. Georgia/serif is the offline fallback.
- **JetBrains Mono** (OFL): `@fontsource/jetbrains-mono` (400/500/700).

## Layout

Fixed 240px sidebar on `--ms-panel`; content column on void with the canvas
main-block padding: `32px 40px` (40px gutters — never wider). Cards: panel
fill, 1px line, 14px radius, 24px padding; console cards (`/console`) run
denser at 20px, and console stat tiles at `16px 20px`. Controls compact per
the canvas overrides: `.ms-btn` 6px 12px, `.ms-input` 6px 10px / line-height
1.4, `.ms-btn-icon` an exact 30×30 square — everything lands ≈30px tall. Lists
(`.ms-table`) run at 13px with 6px cell padding — ≈40px rows, so a page of
contacts or emails fits a laptop viewport; the shared `ListFooter` holds the
page-size chooser and then "Load more" at the right, both drawn as secondary
buttons, and any secondary action under a table or section is right-aligned.
Modals are **centered in the viewport** (both axes), overlay
`rgba(0,0,0,.72)`, no blur.

**Page header** (`PageHeader`). The H1 carries its **status badges** in the
`badges` slot, right after the title's last word on its line; they wrap
under it as a group and never sit among the actions. The mono meta line
under it is " · "-joined parts and breaks only between them. The actions
share the title's row only while the title block keeps its natural width;
otherwise they take their own row under the meta line, at any viewport
width. The trailing icon action ("…" overflow, `</>` API) goes in the
`menu` slot and never starts a row alone.

**Label/value lists** (`.ms-kv` with `KvRow`: region cards, the team
dialog, settings). A value sits right-aligned on its label's line when the
whole of it fits there, and otherwise takes the line under the label at full
width; a " · "-joined value breaks only between its parts, in balanced
lines.

**Strips and dialogs.** A notice strip's action stays beside the text while
the text keeps 18rem, and otherwise takes its own line under it; the support
strip's two buttons share the full width on a phone. Dialog footers are
**not sticky**: the footer is the last thing in a dialog and scrolls with
its content; nothing renders after it. A dialog title, like the meta line,
breaks only between its " · " parts ("Ajustar limites · <team>"), and a
dialog's text wraps a long URL or address rather than widen the dialog.

**Floating panels** — menus, selects, pickers, anchored panels, tooltips,
chart hover tips — measure themselves after rendering and stay inside the
viewport with a 12px margin: they flip above or below, shift sideways, and
cap their size (`src/lib/panel-placement.ts`). A **chart tip** never covers
the pointer or the hovered point: it sits above the plot, centred on the
pointer. Without room above, a mouse's tip drops below the plot; a touch's
never does (the hand would hide it) but rises from above the fingertip,
beside the touched column.

**Narrow desktop (900–1199px).** Beside the sidebar the content column is
under 880px: the console's 4-up grids go 2-up and its 2/1 splits stack, a
detail page's meta grid lays out as many columns as keep each value 11rem
wide, and no meta value widens its column (a long chip ellipsizes). In a
list a long address wraps at its "@" and dots (`Breakable`) rather than push
the list sideways. Filter rows, wrap rows and steppers wrap at every width
rather than overflow.

**Mobile (breakpoint 900px).** Below 900px the sidebar becomes an off-canvas
drawer behind a 48px sticky topbar (hamburger `.ms-btn-icon` + wordmark on
panel bg, hairline bottom); the drawer slides over content with the modal
scrim, closes on nav/scrim/Esc, and locks body scroll while open. Content
padding collapses to 16px. Header actions take the full width under the
title, each button sharing its row; the search takes the full first line of
a filter row and the selects share the lines under it (one per line under
480px); meta grids drop to 2-up then 1-up (<640px), while stat strips stay
2-up; side-by-side KPI cards stack; the console's 6-up stat tile strip drops
to 3-up then 2-up (<640px); stepper rails hide or shrink under 640px. Modals
go `calc(100vw - 24px)` under 480px and their footer buttons share the width.
Toasts drop from under the topbar (<640px) so they never cover a dialog's
footer. Tables scroll horizontally **inside their own wrapper** (the shared
`<Table>`) — the page itself never scrolls horizontally — and a list's row
menu ("…") column sticks to the wrapper's right edge at any width. An email's
events strip reads top to bottom. On touch screens
keycaps are hidden, small glyph controls (✕, ⓘ, a chip's copy button) get a
finger-sized hit area, and bulk-select checkboxes show in a column of their
own. The narrow-desktop and phone rules live in the delimited responsive
section of `components.css`; every rule above it holds at every width.

## Controls

- Buttons never show a text underline — `.ms-btn` sets
  `text-decoration: none` so Link-rendered buttons don't inherit the dotted
  link treatment.
- **Focus-outline policy:** interactive controls (`.ms-btn`, `.ms-input`,
  `.ms-menu-item`) show the steel `--ms-focus-ring` on `:focus-visible`
  only — a11y non-negotiable. Everything else — dialog panels, chart/svg
  containers, anything focused programmatically via `tabindex="-1"` — gets
  `outline: none`. No browser-blue outline anywhere, ever.
- **Text fields on touch screens:** under `(pointer: coarse)` every text
  input, textarea and the `<Select>` trigger runs at 16px
  (`--ms-fs-input-touch`), the only size outside the type scale: iOS Safari
  zooms the page into any field under 16px when it takes focus. Desktop
  keeps 14px.
- **Select:** never render native `<select>`. Use `<Select>` from
  `src/components/select.tsx` — compact `.ms-input` trigger with a `.ms-chev`
  chevron, `.ms-menu` listbox popover, built-in search when there are more
  than 6 options, full keyboard + ARIA combobox support, ✓ on the selected
  row. Options are `{ value, label, hint? }`; controlled `value` +
  `onChange`.
- **Menus/popovers** use the `.ms-menu` grammar (canvas "…" dropdowns): panel
  bg, 1px `--ms-line-strong`, 14px radius, 6px padding; 13px item rows at
  7px 12px that raise to `--ms-panel-raised` (8px radius); `.ms-menu-sep`
  hairline separators. `<PopoverMenu>` in `src/components/popover-menu.tsx`
  is the "…" overflow menu.
- Search inputs carry no "/" keycap for now (removed in visual QA).
