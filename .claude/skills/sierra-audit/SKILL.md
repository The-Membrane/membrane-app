---
name: sierra-audit
description: Audit any surface (or the whole app) against Kathy Sierra's "Badass — Making Users Awesome" framework, constrained by Kahneman & Klein on when expertise is actually possible. Use when asked to review UX for whether it makes USERS better rather than the product better, to run a "Sierra audit" / "badass audit" / "user-expertise review", to judge whether a feature teaches or merely explains, or before shipping any educational, simulation, progression, or onboarding surface. Produces a per-surface verdict against six acceptance tests, not a list of design opinions.
---

# Sierra audit

Judge a surface by one question: **does the user get measurably better at something they can name?**

Not "is it usable". Not "is it pretty". Sierra's claim is that people don't want your
product — they want to be badass at the thing your product enables. A feature that makes
the product smarter without making the user smarter is the wrong feature.

**The project's binding spec is `docs/BADASS_RULESET.md`.** It is this framework already
applied to Membrane — constituencies, ladders, prohibitions, acceptance tests. Read it
before auditing. This skill is the *procedure* for applying it; that file is the *law*.
Where they disagree, the ruleset wins.

## The epistemic gate — run this FIRST

Before asking "does this teach well", ask "is this teachable at all". Kahneman & Klein:
genuine skill needs a **high-validity environment** (real learnable regularities) plus
**rapid unambiguous feedback**. Absent those, people succeed by luck and then develop an
*illusion* of skill.

Sort every skill the surface implies into one bucket:

| Bucket | Then the surface must | Example |
|---|---|---|
| **High-validity** — regularities exist, feedback is fast | Teach mastery hard | mechanism comprehension, exit-cost assessment, position sizing, process discipline |
| **Low-validity** — outcome is mostly noise | Teach **calibration**, never prediction | which venue fails next, where prices go, whether a yield is "real" |

A surface that trains prediction in a low-validity domain is not a weak feature. It
manufactures overconfidence — and in a lending protocol overconfident users become bad
debt. **Miscalibration is a solvency problem, not a UX problem.**

Also check **fractionation**: expertise does not transfer between adjacent tasks, and the
expert cannot feel the boundary. A user who gets genuinely good at reading withdrawal
paths will *feel* good at predicting blowups. Flag any surface whose framing or
progression implies that transfer.

## The six acceptance tests

Score every surface against all six. These are `docs/BADASS_RULESET.md` §12 verbatim —
a surface ships only if it passes all of them.

1. **Dinner-party** — can the user say what they got better at, out loud, in one sentence, without jargon?
2. **Attribution** — does the user believe *they* caused the improvement?
3. **Falsifiability** — could the user tell the difference between having learned something and having been lucky?
4. **Validity** — is the skill in the high-validity bucket, or if not, is it calibration rather than prediction?
5. **Copy** — does it teach without a paragraph of explanation?
6. **Honesty** — where the model is uncertain, is the uncertainty visible in the **geometry** rather than in a footnote?

## Prohibitions — any hit is an automatic FAIL

From ruleset §11. These are not tradeoffs to weigh:

- Progression awarded on **returns** or PnL
- **Silent** risk mitigation — if the protocol saves the user, the user must see it
- Explanatory copy where a **rendered consequence** would work
- A **simulator as the first** educational touchpoint (it only serves a user who already knows to open it — which the minimum badass user, by definition, does not)
- Any confidence figure not backed by **realized outcomes**
- **APY as the y-axis** on any comparison meant to teach sizing
- **Averaged** risk scores that conceal a weak prong
- Any implication that high-validity skill confers **prediction** skill

## Procedure

1. **Read `docs/BADASS_RULESET.md`.** Note the constituency ladders (§2) — audit against the *minimum badass user* for that surface, not the power user. Most surfaces fail because they were designed for someone who already knows to look.
2. **Inventory surfaces factually before judging.** Route, what the user does, real vs mock data, what visual is doing the teaching. Delegate this; keep the judgement in the main loop.
3. **Name the skill.** For each surface write the sentence the user would say at dinner. If you cannot write it, the surface has no skill and that IS the finding.
4. **Run the epistemic gate.** Bucket the skill. Low-validity + prediction framing = fail, stop.
5. **Score the six tests.** PASS / FAIL / N/A with the evidence — a quoted UI string and `file:line`. "Feels thin" is not a finding.
6. **Check prohibitions.** Any hit is a fail regardless of test scores.
7. **Rank by leverage, not severity.** The fix that moves the most users from suck→kick-ass wins. A broken advanced surface matters less than a missing first rep.

## What good evidence looks like

- ✅ "Passes copy test: the counterfactual is a rendered bar pair, 0 words of explainer — `components/Evidence/DebtLens.tsx:41`"
- ✅ "Fails honesty: p999 drawdown shown as a point estimate; uncertainty lives in a caveat string — `components/Carry/fixtures.ts:88`"
- ❌ "The onboarding could be more engaging" — no test, no evidence, not a finding

## Output shape

Per surface: the skill sentence · validity bucket · six test verdicts with evidence ·
prohibition hits. Then a ranked fix list. Then, explicitly, **what you could not
determine** — a surface you did not exercise is unaudited, not passing.

## Traps

- **Grading the product, not the user.** "Clean UI, good hierarchy" is a design review. The question is what the user can now *do*.
- **Accepting a simulator as teaching.** Retrospective before prospective (§3). An opt-in simulator below the fold serves the user who already arrived competent.
- **Counting words of copy as teaching.** More explanation is usually evidence the visual failed.
- **Treating a disclaimer as honesty.** Test 6 wants uncertainty in the geometry. A footnote is how you *avoid* showing it.
- **Auditing the happy path only.** The user who got liquidated is the one whose learning matters.
