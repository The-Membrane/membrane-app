# Evidence — UI design rules corpus (25 videos, 19 channels, fetched 2026-09-06)

Weights: video count / distinct-channel count. A rule repeated by many videos from one
channel is one voice. Flags: [multi] = independent repetition, [single] = one channel,
[unsourced] = a number no video attributes to a study.

## Tier 1 — near-unanimous (5+ channels)

| Rule | Weight | Notes |
|---|---|---|
| Hierarchy: exactly one dominant element per view; size, weight, color are the levers | 10v/9c | "If everything is emphasized, nothing is" (Flux); "if everything is on fire, nothing is on fire" (Showalter) |
| Emphasize by DE-emphasizing neighbors, not by shouting louder | 4v/3c | Sajid ×2, Self-Made ("turn down the volume"), Flux |
| Proximity ∝ relationship: space inside a group smaller than space between groups | 7v/7c | Chainlift's inverse-proportion phrasing; Tim Gabe's 1x/2x multiplier; CRAP; Law of Proximity |
| Consistency: identical components styled identically, one icon style per zone, one grid across screens | 7v/7c | Kole, Showalter, Design Doc, Envato, Riot, Juxtopposed, Tim Gabe |
| Typography restraint: ≤2 families, 2–4 sizes; build hierarchy with weight + color, not more sizes | 7v/6c | Sajid: base size ±2px covers 99% of UI; Tim Gabe counted 6 sizes/4 weights as the beginner tell |
| Whitespace is an active element; hierarchy "cannot survive" without it | 5v/4c | Flux, Satori ×2, Tim Gabe, Kole |
| Restrained palette: neutrals + one brand color + semantic support colors only | 5v/5c | Sajid, UX Tools, Juxtopposed, Satori, Tim Gabe |
| One primary CTA per screen; accent color reserved for it; secondary actions visibly subordinate | 6v/5c | Showalter ×2, Flux, Self-Made, UX Tools, Tim Gabe |

## Tier 2 — strong consensus (3–4 channels)

| Rule | Weight | Notes |
|---|---|---|
| Spacing snaps to a 4/8-pt scale; never eyeball values | 4v/4c | 11px/25px gaps named as the amateur tell (Tim Gabe); "don't eyeball it" (Chainlift) |
| Shadows soft and rare; heavy shadow/glow compensates for bad contrast | 4v/4c | Showalter: senior designs separate zones with color/contrast alone |
| Feedback within ~400ms for every action: hover, pressed, loading states | 4v/4c | Doherty threshold; Kole: greyed button + spinner; absence reads as broken |
| Familiar patterns beat novel ones (Jakob's law); navigation on a clear axial grid | 3v/3c | NakeyJakey: intuition over memorization; Design Doc: vague labels force memorization |
| Design with real content, never lorem ipsum; content changes regrouping | 3v/3c | Chainlift: real content can invert which elements read as related |
| Charts: readability over decoration — labeled axes, no rounded-top bars, segment count = data count | 3v/3c | Kole names Dribbble-style charts as unreadable |
| 60-30-10 color ratio (60 neutral / 30 secondary / 10 accent) as a starting guideline | 3v/3c | 2 of 3 explicitly flag it as a guideline to deviate from |
| Semantic colors (red/green/gold) reserved for their meanings, never decoration | 2v/2c | Showalter: red logout button, brand-green badge both named uglies |
| Text alignment: left-align >3 lines; never mix alignments in one lockup; body never centered | 3v/2c | Tim Gabe, Sajid; Flux adds all-caps+color as a legibility double-penalty |

## Tier 3 — worth checking (1–2 channels, or externally sourced)

| Rule | Weight | Notes |
|---|---|---|
| Body line length 50–75 characters | 1v/1c | Baymard Institute research cited — externally sourced, treat as solid |
| Line height inverse to size: headings 1.1–1.3×, body 1.3–1.5× | 2v/2c | Google/Dropbox/Uber observational |
| Negative letter spacing on headings only, −1 to −2%; never on body | 1v/1c [single] | |
| Monospace/tabular numerals for values that change length | 1v/1c [single] | Independently matches the Living Typeface mono-numbers rule |
| Smart defaults: pre-fill the likely choice; never a fully blank form | 1v/1c | 70–90% never change defaults [unsourced] |
| Progress never starts at 0% (goal-gradient) | 1v/1c | Columbia car-wash study, ~2× completion |
| Optical correction beats mathematically equal padding | 1v/1c [single] | Chainlift: bounding-box vs glyph height |
| Von Restorff: the one visually different item is the one remembered | 1v/1c | Sourced 1933 study |

## Contested — both sides, with verdict

- **F/Z reading patterns.** Satori teaches them; Self-Made Web Designer calls the
  F-pattern "bogus/outdated" and warns against designing rigidly to it. Verdict: use as
  a rough entry-point heuristic only; explicit hierarchy tiers override any assumed scan
  path.
- **"Biggest = most important."** Satori's own contrarian point: the largest element can
  be a decorative hook while the payload (date, CTA) sits smaller. Verdict: size marks
  the ENTRY point; make sure the actual payload is findable from it.
- **"Simpler is always better."** Tognazzini's counter to Tesler's law (users attempt
  more complex tasks when simplified); NakeyJakey's Windows 8 example (oversimplifying
  an already-simple thing); Riot: dense genres NEED dense UI. Verdict: reduce decision
  load, never capability; density is correct for expert audiences (matches the veteran
  UX ruleset).
- **Ghost/outline buttons.** Self-Made: users don't perceive them as clickable [single].
  Consensus elsewhere: secondary actions should be visibly subordinate. Verdict: the
  PRIMARY action is never a ghost; ghost/outline is exactly right for secondary actions.
- **Color psychology.** Sajid: "no real science in choosing colors"; UX Tools: "no real
  scientific way." Verdict: pick pragmatically (legibility, mood, ratio), skip
  color-psychology content.
- **Aesthetics vs function.** Aesthetic-usability effect is real (pretty = perceived
  usable, Hitachi 1995) but Riot ("polish cannot fix bad structure") and Self-Made
  ("pretty that doesn't convert is useless") bound it. Verdict: structure first, then
  polish amplifies.

## Named laws with sources (for citation)

Fitts 1954 (target size/distance) · Hick-Hyman 1952 (choice count → decision time) ·
Jakob's law (Nielsen) · Miller 1956 (7±2 chunking) · Doherty/Thadani IBM 1982 (400ms) ·
Von Restorff 1933 (isolation) · Serial position (Ebbinghaus) · Kahneman loss aversion
(~2× gains) · Goal-gradient (Columbia car-wash) · Jam study (Columbia: 24 flavors → 3%
buy, 6 → 30%) · Aesthetic-usability (Kurosu & Kashimura, Hitachi 1995) · Tesler's law ·
Postel's law · WCAG 4.5:1 body-text contrast (external triangulation — no video cited
the number, but "check contrast with a tool" appears in 3 videos).

Corpus gap to note: one pick (Kole Jain, "Every UI/UX Concept Explained") failed caption
download; NakeyJakey and Fireship extract thin on visual-design rules (entertainment /
CSS-implementation focus) — expected low weight contribution.
