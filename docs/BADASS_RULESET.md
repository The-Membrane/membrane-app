# Membrane — User Expertise Ruleset

**Audience:** the LLM building the Membrane app.
**Status:** governing spec for all UX, education, simulation, and progression surfaces.
**Source doctrine:** Kathy Sierra, *Badass: Making Users Awesome*, constrained by Kahneman & Klein on the conditions for expertise.

---

## 0. The one-sentence mandate

Membrane does not compete on being a better protocol. It competes on producing **better borrowers and better risk managers** than any other venue produces. Every surface in this app is judged by one question: *does the user get measurably better at something they can name?*

If a feature makes the product smarter without making the user smarter, it is the wrong feature.

---

## 1. The epistemic constraint (read this before building anything)

Kahneman & Klein established that genuine skill requires two conditions: a **high-validity environment** (real, learnable regularities) and **rapid, unambiguous feedback**. Where those are absent, people who succeed do so by luck and then develop an illusion of skill. Kahneman named finance explicitly as a rich source of this failure, and called stock-price prediction a near-zero-validity environment.

**This constrains what we are allowed to promise.**

Split every candidate skill into one of two buckets:

### High-validity — real mastery is available; teach it hard
- Mechanism comprehension (how a specific withdrawal path resolves)
- Depth and exit-cost assessment
- Position construction and sizing
- Translating a risk doctrine across differing liquidation mechanics
- Process discipline

### Low-validity — mastery is NOT available; teach calibration instead
- Which venue will fail next
- Where prices go
- Whether a yield is "real"

For the second bucket, the trainable skill is **calibration**, not prediction. Tetlock's work shows calibration improves with tracked forecasts and scored feedback; training measurably reduces overconfidence. Our claim is never "our users predict better." It is **"our users know what they don't know, and size accordingly."**

### Fractionation of skill — the specific danger
Expertise in one task does not transfer to an adjacent one, and the expert cannot feel the boundary. A user who becomes genuinely excellent at reading withdrawal paths will *feel* excellent at predicting blowups. Never build a surface that implies the transfer. Never award progression in a way that implies it.

**Consequence for a lending protocol:** overconfident users become bad debt. Miscalibration is not a UX problem here, it is a solvency problem.

---

## 2. Constituencies and their ladders

> **Owner amendment, 2026-09-06: Membrane is a CARRY-FIRST app — that is the
> headline.** The carry trader leads the app's identity, marketing, landing
> emphasis, and nav order (see `docs/research/carry-userflows.md`). The borrower
> ladder below remains the minimum-badass curriculum and the §2.1 rungs still
> govern its teaching surfaces — but where positioning decisions conflict,
> carry wins.

### 2.1 Borrowers (primary)

**Minimum badass user:** borrows without getting liquidated all the time.

**Design rationale:** we reduce the harm from liquidation so users can fail more and learn faster. This removes analysis paralysis and shifts the real skills to **sizing** and **venue choice**.

**Rungs, in order:**
1. **Venue/yield choice** — the first rung, because it is flashy and users are already motivated by it.
2. **Depth-aware sizing** — the position size that survives the exit, not just the entry.
3. **Cascade survival** — holding through stress without intervening.

**Aspirational identity (use this language, not financial jargon):** *living off your Bitcoin without selling it.* Not "optimizing your finances" — that has no skill ladder and nobody says it out loud.

### 2.2 Risk managers (secondary, higher ceiling)

**Badass definition:** finds alpha and stays ahead of the risk curve — sources new collateral types, sets risk parameters on existing ones, and eventually authors contracts that set the borrower rule set automatically.

**Two-stage ladder (the synthesis — build both):**

- **Middle belts — the allocator path.** The user does not set parameters. They judge those who do: reading a curator's risk doctrine, detecting mandate drift, and sizing exposure across several curators. Membrane is a diligence terminal. Serves users who want to control their assets and use active curators as guides.
- **Black belt — the curator path.** The user authors parameters: sources collateral, sets LTVs and caps, runs a book. Membrane is a workbench. Serves users who run the simulations themselves.

**Order is mandatory: recognition before production.** You learn to judge doctrine before you are permitted to author it. This is how credit desks actually train people, and it is also the safer sequencing for Disco solvency.

### 2.3 CDT savers (deprioritized)
Passive holding has no skill curve. Do not build a progression system for this constituency. Do not let its needs dilute the borrower surfaces.

---

## 3. Teaching rules (binding on every surface)

1. **Teach, don't tell.** Every concept ships as a rendered consequence of the user's own position. Never as explanatory copy. If it can only be explained in a paragraph, it is not ready to build.

2. **Retrospective before prospective.** Unprompted comparisons come first; opt-in simulators come second and sit below the fold. A simulator only serves a user who already knows to open it — which the minimum badass user, by definition, does not.

3. **Attribution to self.** If protocol machinery silently rescues the user, they learn nothing and feel nothing. Mitigation must be **legible**: show that it fired, and show that their sizing is why it was sufficient. Silent rescue teaches carelessness.

4. **Positive metrics, never absences.** "Never liquidated" is unfalsifiable from the user's seat — they cannot distinguish skill from a calm market. "Held through the cascade at 65% LTV" is felt, specific, and repeatable to a friend.

5. **Keep failure unambiguous.** Compress the *cost* of being wrong; keep the *clarity* of being wrong at full volume. If harm reduction makes a bad entry feel like a good one, we have removed the signal along with the pain.

6. **Perceptual exposure beats personal reps.** Users develop judgment by seeing many examples, not only by living through their own. Show distributions of similar positions and what happened to them. The cached archive exists to power this.

7. **Grade process, never P&L.** Kata are gradeable because technique is right or wrong, observable now. Returns are low-validity. A belt system that rewards returns certifies luck and will promote the reckless fastest during a bull run.

8. **The weakest prong governs.** Any composite risk view must surface its least-confident component, not an average.

---

## 4. The core visual: the comparison chart

**Trigger:** immediately after the user selects a position arrangement. Unprompted.

**Base layer:** double line chart — their chosen arrangement vs. the arrangement they did not pick.

**Punchline layer (same chart, no second visual):** ghosted variants of *both* lines at 10× and 100× their size. Two colour families, opacity descending with size.

**The payload is that the lines cross.** The venue that wins at their size loses at 100×, because exit depth eats the spread. Seeing that ordering invert once teaches depth-aware sizing permanently.

**Hard requirements for the crossing to appear:**
- Y-axis must be **realized value net of exit cost**, not APY. APY hides depth cost entirely and the lines will not cross.
- Label the crossing point in dollars: *"above ~$X, this ranking inverts."* That number is what the user repeats to someone else — which is the real test of whether we taught anything.
- Render as **bands, not lines**, where confidence is low (see §7).

**Simulator placement:** below the fold. Never the first thing.

---

## 5. Teach-don't-tell build queue (priority order)

1. **The 1-hour delay counterfactual.** On any day it mattered: *"without the delay you'd have been closed at 3:14am; price recovered by 4:20."* Cheapest to compute, fires when users are most emotionally available, and demonstrates our structural difference with zero copy. **Build this first after the comparison chart.**
2. **Headroom in hours, not percent.** Not "68% LTV" but "you survive a 3-sigma 6-hour BTC move." Moves daily, so it generates daily feedback, and it makes the abstraction bodily.
3. **Seat in the bad-debt waterfall.** Render the stack with a marker on the user's tranche. Nobody reads waterfall prose; everyone understands a position in a queue.
4. **Weekly counterfactual cost in dollars.** *"Staying here instead of moving cost you $340 this week."* Basis points are told; dollars are felt.
5. **Peg band vs. their own mint and exit prices.** Teaches the band's realness without a sentence about the R controller.

---

## 6. Venue classification system

### 6.1 The three prongs
Every venue is analysed on exactly three axes:

1. **Composition** — what assets is the vault token actually comprised of?
2. **Withdrawal path** — what is the process back to CDT? Assume the transmitter swap as the standardized default case; flag deviations as exceptions.
3. **Delivery** — how does it make it to you?

### 6.2 Classification layer
Build a **vector embedding database** over the three-prong analysis. Most venues are hybrids ("a little of this, a little of that") and resist clean bucketing, while a minority are cleanly LP / lending / etc.

**Surface as a trait hexagon** (Pokémon-style attribute display), with filters as a secondary view. Do not force venues into exclusive categories.

### 6.3 Confidence differs per prong — display it
- **Composition:** verifiable on-chain → high confidence
- **Withdrawal path:** mechanistic but assumption-laden → medium confidence
- **Delivery:** behavioural and cascade-dependent → low confidence

Showing three distinct confidence levels on a single venue card teaches the most transferable lesson in the system: **risk assessment is not one number.**

---

## 7. Uncertainty and transparency (non-negotiable)

**Governing principle: we do not teach users wrong. Where we cannot be accurate, we surface the inaccuracy.**

A disclaimer is telling, not teaching. Implement transparency as follows:

1. **Uncertainty as geometry.** Bands, not lines. A wide band on a shallow venue and a tight band on a deep one teaches the depth lesson through width alone.

2. **Publish our own track record.** Log every simulation shown and score it against realized outcomes. Surface the result: *"this model has stayed within its stated band 78% of the time."* This is a Brier score on ourselves. It makes the tool falsifiable and models the exact discipline we ask users to adopt.

3. **Standing rule: model confidence may only be raised by realized outcomes, never by improved methodology alone.** "We upgraded the sim" must not silently become a confidence upgrade with no evidence behind it.

4. **Size-skew is a lesson, not a footnote.** That theoretical position size skews real results is precisely what a badass borrower knows and a novice does not. It is the punchline of §4, never a disclaimer beneath it.

**Why this is competitive, not defensive:** no rival simulator publishes its own error rate. Users learn calibration best from an exemplar that models it. We are that exemplar.

---

## 8. Expert exemplars and deliberate practice

### 8.1 Put real experts in front of users
The relevant profession already exists and publishes. Do not reach for generic "expert investors" — value investing, moonshot investing, and yield management are distinct disciplines with distinct masteries.

**The Gauntlet vs. Steakhouse contrast is the single best teaching artifact available.** Gauntlet runs agent-based simulations across every market a vault touches, caps allocations to what those simulations say the market can absorb, and rebalances continuously. Steakhouse constrains the asset universe instead. The asymmetry: **Steakhouse trusts asset selection to keep risk out; Gauntlet trusts sizing to keep risk bounded even as the asset universe widens.**

Two coherent expert doctrines that disagree. Present them as a live disagreement, not a hagiography — it teaches users that a doctrine must be *chosen*.

**Use expert failure as material.** Re7 and MEV Capital ran higher-beta strategies and both were hit by Stream Finance. During that episode even conservative Steakhouse and Gauntlet USDC vaults briefly went illiquid — out of caution rather than losses — from a timing mismatch between redemption demand and the time needed for borrowers to de-lever. That is prong two of §6 demonstrated by professionals getting caught, and it instructs far better than a passing grade.

### 8.2 Deliberate practice is the workflow, not a bolt-on
Steenbarger's learning loop is the unit: **attempted performance → specific feedback on it → renewed effort incorporating the feedback.** The difference between ten years of experience and one year repeated ten times is whether the loop closes.

Practice exercises must be embedded in the act of using the app, not quarantined in an academy tab.

### 8.3 Niche
Not every user masters every form. Extend the trait-hexagon concept from venues to **users** — different temperaments, different mastery paths, different recommended ladders.

---

## 9. The progression system (belts)

### 9.1 The transfer problem — this is the curriculum's spine
Every mental model a user imports — from Gauntlet, from Aave, from their own history — is calibrated for **instant liquidation**. On Membrane it is wrong in **two directions at once**:

- **Safe LTV is higher than their intuition says.** The delay lets positions survive wicks that would close them anywhere else. The imported expert is systematically **over-conservative on the ceiling**.
- **Depth sensitivity is higher than their intuition says.** The protocol carries tail exposure through the delay window, so exit capacity matters *more*, not less. The same expert is systematically **under-conservative on size**.

Both errors feel like prudence to the person making them. This is fractionation of skill landing directly on our doorstep.

### 9.2 The translation exercise — the belt gate
Before any user is permitted to author parameters, they must demonstrate that they can take a published curator methodology and correctly restate it for delayed liquidation.

**Mechanic:** show Gauntlet's cap logic on a real market → ask for the Membrane-adjusted version → score against the simulation.

This satisfies every requirement simultaneously: deliberate practice with a right answer (high-validity), fast and unambiguous feedback, a rep of a real expert process using real published methodology, and it teaches our core differentiator without a single explainer paragraph.

**Middle belts judge whether a doctrine survives translation. The black belt performs the translation.** Same skill, recognition then production.

### 9.3 Belt design rules
- Grade **process**, never returns (rule 7).
- **Calibration is the scoreboard.** Risk managers post explicit probability estimates on venue outcomes *before* acting; score them. That is a Brier score, it is honest, and no competitor has one.
- The path must be **believable and step-by-step**, martial-arts style — each rung visible from the one below.
- The crossing of the first threshold must be **perceptible and fast**. If the first felt achievement is months away, the ladder has failed regardless of how well it is designed.

---

## 10. Data layer requirements

- **Cache on-chain data; do not continuously requery.** The archive is the more valuable asset — live simulation is copyable, a dated corpus is not.
- Store: position history, price data, **withdrawal-ability data**, and general market data.
- **Instrument withdrawal-ability hardest and earliest.** It is the least-modelled variable in the space, the one that actually breaks in a cascade, and the input competitors' simulators will not have.
- The archive powers perceptual exposure (rule 6): *"here are 200 positions that looked like yours, here is the distribution of what happened."*

---

## 11. Prohibitions

Do not build:

- Any surface that awards progression based on returns.
- Any silent risk mitigation. If the protocol saves the user, the user must see it.
- Explanatory copy where a rendered consequence would work.
- A simulator as the *first* educational touchpoint.
- Any confidence figure not backed by realized outcomes.
- APY as the y-axis on any comparison intended to teach sizing.
- Averaged risk scores that conceal a weak prong.
- Any implication that a user skilled in a high-validity task is thereby skilled at prediction.

---

## 12. Acceptance tests

A surface ships only if it passes all of these:

1. **The dinner-party test.** Can the user say what they got better at, out loud, in one sentence, without jargon?
2. **The attribution test.** Does the user believe *they* caused the improvement?
3. **The falsifiability test.** Could the user tell the difference between having learned something and having been lucky?
4. **The validity test.** Is the skill being taught in a high-validity bucket — or, if not, is it calibration rather than prediction?
5. **The copy test.** Does it teach without a paragraph of explanation?
6. **The honesty test.** Where the model is uncertain, is the uncertainty visible in the geometry rather than in a footnote?
