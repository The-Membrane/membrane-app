---
name: chart-design
description: >-
  Brand and content rules for every chart, graph, diagram, or data visual in membrane-app — Living Typeface palette,
  mono-for-all-numbers typography, sharp corners and hairlines, the ordered series palette, reference-line styles,
  and the BINDING content rules (uncertainty as bands not footnotes, never APY on a sizing y-axis, never average away
  a weak prong, no confidence figure without realized outcomes). Use whenever building or reviewing a chart, plot,
  graph, dashboard, sparkline, gauge, diagram, or any data visualization — including Recharts components, inline SVG,
  canvas rendering, and standalone artifacts — or when someone asks what colours/fonts a chart should use, says
  "make a chart", "plot this", "visualize", "diagram", or hands work to an external diagram tool.
---

# Charts & diagrams — Membrane

**The canonical spec is [`docs/BRAND_CHARTS.md`](../../../docs/BRAND_CHARTS.md).** Machine-readable values live in
[`docs/brand-chart-tokens.json`](../../../docs/brand-chart-tokens.json). Read the spec before drawing; this skill is
the pointer plus the things people get wrong.

For in-app work, **import from code — never copy hex literals**:

```tsx
import { CHART_THEME, ASSET_COLORS, REFERENCE_STYLES, CHART_DIMENSIONS } from '@/config/chartTheme'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
```

For external tools, artifacts, or anything outside the app, hand over `docs/BRAND_CHARTS.md` — it is written to be
self-contained.

---

## The five-second version

- Ground `#09090a`, panel `#0e0d10`, ink **bone `#ece6d8`** — never `#fff`.
- Series in order: phosphor `#9bdc4f` → teal `#46d39a` → gold `#d8b24a` → blood `#cf4034` → …
- **Every number is monospace.** Axes, ticks, legends, values. Serif is display-only.
- Sharp corners. Hairline borders. No glow, no bloom, no gradient fills.
- Semantic colour means state: phosphor = healthy/up, gold = caution/gate, blood = danger/down, teal = informational.

---

## The four mistakes to check for

These are content rules from the User Expertise Ruleset, not taste. A chart that breaks one is wrong even if it
looks right.

1. **A disclaimer where a band belongs.** If the number is uncertain, the *geometry* must show it — a band whose
   width scales with real uncertainty. Footnotes tell; width teaches. A wide band on a shallow venue next to a tight
   band on a deep one conveys the whole depth lesson without a sentence.

2. **APY on the y-axis of a sizing comparison.** APY hides exit cost, so the lines never cross and the lesson dies.
   Use **realized value net of exit cost**. Normalise to % of principal if several size tiers share one axis.

3. **A blended risk score.** When components differ in confidence — composition (high), withdrawal path (medium),
   delivery (low) — show the weakest, or show all three. Averaging conceals exactly the part that matters.

4. **An invented accuracy figure.** Never render "85% accurate" unless 85% is measured against realized outcomes.
   Ship the honest empty state (`0 of 0 scored`) instead. Confidence rises only on realized results, never because
   the model improved.

Also: headline takeaways in **dollars or hours**, rounded to two significant figures — a precise number under a wide
band is false precision, and precise numbers don't survive being repeated out loud.

---

## Legacy colours you will still find

The component long tail has un-migrated code. Do not copy from it:

`#6943FF` / `#A692FF` (purple) · `#3BE5E5` / `#22d3ee` (cyan) · `#091326` (navy) · `#fff` / `whiteAlpha.*`

Map them: purple → phosphor `#9bdc4f`, cyan → teal `#46d39a`, navy → `#09090a`, white → bone `#ece6d8`.

---

Related: [[branding-guidelines]] for the full brand system, [[canvas-ui]] for WebGL/atmosphere effects
(display-only — never wrap a chart or a number in one).
