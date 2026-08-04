# Membrane — Chart & Diagram Brand Spec

**Hand this file to anyone (or anything) producing charts, diagrams, or data visuals for Membrane.**

Canonical path: `docs/BRAND_CHARTS.md`
Machine-readable tokens: `docs/brand-chart-tokens.json`
Source of truth in code: `config/chartTheme.tsx`, `config/semanticColors.ts`

Brand: **Living Typeface** — warm bone on near-black, phosphor-green accent, sharp corners, hairline rules. Full brand guide: `.claude/skills/branding-guidelines/SKILL.md`.

---

## 1. Palette

### Ground and ink
| Token | Hex | Use |
|---|---|---|
| `bg` | `#09090a` | page canvas |
| `bgCard` | `#0e0d10` | chart panel / tooltip background |
| `bgRaise` | `#100f12` | raised surface |
| `ink` | `#ece6d8` | axis labels, primary values (**warm bone, never `#fff`**) |
| `inkDim` | `#8d877b` | legend text, secondary labels |
| `inkFaint` | `#56524a` | tick labels, annotations |

### Hairlines
| Token | Value | Use |
|---|---|---|
| `hairline` | `rgba(236,230,216,0.10)` | panel borders, tooltip cursor |
| `hairlineStrong` | `rgba(236,230,216,0.22)` | tooltip border, emphasized rule |
| `grid` | `rgba(236,230,216,0.08)` | gridlines, `strokeDasharray "3 3"` |

### Semantic (state — not decoration)
| Token | Hex | Meaning |
|---|---|---|
| `success` / `primary` | `#9bdc4f` | phosphor — positive, healthy, up, main series |
| `info` / `secondary` | `#46d39a` | cyber teal — informational, machine-side, second series |
| `warning` | `#d8b24a` | gold — gates, caution, approaching a limit |
| `danger` | `#cf4034` | blood — errors, liquidation, down |

### Series order (multi-series charts)
Use in this exact order. From `ASSET_COLORS` in `config/chartTheme.tsx`:

```
1  #9bdc4f  phosphor green
2  #46d39a  cyber teal
3  #d8b24a  gold
4  #cf4034  blood red
5  #8d877b  bone dim
6  #4a8636  moss dark
7  #c8e89a  pale phosphor
8  #e0c877  pale gold
```

**Never** use purple (`#6943FF`, `#A692FF`), cyan (`#3BE5E5`, `#22d3ee`), or navy (`#091326`) — legacy palette, fully retired.

---

## 2. Typography

| Role | Family | Fallback | Rule |
|---|---|---|---|
| Chart title / display | `Redaction`, serif | `Georgia, "Times New Roman", serif` | headings and editorial copy only |
| **All numbers, axes, ticks, legends, labels** | `JetBrains Mono` | `ui-monospace, SFMono-Regular, Menlo, monospace` | **mandatory** |

**Hard rule:** every number — value, axis tick, percentage, currency, LTV, APR — renders in mono. Never render a number in the display serif. If the tool has no Redaction, Georgia is the correct substitute; never substitute a sans-serif.

Eyebrows and axis-group labels: mono, uppercase, `letter-spacing: 0.28em`, 10–11px, `inkDim`.

Sizes: ticks 10px · legend 12px · annotations 9.5–10px · chart title 16–19px.

Use `font-variant-numeric: tabular-nums` anywhere digits align in a column or update live.

---

## 3. Structure

- **Sharp corners everywhere.** `border-radius: 0` on panels, tooltips, bars. Bar radius `[0,0,0,0]`.
- **Hairline borders**, never solid white or glassy strokes. No `backdrop-filter`.
- **No glow, no bloom, no drop shadows, no gradient fills** behind series. Area fills are flat colour at low opacity.
- Panel: `#0e0d10` background + `1px solid rgba(236,230,216,0.10)`.

### Component defaults
| Element | Spec |
|---|---|
| Grid | `rgba(236,230,216,0.08)`, `strokeDasharray "3 3"` |
| Axis line | `#ece6d8` at `0.6` opacity |
| Ticks | fill `#ece6d8`, 10px, mono |
| Line series | `strokeWidth 2`, `dot: false`, `activeDot r:5` |
| Area series | `strokeWidth 2`, `fillOpacity 0.3`, flat fill |
| Tooltip | bg `#0e0d10`, border `1px solid rgba(236,230,216,0.22)`, radius `0`, text `#ece6d8` |
| Tooltip cursor | `rgba(236,230,216,0.10)`, 1px |
| Legend | 12px, `#8d877b`, line icons |

### Reference lines
| Kind | Stroke | Width | Dash |
|---|---|---|---|
| Liquidation / hard limit | `#cf4034` | 2 | `5 5` |
| Target / soft threshold | `#9bdc4f` | 1 | `3 3` |
| Crossing / inversion marker | `#d8b24a` | 1 | `2 3` |

Chart heights: `sm 200 · md 300 · lg 400 · xl 500`.

---

## 4. Binding content rules

These come from the **User Expertise Ruleset** (`~/Downloads/membrane-badass-ruleset.md`, §4, §6.3, §7, §11) and are **not stylistic** — a chart that breaks them is rejected regardless of how it looks.

1. **Uncertainty renders as geometry, never as a footnote.** Where confidence is low, draw a **band**, not a line. Band width must scale with actual uncertainty — a wide band on a shallow venue and a tight band on a deep one is how the reader learns depth. A disclaimer under the chart does not satisfy this.

2. **Never put APY/APR on the y-axis of a comparison meant to teach sizing.** Use **realized value net of exit cost**. APY hides depth cost, and the lines will not cross — which destroys the entire lesson.

3. **Never average away a weak component.** If a composite has parts with different confidence (e.g. composition = high, withdrawal path = medium, delivery = low), show the **weakest** one, or show all three separately. No blended risk score.

4. **No confidence figure that isn't backed by realized outcomes.** Do not render "85% accurate" unless 85% is a measured hit rate. An honest empty state (`0 of 0 scored`) is required instead. Model confidence may be raised by realized results only — never by improving the methodology.

5. **Label the takeaway in the reader's units.** Dollars and hours beat basis points and percentages. Round the headline number to two significant figures — a precise number under a wide band is false precision, and precise numbers are not repeatable out loud.

6. **Prefer time to percent** for risk headroom: "survives a 3-sigma 6-hour move" beats "68% LTV".

---

## 5. Do not

- Purple, cyan, or navy anywhere
- Pure white (`#fff`, `whiteAlpha.*`) for text or axes
- Rounded corners on any chart element
- Glows, bloom, drop shadows, gradient series fills
- A number set in the display serif
- Sans-serif substituted for the display face
- APY as the y-axis on any sizing comparison
- Averaged/blended risk scores
- Rainbow or perceptually-uneven series palettes — use the ordered list in §1
- Red/green as the *only* distinction between series (add dash pattern or label)

---

## 6. Worked example

The `§4` comparison chart (chosen vs passed-on arrangement, ghosted at 10×/100×):

- Chosen arrangement: phosphor `#9bdc4f`. Passed-on: cyber teal `#46d39a`.
- Size tiers by opacity, descending — `1.0 / 0.72 / 0.5` — with dash patterns `solid / 6 3 / 2 3`. Keep the largest tier legible; it usually carries the point.
- Each series is a **band** (`fillOpacity ≈ 0.24 × tier opacity`) plus a midline.
- Crossing markers in gold `#d8b24a`, dashed `2 3`, with a small filled dot and a mono label.
- Y-axis: realized value net of exit cost, **% of principal** (normalising lets all size tiers share one axis).
- Headline callout below the chart, gold-bordered: *"Above ~$420,000, this ranking inverts."*

---

## 7. Consuming the tokens

`docs/brand-chart-tokens.json` carries every value above in machine-readable form. In-app, import from code rather than copying hex:

```tsx
import { CHART_THEME, ASSET_COLORS, REFERENCE_STYLES } from '@/config/chartTheme'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
```

**Known inconsistency:** `SEMANTIC_COLORS.borderSubtle` and `borderMedium` are currently the same value (`rgba(236,230,216,0.10)`). Use `hairline` (0.10) and `hairlineStrong` (0.22) as the real two-step scale until that's reconciled.

---

**Last updated:** July 2026 · Living Typeface migration in progress; palette layer is committed and stable.
