---
name: canvas-ui
description: >-
  How and where to use Canvas UI (canvasui.dev) — GPU/WebGL "html-in-canvas" effect components (Grid, Liquid,
  Particle Reveal, Shatter, VHS, Ripple, Glass, Dithered/Particle Object, etc.) — inside membrane-app under the
  Living Typeface brand. Use this skill whenever the user wants a hero effect, section-opener animation, landing
  atmosphere, animated wordmark, empty-state flourish, an interactive "game screen" (the Foundry), or a mascot
  treatment — or says "add a canvas effect", "make the hero pop", "use canvasui", "webgl background", "particle
  reveal", "shader effect". It maps each Canvas UI component to the Cyber⇄Organic axis, gives brand-correct tints,
  install/usage, and the HARD rule that these are display-only atmosphere — never applied to app chrome, cards,
  tables, forms, balances, or any surface a user transacts on. Pairs with [[branding-guidelines]].
---

# Canvas UI in membrane-app

**Canvas UI** (https://canvasui.dev, by David Haz) is an open-source library of "html-in-canvas" + WebGL
components that render your *live HTML* through GPU shader effects (refraction, particles, ripples, dither,
glitch). Framework-agnostic (React/Vue/Svelte/vanilla TS), copy-paste via the shadcn CLI, MIT + Commons Clause.

They exist to make a surface feel alive. In Living Typeface terms that means exactly one thing: **they are
atmosphere.** Read the non-negotiable rule before reaching for any of them.

---

## 🚫 The one hard rule: atmosphere-only

Canvas UI components are **display-only atmosphere for heroes, landing pages, section openers, empty states, and
the Foundry game screen.** They are the same tier as the brand's `.lt-scanlines` / `.lt-canopy` / moss layers —
opt-in, decorative, non-interactive.

**NEVER wrap or overlay:**
- App chrome — nav, sidebars, modals, toasts
- Cards, tables, lists — anything in `NeutronMint`, `Bid`, `Disco`, `Dashboard`, `Portfolio`, `ManagedMarkets`
- Forms, inputs, buttons, sliders — anything a user clicks or types into
- **Numbers, balances, LTVs, APRs, amounts** — brand rule #3: numbers are always machine-readable (JetBrains
  Mono), never refracted, dithered, particle-ized, or shattered. Refracting a balance is a correctness hazard,
  not a flourish.

Why it matters beyond taste: these use the **experimental Chrome `html-in-canvas` origin-trial API + WebGL**.
On Safari/Firefox and any browser without the trial they **degrade gracefully to plain HTML** — so the effect
is never guaranteed. Never let a transacting flow depend on one rendering. Atmosphere can vanish; a Deposit
button cannot.

Also inherit the brand's motion rule: **no lift / scale / glow on interactive UI.** A Canvas UI effect on a
hero is fine; the same effect responding to hover on a real button is not.

---

## Install & usage

```bash
# React (copies source into your repo — no runtime dependency)
npx shadcn@latest add @canvas-ui/<name>-react     # e.g. @canvas-ui/grid-react
```

```tsx
import { Grid } from '@canvas-ui/grid-react'

// Wrap DISPLAY content only — a hero headline, a wordmark, a section opener.
<Grid tileSize={120} amplitude={2.2} tint={[0.61, 0.86, 0.31]} tintStrength={0.12}>
  <HeroWordmark />
</Grid>
```

Built-in safety that fits the brand (verify per component before shipping):
- Respects `prefers-reduced-motion` (animation disables) — matches the `MotionConfig reducedMotion="user"` in `_app.tsx`.
- `IntersectionObserver` pauses rendering offscreen; DPR capped at 2×.
- Graceful fallback to normal HTML where the API/WebGL is unavailable.

**Brand tinting:** most components expose a color/tint. Always push it onto the palette — never ship the demo
blue. Tints are `[r, g, b]` in 0–1:
- phosphor `#9bdc4f` → `[0.61, 0.86, 0.31]` (primary / organic-positive)
- cyber teal `#46d39a` → `[0.27, 0.83, 0.60]` (machine emphasis)
- gold `#d8b24a` → `[0.85, 0.70, 0.29]` (gates/flecks)
- bone `#ece6d8` → `[0.93, 0.90, 0.85]` (neutral hairline glow)
- Keep `tintStrength` low (~0.08–0.15). Backgrounds are near-black `#09090a`; the effect should whisper.

---

## Component → membrane-app map (Cyber ⇄ Organic axis)

Pick along the axis: **Cyber** (precise, grid, machine) vs **Organic** (fluid, grown, imperfect). Never split
the difference into generic.

### Cyber end — machine / grid / signal
| Component | Effect | Use in membrane-app |
|-----------|--------|---------------------|
| **Grid** | 3D tiles ripple in staggered waves around cursor | **Top pick.** Hero / section-opener background; the phosphor-tinted evolution of the static hex grid. Machine-grid motif. |
| **Hex Float** | Live HTML on floating hex tiles, perspective tilt | Hero for the hex/honeycomb motif already in the brand; section openers. |
| **Magnify** | Sci-fi scanner HUD lens magnifying the page | Landing "inspect the protocol" moment; NOT over real data. |
| **VHS** | Worn-tape wave, head-switch noise, chroma bleed, grain | Retro-CRT hero; extends `.lt-scanlines`. Pairs with the pixel-moss wordmark. |
| **Glitch** | Broadcast glitch bursts, RGB split, corrupted blocks | Sparingly — a hero accent or transition. Never near numbers. |
| **Retro Dither** | Pixelate lens around cursor | Echoes the pixelated Redaction "living face"; wordmark / hero only. |
| **Asciify** | Cursor lens redraws HTML as ASCII | Editorial hero / "machine-reads-you" moment; display copy only. |
| **Laser** | Beam near viewport bottom reveals HTML on scroll | Section-reveal on long landing pages. |

### Organic end — fluid / grown / living
| Component | Effect | Use in membrane-app |
|-----------|--------|---------------------|
| **Liquid** | Pointer-driven WebGL fluid over the page | Organic hero atmosphere (Disco, landing); phosphor/teal tint. |
| **Ripple** | Water ripples from every click, refract page | Subtle landing atmosphere; click feedback on a hero, never a form. |
| **Droplets** | Rain running down, refracting HTML | Moody section opener; low strength. |
| **Clouds** | Theme-aware mist parted by cursor wind | Soft hero fog; tint bone/phos. |
| **Cloth** | HTML hung on wind-rippling fabric | "Living membrane" hero metaphor — on-brand imagery. |
| **Bubble** | Metaball droplet trailing cursor, refracts page | Playful landing accent; use once, not everywhere. |

### Glass / refraction — use sparingly (off-axis)
Living Typeface is **hairline, not glass** — glass-morphism blur is a legacy cyberpunk tell. These are allowed
only as a deliberate hero centerpiece, never as a card/panel surface.
| Component | Effect | Use in membrane-app |
|-----------|--------|---------------------|
| **Glass** | Cursor glass lens, refracts + zooms | One-off hero centerpiece only. |
| **Shatter** | HTML into 3D glass shards | Dramatic hero transition; not for chrome. |
| **Peel / Bend** | Peel/fold live HTML to reveal a second layer | Section transitions on landing. |

### Object components — 3D/SVG/image (mascot & token candidates)
Render a **GLB/glTF model, SVG, or image** as an effect. These are the most promising answer to the open
**Ditto mascot** question and to token hero art.
| Component | Effect | Use in membrane-app |
|-----------|--------|---------------------|
| **Dithered Object** | Any 3D model through a 1-bit Bayer dither | Candidate new Ditto treatment — 1-bit dither matches the pixel-moss "living face." Hero/section-opener only. |
| **Particle Object** | Model/SVG/image scatters around cursor, springs back | Candidate Ditto or token hero: scatter-and-reform on the landing. |
| **Glass Object** | Model/SVG/image as liquid glass w/ refraction | Token/asset hero art; sparingly (see glass note). |

### Reveal components — editorial / wordmark
| Component | Effect | Use in membrane-app |
|-----------|--------|---------------------|
| **Particle Reveal** | HTML as fine particles that merge into crisp UI near cursor | **Top pick for the display-only "living face" wordmark** — literally particles resolving into readable type. Hero headline reveal. |
| **Particle Scroll** | HTML below a line dissolves to sand, reassembles on scroll | Landing section transition; keep any real data above the dissolve line. |

---

## Where these actually go in this repo
- **Landing / hero / section openers:** `components/Home/*` (the display surfaces, not the QA/stat cards),
  `NeutronHome` hero band — **not** the venue/deposit interactive parts.
- **The Foundry game screen** (yield-routing product, see [[branding-guidelines]] and the foundry concept
  artifact): this is the one *interactive* surface where a Canvas UI effect can be part of the experience —
  still keep every number/LTV/amount in crisp mono, un-effected.
- **Empty states:** e.g. Mint's "No collateral deposited" — a whisper-strength atmosphere behind the copy is
  fine; the CTA and any figures stay crisp.
- **Never:** `NeutronMint` cards/tables/modals, `Bid`, `Dashboard`, `Portfolio`, `ManagedMarkets`, nav, toasts.

## Pre-ship checklist
- [ ] Effect wraps display/hero content only — zero interactive controls, zero numbers inside it
- [ ] Tint pushed to phosphor/teal/gold/bone (not demo blue); `tintStrength` ≤ ~0.15
- [ ] Verified the graceful HTML fallback looks correct (test in Safari/Firefox or with WebGL off)
- [ ] `prefers-reduced-motion` disables it; it pauses offscreen
- [ ] No lift/scale/glow bleeding onto real interactive UI nearby
- [ ] Copy-pasted source lives in-repo (shadcn add), reviewed, not a hidden dependency

For palette, typography, atmosphere layers, and the mascot question, defer to [[branding-guidelines]].
