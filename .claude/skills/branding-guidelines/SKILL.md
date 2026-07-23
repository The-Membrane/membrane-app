---
name: branding-guidelines
description: >-
  Comprehensive branding and visual identity guidelines for membrane-app. Use this skill whenever the user asks about
  brand colors, visual identity, design language, Ditto mascot usage, UI aesthetic decisions, component styling,
  atmosphere/motion effects, or any question about how membrane-app should look and feel. Also trigger when the user is
  building new components, pages, or features and needs to match the existing visual language — even if they just say
  "make it look right" or "match the existing style." Covers the complete brand system: Living Typeface (bone-on-black,
  phosphor, hairlines, sharp corners), token tables, typography, motion, atmosphere effects, mascot theming, and brand voice.
---

# Membrane App Branding Guidelines — Living Typeface

Membrane's current brand direction is **Living Typeface**: warm bone ink on near-black, phosphor-green
accents, sharp corners, hairline dividers, a serif display face that can grow moss at the edges, and
JetBrains Mono for everything a user needs to trust as real data. It replaces the earlier
cyberpunk/neon/purple system (see **Migration Status** below — the app is mid-transition).

## Brand Personality

**Core traits:** A living organism grown over machine rails. Calm and precise at the core, a little
wild at the edges.

Membrane handles real money, so the machine side must feel exact — hairline grids, monospace numbers,
sharp corners, instant legibility. But the brand also has a living side: a serif typeface that
visibly grows moss and pixelation the closer you get to display scale, and atmosphere effects (light
shafts, drifting motes, moss patches) reserved for the places where the product is allowed to breathe.
The balance is: *precise where money is at stake, alive where it's safe to wander.*

## The Cyber ⇄ Organic Axis

Every surface in the app sits somewhere on this axis, and should commit to one side rather than
splitting the difference:

- **Cyber end:** hairline borders, mono type, sharp corners, cyber teal accents, grid rhythm. This is
  the default for anything transactional — forms, tables, balances, modals.
- **Organic end:** serif display type (including the pixelated/moss variants), phosphor and gold,
  atmosphere layers (scanlines, canopy glow, motes). Reserved for heroes, landing pages, and section
  openers — never inside a component the user is actively transacting through.

## Visual Foundation: Dark Mode Only, Warm Bone Not White

The entire app lives in near-black (`#09090a`), not navy and not pure black-black. Text is warm bone
(`#ece6d8`), never `#fff` or Chakra `whiteAlpha.*` — pure white reads cold and clashes with the serif's
organic warmth. Cards are flat dark panels with a single hairline border — no glass blur, no rounded
corners, no drop shadows doing brand work.

---

## Token Tables

### Ink (text)

| Role | Hex | Usage |
|------|-----|-------|
| Bone (primary) | `#ece6d8` | Headings, primary content |
| Dim (secondary) | `#8d877b` | Supporting text, descriptions |
| Faint (tertiary) | `#56524a` | Timestamps, metadata, least important |

### Background

| Layer | Hex | Usage |
|-------|-----|-------|
| Page | `#09090a` | App background |
| Raise | `#100f12` | Hover/pressed background step |
| Card | `#0e0d10` | Card/panel surfaces |

### Hairlines (borders)

| Weight | Value | Usage |
|--------|-------|-------|
| Default | `rgba(236,230,216,0.10)` | Standard card/divider borders |
| Strong | `rgba(236,230,216,0.22)` | Hover state, emphasized/focused borders |

### Accents

| Role | Hex | Meaning / usage |
|------|-----|------------------|
| Phosphor | `#9bdc4f` | Primary, positive, up/healthy, main CTAs |
| Cyber teal | `#46d39a` | Machine-side emphasis, secondary actions, info |
| Gold | `#d8b24a` | Gates, warnings, caution, decorative flecks/motes |
| Blood | `#cf4034` | Negative, down/behind, errors, destructive actions |

### Semantic Color Mapping

| Semantic role | Accent | Notes |
|----------------|--------|-------|
| `success` | Phosphor `#9bdc4f` | Confirmations, healthy positions, positive deltas |
| `warning` | Gold `#d8b24a` | Approaching limits, gated actions |
| `danger` | Blood `#cf4034` | Errors, liquidation risk, destructive actions |
| `info` | Cyber teal `#46d39a` | Tooltips, informational, machine-side content |
| `primary` | Phosphor `#9bdc4f` | Main CTAs, organic/living emphasis |
| `secondary` | Cyber teal `#46d39a` | Secondary actions, machine emphasis |

All colors are defined in `config/semanticColors.ts` — never hardcode hex values inline. Note: as of
this writing not every value in that file has been migrated yet (see Migration Status).

---

## Typography

**Display font:** Redaction (serif), embedded as woff2 in the canonical design file. Variants range
from `10` (nearly clean serif) to `100` (heavily pixelated/moss-grown). Fallback: Georgia, serif.
**Functional font:** JetBrains Mono, weights 400/500/700. Fallback: `ui-monospace`, monospace.

### Typography Roles

| Role | Font | Where |
|------|------|-------|
| **Display** | Redaction, low-pixelation variants | Page (h1) and section (h2) headings |
| **Heading** | Redaction | h3/h4 card and subsection titles |
| **Editorial / italic** | Redaction Italic | Sub-copy, pull quotes, voice-forward copy |
| **Living face** | Redaction, high-pixelation/moss variants (70-100) | Wordmark, hero titles, section openers ONLY |
| **Data** | JetBrains Mono | Balances, LTVs, APRs, any number |
| **UI** | JetBrains Mono | Buttons, inputs, body copy, nav |
| **Micro / eyebrow** | JetBrains Mono, uppercase, letterspacing `0.28em` | Labels, table headers, numbered eyebrows (`"01 /"`) with a 24px leading rule |

### Scale

| Token | Size | Weight | Font |
|-------|------|--------|------|
| `h1` | 32px | Bold (700) | Redaction |
| `h2` | 24px | Semibold (600) | Redaction |
| `h3` | 18px | Semibold (600) | Redaction or Mono |
| `h4` | 16px | Medium (500) | Redaction or Mono |
| `body` | 16px | Normal (400) | JetBrains Mono |
| `small` | 14px | Normal (400) | JetBrains Mono |
| `xs` | 12px | Normal (400) | JetBrains Mono |
| `label` | 11px | Normal (400) | JetBrains Mono, uppercase, letterspacing 0.28em |

Import from `helpers/typography.ts`. **Rule of thumb: prose reads in serif, data reads in mono** — a
sentence describing a position can be serif, the number inside it is always mono.

---

## Shape Rules

- **No border-radius, anywhere.** Cards, modals, buttons, inputs, tooltips — all sharp corners
  (`borderRadius={0}`). This is a hard break from the old system's 24px/16px/8px rounding scale.
- **Cards = flat background + 1px hairline border.** No glass blur, no elevation shadow doing brand
  work. `bgCard` (`#0e0d10`) + `1px solid hairline`.
- **Dividers are hairlines**, not gradient-fade lines. `rgba(236,230,216,0.10)`, brightening to `0.22`
  for emphasis.

---

## Motion

Living Typeface motion is deliberately quiet. Two registers only:

### Interactive motion (UI components)

- **Color/border transitions only** — `.15s`, no easing drama.
- Hover = hairline brightens (`0.10` → `0.22` alpha) or text/icon color shifts to phosphor.
- Press = slight opacity dim. **No `translateY` lift, no scale, no box-shadow glow bloom.**
- Focus ring = `1px solid` phosphor outline, offset 2px. Not a blurred purple box-shadow ring.

### Atmosphere motion (opt-in, non-interactive)

- Slow ambient **breathe** (opacity pulse) and **sway** (subtle position drift) for background/
  decorative layers only.
- Used for: canopy glow, light shafts, drifting motes, moss growth animation.
- **Never** applied to buttons, cards, inputs, or anything the user clicks/reads for data.

All standardized transitions live in `config/transitions.ts`. If you find `HOVER_EFFECTS.lift`,
`.scale`, or `.glow` still in use, that's legacy code — don't extend it, migrate it.

---

## Atmosphere Recipe

Atmosphere layers are the "organic" side made visible. They are **opt-in decoration**, allowed only in
heroes, landing pages, and section openers — **never inside data tables, forms, or transactional
components.**

| Effect | Technique | Where |
|--------|-----------|-------|
| **Scanlines** | `repeating-linear-gradient` overlay, low opacity | Hero backgrounds |
| **Canopy glow** | Radial gradients (green/gold), `mix-blend-mode: screen` | Behind hero copy, section openers |
| **Light shafts** | Angled linear gradients, slow drift | Hero backgrounds |
| **Gold motes** | Small particles, slow float/drift animation | Heroes, footers |
| **Moss patches / grass tufts** | Procedurally grown in-browser: value-noise field, glyph-masked pixel grid, counters flood-filled — nothing is a baked image | Footer, wordmark edges, section openers |
| **Animated grain** | SVG turbulence filter, very low opacity | Full-page overlay (sparingly) |

**Layout companion rules:** 1080px max content width, 78px section padding, sections separated by
hairlines (not cards), sticky topbar with blur.

---

## Pixel-Moss Living Face — Usage Rules

The heavily-pixelated/moss-grown Redaction treatment (variants 70-100) is the most distinctive and
most restricted asset in the system:

- ✅ Wordmark / logotype
- ✅ Hero headlines
- ✅ Section openers (numbered eyebrow + big heading)
- ❌ Card titles, table headers, buttons, nav — use plain Redaction (low-pixelation) or mono instead
- ❌ Anything a user reads to make a financial decision — always fall back to clean serif or mono

The moss is grown procedurally (noise-based, glyph-masked, flood-filled) in the canonical design file —
never regenerate it as a static image; if you need it, source it from that file.

---

## Chart Palette

Ordered for multi-series charts, built entirely from the accent + ink tokens (no purple, no old cyan):

1. `#9bdc4f` (Phosphor)
2. `#46d39a` (Cyber teal)
3. `#d8b24a` (Gold)
4. `#cf4034` (Blood)
5. `#8d877b` (Bone dim)
6. `#c3e896` (Phosphor tint, lighter)
7. `#8fe0c0` (Teal tint, lighter)
8. `#56524a` (Faint gray)

### Chart Styling

- **Grid:** hairline default (`rgba(236,230,216,0.10)`)
- **Axis text:** bone dim (`#8d877b`), mono font
- **Tooltip:** `bgCard` (`#0e0d10`) with hairline-strong border, sharp corners
- **Liquidation line:** blood, dashed (5 5)
- **Target line:** phosphor, dashed (3 3)

Chart theming is defined in `config/chartTheme.tsx` — still mid-migration from the old cyan/purple
multi-series palette (see Migration Status).

---

## Component Patterns

The app uses Chakra UI with heavy customization. Component styling is centralized in the `/theme/`
directory.

### Cards
Variants: `default`, `elevated`, `subtle`. All use `borderRadius={0}`, `bgCard` background, 1px
hairline border. Interactive cards brighten their hairline to `0.22` alpha on hover — no scale, no
glow.

### Buttons
Primary = phosphor solid, sharp corners. Ghost = transparent with hairline border-highlight on hover.
No lift. Focus ring is a 1px phosphor outline.

### Modals
Background `bgCard`, `borderRadius={0}`, 1px hairline border. No backdrop glow. Standard body padding
is `pb={6}` (24px).

### Inputs
Background `bgCard`, 1px hairline border, sharp corners. Focus = 1px phosphor outline. Invalid =
blood border.

Full component specs are in `CLAUDE.md` and the `/theme/components/` directory.

---

## The Ditto Mascot

Ditto is Membrane's companion character — a state-aware interpreter that guides users through the
app. It's NOT a chatbot, tutorial wizard, or dashboard. Ditto explains *why things matter*, blocks
dangerous actions, and surfaces meaningful state changes. This behavioral contract is unchanged by the
Living Typeface migration — see `references/ditto-character.md` for full voice, message-type, and
state-machine rules.

### Character Design — Open Question

Ditto's existing neon-themed variants (purple/cyan/teal glow panels, per-section hat + glow color) are
**legacy cyberpunk-era assets.** They have not been redesigned for Living Typeface. Treatment options
(serif/moss Ditto? mono-line Ditto? kept as an intentional cyber-side exception?) are an **open
question — do not invent a new Ditto visual design without design sign-off.** Until a decision is
made, existing Ditto assets and glow theming continue to render as-is; don't propagate their glow
patterns to new non-Ditto components.

See `references/ditto-character.md` for the legacy theming table and current voice/behavior rules.

---

## Responsive Design

Mobile-first with these breakpoints:

| Token | Width | Target |
|-------|-------|--------|
| `base` | 0px | Mobile default |
| `xs` | 375px | Small phones |
| `sm` | 480px | Large phones |
| `md` | 768px | Tablets |
| `lg` | 992px | Laptops |
| `xl` | 1280px | Desktops |
| `2xl` | 1536px | Large screens |

Touch targets are minimum 44px on mobile. No horizontal scroll. Page padding scales from 16px (mobile)
to 32px (desktop). Landing/hero layout uses a 1080px max content width with 78px section padding.

---

## Quick Decision Framework

When you're making a visual decision and you're not sure what's "on brand," use these filters:

1. **Is it sharp?** No border-radius, anywhere. If it's rounded, it's wrong.
2. **Does it use semantic colors correctly?** Success = phosphor, warning = gold, danger = blood,
   info = teal. No purple, no old cyan.
3. **Does it glow, lift, or scale?** It shouldn't — that's the old cyberpunk language. Hover = hairline
   brightens or color shifts. That's it.
4. **Is the number in mono?** Any balance, LTV, APR, or metric must be machine-readable mono — never
   the display serif.
5. **Is atmosphere decoration confined to heroes/openers?** Scanlines, canopy glow, motes, moss —
   never inside a data table or transactional form.
6. **Is it consistent with the spacing scale?** Use SPACING constants, never arbitrary pixel values.

---

## Migration Status

**Honest state as of this writing:** the token set, typography roles, and component rules above are
the target — but the app's component long tail has not fully migrated yet. Expect to still find:

- Purple hexes (`#A692FF`, `#6943FF`) and old cyan (`#22d3ee`, `#20d6ff`) hardcoded in older
  components, especially Disco/Manic/Acquisition feature sections
- `borderRadius="24px"`/`16px`/`8px` rounding on cards, modals, and inputs that haven't been touched
- Lift/scale/glow hover effects (`translateY`, `boxShadow` blooms) still wired into some buttons and
  cards
- Ditto's neon per-section glow theming (unchanged — see Open Question above)
- Chart palettes in `config/chartTheme.tsx` still using the old cyan/purple/pink multi-series order

Treat these as things to migrate when you touch that code, not as reference patterns to copy into new
work. When in doubt, this doc and `CLAUDE.md` are the source of truth — not the nearest existing
component.

---

## Key Source Files

| What | Where |
|------|-------|
| Color system | `config/semanticColors.ts`, `config/defaults.ts` |
| Spacing system | `config/spacing.ts` |
| Typography | `helpers/typography.ts` |
| Transitions & animations | `config/transitions.ts` |
| Chart theming | `config/chartTheme.tsx` |
| Ditto themes | `config/dittoThemes.ts` |
| Ditto messages | `config/dittoMessages.ts` |
| Chakra theme overrides | `theme/` directory |
| Global CSS & keyframes | `styles/global.css` |
| Card component | `components/ui/Card.tsx` |
| Brand assets | `public/images/` |
| Full design system spec | `CLAUDE.md` |
| Ditto voice/behavior detail | `references/ditto-character.md` |
| Atmosphere/motion detail | `references/atmosphere-and-motion.md` |
