---
name: ui-design-audit
description: >-
  Audit and polish a membrane-app page against the four game-UI design principles: Hierarchy
  (attention follows importance), Gestalt (relationships visible before reading), State (truth
  visible without status copy), and Representation (show the object, not a description of it).
  Use this skill whenever the user asks for a UI audit, design review, page polish, "make this
  page feel right", "why does this page feel flat/cluttered", a hierarchy or layout critique,
  or before shipping any new page or major component — even if they only say "review the UI"
  or "clean up this page". Also use it when a page has grown organically (many cards, many
  CTAs) and needs its attention order re-established. Produces a per-principle findings table
  with file:line references, then applies fixes inside the Living Typeface design system.
---

# UI Design Audit — Four Principles

Audit a page the way a game-UI designer would: the player should know what matters, what goes
together, what is true, and what things *are* — before reading a single word. Then fix what
fails, without leaving the design system.

## The Four Principles

### 1. Hierarchy — attention follows importance

Make the most important action visually dominant using size, color, and contrast. Reduce the
size, color, and contrast of everything less important so attention follows the intended order.

Checks:
- Each view has exactly ONE visually dominant primary action. Two solid phosphor CTAs on one
  screen means neither is primary.
- Squint test: blur your eyes at the screenshot. The first thing that pops must be the thing
  the user came to do (or the number they came to check), not a section label or a border.
- Importance order maps to visual weight order: primary value > primary action > supporting
  data > labels > chrome. If a label (uppercase, letterspaced) reads louder than the value
  under it, the label is too heavy or the value too light.
- De-emphasis is half the principle. The fix for a weak CTA is usually to QUIET its neighbors
  (drop to `textSecondary`/`textTertiary`, ghost variant, smaller size), not to make the CTA
  shout louder.
- Equal-sized grid cards give equal weight to unequal things. If one card carries the page's
  purpose, let it be larger or higher-contrast than the rest.

### 2. Gestalt — relationships visible before reading

Group related controls using proximity, shared containers, alignment, and similarity. Separate
unrelated controls so their relationships are visible before they are read.

Checks:
- Space inside a group < space between groups. If gap between a label and its input equals the
  gap between two unrelated fields, grouping has failed and headers are doing the work words
  should never have to do.
- Controls that act on the same object share a container; controls that act on different
  objects do not share one. A deposit form and a claim button in one card reads as one action.
- Similarity implies sameness: identically-styled buttons must do the same class of thing.
  If "Max" and "Submit" look identical, restyle one.
- Alignment is grouping: elements on the same left edge read as one column of related things.
  A stray offset breaks the group membership.
- Prefer removing a section header over adding one. If a group's boundary needs a header to be
  understood, first try tightening proximity/containers until the header becomes redundant.

### 3. State — truth visible without status copy

Represent each important state with a visible change in shape, color, position, motion, or
contrast so users know what is true without reading status copy.

Checks:
- Enumerate the states the page can be in (empty / demo / loading / ready / pending tx /
  success / error / disabled / selected / at-risk). Each one the user must act on differently
  needs a NON-TEXTUAL signal. Text may accompany the signal; it may not BE the signal.
- Selected vs unselected: border weight/color change, background step, or a check glyph — not
  just a "Selected" caption.
- Disabled/locked: reduced contrast + no hover response + optionally a lock glyph — not a
  sentence explaining unavailability.
- Danger states escalate visually with severity: an LTV at 92% of liquidation must look
  different from one at 40% before the user reads either number (color shift toward
  `SEMANTIC_COLORS.danger`, weight, position on a gauge).
- Loading: skeletons/placeholders shaped like the content, not a spinner plus prose.
- The demo state (V20 demo-first rule): the "Demo — not yours" condition must be visible as a
  persistent banner treatment, not a footnote.

### 4. Representation — show the object, not a description of it

Show the object or action directly instead of naming or describing it so users interact with
meaning rather than explanatory UI.

Checks:
- Assets appear as themselves: token icon + symbol + amount, not a labeled text field that
  says "ASSET".
- Consequences render as previews: a borrow form shows the resulting LTV/health position on
  the actual gauge as the user types, not a paragraph explaining what LTV will become.
- Ranges and positions are spatial: a liquidation price lives as a marker on a price track,
  not only as a row in a stats list.
- Copy that explains what a control does ("Select whether to approve or deny") is a
  representation failure — redesign the control until the explanation is deletable, then
  delete it. (Veteran UX rule: text decays on competence.)
- Actions carry their meaning: a stamp stamps, a slider slides through real values, a route
  is drawn as a route. Generic Deny/Approve buttons under a form are the anti-pattern.

### 5. Quiet — micro-copy earns its place

Tiny type breeds. Each component adds its own 9px reassurance line, heading subtitle, and
footnote, and the page ends up dusted with small words nobody reads. Sub-body type (below
~12px) is allowed exactly three jobs:

1. A unit, axis, or zone label bound to a representation ("first loss / last loss",
   "cap 60% · line 73%", the zone captions on a timeline, a live readout under an input).
2. A provenance stamp (MOCK / MEASURED / `source · fetched HH:MM`) — required by the
   demo-first rule. Keep the stamp, cut the essay after it.
3. A material risk disclosure that has to sit on-surface.

Everything else in small type is noise. The removal test: if a small-type run explains,
reassures, restates the section title, or repeats across sibling cards, delete it. If the
information genuinely matters, it moves UP, never sideways: into the representation itself
(principle 4), into a tooltip on the element it explains, or into the section's single
body-size intro paragraph. Budget after the pass: zero footnotes under CTAs, zero heading
subtitles, at most one stamp line per card, and fine print stated once per section instead
of once per card.

## The consensus ruleset — "known uglies"

Distilled from a 25-video / 19-channel YouTube practitioner corpus (weighting and
citations in `references/evidence.md`; ranked source table in `references/sources.md`).
The five principles above cover most of Tier 1 already; these are the CONCRETE
thresholds and the mistake checklist the corpus adds. Check them mechanically before
spending judgment time — polishing a page that fails these is polishing a known ugly.

Thresholds (consensus values):
- Typography: ≤2 families, 2–4 sizes on the page; hierarchy from weight + color, not
  more sizes. Off-scale one-off font sizes are the same sin as off-scale spacing.
- Spacing: every value on the 4/8-pt scale; never eyeballed.
- Color ratio: ~60% neutral / 30% secondary / 10% accent, accent reserved for the
  primary action (guideline, not law — but a page that FEELS loud usually fails it).
- Body line length 50–75 characters; left-align anything over 3 lines; never mix
  alignments inside one lockup; never center body text.
- Line height: headings 1.1–1.3×, body 1.3–1.5× (inverse to size).
- Feedback inside ~400ms for every interaction: hover, pressed, loading, disabled.
- Numbers that change length render in mono/tabular figures.
- Forms open with smart defaults, never fully blank; progress never starts at 0%.

The uglies checklist (each one named by 3+ independent channels as a beginner tell):
1. Accent/brand color sprayed across many elements — "if everything is on fire,
   nothing is on fire."
2. Two equally-weighted CTAs forcing the user to guess.
3. Heavy drop shadows or glows compensating for weak contrast separation.
4. Six font sizes / four weights on one screen.
5. Arbitrary spacing values (11px, 25px) off the scale.
6. Identical-purpose components styled differently; mixed icon sets in one zone.
7. Charts decorated past readability: missing axis labels, rounded bar tops,
   segment count ≠ data count, every series in brand color.
8. Semantic colors used decoratively (red for a neutral action, brand-green hiding
   a success state).
9. Vague catch-all labels ("Games and More") that force memorization over inference.
10. No interaction feedback — clicks that feel unregistered.
11. Centered multi-line body text, or a centered heading over left-aligned body.
12. Lorem ipsum surviving into layout decisions (real content regroups elements).

Contested rules — do not enforce blindly (details in evidence.md): F/Z scan patterns
(heuristic only), "biggest = most important" (size marks the entry point, not the
payload), "simpler is always better" (reduce decision load, never capability — dense
is correct for expert audiences), ghost buttons (wrong for the primary action only),
color psychology (skip it; pick pragmatically).

## Workflow

### Step 1 — Scope

Pick the target page and read its component tree top-down (page file → top 2 levels of
components). Note every interactive control and every rendered state you can trigger.

### Step 2 — Capture evidence

Take screenshots with Playwright, NOT the in-app Browser pane (the Browser pane tab is
permanently hidden, requestAnimationFrame never fires, and Next pages never hydrate there —
screenshots from it show the pre-hydration shell and will mislead the audit):

```bash
# dev server must be running (see .claude/launch.json for name/port)
npx playwright screenshot --viewport-size=1440,900 --wait-for-timeout=8000 \
  http://localhost:<port>/<route> audit-before.png
```

Capture the no-wallet demo state first (that is the stranger-test state and the one most
users see first), plus any state reachable without a wallet (hover is out of reach; note
hover-dependent findings as code-level). Read the screenshot with the Read tool.

### Step 3 — Audit

Go principle by principle. For each finding record: principle, severity (high = attention or
meaning actively misdirected; medium = slows comprehension; low = polish), evidence
(screenshot region + file:line), and the proposed fix. Audit the screenshot FIRST (what does
it look like it does?), then the code (what does it actually do?) — mismatches between those
two readings are usually the highest-severity findings.

Output the findings as a table before touching any code, so the fixes trace back to evidence.

### Step 4 — Polish

Apply fixes inside the Living Typeface system (see CLAUDE.md and the branding-guidelines
skill). Non-negotiable constraints while fixing:

- Colors from `SEMANTIC_COLORS` only; text is bone, never white; success is phosphor, never
  cyan; no purple.
- Fonts via `TYPOGRAPHY`: serif display for headings, JetBrains Mono for every number and
  functional string. Never a number in the display face.
- Spacing from `SPACING` / `SPACING_PATTERNS` — grouping fixes are made with these steps
  (inside-group `sm`/`md`, between-group `lg`/`xl`), not arbitrary values.
- Sharp corners, hairline borders. Hover = hairline brighten / color shift / bg raise only.
  No lift, no scale, no glow — state changes use color, border, contrast, position.
- Hierarchy fixes prefer demotion (quiet the neighbors) over promotion (enlarge the CTA).
- Any UI copy you touch: state what the thing IS, plain words, no emdashes.

### Step 5 — Verify

Re-screenshot the same routes/states (`audit-after.png`), read both images, and confirm each
high/medium finding visibly changed. Run the smoke tests
(`pnpm test:e2e tests/e2e/smoke.spec.ts`) if interactive structure changed. Close with a
before/after summary tied to the findings table: every finding is either fixed (with
file:line of the fix) or explicitly deferred with a reason.

## Report format

```
## UI Audit — <page>

| # | Principle | Sev | Finding (evidence) | Fix |
|---|-----------|-----|--------------------|-----|
| 1 | Hierarchy | High | Two solid CTAs compete (Deposit + Claim, screenshot top-right; DepositCard.tsx:88, ClaimRow.tsx:41) | Claim → ghost variant |

### Applied
- #1 fixed — ClaimRow.tsx:41 now `variant="ghost"`
### Deferred
- #4 — needs product decision on primary action
```

Severity discipline: a clean page yields a short table. Do not pad the report — three real
findings beat ten cosmetic ones. If a principle passes, say it passes and move on.
