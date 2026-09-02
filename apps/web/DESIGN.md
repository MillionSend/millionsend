# MillionSend dashboard design system — "Rollover"

Scale stated as numbers that keep counting. Black void, bone type, one steel
accent per view. **Dark theme only.** All values live in `src/styles/` as
`--ms-*` custom properties; components apply the `ms-*` classes from
`components.css`. Do not invent new colors, radii, or font sizes.

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
- Timestamps compact and relative: "24min ago", "1h ago".
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
fill, 1px line, 14px radius, 24px padding. Controls compact per the canvas
overrides: `.ms-btn` 6px 12px, `.ms-input` 6px 10px / line-height 1.4,
`.ms-btn-icon` an exact 30×30 square — everything lands ≈30px tall. Lists
(`.ms-table`) run at 13px with 6px cell padding — ≈40px rows, so a page of
contacts or emails fits a laptop viewport; "Load more" lives in the shared
`ListFooter` at the right, beside the page-size chooser, and any secondary
action under a table or section is right-aligned. Modals
are **centered in the viewport** (both axes), overlay `rgba(0,0,0,.72)`, no
blur.

**Mobile (breakpoint 900px).** Below 900px the sidebar becomes an off-canvas
drawer behind a 48px sticky topbar (hamburger `.ms-btn-icon` + wordmark on
panel bg, hairline bottom); the drawer slides over content with the modal
scrim, closes on nav/scrim/Esc, and locks body scroll while open. Content
padding collapses to 16px. Page headers and filter rows wrap (search takes
the full first line); meta/stat grids drop to 2-up then 1-up (<480px);
side-by-side KPI cards stack; stepper rails hide or shrink under 640px.
Modals go `calc(100vw - 24px)` under 480px; `.ms-menu` popovers clamp to the
viewport. Tables scroll horizontally **inside their own wrapper** (the shared
`<Table>`) — the page itself never scrolls horizontally. All rules live in
the delimited responsive section at the end of `components.css` (media
queries only; desktop ≥900px is untouched).

## Controls

- Buttons never show a text underline — `.ms-btn` sets
  `text-decoration: none` so Link-rendered buttons don't inherit the dotted
  link treatment.
- **Focus-outline policy:** interactive controls (`.ms-btn`, `.ms-input`,
  `.ms-menu-item`) show the steel `--ms-focus-ring` on `:focus-visible`
  only — a11y non-negotiable. Everything else — dialog panels, chart/svg
  containers, anything focused programmatically via `tabindex="-1"` — gets
  `outline: none`. No browser-blue outline anywhere, ever.
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
