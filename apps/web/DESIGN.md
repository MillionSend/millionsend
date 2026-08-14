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

**Text is the icon system.** Interface glyphs are unicode in the running
font: `⧉` copy, `✓` confirmed, `●` status dot, `…` overflow, `</>` code
(mono), `→` follow-through. The only drawn icons are the 10 nav glyphs in
`src/components/nav-icon.tsx` and the logos in `public/logo/` (never
redrawn). Do not add icon fonts or icon libraries.

## Fonts

- **Erode** (Fontshare, © Indian Type Foundry): loaded from the Fontshare
  CDN in the root layout. The EULA forbids committing the font files to this
  repository — never vendor them. Georgia/serif is the offline fallback.
- **JetBrains Mono** (OFL): `@fontsource/jetbrains-mono` (400/500/700).

## Layout

Fixed 300px sidebar on `--ms-panel`; content column on void with 75px
gutters. Cards: panel fill, 1px line, 14px radius, 24px padding. Controls
compact: buttons/inputs ≈34px. Modals drop from top (14vh offset), overlay
`rgba(0,0,0,.72)`, no blur.
